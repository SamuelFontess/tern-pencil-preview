--!strict
-- The session's step: attach to the owner, then look at the board and poll the owner, one tick at a time.
local editor_launch = require("./lib/editor_launch")
local projection = require("./lib/editor_projection")
local util = require("./lib/util")
local Core = require("./editor_core")
local Lifecycle = require("./editor_lifecycle")
local Closing = require("./editor_closing")
local Build = require("./editor_build")
local Capture = require("./editor_capture")
local Text = require("./editor_text")
local Nav = require("./editor_nav")
local POLL_MS, QUICK_FETCH_MS, READY_POLL_MS = Core.POLL_MS, Core.QUICK_FETCH_MS, Core.READY_POLL_MS
local READY_TIMEOUT_MS, RETRY_MS, SWEEP_READ = Core.READY_TIMEOUT_MS, Core.RETRY_MS, Core.SWEEP_READ
local WHOLE_PAGE, announce, holderOf = Core.WHOLE_PAGE, Core.announce, Core.holderOf
local live, queueRegistry, remember, sessions, tick = Core.live, Core.queueRegistry, Core.remember, Core.sessions, Core.tick
local writeStatus = Core.writeStatus
local after, bump, call = Lifecycle.after, Lifecycle.bump, Lifecycle.call
local closeOwner, fail, finish = Lifecycle.closeOwner, Lifecycle.fail, Lifecycle.finish
local guard, ownerGone = Lifecycle.guard, Lifecycle.ownerGone
local retirePrivate, schedule = Lifecycle.retirePrivate, Lifecycle.schedule
local startChain = Lifecycle.startChain
local offerRecovery, reopenBoard = Closing.offerRecovery, Closing.reopenBoard
local build, showActivity = Build.build, Build.showActivity
local boardState, pickedTarget, probe = Capture.boardState, Capture.pickedTarget, Capture.probe
local sendSelection, sweepRevived = Capture.sendSelection, Capture.sweepRevived
local watchGestures = Capture.watchGestures
local watchText = Text.watchText
local watchLevel = Nav.watchLevel
type Session = Core.Session

-- Another window holds the owner's lease for as long as it keeps asking (the owner gives it up after
-- VIEW_LEASE_MS of silence). A window that was refused waits for it; one that has waited longer than that has a rival
-- that is alive, and leaves the session to it: nothing is drawn, swept, closed or forgotten.
local LEASE_WAIT_MS = 16000
-- How long a window whose own owner stopped with the document already open looks for the owner that has it. The owner of
-- an open that was begun again may have been started by the run before it and still be starting its engine: it holds the
-- lock but publishes only once the engine is up, so that one is looked for as long as any owner is waited for.
local RECONNECT_WAIT_MS = 6000

local function forfeit(c: WindowCx, sess: Session)
	sess.alive = false
	sess.generation += 1
	sessions[sess.launch_id] = nil
	if live.registry_ops[sess.launch_id] == sess then
		live.registry_ops[sess.launch_id] = nil
	end
	if sess.proj then
		projection.close(sess.proj)
	end
	-- A follower's entry is its own (the window that holds the editor keeps the editor's): left, it would be picked up after
	-- every reload, wait for the lease again and say this again.
	if sess.reconnect then
		queueRegistry(sess.launch_id, false)
	end
	c:toast("info", "This editor is open in another window", util.basename(sess.path))
end

local sweepOld: (c: WindowCx, sess: Session, ours: { [string]: boolean }, done: (c: WindowCx) -> (), round: number, tries: number) -> ()
local giveUp: (sess: Session) -> ()

local function attach(c: WindowCx, sess: Session)
	startChain(sess)
	local gen = sess.generation
	call(sess, "attach_view", { scene_revision = 0, frame_id = sess.focus, holder = holderOf() }, QUICK_FETCH_MS, function(reply, code, remote, c1, request_id)
		if reply == nil then
			if remote == "RENDER_FRAME_MISSING" and tern.now() - sess.started < READY_TIMEOUT_MS then
				-- The first render is still running; not a failure.
				finish(sess, READY_POLL_MS * 2)
			elseif remote == "VIEW_TAKEN" then
				local since = sess.taken_since or tern.now()
				sess.taken_since = since
				if tern.now() - since > LEASE_WAIT_MS then
					forfeit(c1, sess)
				else
					finish(sess, RETRY_MS)
				end
			elseif sess.claim and sess.adopted and (code == "TRANSPORT" or code == "OWNER_ABSENT") then
				-- An owner a reload left behind that no longer answers ended while nobody watched (a record it did not live
				-- to take down): nothing to tell. Not asked to end either: it may be another window's, merely slow.
				sess.record = nil
				giveUp(sess)
			else
				fail(c1, sess, code or "BAD_REPLY", remote)
			end
			return
		end
		if not editor_launch.attached(reply, request_id, gen) then
			announce(c1, sess, "BAD_REPLY")
			finish(sess, RETRY_MS)
			return
		end
		sess.attached = gen
		sess.taken_since = nil
		sess.reset_seen = if typeof(reply.reset) == "number" then reply.reset else nil
		local function ready(c2: WindowCx)
			if typeof(reply.activity) == "table" and reply.activity.phase == "recovering" and not sess.recovery_asked then
				offerRecovery(c2, sess)
			end
			showActivity(c2, sess, reply.activity, function(c3)
				build(c3, sess)
			end)
		end
		if sess.claim then
			-- The lease is won: only now does the session record itself, open a board or clear the old one.
			sess.claim = false
			remember(sess)
			c1:toast("info", "Pencil editor reconnected", util.basename(sess.path))
			if sess.board ~= 0 and c1.session:pane(sess.board) == nil then
				-- The user closed the board while this window waited for the lease: the next step finds that out and asks
				-- what to do with the document, as it would for any closed board.
				finish(sess, 0)
				return
			end
			if sess.board == 0 then
				reopenBoard(c1, sess)
				return
			end
			local old = sess.sweep_ids
			if old ~= nil then
				local ours: { [string]: boolean } = {}
				for _, id in old do
					ours[id] = true
				end
				after(sess, "sweep_read", 0, function(c2: WindowCx)
					sweepOld(c2, sess, ours, ready, 1, 1)
				end)
				return
			end
		end
		ready(c1)
	end)
end

local function idle(c: WindowCx, sess: Session)
	startChain(sess)
	local state = boardState(c, sess)
	local picked = pickedTarget(sess, if state then state.selection else nil)
	sweepRevived(c, sess, state, function(c0: WindowCx)
		watchGestures(c0, sess, function(c1: WindowCx)
			watchText(c1, sess, state, function(c2: WindowCx)
				watchLevel(c2, sess, state, function(c3: WindowCx)
					if picked then
						sess.quiet = 0
						sendSelection(c3, sess, picked, function(c4: WindowCx)
							sess.selected = picked
							probe(c4, sess)
						end)
					else
						probe(c3, sess)
					end
				end)
			end)
		end)
	end)
end

-- The shapes a board kept from before a reload that this session drew, by the ids it recorded (the new VM knows none
-- of them): read in one tick and removed in the next, until none is left. Nothing else on the board is touched, however
-- it looks. A board that holds none of them at the first look is not this session's: it gets a board of its own. A
-- board that cannot be read is read again a few times, and then left as it is with the ids kept for the next load. The
-- ids stay on the session until the sweep has finished.
local SWEEP_ROUNDS = 20
local SWEEP_READ_TRIES = 3

sweepOld = function(c: WindowCx, sess: Session, ours: { [string]: boolean }, done: (c: WindowCx) -> (), round: number, tries: number)
	local ids: { string } = {}
	local read, state = pcall(function(): WhiteboardState
		return c.whiteboard:read(sess.board, { area = WHOLE_PAGE, max_shapes = SWEEP_READ })
	end)
	if not read then
		if tries < SWEEP_READ_TRIES then
			after(sess, "sweep_read", RETRY_MS, function(c1: WindowCx)
				sweepOld(c1, sess, ours, done, round, tries + 1)
			end)
		else
			done(c)
		end
		return
	end
	for _, shape in state.shapes do
		if ours[shape.id] then
			table.insert(ids, shape.id)
		end
	end
	if #ids == 0 and round == 1 then
		sess.sweep_ids = nil
		sess.board = 0
		remember(sess)
		-- A session being forgotten (see `giveUp`) has no use for a board of its own.
		if sess.closing then
			done(c)
		else
			reopenBoard(c, sess)
		end
		return
	end
	if #ids == 0 then
		sess.sweep_ids = nil
		done(c)
		return
	end
	if round >= SWEEP_ROUNDS then
		sess.sweep_ids = ids
		done(c)
		return
	end
	retirePrivate(c, sess, ids, function(_c1)
		after(sess, "sweep_read", 0, function(c2: WindowCx)
			sweepOld(c2, sess, ours, done, round + 1, 1)
		end)
	end)
end

-- The reason an editor that did not start is told, and the end of that session: the program is gone and nothing is left to
-- ask, so it is forgotten (its launch file, if nobody read it, goes), then told (a toast is a native call that shares its
-- tick with no other) and the reason removed in the last.
local function endStart(c: WindowCx, sess: Session, code: string?, status: number)
	closeOwner(c, sess)
	tick("owner_exited_notice", c, function(c3: WindowCx)
		local title, detail = projection.start_failure(code, status)
		sess.note = code or "OWNER_EXITED"
		c3:toast("error", title, detail)
		writeStatus(sess)
		tick("owner_failure_cleanup", c3, function(_c4: WindowCx)
			pcall(tern.fs.remove, editor_launch.failure_path(sess.manifest))
		end)
	end)
end

-- A session picked up after a reload whose owner is gone ended while nobody watched: forgotten without a word, but first
-- the shapes it drew are taken off the board, which is still there (the entry that names them goes with it).
giveUp = function(sess: Session)
	after(sess, "owner_forgotten", 0, function(c: WindowCx)
		local old = sess.sweep_ids
		if old == nil or sess.board == 0 or c.session:pane(sess.board) == nil then
			closeOwner(c, sess)
			return
		end
		sess.closing = true
		local ours: { [string]: boolean } = {}
		for _, id in old do
			ours[id] = true
		end
		sweepOld(c, sess, ours, function(c1: WindowCx)
			closeOwner(c1, sess)
		end, 1, 1)
	end)
end

-- The editor's program ended before it published a session (a lock that is not its to take, a file that changed, Node
-- missing): nothing will ever answer, so waiting for the timeout only keeps the user at an empty board. Reads the
-- reason the program left for this launch, in a tick of its own. A document that is already open in an owner this
-- window does not know about is not a failure: that owner is followed instead (see `waitForOwner`).
local function ownerExited(sess: Session, status: number)
	after(sess, "owner_failure_read", 0, function(_c1: WindowCx)
		local code = editor_launch.read_failure(sess.manifest)
		after(sess, "owner_exited", 0, function(c2: WindowCx)
			if code == "ALREADY_OPEN" and not sess.reconnect then
				-- Nothing it does reaches that owner until it holds the lease: another window may be editing it (see `attach`).
				sess.reconnect, sess.claim, sess.exited, sess.started = true, true, nil, tern.now()
				remember(sess)
				tick("owner_failure_cleanup", c2, function(c3: WindowCx)
					pcall(tern.fs.remove, editor_launch.failure_path(sess.manifest))
					schedule(sess, 0)
				end)
				return
			end
			endStart(c2, sess, code, status)
		end)
	end)
end

-- Looks for the owner's record: the list of the session records in this tick, each file's read in a tick of its own
-- (every one is a native call that can be slow), and what a give-up says in another. The record is the one this launch's
-- id names. Two kinds of session look for another: one picked up after a reload gives up quietly once its launch is old
-- enough that its owner would have published (the owner ended while nobody watched), and one whose own owner stopped with
-- the document already open follows the owner that has it, by the document's path, or says the file is open.
local function waitForOwner(c: WindowCx, sess: Session)
	if sess.exited ~= nil then
		ownerExited(sess, sess.exited)
		return
	end
	local names = editor_launch.record_names(sess.data_dir)
	local function look(c1: WindowCx, index: number)
		local name = names[index]
		if name ~= nil then
			local record = if sess.reconnect
				then editor_launch.read_record_of(sess.data_dir, name, sess.path)
				else editor_launch.read_record(sess.data_dir, name, sess.launch_id)
			if record then
				sess.record = record
				sess.proj = projection.begin(record.session_id, sess.board, sess.generation)
				sess.frames_state = projection.begin(record.session_id, sess.board, 0)
				sess.halos = projection.begin(record.session_id, sess.board, sess.generation)
				schedule(sess, 0)
				return
			end
			after(sess, "owner_read", 0, function(c2: WindowCx)
				look(c2, index + 1)
			end)
		elseif sess.reconnect then
			if sess.adopted then
				giveUp(sess)
			elseif tern.now() - sess.started < (if sess.restarted then READY_TIMEOUT_MS else RECONNECT_WAIT_MS) then
				-- Another window's owner that is still starting holds the lock before it publishes its record: look a few
				-- seconds more. (One that is closing has taken its record down for good: it ends here too, after them.)
				schedule(sess, READY_POLL_MS)
			else
				-- Nobody serves the document that the lock says is open: the old message, as before.
				after(sess, "owner_unfollowed", 0, function(c2: WindowCx)
					endStart(c2, sess, "ALREADY_OPEN", 1)
				end)
			end
		elseif tern.now() - sess.started > READY_TIMEOUT_MS then
			-- The list or the last read may have been this tick's native call: what follows waits for the next.
			if sess.adopted then
				giveUp(sess)
				return
			end
			after(sess, "owner_timeout", 0, function(c2: WindowCx)
				closeOwner(c2, sess)
				tick("owner_timeout_notice", c2, function(c3: WindowCx)
					announce(c3, sess, "OWNER_TIMEOUT")
					writeStatus(sess)
				end)
			end)
		else
			schedule(sess, READY_POLL_MS)
		end
	end
	if names[1] == nil then
		look(c, 1)
	else
		-- The list was this tick's native call: the first read waits for the next.
		after(sess, "owner_read", 0, function(c1: WindowCx)
			look(c1, 1)
		end)
	end
end

local function step(c: WindowCx, sess: Session)
	if not guard(c, sess) then
		return
	end
	if sess.opening_board then
		schedule(sess, POLL_MS)
		return
	end
	if sess.record == nil then
		waitForOwner(c, sess)
		return
	end
	if sess.board == 0 and not sess.claim then
		if sess.busy then
			schedule(sess, POLL_MS)
		else
			startChain(sess)
			-- The window's own read: it keeps the owner, which ends itself when no window asks (an agent's reads do not count).
			call(sess, "poll_document", {}, QUICK_FETCH_MS, function(reply, code, remote, c1, _request_id)
				if reply == nil then
					fail(c1, sess, code or "BAD_REPLY", remote)
				elseif typeof(reply.activity) == "table" and reply.activity.state == "disconnected" then
					ownerGone(c1, sess)
				else
					finish(sess, RETRY_MS)
				end
			end)
		end
		return
	end
	local action = projection.busy_action(sess.busy, sess.holding, tern.now() - sess.busy_since)
	if action == "bump" then
		bump(c, sess, 0)
		return
	elseif action == "peek" then
		-- The owner is holding its answer for a change: a click on the board is one, and the owner cannot see it. Say
		-- so (select_node wakes the hold); the held answer then arrives with the selection already known.
		local state = boardState(c, sess)
		local picked = pickedTarget(sess, if state then state.selection else nil)
		if picked then
			sess.quiet = 0
			-- The read above was this tick's native call: the request waits for the next. No `sess.selected` here:
			-- `sendSelection` sets it, and a held answer that lands first and takes it back is corrected by the next
			-- drift check instead of being masked.
			after(sess, "peek_select", 0, function(c1: WindowCx)
				sendSelection(c1, sess, picked, function(_c2: WindowCx) end)
			end)
		end
		-- A gesture is as much a change as a click, and the owner cannot see it either; so is the board's own Undo.
		sweepRevived(c, sess, state, function(c0: WindowCx)
			watchGestures(c0, sess, function(c1: WindowCx)
				watchText(c1, sess, state, function(c2: WindowCx)
					watchLevel(c2, sess, state, function(_c3: WindowCx) end)
				end)
			end)
		end)
		schedule(sess, POLL_MS)
		return
	elseif action == "wait" then
		schedule(sess, POLL_MS)
		return
	end
	if sess.attached ~= sess.generation then
		attach(c, sess)
	else
		idle(c, sess)
	end
end

return {
	step = step,
}
