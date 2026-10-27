--!strict
-- Tells when Tern has disabled both scheduling hooks of this VM. A window callback that runs over its 50 ms budget turns its
-- hook off until the next reload: `tern.timer` is one hook, `Awaitable:next` (`tern.sleep`, fetch, process) another, and a
-- machine busy enough to kill a tick of 5 ms can kill both. Everything the plugin schedules then never runs and nothing says
-- why. Every callback the plugin arms is noted here with the moment it was due, and noted again when it runs; a hook whose
-- oldest due callback is still waiting well past its due time is dead, and both dead means the commands and the route must
-- tell the user to reload plugins instead of scheduling more work that will not run. A callback that is late but runs is
-- never counted: running clears the wait, so a slow machine only ever shows a dead hook while the hook really is silent.
local M = {}

export type Kind = "timer" | "await"

export type State = {
	-- The due time of the first callback armed on the hook that has not run since (never a later one: a wait only starts
	-- over once something runs).
	waiting: { timer: number?, await: number? },
	-- A callback of the kind began and has not finished.
	busy: { timer: boolean?, await: boolean? },
	-- The waits both hooks showed at the last look that found them overdue.
	suspect: { timer: number, await: number }?,
	-- The stalled-session notice was given (once per VM).
	noticed: boolean,
}

-- How long past its due time a callback may wait before its hook is called dead. A busy machine delays ticks by seconds
-- (an 11 s daemon start was measured); a hook that is only slow runs its callback long before this.
M.GRACE_MS = 10000

function M.new(): State
	return { waiting = {}, busy = {}, suspect = nil, noticed = false }
end

-- The VM's own state, shared by every module that schedules: `require` hands them all this table.
M.live = M.new()

-- A callback was handed to `kind`, to run at `due` (the clock of `tern.now`).
function M.arm(s: State, kind: Kind, due: number)
	local current = s.waiting[kind]
	if current == nil then
		s.waiting[kind] = due
	end
end

-- A callback of `kind` ran at `now`: every callback due by then has had its turn.
function M.ran(s: State, kind: Kind, now: number)
	local current = s.waiting[kind]
	if current ~= nil and current <= now then
		s.waiting[kind] = nil
	end
end

local function silent(s: State, kind: Kind, now: number): boolean
	local due = s.waiting[kind]
	return due ~= nil and now - due > M.GRACE_MS
end

-- A callback of `kind` starts (`ran` first, so the wait is cleared even if it is killed) and, when it returns, finishes.
-- One that never finishes was aborted: killed over its budget, or it raised.
function M.begin(s: State, kind: Kind, now: number)
	M.ran(s, kind, now)
	s.busy[kind] = true
end

function M.finish(s: State, kind: Kind)
	s.busy[kind] = false
end

-- A look for a hook that is alive and running (a command, the route): are both scheduling hooks dead?
--   - Callbacks of both kinds begun and never finished: Tern aborted them, so dead at once. (One kind alone may be a plain
--     error, which leaves the hook alone; the next callback that finishes clears it.)
--   - Both hooks have a callback that never ran past the grace: dead only if the same callbacks were already overdue at an
--     earlier look. A window that stops rendering holds its callbacks queued, and the first hook to run after the pause
--     (this one) comes before they do; the render in between clears them, so the second look finds nothing.
-- With one hook alive the plugin's own watch (editor_adopt) carries on from it.
function M.dead(s: State, now: number): boolean
	if s.busy.timer and s.busy.await then
		return true
	end
	local timer, await = s.waiting.timer, s.waiting.await
	if not (silent(s, "timer", now) and silent(s, "await", now)) then
		s.suspect = nil
		return false
	end
	local seen = s.suspect
	if seen ~= nil and seen.timer == timer and seen.await == await then
		return true
	end
	s.suspect = { timer = timer :: number, await = await :: number }
	return false
end

local DEAD_TITLE = "The Pencil editor cannot run"
local DEAD_DETAIL = "Tern turned off this plugin's timers because the machine was too busy. Reload plugins from the command palette, then open it again"

-- For a command or a route: when the hooks are dead, says so on the spot (this hook is alive, it is running) and returns
-- true so the caller schedules nothing.
function M.refuse(s: State, now: number, cx: WindowCx): boolean
	if not M.dead(s, now) then
		return false
	end
	pcall(function()
		cx:toast("error", DEAD_TITLE, DEAD_DETAIL)
	end)
	return true
end

-- For a hook that does not open anything (another command): an editor that is open and whose work died is said once per
-- VM, on the first hook that finds it.
function M.warnStalled(s: State, now: number, session_open: boolean, cx: WindowCx)
	if s.noticed or not session_open or not M.dead(s, now) then
		return
	end
	s.noticed = true
	pcall(function()
		cx:toast("error", "The open Pencil editor stopped updating", DEAD_DETAIL)
	end)
end

-- The two hooks as the plugin schedules on them, each callback noted in `live` (see `begin`/`finish`).
function M.timer(ms: number, fn: (fresh: WindowCx?) -> ())
	M.arm(M.live, "timer", tern.now() + ms)
	tern.timer(ms, function(fresh: WindowCx?)
		M.begin(M.live, "timer", tern.now())
		fn(fresh)
		M.finish(M.live, "timer")
	end)
end

function M.sleep(ms: number, fn: (fresh: WindowCx?) -> ())
	M.arm(M.live, "await", tern.now() + ms)
	tern.sleep(ms):next(function(_result: nil, _err: string?, fresh: WindowCx?)
		M.begin(M.live, "await", tern.now())
		fn(fresh)
		M.finish(M.live, "await")
	end)
end

-- `refuse` and `warnStalled` on this VM's own state and clock.
function M.refuseNow(cx: WindowCx): boolean
	return M.refuse(M.live, tern.now(), cx)
end

-- Set by editor_board once loaded: whether a session of this window is open. Before that none is.
M.session_open = function(): boolean
	return false
end

-- Set by editor_board once loaded: the load chain found the timer hook gone, so the editor carries on from the await hook
-- from its first tick (see editor_adopt). Before that no editor runs, and there is nothing to carry on.
M.timers_cut = function(_cx: WindowCx) end

function M.warnStalledNow(cx: WindowCx)
	M.warnStalled(M.live, tern.now(), M.session_open(), cx)
end

return M

