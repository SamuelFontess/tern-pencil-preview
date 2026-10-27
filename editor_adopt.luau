--!strict
-- What a plugin reload leaves behind: the watch over the timer hook, and picking up the editors the old VM started.
local Hooks = require("./lib/editor_hooks")
local editor_launch = require("./lib/editor_launch")
local registry = require("./lib/editor_registry")
local util = require("./lib/util")
local Core = require("./editor_core")
local Closing = require("./editor_closing")
local Lifecycle = require("./editor_lifecycle")
local Start = require("./editor_start")
local armRegistry, deferFlush, later = Core.armRegistry, Core.deferFlush, Core.later
local live, sessions = Core.live, Core.sessions
local READY_TIMEOUT_MS, timed = Core.READY_TIMEOUT_MS, Core.timed
local bump, schedule = Lifecycle.bump, Lifecycle.schedule
local newSession = Start.newSession
local finishBoard, reopenBoard = Closing.finishBoard, Closing.reopenBoard

-- The timer hook can stop with no word (one callback over its 50 ms budget disables every timer of the plugin until
-- the next reload). A canary timer beats every second; the watch, on the await hook, notices when it has not beaten
-- for a while (and again one pass later, so a long pause of the whole window is not mistaken for it), says so once and
-- restarts every session from the await hook, which `later` then also uses for everything it schedules.
local WATCH_MS = 1000
local STALL_MS = 4000
local watch: { running: boolean, beat: number, suspect: number? } = { running = false, beat = 0, suspect = nil }

local adoption: {
	started: boolean,
	done: boolean,
	waiting: { (c: WindowCx) -> () },
	-- Where the pick-up stands, so a timer hook that stops in the middle of it can be carried on from the await hook.
	index: number,
	kick: ((c: WindowCx) -> ())?,
} = { started = false, done = false, waiting = {}, index = 1, kick = nil }

local function resume(c: WindowCx)
	-- The ticks that were queued on the dead timer hook never ran, and each of these flags is only cleared by its tick:
	-- left set, nothing would ever be written again.
	live.flush_queued, live.registry_queued = false, false
	if next(live.registry_ops) ~= nil then
		armRegistry()
	end
	deferFlush()
	c:toast("error", "The editor's timers stopped", "Carrying on without them; reload plugins to restore them")
	local kick = adoption.kick
	if kick ~= nil and adoption.started and not adoption.done then
		kick(c)
	end
	-- An open that has no session yet is not one of those: its ticks were queued on the dead hook, so it begins again (from
	-- the await hook now, see `later`). A launch file the cut run wrote is left for its owner, if one ran.
	for _, op in live.opening do
		op.restart(c)
	end
	for _, sess in sessions do
		if sess.alive and not sess.retiring then
			local ask = sess.board_ask
			if sess.opening_board and ask == nil then
				-- The tick that was to ask for the board died with the timers: nothing is coming, so it asks again.
				sess.opening_board = false
				reopenBoard(c, sess)
			elseif sess.opening_board and ask ~= nil and ask.answered then
				-- The board is open and the tick that was to install it died with the timers.
				finishBoard(sess)
			elseif sess.opening_board then
				-- The board's own callback runs on the await hook and is still coming.
				schedule(sess, 0)
			elseif sess.record ~= nil and sess.board ~= 0 then
				bump(c, sess, 0)
			elseif not sess.closing then
				schedule(sess, 0)
			end
		end
	end
end

-- The timers are gone: said once, and everything that waited on them carries on from the await hook.
local function cut(c: WindowCx)
	if live.timers_dead then
		return
	end
	live.timers_dead = true
	resume(c)
end

-- A pass of the watch without a window context cannot say anything or restart anything: the stop is only recorded
-- once there is one to do both with.
local function look(c: WindowCx?)
	if live.timers_dead or tern.now() - watch.beat <= STALL_MS then
		watch.suspect = nil
	elseif watch.suspect ~= watch.beat then
		watch.suspect = watch.beat
	elseif c ~= nil then
		cut(c)
	end
end

local function canary()
	Hooks.timer(WATCH_MS, function(_c: WindowCx?)
		canary()
		watch.beat = tern.now()
	end)
end

local function watchLoop()
	Hooks.sleep(WATCH_MS, timed("watch", function(c: WindowCx?)
		watchLoop()
		look(c)
	end))
end

local function ensureWatch()
	if watch.running then
		return
	end
	watch.running, watch.beat = true, tern.now()
	watchLoop()
	canary()
end

-- Picks up what a plugin reload left behind (see lib/editor_registry): the new VM has no sessions, but each editor's owner
-- still runs (a process outlives the reload) and usually its board still shows. Without this the owner would sit with its
-- file locked, and opening the file again would meet ALREADY_OPEN. The owner itself is found by the session record it
-- published under the launch's id (see `waitForOwner`), and is alive if it answers: an owner that is gone is told once
-- by the first request that fails. A launch too old to still be starting that has no record is an owner that ended while
-- nobody watched, and is forgotten without a word. The session claims the owner's lease first (see `attach`); until it
-- has it, it records, draws, opens and sweeps nothing.
local function adoptEntry(c: WindowCx, entry: registry.Entry)
	if sessions[entry.launch_id] then
		return
	end
	local sess = newSession(entry.path, entry.data_dir, entry.launch_id, entry.manifest, entry.scope)
	sess.claim, sess.adopted, sess.reconnect = true, true, entry.follow
	local _, now = pcall(os.time)
	sess.started = tern.now() - editor_launch.launch_age_ms(entry.manifest, if typeof(now) == "number" then now else 0, READY_TIMEOUT_MS)
	-- The board is the session's only if the session drew on it: the shapes it recorded must be there (checked at the
	-- first read of the board); a record without any never saw its board drawn on.
	local board = if entry.board ~= 0 and #entry.shapes > 0 then c.session:pane(entry.board) else nil
	if board ~= nil and board.kind == "canvas" then
		sess.board, sess.sweep_ids = entry.board, entry.shapes
	end
	sessions[entry.launch_id] = sess
	schedule(sess, 0)
end

-- Nothing that starts or reveals an editor runs before the sessions of an earlier VM are back, or it could start a
-- second editor for a file that already has one. One entry per tick; with nothing to pick up, no tick at all.
local function startAdoption(c: WindowCx)
	if adoption.started then
		return
	end
	adoption.started = true
	ensureWatch()
	local pending: { registry.Entry } = {}
	for _, entry in registry.mine(registry.scope(c)) do
		if not sessions[entry.launch_id] then
			table.insert(pending, entry)
		end
	end
	local function release(c1: WindowCx, inline: boolean)
		adoption.done = true
		local waiting = adoption.waiting
		adoption.waiting = {}
		for _, fn in waiting do
			if inline then
				fn(c1)
			else
				later(0, function(fresh: WindowCx?)
					fn((fresh or c1) :: WindowCx)
				end)
			end
		end
	end
	if #pending == 0 then
		release(c, true)
		return
	end
	local function pickUp(c1: WindowCx, index: number)
		local entry = pending[index]
		if entry == nil then
			release(c1, false)
			return
		end
		adoption.index = index
		local ok = xpcall(function()
			adoptEntry(c1, entry)
		end, function(e: any): string
			tern.log.error("editor session could not be picked up: " .. (tostring(e):match("^[^\n]-:%d+: ([%w_ %.]*)") or "error"))
			return ""
		end)
		if not ok then
			c1:toast("error", "A Pencil editor could not be reconnected", util.basename(entry.path))
		end
		later(0, timed("adopt", function(fresh: WindowCx?)
			pickUp((fresh or c1) :: WindowCx, index + 1)
		end))
	end
	adoption.kick = function(c1: WindowCx)
		later(0, timed("adopt", function(fresh: WindowCx?)
			pickUp((fresh or c1) :: WindowCx, adoption.index)
		end))
	end
	later(0, timed("adopt", function(fresh: WindowCx?)
		pickUp((fresh or c) :: WindowCx, 1)
	end))
end

local function whenAdopted(c: WindowCx, fn: (c: WindowCx) -> ())
	ensureWatch()
	if adoption.done then
		fn(c)
		return
	end
	table.insert(adoption.waiting, fn)
	startAdoption(c)
end

-- Tests only: what a plugin reload does to the watch and the pick-up, which is to forget where they stood.
local function reset()
	watch.running, watch.beat, watch.suspect = false, 0, nil
	adoption.started, adoption.done, adoption.waiting, adoption.index, adoption.kick = false, false, {}, 1, nil
end

return {
	cut = cut,
	reset = reset,
	startAdoption = startAdoption,
	whenAdopted = whenAdopted,
}
