--!strict
-- The life of a session: the ticks every step runs in (one view generation each), the calls to the owner, and how a session is
-- retired, ended or found gone.
local gesture = require("./lib/editor_gesture")
local editor_launch = require("./lib/editor_launch")
local projection = require("./lib/editor_projection")
local Core = require("./editor_core")
local POLL_MS, QUICK_FETCH_MS = Core.POLL_MS, Core.QUICK_FETCH_MS
local READY_TIMEOUT_MS, READ_GROUP, RETRY_MS = Core.READY_TIMEOUT_MS, Core.READ_GROUP, Core.RETRY_MS
local announce, hooks, later = Core.announce, Core.hooks, Core.later
local queueRegistry, record, remember = Core.queueRegistry, Core.record, Core.remember
local sessions, tick, timed, writeStatus = Core.sessions, Core.tick, Core.timed, Core.writeStatus
type Session = Core.Session

local schedule: (sess: Session, ms: number) -> ()
local guard: (c: WindowCx, sess: Session) -> boolean
local ownerGone: (c: WindowCx, sess: Session) -> ()
local keepAlive: (sess: Session) -> ()

-- Runs `fn` in a timer tick with a fresh cx, measuring it. A step that raises is a bug, not a reason to stop: the
-- projection starts over (a new generation) after a pause, and says so. A tick belongs to the view generation it was
-- scheduled in and stops if that moved on; `ungated` ones (an answer the session still needs whatever the view did)
-- run while the session lives.
local function after(sess: Session, name: string, ms: number, fn: (c: WindowCx) -> (), ungated: boolean?)
	local gen = sess.generation
	local function run(c: WindowCx)
		local t0 = tern.now()
		local failure = ""
		local ok = xpcall(fn, function(e: any): string
			failure = tostring(e) .. "\n" .. debug.traceback()
			return failure
		end, c)
		local took = tern.now() - t0
		record(name, took)
		if not ok then
			tern.log.error("editor step " .. name .. " failed: " .. failure)
			sess.busy = false
			sess.generation += 1
			if sess.proj then
				sess.proj = projection.advance(sess.proj, sess.generation)
			end
			announce(c, sess, "BOARD_FAILED")
			schedule(sess, RETRY_MS)
		end
	end
	later(ms, function(fresh: WindowCx?)
		if not sess.alive or (gen ~= sess.generation and not ungated) then
			return
		end
		if fresh == nil then
			after(sess, name, RETRY_MS, fn, ungated)
			return
		end
		if not sess.retiring and not guard(fresh, sess) and not (ungated and sess.alive and not sess.retiring) then
			return
		end
		run(fresh)
	end)
end

schedule = function(sess: Session, ms: number)
	sess.tick += 1
	local mine = sess.tick
	after(sess, "step", ms, function(c: WindowCx)
		if sess.tick == mine then
			hooks.step(c, sess)
		end
	end)
end

local function startChain(sess: Session)
	sess.busy = true
	sess.busy_since = tern.now()
	schedule(sess, POLL_MS)
end

local function finish(sess: Session, ms: number)
	sess.busy = false
	sess.holding = false
	if sess.proj then
		sess.proj.seen_requests = {}
	end
	schedule(sess, ms)
end

-- The projection state of generation `gen`, or nil when the session or the generation has moved on.
local function accepted(sess: Session, gen: number): projection.State?
	local proj, record = sess.proj, sess.record
	if not sess.alive or sess.retiring or proj == nil or record == nil or gen ~= sess.generation then
		return nil
	end
	if projection.accept(proj, { session_id = record.session_id, pane = sess.board, generation = gen }) then
		return proj
	end
	return nil
end

-- Reads exactly these shapes. It asks for exactly these ids, so a board with any number of shapes (the full listing is
-- capped at 2000) gives the same answer; a read naming a missing shape raises, so a failing group is split until the
-- missing ids stand alone. Returns the shapes found, the ids whose read failed for another reason (they may still be
-- on the board) and how many shapes the board left out of its answers.
local function readIds(c: WindowCx, sess: Session, ids: { string }): ({ [string]: WhiteboardShape }, { [string]: boolean }, number)
	local found: { [string]: WhiteboardShape } = {}
	local unreadable: { [string]: boolean } = {}
	local left_out = 0
	local function probe(first: number, last: number)
		if first > last then
			return
		end
		local group: { string } = table.move(ids, first, last, 1, {})
		local ok, state = pcall(function(): WhiteboardState
			return c.whiteboard:read(sess.board, { ids = group, max_shapes = #group })
		end)
		if ok then
			left_out += state.more
			for _, shape in state.shapes do
				found[shape.id] = shape
			end
		elseif first == last then
			if not projection.is_missing_shape(state) then
				unreadable[ids[first]] = true
			end
		else
			local middle = (first + last) // 2
			probe(first, middle)
			probe(middle + 1, last)
		end
	end
	for first = 1, #ids, READ_GROUP do
		probe(first, math.min(first + READ_GROUP - 1, #ids))
	end
	return found, unreadable, left_out
end

-- Which of `ids` are still on the board (and the shapes read, for those whose box is wanted). Any failure other than a
-- missing shape counts as present: the caller then tries its edit and learns from that.
local function present(c: WindowCx, sess: Session, ids: { string }): ({ [string]: boolean }, { [string]: WhiteboardShape })
	local found, unreadable = readIds(c, sess, ids)
	local there: { [string]: boolean } = {}
	for id in found do
		there[id] = true
	end
	for id in unreadable do
		there[id] = true
	end
	return there, found
end

-- Remembers target shapes taken off the board: a native Undo of the board can bring them back, and the ones this
-- session drew are then removed again (by id; nothing else on the board is ever touched for it).
local function retireIds(sess: Session, ids: { string })
	local cut = gesture.retire(sess.gesture, ids)
	if cut > 0 and not sess.retired_cut then
		sess.retired_cut = true
		tern.log.warn(string.format("editor board remembers at most %d replaced shapes; the oldest are dropped, so a very old Undo may bring one back", gesture.MAX_RETIRED))
	end
end

-- Deletes just these target shapes (those of `ids` that `have` says the board still has) and forgets them. Failures leave
-- the shapes alone. The read that made `have` is the caller's, in a tick of its own.
local function deleteTargets(c: WindowCx, sess: Session, ids: { string }, have: { [string]: boolean }): boolean
	local found: { string } = {}
	for _, id in ids do
		if have[id] then
			table.insert(found, id)
		end
	end
	if #found > 0 then
		local ok = pcall(function()
			return c.whiteboard:edit(sess.board, projection.retire(found))
		end)
		if not ok then
			return false
		end
		retireIds(sess, found)
	end
	for _, id in ids do
		local path = sess.targets.by_id[id]
		sess.targets.by_id[id] = nil
		sess.targets.box[id] = nil
		if path and sess.targets.by_path[path] == id then
			sess.targets.by_path[path] = nil
		end
		if sess.proj then
			sess.proj.owned[id], sess.proj.partial[id] = nil, nil
		end
		if sess.halos then
			sess.halos.owned[id], sess.halos.partial[id] = nil, nil
		end
	end
	return true
end


local function retirePrivate(c: WindowCx, sess: Session, ids: { string }, done: (c: WindowCx) -> ())
	-- One read and one edit, each in a tick of its own, per group.
	local function chunk(c1: WindowCx, first: number)
		if first > #ids or c1.session:pane(sess.board) == nil then
			done(c1)
			return
		end
		local slice: { string } = table.move(ids, first, math.min(first + projection.MAX_REMOVALS - 1, #ids), 1, {})
		local have = present(c1, sess, slice)
		after(sess, "retire_delete", 0, function(c2: WindowCx)
			local ok = deleteTargets(c2, sess, slice, have)
			after(sess, "retire_private", if ok then 0 else RETRY_MS, function(c3: WindowCx)
				chunk(c3, if ok then first + #slice else first)
			end)
		end)
	end
	after(sess, "retire_private", 0, function(c1: WindowCx)
		chunk(c1, 1)
	end)
end

-- Abandons whatever is in flight for the current generation and starts the next one: half-built targets go, the
-- shapes of finished ones stay until the next build replaces them.
local function bump(c: WindowCx, sess: Session, delay: number)
	sess.generation += 1
	sess.busy = false
	sess.holding = false
	sess.quiet = 0
	local proj = sess.proj
	local ids: { string } = {}
	-- Only partial targets are abandoned on a generation change; completed targets remain until the replacement.
	if proj then
		for id in proj.partial do
			table.insert(ids, id)
		end
		sess.proj = projection.advance(proj, sess.generation)
	end
	sess.busy = true
	retirePrivate(c, sess, ids, function(_c1)
		finish(sess, delay)
	end)
end

local function fail(c: WindowCx, sess: Session, code: string, remote: string?)
	if code == "TRANSPORT" or code == "OWNER_ABSENT" then
		ownerGone(c, sess)
		return
	end
	-- A page of an older revision is not a failure: the next build reads the new one.
	if code ~= "STALE_REPLY" then
		announce(c, sess, remote or code)
		writeStatus(sess)
	end
	bump(c, sess, if code == "STALE_REPLY" then 0 else RETRY_MS)
end

-- Owner shutdown and launch timeout end the session; closing its board asks what to do with the document first.
-- Returns whether the launch manifest is still to be removed (by the caller, in a tick of its own). A starting owner may
-- still read its manifest, so it is only removed when the owner can no longer consume it (`stopped`: the window itself
-- is ending the owner, so nothing will read it). An owner whose record is known has read it and deleted it already.
local function cleanup(sess: Session, stopped: boolean?): boolean
	sess.alive = false
	sessions[sess.launch_id] = nil
	queueRegistry(sess.launch_id, false)
	sess.generation += 1
	if sess.proj then
		projection.close(sess.proj)
	end
	local starting = not stopped and sess.record == nil and sess.exited == nil and tern.now() - sess.started < READY_TIMEOUT_MS
	return not starting and sess.record == nil
end

local function removeManifest(c: WindowCx, sess: Session, remove: boolean)
	if remove then
		tick("manifest_cleanup", c, function(_c1: WindowCx)
			pcall(tern.fs.remove, sess.manifest)
		end)
	end
end

-- Asks the owner to end, once and without waiting for the answer: it ends whatever the answer says, closing its document
-- (the lock goes, the working copy goes, unsaved changes stay as recovery). An owner that cannot be reached, or whose
-- process is known to have ended, is not asked; one that is there but never hears ends by itself when no window asks for
-- it (ORPHAN_MS in editor/src/main.mjs).
local function askToEnd(sess: Session)
	local record = sess.record
	if record == nil or sess.exited ~= nil then
		return
	end
	pcall(function()
		local request = editor_launch.call(record, "close_editor", {}, QUICK_FETCH_MS)
		tern.fetch(request.url, request.options, function(_result: FetchResult, _c: WindowCx?) end)
	end)
end

-- Ends the editor: the session is forgotten and the owner is asked to end, at once, in this tick (the hook may not
-- live to run another). An owner that has not published its session yet cannot be asked: it starts on, finds nobody
-- and ends by itself, or never reads the launch manifest, which is removed in a tick of its own.
local function closeOwner(c: WindowCx, sess: Session)
	local remove = cleanup(sess, true)
	askToEnd(sess)
	removeManifest(c, sess, remove)
end

ownerGone = function(_c: WindowCx, sess: Session)
	if sess.retiring then
		return
	end
	sess.retiring = true
	sess.generation += 1
	sess.busy, sess.holding = false, false
	if sess.proj then
		projection.close(sess.proj)
	end
	if sess.halos then
		projection.close(sess.halos)
	end
	local ids = if sess.proj then projection.owned_ids(sess.proj) else {}
	if sess.halos then
		for _, id in projection.owned_ids(sess.halos) do
			table.insert(ids, id)
		end
	end
	-- The board's note, the notice and the removal of the board's shapes follow in ticks of their own.
	after(sess, "gone_board", 0, function(c1: WindowCx)
		if sess.activity_text and c1.session:pane(sess.board) then
			pcall(function()
				c1.whiteboard:edit(sess.board, {
					{ op = "unlock", id = sess.activity_text },
					{ op = "text", id = sess.activity_text, text = "Disconnected; images are read-only" },
					{ op = "lock", id = sess.activity_text },
				})
			end)
		end
		after(sess, "gone_notice", 0, function(c2: WindowCx)
			announce(c2, sess, "OWNER_ABSENT")
			writeStatus(sess)
			retirePrivate(c2, sess, ids, function(c3)
				removeManifest(c3, sess, cleanup(sess))
			end)
		end)
	end)
end

local function detach(sess: Session)
	local record = sess.record
	if record == nil then
		return
	end
	local generations = { sess.generation }
	if sess.attached and sess.attached ~= sess.generation then
		table.insert(generations, sess.attached)
	end
	for _, generation in generations do
		sess.requests += 1
		local request = editor_launch.call(record, "detach_view", {
			request_id = sess.launch_id .. "-" .. tostring(sess.requests),
			view_id = sess.view_id, view_generation = generation,
		}, QUICK_FETCH_MS)
		pcall(function()
			tern.fetch(request.url, request.options, function(_result: FetchResult, _c: WindowCx?) end)
		end)
	end
end

guard = function(c: WindowCx, sess: Session): boolean
	-- The owner's process ended. Before it published its session the loop reads why (see `ownerExited`).
	if sess.exited ~= nil and sess.record ~= nil then
		ownerGone(c, sess)
		return false
	end
	-- Until the owner's lease is won this window acts for nothing: a board that went meanwhile is dealt with by `attach`.
	if sess.board ~= 0 and not sess.claim and c.session:pane(sess.board) == nil then
		detach(sess)
		if sess.proj then
			projection.close(sess.proj)
		end
		sess.generation += 1
		sess.board = 0
		remember(sess)
		sess.busy, sess.holding = false, false
		sess.attached = nil
		-- The board is the editor's only window: closing it ends the editor, asking first about unsaved work (in a tick
		-- of its own: the detach above already used part of this one).
		sess.closing = true
		keepAlive(sess)
		after(sess, "board_closed", 0, function(c1: WindowCx)
			hooks.boardClosed(c1, sess)
		end)
		return false
	end
	return true
end

local VIEW_FREE: { [string]: boolean } = {
	get_document = true, save_document = true, undo_document = true, redo_document = true,
	discard_unsaved = true, resolve_recovery = true, save_recovery_copy = true, get_mcp_config = true, poll_document = true,
}

-- One call to the owner. `done` runs in a later tick, with a fresh cx, only when the reply still belongs to the
-- generation that asked; everything else is dropped. `keep` is for an answer the session needs whatever the board did
-- meanwhile (a recovery being decided): it is delivered while the session lives.
local function call(
	sess: Session,
	method: string,
	args: { [string]: any },
	timeout_ms: number,
	done: (reply: any?, code: string?, remote: string?, c: WindowCx, request_id: string) -> (),
	keep: boolean?
)
	local record = sess.record :: editor_launch.Record
	local gen = sess.generation
	sess.requests += 1
	local request_id = sess.launch_id .. "-" .. tostring(sess.requests)
	-- Only the board's own methods carry a view tag; the document's are closed over their own keys (the owner refuses
	-- any other key on them), and Undo and Redo are the document's as much as Save is.
	if VIEW_FREE[method] ~= true then
		args.request_id = request_id
		args.view_id = sess.view_id
		args.view_generation = gen
	end
	local request = editor_launch.call(record, method, args, timeout_ms)
	local started = pcall(function()
		tern.fetch(request.url, request.options, timed("fetch", function(result: FetchResult, _fresh: WindowCx?)
			-- Decode in its own tick: the callback itself only hands the bytes over.
			after(sess, "decode", 0, function(c: WindowCx)
				if gen ~= sess.generation and not keep then
					return
				end
				local reply, code, remote = editor_launch.page(result)
				done(reply, code, remote, c, request_id)
			end, keep)
		end))
	end)
	if not started then
		-- A rejected request is a transport fault of this session; its text is not logged (the request holds the token).
		tern.log.warn("editor request refused")
		after(sess, "refused", 0, function(c: WindowCx)
			if gen == sess.generation or keep then
				done(nil, "TRANSPORT", nil, c, request_id)
			end
		end, keep)
	end
end

-- The owner ends itself when no window has asked for it for a while (ORPHAN_MS in editor/src/main.mjs), and a window that
-- has closed its board and waits for the user's answer asks nothing else. This asks, with the window's own read of the
-- document, until the question is over; the answer is of no use.
local KEEP_ALIVE_MS = 20000
keepAlive = function(sess: Session)
	sess.keep += 1
	local mine = sess.keep
	local function beat()
		after(sess, "keep_alive", KEEP_ALIVE_MS, function(_c: WindowCx)
			if sess.keep ~= mine or not sess.closing or sess.record == nil then
				return
			end
			call(sess, "poll_document", {}, QUICK_FETCH_MS, function() end, true)
			beat()
		end, true)
	end
	beat()
end

return {
	accepted = accepted,
	after = after,
	bump = bump,
	call = call,
	closeOwner = closeOwner,
	fail = fail,
	finish = finish,
	guard = guard,
	ownerGone = ownerGone,
	present = present,
	retireIds = retireIds,
	retirePrivate = retirePrivate,
	schedule = schedule,
	startChain = startChain,
}
