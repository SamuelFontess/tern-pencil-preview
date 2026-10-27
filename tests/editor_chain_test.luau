--!strict
-- The editor's load chain on a virtual clock with both hooks under the test's control. A tick that Tern kills for going
-- over its budget is an error that leaves the callback half run, and the hook that ran it is then dead for good (the other
-- hook is not). An error that is not a kill leaves its hook alone (`soft_awaits`). Nothing here looks at source text.
local chain = require("../lib/editor_chain")

type T = {
	eq: (actual: any, expected: any, msg: string?) -> (),
	match: (s: string, pattern: string, msg: string?) -> (),
	truthy: (v: any, msg: string?) -> (),
	raises: (fn: () -> (), pattern: string?, msg: string?) -> (),
}

local tests: { [string]: (t: T) -> () } = {}

type Cx = { id: number }

type World = {
	now: number,
	timer_dead: boolean,
	-- The timer hook is slow (the machine is busy): what it has queued waits until this is cleared.
	hold_timers: boolean,
	await_dead: boolean,
	-- An await callback that raises is an ordinary error, not a budget kill: the hook lives on.
	soft_awaits: boolean,
	timers: { (fresh: WindowCx?) -> () },
	laters: { { due: number, fn: (fresh: WindowCx?) -> () } },
	cx_seq: number,
	without_cx: boolean,
	sched: chain.Scheduler,
	-- Every callback that raised (a killed tick), in order.
	killed: number,
}

local function world(): World
	local w: World = { now = 0, timer_dead = false, hold_timers = false, await_dead = false, soft_awaits = false, timers = {}, laters = {}, cx_seq = 0, without_cx = false, killed = 0, sched = nil :: any }
	w.sched = {
		timer = function(fn)
			table.insert(w.timers, fn)
		end,
		later = function(ms, fn)
			table.insert(w.laters, { due = w.now + ms, fn = fn })
		end,
		now = function(): number
			return w.now
		end,
	}
	return w
end

local function freshCx(w: World): WindowCx?
	if w.without_cx then
		return nil
	end
	w.cx_seq += 1
	return ({ id = w.cx_seq } :: any) :: WindowCx
end

-- Runs every timer queued (and those queued meanwhile). A callback that raises is a killed tick: the hook is dead.
local function fireTimers(w: World)
	while #w.timers > 0 and not w.timer_dead and not w.hold_timers do
		local fn = table.remove(w.timers, 1) :: (fresh: WindowCx?) -> ()
		local ok = pcall(fn, freshCx(w))
		if not ok then
			w.timer_dead = true
			w.killed += 1
		end
	end
end

-- Moves the clock by `ms`, running the awaits that fall due (in order) and the timers each one leaves behind.
local function advance(w: World, ms: number)
	local target = w.now + ms
	while true do
		local next_at: number? = nil
		local index = 0
		for i, later in w.laters do
			if later.due <= target and (next_at == nil or later.due < next_at) then
				next_at, index = later.due, i
			end
		end
		if next_at == nil then
			break
		end
		local later = table.remove(w.laters, index) :: { due: number, fn: (fresh: WindowCx?) -> () }
		w.now = math.max(w.now, later.due)
		if not w.await_dead and not pcall(later.fn, freshCx(w)) then
			w.killed += 1
			w.await_dead = not w.soft_awaits
		end
		fireTimers(w)
	end
	w.now = target
end

-- A loader that is killed its first `kills` runs, and counts every run.
local function loader(name: string, kills: number?): (chain.Loader, { runs: number })
	local state = { runs = 0 }
	return {
		name = name,
		load = function()
			state.runs += 1
			if state.runs <= (kills or 0) then
				error("tern: timer exceeded 50 ms", 0)
			end
		end,
	}, state
end

local function start(w: World, loaders: { chain.Loader }, finish_kills: number?): { finished: number, loads: { [string]: number }?, lost: { WindowCx? }, retrying: { WindowCx? }, cuts: { WindowCx? }, finish_runs: number, order: { string } }
	local out = { finished = 0, loads = nil :: { [string]: number }?, lost = {} :: { WindowCx? }, retrying = {} :: { WindowCx? }, cuts = {} :: { WindowCx? }, finish_runs = 0, order = {} :: { string } }
	chain.load(w.sched, loaders, freshCx(w), function(_c, loads)
		out.finish_runs += 1
		table.insert(out.order, "finish")
		if out.finish_runs <= (finish_kills or 0) then
			error("tern: timer exceeded 50 ms", 0)
		end
		out.finished += 1
		out.loads = loads
	end, {
		lost = function(c)
			table.insert(out.lost, c)
		end,
		retrying = function(c)
			table.insert(out.retrying, c)
		end,
		cut = function(c)
			table.insert(out.cuts, c)
			table.insert(out.order, "cut")
		end,
	})
	return out
end

tests.runs_every_loader_once_in_order_then_finishes = function(t)
	local w = world()
	local order: { string } = {}
	local a, b = loader("a"), loader("b")
	local loaders: { chain.Loader } = {
		{ name = "a", load = function() table.insert(order, "a"); a.load() end },
		{ name = "b", load = function() table.insert(order, "b"); b.load() end },
	}
	local out = start(w, loaders)
	fireTimers(w)
	advance(w, 5000)
	t.eq(order, { "a", "b" })
	t.eq(out.finish_runs, 1)
	t.eq(out.finished, 1)
	t.eq(out.lost, {})
	t.eq(w.killed, 0)
end

tests.each_step_runs_in_a_tick_of_its_own = function(t)
	local w = world()
	local a, ra = loader("a")
	local b, rb = loader("b")
	local out = start(w, { a, b })
	-- One timer is queued at a time: the next step is armed by the one before it.
	t.eq(#w.timers, 1)
	local first = table.remove(w.timers, 1) :: (fresh: WindowCx?) -> ()
	first(freshCx(w))
	t.eq({ ra.runs, rb.runs, out.finish_runs }, { 1, 0, 0 })
	t.eq(#w.timers, 1)
	local second = table.remove(w.timers, 1) :: (fresh: WindowCx?) -> ()
	second(freshCx(w))
	t.eq({ ra.runs, rb.runs, out.finish_runs }, { 1, 1, 0 })
	local third = table.remove(w.timers, 1) :: (fresh: WindowCx?) -> ()
	third(freshCx(w))
	t.eq({ ra.runs, rb.runs, out.finish_runs }, { 1, 1, 1 })
end

tests.the_await_hook_runs_a_step_whose_timer_never_fires = function(t)
	local w = world()
	local a, ra = loader("a")
	local b, rb = loader("b")
	local out = start(w, { a, b })
	w.timer_dead = true
	advance(w, 5000)
	t.eq({ ra.runs, rb.runs, out.finish_runs, out.finished }, { 1, 1, 1, 1 })
	t.eq(out.lost, {})
end

tests.a_step_that_finished_never_runs_again_when_the_other_hook_fires = function(t)
	local w = world()
	local a, ra = loader("a")
	local out = start(w, { a })
	fireTimers(w)
	t.eq({ ra.runs, out.finish_runs }, { 1, 1 })
	-- Every await armed along the way fires now: nothing runs a second time.
	advance(w, 10000)
	t.eq({ ra.runs, out.finish_runs }, { 1, 1 })
end

tests.a_late_timer_does_not_run_a_step_the_await_hook_already_ran = function(t)
	local w = world()
	local a, ra = loader("a")
	local out = start(w, { a })
	-- The timer is slow (the machine is busy): the await hook gets there first.
	local pending = w.timers
	w.timers = {}
	advance(w, chain.RESUME_MS)
	t.eq(ra.runs, 1)
	for _, fn in pending do
		fn(freshCx(w))
	end
	advance(w, 10000)
	t.eq(ra.runs, 1)
	t.eq(out.finish_runs, 1)
end

tests.a_step_killed_in_the_middle_is_resumed_once_by_the_await_hook = function(t)
	local w = world()
	local a, ra = loader("a")
	local b, rb = loader("b", 1)
	local c, rc = loader("c")
	local out = start(w, { a, b, c })
	fireTimers(w)
	t.truthy(w.timer_dead, "the killed tick disabled the timer hook")
	t.eq({ ra.runs, rb.runs, rc.runs, out.finish_runs }, { 1, 1, 0, 0 })
	advance(w, 5000)
	t.eq({ ra.runs, rb.runs, rc.runs }, { 1, 2, 1 })
	t.eq(out.finish_runs, 1)
	t.eq(out.finished, 1)
	t.eq(out.lost, {})
	t.eq(#out.retrying, 1, "the user was told once that the load was interrupted and retried")
end

-- A kill disables the hook that ran the tick. When the retry is killed too, no hook is left to say anything after it, so
-- the user is told before the retry.
tests.both_hooks_killed_still_tells_the_user_before_the_retry = function(t)
	local w = world()
	local a, ra = loader("a")
	local b, rb = loader("b", 2)
	local c, rc = loader("c")
	local out = start(w, { a, b, c })
	fireTimers(w)
	advance(w, 60000)
	t.truthy(w.timer_dead and w.await_dead, "both hooks are dead")
	t.eq({ ra.runs, rb.runs, rc.runs }, { 1, 2, 0 })
	t.eq(#out.retrying, 1, "the user was told before the second run")
	t.eq(out.finish_runs, 0)
end

tests.a_step_that_fails_twice_without_a_kill_tells_the_user_once_and_stops = function(t)
	local w = world()
	w.soft_awaits = true
	local a, ra = loader("a")
	local b, rb = loader("b", 2)
	local c, rc = loader("c")
	local out = start(w, { a, b, c })
	fireTimers(w)
	advance(w, 60000)
	t.eq({ ra.runs, rb.runs, rc.runs }, { 1, 2, 0 })
	t.eq(#out.retrying, 1)
	t.eq(#out.lost, 1)
	t.eq(out.finish_runs, 0)
end

tests.a_step_that_fails_three_times_still_runs_only_twice = function(t)
	local w = world()
	w.soft_awaits = true
	local b, rb = loader("b", 3)
	local out = start(w, { b })
	fireTimers(w)
	advance(w, 60000)
	t.eq(rb.runs, 2)
	t.eq(#out.lost, 1)
end

tests.a_late_timer_finishes_a_step_the_await_hook_was_killed_in = function(t)
	local w = world()
	local a, ra = loader("a", 1)
	local out = start(w, { a })
	-- The machine is busy: the timer's tick comes after the await hook has run the step first, and that run is killed.
	local pending = w.timers
	w.timers = {}
	advance(w, chain.RESUME_MS)
	t.truthy(w.await_dead, "the await hook is dead")
	t.eq({ ra.runs, out.finish_runs }, { 1, 0 })
	for _, fn in pending do
		fn(freshCx(w))
	end
	fireTimers(w)
	t.eq({ ra.runs, out.finish_runs, out.finished }, { 2, 1, 1 })
	t.eq(#out.retrying, 1)
	t.eq(out.lost, {})
end

tests.a_late_timer_does_not_run_a_step_that_is_finished_or_already_retried = function(t)
	local w = world()
	w.soft_awaits = true
	local a, ra = loader("a", 2)
	local out = start(w, { a })
	local pending = w.timers
	w.timers = {}
	advance(w, chain.RESUME_MS * 4)
	t.eq(ra.runs, 2, "the step ran twice on the await hook and is lost")
	t.eq(#out.lost, 1)
	for _, fn in pending do
		fn(freshCx(w))
	end
	t.eq(ra.runs, 2, "a lost step is not run a third time")
end

tests.finish_is_never_run_a_second_time = function(t)
	local w = world()
	local a = loader("a")
	local out = start(w, { a }, 1)
	fireTimers(w)
	t.eq(out.finish_runs, 1)
	advance(w, 60000)
	-- It may have half opened a board: the user is told to run the command again, and it does not run twice.
	t.eq(out.finish_runs, 1)
	t.eq(out.finished, 0)
	t.eq(#out.lost, 1)
	t.eq(#out.retrying, 0, "a step that is not safe to run twice is not retried, so nothing is announced")
end

tests.a_late_timer_tells_the_user_a_step_that_cannot_run_twice_was_lost_on_the_await_hook = function(t)
	local w = world()
	w.hold_timers = true
	local a = loader("a")
	local out = start(w, { a }, 1)
	-- The await hook runs the last load, then `finish`, which is killed there; only then does the timer's tick arrive.
	advance(w, chain.RESUME_MS)
	advance(w, chain.RESUME_MS)
	t.truthy(w.await_dead, "the await hook is dead")
	t.eq({ out.finish_runs, #out.lost }, { 1, 0 })
	w.hold_timers = false
	fireTimers(w)
	t.eq(out.finish_runs, 1, "finish does not run a second time")
	t.eq(#out.lost, 1, "the user is told")
end

tests.no_window_context_stops_the_chain_and_says_so_on_the_last_one = function(t)
	local w = world()
	local a, ra = loader("a")
	local out = start(w, { a })
	w.without_cx = true
	-- The first hook finds no context; the start context was given by `start` as `freshCx` (id 1).
	fireTimers(w)
	advance(w, 60000)
	t.eq(ra.runs, 0)
	t.eq(out.finish_runs, 0)
	t.eq(#out.lost, 1)
	t.eq((out.lost[1] :: any).id, 1, "the message goes to the last good context")
end

tests.reports_how_long_each_load_took_the_most_of_its_runs = function(t)
	local w = world()
	local slow: chain.Loader = {
		name = "slow",
		load = function()
			w.now += 12
		end,
	}
	local out = start(w, { slow })
	fireTimers(w)
	t.eq(out.loads, { slow = 12 })
end

tests.the_loads_of_an_earlier_step_are_kept = function(t)
	local w = world()
	local a = loader("a")
	local seen: { [string]: number }? = nil
	chain.load(w.sched, { a }, freshCx(w), function(_c, loads)
		seen = loads
	end, { lost = function() end, retrying = function() end }, { load_editor_chain = 7 })
	fireTimers(w)
	t.eq(seen, { load_editor_chain = 7, a = 0 })
end

tests.a_plain_step_has_its_own_resume = function(t)
	local w = world()
	local runs, dones = 0, 0
	chain.step(w.sched, freshCx(w), { resumable = true, needs_cx = false }, function()
		runs += 1
		if runs == 1 then
			error("tern: timer exceeded 50 ms", 0)
		end
	end, function()
		dones += 1
	end)
	fireTimers(w)
	advance(w, 5000)
	t.eq({ runs, dones }, { 2, 1 })
end

tests.a_plain_step_with_no_context_still_runs_when_it_does_not_need_one = function(t)
	local w = world()
	w.without_cx = true
	local runs = 0
	chain.step(w.sched, nil, { resumable = true, needs_cx = false }, function(fresh)
		runs += 1
		t.eq(fresh, nil)
	end, function() end)
	fireTimers(w)
	advance(w, 5000)
	t.eq(runs, 1)
end

-- A timer hook that was cut in the middle of a step does not come back: the rest of the chain does not wait a resume
-- interval per step for it.
tests.after_a_cut_the_rest_of_the_chain_runs_on_the_await_hook_without_waiting_for_the_timer = function(t)
	local w = world()
	local loaders: { chain.Loader } = {}
	local runs: { { runs: number } } = {}
	for index = 1, 12 do
		local l, r = loader("l" .. index, if index == 3 then 1 else 0)
		table.insert(loaders, l)
		table.insert(runs, r)
	end
	local out = start(w, loaders)
	fireTimers(w)
	t.truthy(w.timer_dead)
	advance(w, chain.RESUME_MS + 50)
	t.eq(out.finished, 1, "the chain was finished one resume interval after the cut, not one per step")
	for index, r in runs do
		t.eq(r.runs, if index == 3 then 2 else 1, "loader " .. index)
	end
	t.eq(out.lost, {})
end

tests.a_cut_is_told_once_before_finish_and_in_a_tick_of_its_own = function(t)
	local w = world()
	local a = loader("a")
	local b = loader("b", 1)
	local c = loader("c")
	local out = start(w, { a, b, c })
	fireTimers(w)
	advance(w, 5000)
	t.eq(out.order, { "cut", "finish" }, "the timers are known to be gone before the editor starts")
	t.eq(#out.cuts, 1)
	t.truthy(out.cuts[1] ~= nil, "with a window context to say it on")
	t.eq(out.finish_runs, 1)
end

tests.a_chain_with_no_cut_tells_nothing_about_timers = function(t)
	local w = world()
	local out = start(w, { (loader("a")), (loader("b")) })
	fireTimers(w)
	advance(w, 5000)
	t.eq(out.cuts, {})
	t.eq(out.finished, 1)
end

tests.a_slow_timer_is_not_a_cut = function(t)
	local w = world()
	w.hold_timers = true
	local out = start(w, { (loader("a")), (loader("b")), (loader("c")) })
	advance(w, chain.RESUME_MS * 4)
	t.eq(out.finished, 1, "the await hook carried the chain")
	t.eq(out.cuts, {}, "no step of the timer's began: nothing says it is gone")
end

tests.an_await_hook_killed_in_a_step_is_not_a_timer_cut = function(t)
	local w = world()
	local out = start(w, { (loader("a", 1)) })
	local pending = w.timers
	w.timers = {}
	advance(w, chain.RESUME_MS)
	t.truthy(w.await_dead)
	for _, fn in pending do
		fn(freshCx(w))
	end
	fireTimers(w)
	t.eq(out.finished, 1)
	t.eq(out.cuts, {}, "the timer hook is alive: it finished the step")
end

tests.a_cut_step_that_is_lost_does_not_tell_a_cut_or_finish = function(t)
	local w = world()
	w.soft_awaits = true
	local out = start(w, { (loader("a", 2)), (loader("b")) })
	fireTimers(w)
	advance(w, 60000)
	t.eq(#out.lost, 1)
	t.eq(out.cuts, {})
	t.eq(out.finish_runs, 0)
end

return tests
