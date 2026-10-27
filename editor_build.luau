--!strict
-- Drawing the board: frame images, the click targets of the focused frame and the activity line, each bounded to one batch
-- per tick.
local drafts = require("./lib/editor_draft")
local gesture = require("./lib/editor_gesture")
local editor_level = require("./lib/editor_level")
local label = require("./lib/editor_label")
local mirror = require("./lib/mirror")
local projection = require("./lib/editor_projection")
local Core = require("./editor_core")
local Lifecycle = require("./editor_lifecycle")
local IMAGE_BATCH_ADDITIONS = Core.IMAGE_BATCH_ADDITIONS
local IMAGE_BATCH_REMOVALS, MAX_SCAN_ROWS = Core.IMAGE_BATCH_REMOVALS, Core.MAX_SCAN_ROWS
local POLL_MS, READ_GROUP, announce = Core.POLL_MS, Core.READ_GROUP, Core.announce
local remember, stats, writeStatus = Core.remember, Core.stats, Core.writeStatus
local accepted, after, call = Lifecycle.accepted, Lifecycle.after, Lifecycle.call
local fail, finish, ownerGone = Lifecycle.fail, Lifecycle.finish, Lifecycle.ownerGone
local present, retireIds = Lifecycle.present, Lifecycle.retireIds
local retirePrivate = Lifecycle.retirePrivate
type Session = Core.Session

local showActivity: (c: WindowCx, sess: Session, activity: any, done: (c: WindowCx) -> ()) -> ()

-- Reads every page of `method` (list_frames or poll_view) through the pure offer/take checks, pinning the revision
-- the first page reports. `done` gets the rows, that revision and the first reply (for the panel focus).
local function scan(
	c: WindowCx,
	sess: Session,
	method: string,
	frame: string?,
	pinned: number?,
	done: (rows: { any }, revision: number, first: any, c: WindowCx) -> ()
)
	local gen = sess.generation
	local rows: { any } = {}
	local revision = pinned
	local first: any = nil
	local function page(c1: WindowCx, cursor: number?)
		call(sess, method, { cursor = cursor, frame_id = frame }, 120000, function(reply, code, remote, c2, request_id)
			if reply == nil then
				fail(c2, sess, code or "BAD_REPLY", remote)
				return
			end
			-- Offer in this tick, take in the next: the reply is never installed and applied together.
			after(sess, "offer", 0, function(c3: WindowCx)
				local proj = accepted(sess, gen)
				if proj == nil then
					return
				end
				if not projection.offer(proj, reply) then
					fail(c3, sess, proj.last_error or "BAD_REPLY")
					return
				end
				after(sess, "take", 0, function(c4: WindowCx)
					if gen ~= sess.generation then
						return
					end
					local taken = projection.take(proj, { request_id = request_id, cursor = cursor or 0, revision = revision })
					if taken == nil then
						fail(c4, sess, proj.last_error or "BAD_REPLY")
						return
					end
					revision = taken.revision
					if first == nil then
						first = reply
					end
					for _, row in taken.nodes do
						table.insert(rows, row)
					end
					if taken.next_cursor ~= nil and #rows < MAX_SCAN_ROWS then
						page(c4, taken.next_cursor)
					else
						if method == "list_frames" then
							sess.frame_rows = rows
						end
						showActivity(c4, sess, first.activity, function(c5)
							done(rows, revision :: number, first, c5)
						end)
					end
				end)
			end)
		end)
	end
	page(c, nil)
end

-- Applies `batches` one per tick, the first included, so no tick holds more than one whiteboard edit. `on_batch`
-- records each success; `done(ok)` runs after the last, or after the first failure (the rest are not tried: refs of
-- a later batch may depend on an earlier one).
local function applyBatches(
	c: WindowCx,
	sess: Session,
	batches: { projection.Batch },
	on_batch: (batch: projection.Batch, result: WhiteboardResult) -> (),
	done: (ok: boolean, c: WindowCx) -> ()
)
	local gen = sess.generation
	local function run(c1: WindowCx, index: number)
		local batch = batches[index]
		if batch == nil then
			done(true, c1)
			return
		end
		local ok, result = pcall(function(): WhiteboardResult
			return c1.whiteboard:edit(sess.board, batch.edits)
		end)
		if not ok then
			-- The failed edit was this tick's native call: what follows (a notice) waits for the next.
			after(sess, "batch_failed", 0, function(c2: WindowCx) done(false, c2) end)
			return
		end
		on_batch(batch, result)
		after(sess, "batch", 0, function(c2: WindowCx)
			if gen == sess.generation then
				run(c2, index + 1)
			end
		end)
	end
	after(sess, "batch", 0, function(c1: WindowCx)
		if gen == sess.generation then
			run(c1, 1)
		end
	end)
end

-- `present`, one group of READ_GROUP ids per tick, so the work of a tick does not grow with the number of shapes. `done`
-- also gets the shapes that were read.
local function presentAsync(c: WindowCx, sess: Session, ids: { string }, done: (found: { [string]: boolean }, c: WindowCx, shapes: { [string]: WhiteboardShape }) -> ())
	local gen = sess.generation
	local found: { [string]: boolean } = {}
	local shapes: { [string]: WhiteboardShape } = {}
	local function group(c1: WindowCx, first: number)
		if first > #ids then
			done(found, c1, shapes)
			return
		end
		local slice: { string } = table.move(ids, first, math.min(first + READ_GROUP - 1, #ids), 1, {})
		local there, read = present(c1, sess, slice)
		for id in there do
			found[id] = true
		end
		for id, shape in read do
			shapes[id] = shape
		end
		after(sess, "present", 0, function(c2: WindowCx)
			if gen == sess.generation then
				group(c2, first + READ_GROUP)
			end
		end)
	end
	group(c, 1)
end

-- Feedback shapes are separate from both editable targets and durable frame images.
showActivity = function(c: WindowCx, sess: Session, activity: any, done: (c: WindowCx) -> ())
	if typeof(activity) == "table" and activity.state == "disconnected" then
		ownerGone(c, sess)
		return
	end
	local plan = projection.activity_plan(activity, sess.frame_rows)
	if sess.level then
		plan.text ..= " · inside a container · click outside it to go up"
	end
	local key = tern.json.encode({ activity = activity, generation = sess.generation, frames = #sess.frame_rows, level = sess.level })
	if key == sess.activity_key then
		done(c)
		return
	end
	local halos = sess.halos :: projection.State
	retirePrivate(c, sess, projection.owned_ids(halos), function(c1)
		after(sess, "activity_plan", 0, function(c2: WindowCx)
			local edits = table.clone(plan.edits)
			local view = projection.extent(sess.frame_rows)
			local x, y = if view then view.x or 0 else 0, if view then (view.y or 0) - 40 else -40
			if sess.activity_text then
				table.insert(edits, { op = "unlock", id = sess.activity_text })
				table.insert(edits, { op = "text", id = sess.activity_text, text = plan.text })
				table.insert(edits, { op = "move", id = sess.activity_text, x = x, y = y })
				table.insert(edits, { op = "lock", id = sess.activity_text })
			else
				table.insert(edits, {
					op = "add", type = "text", ref = "activity-text", x = x, y = y,
					text = plan.text, color = "#7c3aed", font_size = 18,
				})
				table.insert(edits, { op = "lock", id = "activity-text" })
			end
			applyBatches(c2, sess, projection.batches({ edits = edits, replaced = {}, gone = {}, missing = {} }), function(batch, result)
				for _, ref in batch.refs do
					local id = result.refs[ref]
					if ref == "activity-text" then
						sess.activity_text = id
					elseif id then
						halos.owned[id] = true
						halos.partial[id] = true
					end
				end
			end, function(ok, c3)
				if not ok then
					sess.activity_text = nil
					fail(c3, sess, "BOARD_FAILED")
					return
				end
				projection.complete(halos)
				sess.activity_key = key
				remember(sess)
				done(c3)
			end)
		end)
	end)
end

-- Brings frame images in line with the owner, reading, planning and applying one bounded batch per tick.
local function applyFrames(c: WindowCx, sess: Session, rows: { any }, done: (ok: boolean, c: WindowCx) -> ())
	local gen = sess.generation
	local frames_state = sess.frames_state :: projection.State
	local mine: { string } = {}
	for id, owned in frames_state.owned do
		if owned then
			table.insert(mine, id)
		end
	end
	for _, entry in sess.shown do
		table.insert(mine, entry.shape)
		if entry.bg then
			table.insert(mine, entry.bg)
		end
	end
	presentAsync(c, sess, mine, function(existing, c1)
		projection.reconcile(frames_state, existing)
		projection.reconcile_shown(sess.shown, existing)
		after(sess, "plan_frames", 0, function(c2: WindowCx)
			if gen ~= sess.generation then
				return
			end
			local frames = projection.frames(rows, sess.shown)
			local plan = mirror.plan(sess.shown, frames, "", tern.fs.exists)
			local edits = projection.retire(projection.orphans(frames_state, sess.shown), IMAGE_BATCH_REMOVALS)
			for _, edit in plan.edits do
				table.insert(edits, edit)
			end
			local refs: { [string]: string } = {}
			local batches = projection.batches(
				{ edits = edits, replaced = plan.replaced, gone = plan.gone, missing = plan.missing },
				{ additions = IMAGE_BATCH_ADDITIONS, removals = IMAGE_BATCH_REMOVALS }
			)
			applyBatches(c2, sess, batches, function(batch, result)
				projection.adopt(frames_state, batch, result.refs)
				retireIds(sess, batch.removed)
				for ref, id in result.refs do
					refs[ref] = id
				end
			end, function(ok, c3)
				if gen ~= sess.generation then
					return
				end
				-- Whatever landed is recorded, even after a failure: an unrecorded shape would be drawn over next time.
				mirror.adopt(sess.shown, plan, frames, refs, "")
				if ok then
					projection.complete(frames_state)
					remember(sess)
				end
				done(ok, c3)
			end)
		end)
	end)
end

-- Replaces the click targets with those of the focused frame's rows: ids still on the board are read in groups, then
-- the plan is made, then the batches go one per tick.
local function applyTargets(c: WindowCx, sess: Session, rows: { any }, frame: string, done: (ok: boolean, capped: number, c: WindowCx) -> ())
	local gen = sess.generation
	local proj = sess.proj :: projection.State
	local owned: { string } = {}
	for id, is_owned in proj.owned do
		if is_owned then
			table.insert(owned, id)
		end
	end
	presentAsync(c, sess, owned, function(have, c1, read)
		after(sess, "plan_targets", 0, function(c2: WindowCx)
			if gen ~= sess.generation then
				return
			end
			-- Targets the user deleted or undid on the board leave the registry and our ownership: kept, every later
			-- capture would look like a board with missing shapes, and every rebuild would read them all again.
			local forgotten = projection.reconcile(proj, have)
			projection.forget_targets(sess.targets, forgotten)
			retireIds(sess, forgotten)
			local plan = projection.targets(rows, frame, sess.level)
			gesture.reset(sess.gesture)
			gesture.drawn(sess.gesture, plan, rows)
			-- A target the user is still dragging after the owner applied its gesture is not pulled from under the pointer.
			-- Whether it is, is decided here, from the read of the shapes just made (the rebuild follows the render by some
			-- time, and the pointer may have moved on since the owner answered): a shape that is no longer at the box that
			-- was applied stays, is compared with the document's box from now on, and what the user does next is a new gesture.
			local applied, keep_refs = sess.applied, {}
			sess.applied = nil
			if applied then
				for ref, path in plan.paths do
					local record = applied[path]
					local shape = if record then read[record.id] else nil
					if record and shape and not drafts.at_box(shape, record.change) then
						keep_refs[ref] = record.id
						sess.targets.by_path[path], sess.targets.by_id[record.id], sess.targets.box[record.id] = record.id, path, plan.boxes[ref]
					end
				end
			end
			-- The target the user may be typing on, and the one they selected next, are never replaced: a new shape would
			-- take the editor from under their hands, and the typed text with it (lib/editor_label).
			local fixes = label.hold(sess.label, plan, rows, read, have, sess.targets, keep_refs)
			local keeping: { [string]: boolean } = {}
			for _, id in keep_refs do
				keeping[id] = true
			end
			local old: { string } = {}
			for _, id in owned do
				if have[id] and not keeping[id] then
					table.insert(old, id)
				end
			end
			table.sort(old)
			local edits = projection.removals(old)
			for _, edit in plan.edits do
				if keep_refs[edit.ref :: string] == nil then
					table.insert(edits, edit)
				end
			end
			-- After the new targets: the kept one is brought in front of them.
			for _, edit in fixes do
				table.insert(edits, edit)
			end
			local batches = projection.batches({ edits = edits, replaced = {}, gone = {}, missing = {} })
			applyBatches(c2, sess, batches, function(batch, result)
				projection.adopt_targets(proj, batch, result.refs, plan, sess.targets)
				retireIds(sess, batch.removed)
			end, function(ok, c3)
				if ok then
					projection.complete(proj)
				end
				done(ok, plan.capped, c3)
			end)
		end)
	end)
end

-- One full construction: frames, then the focused frame's targets, then the selection the panel has.
local function build(c: WindowCx, sess: Session)
	local gen = sess.generation
	local t0 = tern.now()
	scan(c, sess, "list_frames", nil, nil, function(frame_rows, revision, first, c1)
		if typeof(first.activity) ~= "table" or first.activity.state ~= "ready" then
			finish(sess, POLL_MS)
			return
		end
		local panel = if typeof(first.focus) == "table" then first.focus else {}
		local focus: string? = if typeof(panel.frame_id) == "string" then panel.frame_id else nil
		local listed = false
		for _, row in frame_rows do
			if row.id == focus then
				listed = true
			end
		end
		if not listed then
			focus = if frame_rows[1] then frame_rows[1].id else nil
		end
		after(sess, "frames", 0, function(c2: WindowCx)
			if gen ~= sess.generation then
				return
			end
			applyFrames(c2, sess, frame_rows, function(frames_ok, c3)
				if not frames_ok then
					fail(c3, sess, "BOARD_FAILED")
					return
				end
				if not sess.framed then
					sess.framed = true
					local view = projection.extent(projection.frames(frame_rows, {}))
					if view then
						pcall(function()
							return c3.whiteboard:edit(sess.board, { view })
						end)
					end
				end
				if focus == nil then
					sess.scene, sess.focus, sess.built_focus, sess.capped_focus = revision, nil, nil, nil
					if sess.note == "TARGETS_CAPPED" then
						sess.note = nil
					end
					announce(c3, sess, nil)
					finish(sess, POLL_MS)
					return
				end
				scan(c3, sess, "poll_view", focus, revision, function(node_rows, _, _, _c4)
					local tree = editor_level.tree(node_rows)
					sess.tree, sess.level = tree, editor_level.valid(tree, sess.level)
					after(sess, "targets", 0, function(c5: WindowCx)
						if gen ~= sess.generation then
							return
						end
						applyTargets(c5, sess, node_rows, focus, function(targets_ok, capped, c6)
							if not targets_ok then
								fail(c6, sess, "BOARD_FAILED")
								return
							end
							sess.scene, sess.focus, sess.built_focus = revision, focus, focus
							sess.armed = gen
							sess.chosen = nil
							sess.selected = if typeof(panel.selected_node) == "string" then panel.selected_node else nil
							stats.builds += 1
							remember(sess)
							stats.build_ms = math.floor(tern.now() - t0)
							local show, capped_focus = projection.cap_notice(sess.capped_focus, focus, capped)
							sess.capped_focus = capped_focus
							local function conclude(c7: WindowCx, code: string?)
								announce(c7, sess, code)
								writeStatus(sess)
								finish(sess, POLL_MS)
							end
							if capped_focus == nil then
								sess.note = if sess.note == "TARGETS_CAPPED" then nil else sess.note
								conclude(c6, nil)
							elseif show then
								sess.note = nil
								-- A toast is a native call: it gets a tick of its own.
								after(sess, "capped_notice", 0, function(c7: WindowCx) conclude(c7, "TARGETS_CAPPED") end)
							else
								sess.note = "TARGETS_CAPPED"
								conclude(c6, nil)
							end
						end)
					end)
				end)
			end)
		end)
	end)
end

return {
	build = build,
	showActivity = showActivity,
}
