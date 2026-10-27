--!strict
-- What the user does on the board: a click selects, a drag or resize is a gesture the owner validates, the panel can ask for
-- a capture of the targets. Everything is read in small slices over ticks.
local drafts = require("./lib/editor_draft")
local gesture = require("./lib/editor_gesture")
local editor_launch = require("./lib/editor_launch")
local projection = require("./lib/editor_projection")
local Core = require("./editor_core")
local Lifecycle = require("./editor_lifecycle")
local Closing = require("./editor_closing")
local Build = require("./editor_build")
local CAPTURE_GROUP, CAPTURE_TICK_MS = Core.CAPTURE_GROUP, Core.CAPTURE_TICK_MS
local CAPTURE_TICK_READS, HELD_GAP_MS = Core.CAPTURE_TICK_READS, Core.HELD_GAP_MS
local POLL_MS, QUICK_FETCH_MS, SWEEP_READ = Core.POLL_MS, Core.QUICK_FETCH_MS, Core.SWEEP_READ
local WHOLE_PAGE, announce = Core.WHOLE_PAGE, Core.announce
local accepted, after, bump = Lifecycle.accepted, Lifecycle.after, Lifecycle.bump
local call, fail, finish = Lifecycle.call, Lifecycle.fail, Lifecycle.finish
local retirePrivate, schedule = Lifecycle.retirePrivate, Lifecycle.schedule
local offerRecovery = Closing.offerRecovery
local showActivity = Build.showActivity
type Session = Core.Session

-- Sends a click made on the board to the owner.
local function sendSelection(c: WindowCx, sess: Session, path: string, next_step: (c: WindowCx) -> ())
	local gen = sess.generation
	sess.selected = path
	call(sess, "select_node", { scene_revision = sess.scene, path = path }, QUICK_FETCH_MS, function(reply, code, remote, c1, request_id)
		if reply == nil then
			fail(c1, sess, code or "BAD_REPLY", remote)
			return
		end
		if not editor_launch.selected(reply, request_id, gen, path) then
			fail(c1, sess, "BAD_REPLY")
			return
		end
		next_step(c1)
	end)
end

-- The ids of every click target of the current build.
local function targetIds(sess: Session): { string }
	local ids: { string } = {}
	for id in sess.targets.by_id do
		table.insert(ids, id)
	end
	table.sort(ids)
	return ids
end

-- Reads these target shapes (`ids`, sorted) and hands the listing over. The reads are small groups, a bounded
-- number (and time) per tick, the first in a tick of its own. A group that fails names the missing shape: that id is
-- dropped and the rest retried, so a board cleared of its shapes costs one cheap read per missing shape, spread over
-- ticks, never one long tick. A shape the board will not read for another reason counts as left out, so the draft asks
-- for a rebuild instead of trusting a partial answer.
local function readTargets(sess: Session, ids: { string }, done: (listing: drafts.Listing, c: WindowCx) -> ())
	local gen = sess.generation
	local queue: { { string } } = {}
	for first = #ids - ((#ids - 1) % CAPTURE_GROUP), 1, -CAPTURE_GROUP do
		table.insert(queue, table.move(ids, first, math.min(first + CAPTURE_GROUP - 1, #ids), 1, {}))
	end
	-- The queue is a stack: the next group is the last element.
	local listing: drafts.Listing = { shapes = {}, more = 0 }
	local function run(c1: WindowCx)
		local t0, reads = tern.now(), 0
		while #queue > 0 and reads < CAPTURE_TICK_READS and tern.now() - t0 < CAPTURE_TICK_MS do
			local group = table.remove(queue) :: { string }
			reads += 1
			local ok, state = pcall(function(): WhiteboardState
				return c1.whiteboard:read(sess.board, { ids = group, max_shapes = #group })
			end)
			if ok then
				listing.more += state.more
				for _, shape in state.shapes do
					table.insert(listing.shapes, shape)
				end
			else
				local missing = projection.missing_id(state)
				local at = if missing then table.find(group, missing) else nil
				if at ~= nil then
					table.remove(group, at)
					if #group > 0 then
						table.insert(queue, group)
					end
				elseif #group == 1 then
					listing.more += 1
				else
					local middle = #group // 2
					table.insert(queue, table.move(group, middle + 1, #group, 1, {}))
					table.insert(queue, table.move(group, 1, middle, 1, {}))
				end
			end
		end
		if #queue == 0 then
			done(listing, c1)
			return
		end
		after(sess, "capture_read", 0, function(c2: WindowCx)
			if gen == sess.generation then
				run(c2)
			end
		end)
	end
	after(sess, "capture_read", 0, function(c1: WindowCx)
		if gen == sess.generation then
			run(c1)
		end
	end)
end

-- Answers the panel's request for the board's geometry drafts: a fresh complete reading of the targets, then the
-- candidates go to the owner, which validates them against the document and decides. Nothing here writes the
-- document or the board; a refusal leaves the shapes as the user left them, a conflict or a missing target rebuilds.
local function captureBoard(sess: Session, capture_id: string)
	local gen = sess.generation
	readTargets(sess, targetIds(sess), function(listing, _c1)
		after(sess, "capture_plan", 0, function(c2: WindowCx)
			if gen ~= sess.generation then
				return
			end
			local draft = drafts.capture(drafts.known(sess.targets), listing)
			local args = {
				capture_id = capture_id,
				scene_revision = sess.scene or 0,
				changes = draft.changes,
				needs_reconcile = draft.needs_reconcile,
			}
			call(sess, "submit_capture", args, QUICK_FETCH_MS, function(reply, code, remote, c3, request_id)
				if reply == nil then
					if remote == "GEOMETRY_CAPTURE_STALE" then
						-- The panel gave up or asked again: the board stays as the user left it.
						finish(sess, POLL_MS)
					else
						fail(c3, sess, code or "BAD_REPLY", remote)
					end
					return
				end
				if not editor_launch.captured(reply, request_id, gen, capture_id) then
					fail(c3, sess, "BAD_REPLY")
					return
				end
				if draft.needs_reconcile or reply.outcome == "conflict" then
					announce(c3, sess, if draft.needs_reconcile then "TARGETS_RESTORED" else nil)
					bump(c3, sess, 0)
				else
					finish(sess, if reply.outcome == "applied" then 0 else POLL_MS)
				end
			end)
		end)
	end)
end

-- Asks the owner where it stands (frames page 0 carries the revision and the panel focus) and follows it.
local function probe(c: WindowCx, sess: Session)
	local gen = sess.generation
	-- After a run of quiet probes the owner holds its answer until something changes (or the wait is over).
	local wait = projection.poll_wait(sess.quiet)
	local args: { [string]: any } = { since = sess.change_seq, wait_ms = if wait > 0 then wait else nil }
	-- While the owner holds this answer, `step` keeps looking at the board for a click (see `step`).
	sess.holding = wait > 0
	if sess.holding then
		schedule(sess, POLL_MS)
	end
	call(sess, "list_frames", args, 120000, function(reply, code, remote, c1, request_id)
		sess.holding = false
		if reply == nil then
			fail(c1, sess, code or "BAD_REPLY", remote)
			return
		end
		after(sess, "offer", 0, function(c2: WindowCx)
			local proj = accepted(sess, gen)
			if proj == nil then
				return
			end
			if not projection.offer(proj, reply) then
				fail(c2, sess, proj.last_error or "BAD_REPLY")
				return
			end
			after(sess, "take", 0, function(c3: WindowCx)
				if accepted(sess, gen) == nil then
					return
				end
				if projection.take(proj, { request_id = request_id, cursor = 0, revision = nil }) == nil then
					fail(c3, sess, proj.last_error or "BAD_REPLY")
					return
				end
				showActivity(c3, sess, reply.activity, function(c3: WindowCx)
					announce(c3, sess, nil)
					if typeof(reply.activity) == "table" and reply.activity.phase == "recovering" and not sess.recovery_asked then
						offerRecovery(c3, sess)
					end
					if typeof(reply.change_seq) == "number" then
						sess.change_seq = reply.change_seq
					end
					if typeof(reply.activity) ~= "table" or reply.activity.state ~= "ready" then
						finish(sess, POLL_MS)
						return
					end
					if typeof(reply.reset) == "number" and reply.reset ~= sess.reset_seen then
						sess.reset_seen = reply.reset
						bump(c3, sess, 0)
						return
					end
					if typeof(reply.capture) == "table" and typeof(reply.capture.capture_id) == "string" then
						sess.quiet = 0
						captureBoard(sess, reply.capture.capture_id)
						return
					end
					local drift = projection.drift({ scene = sess.scene, focus = sess.built_focus, selected = sess.selected }, reply)
					if drift == "revision" or drift == "focus" then
						local focus = if typeof(reply.focus) == "table" then reply.focus.frame_id else nil
						sess.focus = if typeof(focus) == "string" then focus else sess.focus
						bump(c3, sess, 0)
					elseif drift == "selection" then
						local selected = reply.focus.selected_node
						sess.selected = if typeof(selected) == "string" then selected else nil
						sess.quiet = 0
						finish(sess, POLL_MS)
					else
						sess.quiet += 1
						finish(sess, if projection.poll_wait(sess.quiet) > 0 then HELD_GAP_MS else POLL_MS)
					end
				end)
			end)
		end)
	end)
end

-- The board as read now (selection, undo and redo steps), or nil when it cannot be read just now.
local function boardState(c: WindowCx, sess: Session): WhiteboardState?
	local ok, state = pcall(function(): WhiteboardState
		return c.whiteboard:read(sess.board, { max_shapes = 1 })
	end)
	if not ok then
		return nil
	end
	return state
end

-- The one target the user selected on the board that the panel does not show yet, if any.
local function pickedTarget(sess: Session, selection: { string }?): string?
	if selection == nil or #selection ~= 1 then
		return nil
	end
	local path = sess.targets.by_id[selection[1]]
	if path ~= nil and path ~= sess.selected then
		return path
	end
	return nil
end

-- The board's own Undo can bring back target shapes this session drew and replaced (they are on the board again with
-- the very ids it retired). They are removed, by id and in silence: nothing is applied, and nothing else of the board is
-- touched, however it looks. Only a change of the undo/redo step counts with something to redo is looked into.
-- shortcut: a plugin edit that lands between the user's Undo and the next look clears the redo count, so that Undo is
-- missed (an Undo during a rebuild's batches, or a held Ctrl+Z); upgrade by watching the undo count against the number of
-- steps the plugin itself made.
-- shortcut: the retired ids live in memory only; a plugin reload forgets them, so an Undo brings back orphans of the
-- earlier VM; upgrade by recording them in the session registry (lib/editor_registry).
local function sweepRevived(c: WindowCx, sess: Session, state: WhiteboardState?, proceed: (c: WindowCx) -> ())
	if state == nil then
		proceed(c)
		return
	end
	local before = sess.marks
	sess.marks = { undo = state.undo, redo = state.redo }
	if state.redo == 0 or #sess.gesture.retired == 0 or (before and before.undo == state.undo and before.redo == state.redo) then
		proceed(c)
		return
	end
	after(sess, "revived_read", 0, function(c1: WindowCx)
		local ok, page = pcall(function(): WhiteboardState
			return c1.whiteboard:read(sess.board, { area = WHOLE_PAGE, max_shapes = SWEEP_READ })
		end)
		if not ok then
			sess.marks = before
			proceed(c1)
			return
		end
		local there: { [string]: boolean } = {}
		for _, shape in page.shapes do
			there[shape.id] = true
		end
		local ids = gesture.revived(sess.gesture, there)
		if #ids == 0 then
			proceed(c1)
			return
		end
		retirePrivate(c1, sess, ids, proceed)
	end)
end

-- A gesture that ended goes to the owner as a capture of its own (no panel in between), which validates it against the
-- document; the activity line says so meanwhile. Whatever the owner answers, the board is drawn again from the document
-- afterwards: an applied move shows at its new place, a refusal or a conflict puts every target back in the box the
-- document confirmed. Only the owner being busy with another capture leaves the board as the user left it, and the same
-- gesture is offered again (without a word: what could not be done is told once the owner has answered).
local function applyGestures(c: WindowCx, sess: Session, verdict: gesture.Verdict, proceed: (c: WindowCx) -> ())
	local gen = sess.generation
	sess.gestures += 1
	local capture_id = sess.launch_id .. "-g" .. tostring(sess.gestures)
	showActivity(c, sess, { state = "working", phase = "applying", revision = sess.scene }, function(c0: WindowCx)
		call(sess, "submit_capture", { capture_id = capture_id, direct = true, scene_revision = sess.scene or 0, changes = verdict.changes }, QUICK_FETCH_MS, function(reply, code, remote, c1, request_id)
			sess.watching = nil
			if reply == nil then
				if remote == "GEOMETRY_CAPTURE_STALE" then
					proceed(c1)
				else
					fail(c1, sess, code or "BAD_REPLY", remote)
				end
				return
			end
			if not editor_launch.captured(reply, request_id, gen, capture_id) then
				fail(c1, sess, "BAD_REPLY")
				return
			end
			if reply.outcome == "refused" and typeof(reply.code) == "string" then
				announce(c1, sess, reply.code, if reply.layout == "horizontal" or reply.layout == "vertical" then reply.layout else nil)
			elseif verdict.bounced[1] then
				announce(c1, sess, verdict.bounced[1].note)
			end
			if reply.outcome == "applied" then
				local record: { [string]: { id: string, change: drafts.Change } } = {}
				for _, change in verdict.changes do
					local id = verdict.ids[change.path]
					if id then
						record[change.path] = { id = id, change = change }
					end
				end
				sess.applied = record
			end
			bump(c1, sess, 0)
		end)
	end)
end

-- Looks at every click target (see lib/editor_gesture) and acts on what it finds: an ended gesture is applied, a target
-- that was deleted or moved where the document does not allow is drawn again. `proceed` runs when there is nothing to
-- act on; otherwise this has taken over the step. The reads are sliced over ticks like the panel's.
local function watchGestures(c: WindowCx, sess: Session, proceed: (c: WindowCx) -> ())
	if sess.armed ~= sess.generation or sess.watching == sess.generation or next(sess.targets.by_id) == nil then
		proceed(c)
		return
	end
	local known = drafts.known(sess.targets)
	sess.watching = sess.generation
	readTargets(sess, targetIds(sess), function(listing, _c1)
		after(sess, "gesture_plan", 0, function(c2: WindowCx)
			local verdict = gesture.observe(sess.gesture, known, listing)
			if #verdict.changes > 0 then
				applyGestures(c2, sess, verdict, proceed)
				return
			end
			sess.watching = nil
			if verdict.rebuild == nil and #verdict.bounced == 0 then
				proceed(c2)
				return
			end
			if verdict.bounced[1] then
				announce(c2, sess, verdict.bounced[1].note)
			elseif verdict.rebuild == "deleted" and not (sess.marks and sess.marks.redo > 0) then
				-- (Targets that went with the board's own Undo are no news: they are simply drawn again.)
				announce(c2, sess, "TARGETS_RESTORED")
			end
			bump(c2, sess, 0)
		end)
	end)
end

return {
	boardState = boardState,
	pickedTarget = pickedTarget,
	probe = probe,
	sendSelection = sendSelection,
	sweepRevived = sweepRevived,
	watchGestures = watchGestures,
}
