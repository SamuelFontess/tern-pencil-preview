--!strict
-- The load chain of the native editor, with the clock and the two hooks injected so it can be tested. A window hook has
-- a budget of 50 ms and a callback over it is killed (the timer hook is then disabled until the next reload), so every
-- module loads in a tick of its own. Each step is armed on both hooks, because the await hook has a budget of its own:
-- the timer hook runs it first; if that tick never fires, or dies in the middle of the step, the await hook takes over, and
-- the other way round (a tick that arrives late finishes a step the await hook was killed in). A hook that runs a callback
-- over its budget is disabled for good, so by the time a retry is killed there is no hook left to say anything: the user is
-- told before each retry what to do if the editor does not open.
local M = {}

export type Scheduler = {
	-- Runs `fn` on the timer hook, as soon as it fires.
	timer: (fn: (fresh: WindowCx?) -> ()) -> (),
	-- Runs `fn` on the await hook after `ms`, whatever the timer hook does.
	later: (ms: number, fn: (fresh: WindowCx?) -> ()) -> (),
	now: () -> number,
}

export type Loader = { name: string, load: () -> () }

-- What the user is told: `retrying` before a killed step runs again (cheap, and may be the last thing that can be said),
-- `lost` when the chain stopped for good, `cut` once, before the chain finishes, when the timer hook is known to be gone
-- (it began a step and never finished it, and the await hook ran that step again).
export type Notify = {
	lost: (c: WindowCx?) -> (),
	retrying: (c: WindowCx?) -> (),
	cut: ((c: WindowCx?) -> ())?,
}

-- What the steps of one chain tell each other. `carried`: the await hook had to run a step the timer hook had not, so
-- the steps after it are armed on the await hook at once instead of after a resume interval (waiting for a timer that is
-- most likely gone would cost one interval per step). `cut`: the timer hook began a step and never finished it.
export type Shared = { carried: boolean, cut: boolean }

export type Options = {
	-- A step killed in the middle runs again once; only a step that is safe to run twice (a `require`) says so.
	resumable: boolean,
	-- The step cannot run without a window context: with none, `lost` is told and the chain stops.
	needs_cx: boolean,
	notify: Notify?,
	shared: Shared?,
}

M.RESUME_MS = 250

-- Runs `work` in a tick of its own, then `done` (which starts the next step). `done` runs only after `work` returned, and
-- neither runs again after that: whichever hook finds the step finished does nothing.
function M.step(sched: Scheduler, last: WindowCx?, opts: Options, work: (fresh: WindowCx?) -> (), done: (fresh: WindowCx?) -> ())
	local attempts, finished = 0, false
	-- Which hook ran the first attempt.
	local first: "timer" | "await" | nil = nil
	local shared = opts.shared
	local function lose(c: WindowCx?)
		finished = true
		local notify = opts.notify
		if notify then
			notify.lost(c or last)
		end
	end
	local function attempt(fresh: WindowCx?)
		if opts.needs_cx and fresh == nil then
			lose(nil)
			return
		end
		attempts += 1
		work(fresh)
		finished = true
		done(fresh)
	end
	-- A step that began and did not finish was killed: it may run once more, if it is safe to, on whichever hook finds it.
	local function mayRun(): boolean
		return not finished and (attempts == 0 or (opts.resumable and attempts == 1))
	end
	local function run(fresh: WindowCx?)
		local notify = opts.notify
		if attempts == 1 and notify then
			notify.retrying(fresh or last)
		end
		attempt(fresh)
	end
	local function check(fresh: WindowCx?)
		if finished then
			return
		end
		if mayRun() then
			if shared then
				shared.carried = true
				-- The timer hook's run began and never finished, and the await hook is the one that found it.
				shared.cut = shared.cut or (attempts == 1 and first == "timer")
			end
			first = first or "await"
			-- Armed again before the run, so a run that is killed too is seen by the other hook, if it is still alive.
			sched.later(M.RESUME_MS, check)
			run(fresh)
		else
			lose(fresh)
		end
	end
	sched.timer(function(fresh: WindowCx?)
		if mayRun() then
			first = first or "timer"
			run(fresh)
		elseif not finished then
			-- Begun, killed, and not safe to run twice (or already run twice): a late timer finds it as `check` would.
			lose(fresh)
		end
	end)
	sched.later(if shared and shared.carried then 0 else M.RESUME_MS, check)
end

-- Loads `loaders` one per step, each timed (`loads`, in ms, by loader name; the most of a step's runs), then runs `finish`
-- in the step after the last one. The loads are resumable; `finish` starts the editor and so never runs twice. When the
-- timer hook was cut on the way, `notify.cut` is told in a step of its own before `finish` (the notice is a native call,
-- and `finish` makes its own). `gone`: the timer hook is already known to be gone, so no step waits for it and the cut is
-- told as if this chain had found it.
function M.load(
	sched: Scheduler,
	loaders: { Loader },
	last: WindowCx?,
	finish: (c: WindowCx, loads: { [string]: number }) -> (),
	notify: Notify,
	loads: { [string]: number }?,
	gone: boolean?
)
	local took: { [string]: number } = loads or {}
	local shared: Shared = { carried = gone == true, cut = gone == true }
	local function last_step(previous: WindowCx?)
		M.step(sched, previous, { resumable = false, needs_cx = true, notify = notify, shared = shared }, function(fresh)
			finish(fresh :: WindowCx, took)
		end, function(_fresh) end)
	end
	local function from(index: number, previous: WindowCx?)
		local loader = loaders[index]
		if loader then
			M.step(sched, previous, { resumable = true, needs_cx = true, notify = notify, shared = shared }, function(_fresh)
				local t0 = sched.now()
				loader.load()
				took[loader.name] = math.max(took[loader.name] or 0, sched.now() - t0)
			end, function(fresh)
				from(index + 1, fresh)
			end)
		elseif shared.cut and notify.cut then
			local tell = notify.cut
			M.step(sched, previous, { resumable = true, needs_cx = true, notify = notify, shared = shared }, function(fresh)
				tell(fresh)
			end, last_step)
		else
			last_step(previous)
		end
	end
	from(1, last)
end

return M
