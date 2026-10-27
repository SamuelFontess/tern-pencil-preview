--!strict
-- When both scheduling hooks are dead: a late hook that still runs is never dead, and a command or route with dead hooks
-- says so and schedules nothing.
local hooks = require("../lib/editor_hooks")

type T = {
	eq: (actual: any, expected: any, msg: string?) -> (),
	match: (s: string, pattern: string, msg: string?) -> (),
	truthy: (v: any, msg: string?) -> (),
	raises: (fn: () -> (), pattern: string?, msg: string?) -> (),
}

local tests: { [string]: (t: T) -> () } = {}

local LATE = hooks.GRACE_MS + 1

-- A hook that finds both overdue says nothing the first time (see `dead`) and confirms on the next look.
local function look(s: any, now: number): boolean
	hooks.dead(s, now)
	return hooks.dead(s, now)
end

local function toasts(): ({ { kind: string, title: string, detail: string? } }, WindowCx)
	local seen: { { kind: string, title: string, detail: string? } } = {}
	local cx = {
		toast = function(_self: any, kind: string, title: string, detail: string?)
			table.insert(seen, { kind = kind, title = title, detail = detail })
		end,
	}
	return seen, cx :: any
end

tests["nothing armed is not dead"] = function(t: T)
	t.eq(hooks.dead(hooks.new(), 1e9), false)
end

tests["both hooks silent past the grace are dead"] = function(t: T)
	local s = hooks.new()
	hooks.arm(s, "timer", 0)
	hooks.arm(s, "await", 250)
	t.eq(look(s, hooks.GRACE_MS), false, "still within the grace")
	t.eq(look(s, 250 + LATE), true)
end

tests["a slow hook that runs its callback is never dead"] = function(t: T)
	local s = hooks.new()
	hooks.arm(s, "timer", 0)
	hooks.arm(s, "await", 0)
	-- Both ran, a long time late.
	hooks.ran(s, "timer", 60000)
	hooks.ran(s, "await", 60001)
	t.eq(hooks.dead(s, 60002), false)
	t.eq(hooks.dead(s, 1e9), false, "nothing waits any more")
end

tests["one live hook is not dead"] = function(t: T)
	local s = hooks.new()
	hooks.arm(s, "timer", 0)
	hooks.arm(s, "await", 0)
	hooks.ran(s, "await", 1000)
	t.eq(look(s, 1e6), false, "the timer alone is dead: the watch carries on from the await hook")
end

tests["a callback that runs does not clear one due later"] = function(t: T)
	local s = hooks.new()
	hooks.arm(s, "timer", 1000)
	hooks.ran(s, "timer", 500)
	t.eq(s.waiting.timer, 1000)
end

tests["hooks that die after working are seen on the next callbacks they never run"] = function(t: T)
	local s = hooks.new()
	hooks.arm(s, "timer", 0)
	hooks.arm(s, "await", 0)
	hooks.ran(s, "timer", 5)
	hooks.ran(s, "await", 5)
	hooks.arm(s, "timer", 100)
	hooks.arm(s, "await", 100)
	t.eq(look(s, 100 + LATE), true)
end

tests["a command with dead hooks says so at once and refuses"] = function(t: T)
	local s = hooks.new()
	hooks.arm(s, "timer", 0)
	hooks.arm(s, "await", 0)
	local seen, cx = toasts()
	t.eq(hooks.refuse(s, LATE, cx), false, "the first look only suspects")
	t.eq(#seen, 0)
	t.eq(hooks.refuse(s, LATE, cx), true)
	t.eq(#seen, 1)
	t.eq(seen[1].kind, "error")
	t.match(seen[1].detail or "", "Reload plugins")
	t.eq(hooks.refuse(s, LATE, cx), true, "every run says it again")
	t.eq(#seen, 2)
end

tests["a command with live hooks proceeds silently"] = function(t: T)
	local s = hooks.new()
	hooks.arm(s, "timer", 0)
	hooks.arm(s, "await", 0)
	local seen, cx = toasts()
	t.eq(hooks.refuse(s, 3000, cx), false, "late, not dead")
	t.eq(#seen, 0)
end

tests["an open session whose work died is told once"] = function(t: T)
	local s = hooks.new()
	hooks.arm(s, "timer", 0)
	hooks.arm(s, "await", 0)
	local seen, cx = toasts()
	hooks.warnStalled(s, LATE, false, cx)
	hooks.warnStalled(s, LATE, false, cx)
	t.eq(#seen, 0, "no session open, nothing to say")
	hooks.warnStalled(s, LATE, true, cx)
	t.eq(#seen, 0, "the first look only suspects")
	hooks.warnStalled(s, LATE + 5, true, cx)
	hooks.warnStalled(s, LATE + 6, true, cx)
	t.eq(#seen, 1)
	t.eq(seen[1].kind, "error")
end

tests["an open session with live hooks is not told"] = function(t: T)
	local s = hooks.new()
	local seen, cx = toasts()
	hooks.warnStalled(s, 1e9, true, cx)
	t.eq(#seen, 0)
end

tests["a window that stops rendering is not taken for dead hooks"] = function(t: T)
	local s = hooks.new()
	hooks.arm(s, "timer", 0)
	hooks.arm(s, "await", 0)
	local seen, cx = toasts()
	-- A command arrives first after the pause: both callbacks are overdue and nothing has run yet.
	t.eq(hooks.refuse(s, LATE, cx), false)
	-- The render runs the queued callbacks.
	hooks.begin(s, "timer", LATE + 1)
	hooks.finish(s, "timer")
	hooks.begin(s, "await", LATE + 1)
	hooks.finish(s, "await")
	t.eq(hooks.refuse(s, LATE + 2, cx), false)
	t.eq(hooks.refuse(s, LATE + 3, cx), false)
	t.eq(#seen, 0)
end

tests["new overdue callbacks after a quiet look are a new suspicion"] = function(t: T)
	local s = hooks.new()
	hooks.arm(s, "timer", 0)
	hooks.arm(s, "await", 0)
	t.eq(hooks.dead(s, LATE), false)
	hooks.begin(s, "timer", LATE)
	hooks.finish(s, "timer")
	hooks.begin(s, "await", LATE)
	hooks.finish(s, "await")
	hooks.arm(s, "timer", LATE + 10)
	hooks.arm(s, "await", LATE + 10)
	t.eq(hooks.dead(s, LATE + 10 + LATE), false, "first look at the new records")
	t.eq(hooks.dead(s, LATE + 10 + LATE), true)
end

tests["callbacks of both hooks that never finished are dead at once"] = function(t: T)
	local s = hooks.new()
	hooks.begin(s, "timer", 0)
	hooks.begin(s, "await", 0)
	local seen, cx = toasts()
	t.eq(hooks.refuse(s, 1, cx), true, "no grace, no second look")
	t.eq(#seen, 1)
end

tests["a plain error on one hook alone is not dead, and the next success clears it"] = function(t: T)
	local s = hooks.new()
	hooks.begin(s, "timer", 0)
	t.eq(hooks.dead(s, 1), false)
	hooks.begin(s, "await", 2)
	hooks.finish(s, "await")
	t.eq(hooks.dead(s, 3), false)
	hooks.begin(s, "timer", 4)
	hooks.finish(s, "timer")
	hooks.begin(s, "await", 5)
	t.eq(hooks.dead(s, 6), false, "the timer finished again: only the await one is open")
end

-- The wrappers over a fake Tern: a clock and the two hooks, each callback held until the test runs it.
local function fakeTern()
	local stub = require("./stub")
	local fake: any = stub.install({ os = "linux", data = "/data", files = {} })
	local world = { now = 0, timers = {} :: { any }, sleeps = {} :: { any } }
	fake.now = function(): number
		return world.now
	end
	fake.timer = function(_ms: number, fn: any)
		table.insert(world.timers, fn)
	end
	fake.sleep = function(_ms: number): any
		return {
			next = function(_self: any, fn: any)
				table.insert(world.sleeps, fn)
			end,
		}
	end
	stub.attach(hooks)
	hooks.live = hooks.new()
	return world
end

tests["callbacks that ran, however late, leave the hooks alive"] = function(t: T)
	local world = fakeTern()
	local ran = 0
	hooks.timer(0, function()
		ran += 1
	end)
	hooks.sleep(250, function()
		ran += 1
	end)
	world.now = 60000
	world.timers[1](nil)
	world.sleeps[1](nil, nil, nil)
	t.eq(ran, 2)
	world.now = 1e7
	t.eq(look(hooks.live, world.now), false)
end

tests["callbacks that never ran leave the hooks dead"] = function(t: T)
	local world = fakeTern()
	hooks.timer(0, function() end)
	hooks.sleep(250, function() end)
	world.now = 250 + LATE
	t.eq(look(hooks.live, world.now), true)
end

tests["a wrapped callback is noted as run, on its own hook, before it starts"] = function(t: T)
	local world = fakeTern()
	local inside: { timer: number?, await: number?, busy_timer: boolean?, busy_await: boolean? } = {}
	hooks.timer(0, function()
		inside.timer = hooks.live.waiting.timer
		inside.busy_timer = hooks.live.busy.timer
	end)
	hooks.sleep(0, function()
		inside.await = hooks.live.waiting.await
		inside.busy_await = hooks.live.busy.await
	end)
	world.now = 5
	world.timers[1](nil)
	t.eq(hooks.live.waiting.timer, nil)
	t.eq(hooks.live.waiting.await, 0, "the timer callback did not note the await hook")
	world.sleeps[1](nil, nil, nil)
	t.eq(hooks.live.waiting.await, nil)
	t.eq(inside.timer, nil)
	t.eq(inside.await, nil)
	t.eq(inside.busy_timer, true, "busy while it runs")
	t.eq(inside.busy_await, true)
	t.eq(hooks.live.busy.timer, false, "and not after")
	t.eq(hooks.live.busy.await, false)
end

tests["a wrapped callback that is killed leaves its hook busy, both killed is dead"] = function(t: T)
	local world = fakeTern()
	hooks.timer(0, function()
		error("killed")
	end)
	hooks.sleep(0, function()
		error("killed")
	end)
	pcall(world.timers[1], nil)
	t.eq(hooks.dead(hooks.live, 1), false, "one kind alone")
	pcall(world.sleeps[1], nil, nil, nil)
	t.eq(hooks.dead(hooks.live, 1), true)
end

return tests
