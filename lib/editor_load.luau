--!strict
-- How window.luau loads the modules of a feature: lib/editor_chain over the plugin's two scheduling hooks, with what the
-- user is told when a tick is killed. A hook that runs a callback over its budget is disabled until the next reload, and
-- the await hook is one of them, so after a second kill nothing is left to speak: what to do (reload plugins) is said
-- before the retry, and again if the chain is lost without one.
local Hooks = require("./editor_hooks")

local M = {}

local function retrying(c: WindowCx?)
	if c ~= nil then
		pcall(function()
			c:toast("info", "Loading Pencil Preview was interrupted", "Trying again. If it does not open, reload plugins from the command palette")
		end)
	end
end

local function interrupted(c: WindowCx?)
	if c ~= nil then
		pcall(function()
			c:toast("error", "Pencil Preview could not be opened", "Reload plugins from the command palette, then open it again")
		end)
	end
end

-- The chain found the timer hook gone: an editor that is loaded says so and carries on without it (editor_board sets
-- `Hooks.timers_cut`); until it is loaded there is nothing to say.
local function cut(c: WindowCx?)
	if c ~= nil then
		Hooks.timers_cut(c)
	end
end

-- "Open Pencil board (live mirror)": the mirror polls and updates on the timer hook, so with it gone the board comes up
-- and never follows the file. Nothing carries that on from the await hook; the user is told, once, to reload.
local function mirror_cut(c: WindowCx?)
	if c ~= nil then
		pcall(function()
			c:toast("error", "The live mirror cannot update", "Tern turned off this plugin's timers because the machine was too busy. Reload plugins from the command palette, then open it again")
		end)
	end
end

local NOTIFY = { lost = interrupted, retrying = retrying, cut = cut }
local MIRROR_NOTIFY = { lost = interrupted, retrying = retrying, cut = mirror_cut }

M.SCHEDULER = {
	timer = function(fn: (fresh: WindowCx?) -> ())
		Hooks.timer(0, fn)
	end,
	later = function(ms: number, fn: (fresh: WindowCx?) -> ())
		Hooks.sleep(ms, fn)
	end,
	now = function(): number
		return tern.now()
	end,
}

type Chain = typeof(require("./editor_chain"))

-- The chain module is itself the first load (a require at window load would be one more thing the load hook pays for), and
-- it cannot resume itself: this is the same thing in miniature, with the same rules as lib/editor_chain's `step`. Both
-- hooks are armed. A step that began and did not finish was killed, and runs once more on whichever hook finds it first
-- (the user is told before, since a second kill leaves no hook to say anything); after that it is lost. `gone` tells
-- `run` that the timer hook is known to be dead: the await hook found it with a timer callback begun and never finished
-- (on the timer hook itself that flag is just the running callback, so it says nothing there).
function M.withChain(last: WindowCx?, needs_cx: boolean, run: (chain: Chain, fresh: WindowCx?, took: number, gone: boolean) -> ())
	local attempts, done = 0, false
	local function go(fresh: WindowCx?, on_await: boolean)
		if done then
			return
		end
		if (needs_cx and fresh == nil) or attempts >= 2 then
			done = true
			if needs_cx then
				interrupted(fresh or last)
			end
			return
		end
		if attempts == 1 and needs_cx then
			retrying(fresh or last)
		end
		attempts += 1
		local t0 = tern.now()
		local chain = require("./editor_chain")
		local took = tern.now() - t0
		done = true
		run(chain, fresh, took, on_await and Hooks.live.busy.timer == true)
	end
	Hooks.timer(0, function(fresh: WindowCx?)
		if attempts < 2 then
			go(fresh, false)
		end
	end)
	for _, ms in { 250, 500, 750 } do
		Hooks.sleep(ms, function(fresh: WindowCx?)
			go(fresh, true)
		end)
	end
end

local function load(cx: WindowCx, loaders: { { name: string, load: () -> () } }, finish: (c: WindowCx, loads: { [string]: number }) -> (), notify: typeof(NOTIFY))
	M.withChain(cx, true, function(chain, fresh, took, gone)
		chain.load(M.SCHEDULER, loaders, fresh, finish, notify, { load_editor_chain = took }, gone)
	end)
end

-- Loads `loaders` one per tick, then runs `finish` in the tick after the last one with the time each load took. A cut of
-- the timer hook on the way does not lose the open: the await hook carries the chain on, and the editor is told before
-- `finish` runs.
function M.load(cx: WindowCx, loaders: { { name: string, load: () -> () } }, finish: (c: WindowCx, loads: { [string]: number }) -> ())
	load(cx, loaders, finish, NOTIFY)
end

-- The same for the live mirror, which a cut leaves unable to update: that is told instead of carried on.
function M.loadMirror(cx: WindowCx, loaders: { { name: string, load: () -> () } }, finish: (c: WindowCx, loads: { [string]: number }) -> ())
	load(cx, loaders, finish, MIRROR_NOTIFY)
end

return M
