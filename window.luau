--!strict
-- The window half: `.pen` files opened from the Files pane, the palette or `tern open` open the
-- native Pencil editor, unless the command "Toggle Pencil Preview for .pen opens" turned that off
-- (then Tern's own editor opens them). "Open Pencil board (live mirror)" is a separate, explicit
-- readonly whiteboard companion; it is never the route's destination or an editor fallback.

-- The board's lib/ chain is large; a window hook has a 50 ms budget and requiring the whole chain
-- in one hook (here, or inside board.luau's own top level) blows it. Each module loads in its own
-- tick instead (lib/editor_load), and only when "Open Pencil board (live mirror)" first runs: the default
-- route above needs none of them.
local Hooks = require("./lib/editor_hooks")
local Load = require("./lib/editor_load")

type Loader = { name: string, load: () -> () }
local BOARD_LOADERS: { Loader } = {
	{ name = "load_cache", load = function() require("./lib/cache") end },
	{ name = "load_launch", load = function() require("./lib/launch") end },
	{ name = "load_mirror", load = function() require("./lib/mirror") end },
	{ name = "load_script", load = function() require("./lib/script") end },
	{ name = "load_util", load = function() require("./lib/util") end },
}

-- The kv key of the switch; absent means on.
local ROUTE_KEY = "route_pen"

-- Read on every open: `tern.kv` is one store for every window, so a toggle
-- in one window applies in the others at once.
local function enabled(): boolean
	return tern.kv.get(ROUTE_KEY) ~= false
end

tern.command({
	id = "board",
	title = "Open Pencil board (live mirror)",
	icon = "pen",
	run = function(cx: WindowCx)
		Hooks.warnStalledNow(cx)
		Load.loadMirror(cx, BOARD_LOADERS, function(c: WindowCx, _loads: { [string]: number })
			require("./board").open(c)
		end)
	end,
})

tern.command({
	id = "toggle_route",
	title = "Toggle Pencil Preview for .pen opens",
	icon = "pen",
	run = function(cx: WindowCx)
		Hooks.warnStalledNow(cx)
		local on = not enabled()
		tern.kv.set(ROUTE_KEY, on)
		if on then
			cx:toast("success", ".pen files open in the Pencil editor", "\"Open Pencil board (live mirror)\" still opens the readonly mirror")
		else
			cx:toast("info", ".pen files open in Tern's editor", "\"Open Pencil editor\" still opens them")
		end
	end,
})

-- The native editor. Its modules are large and every hook has a 50 ms budget (a cold `require` of all of them in one
-- hook blew it, and on a busy machine so did one module of a couple of thousand lines), so they load one per timer tick
-- the first time something needs the editor, not at window load, and each tick is timed (the editor writes the numbers
-- to its status file). Every module the editor requires is on this list, after the modules it requires (scripts/gate.py
-- checks both), so no `require` is ever cold inside a tick that does work. The chain is lib/editor_chain: a tick that
-- dies in the middle of a load is run once more, on whichever hook finds it, and the user is told how to recover.
local EDITOR_LOADERS: { Loader } = {
	{ name = "load_editor_hooks", load = function() require("./lib/editor_hooks") end },
	{ name = "load_sha1", load = function() require("./lib/sha1") end },
	{ name = "load_doc", load = function() require("./lib/doc") end },
	{ name = "load_util", load = function() require("./lib/util") end },
	{ name = "load_mirror", load = function() require("./lib/mirror") end },
	{ name = "load_launch", load = function() require("./lib/launch") end },
	{ name = "load_editor_launch", load = function() require("./lib/editor_launch") end },
	{ name = "load_editor_registry", load = function() require("./lib/editor_registry") end },
	{ name = "load_editor_close", load = function() require("./lib/editor_close") end },
	{ name = "load_editor_projection_session", load = function() require("./lib/editor_projection_session") end },
	{ name = "load_editor_projection_batch", load = function() require("./lib/editor_projection_batch") end },
	{ name = "load_editor_projection_targets", load = function() require("./lib/editor_projection_targets") end },
	{ name = "load_editor_projection_messages", load = function() require("./lib/editor_projection_messages") end },
	{ name = "load_editor_projection", load = function() require("./lib/editor_projection") end },
	{ name = "load_editor_draft", load = function() require("./lib/editor_draft") end },
	{ name = "load_editor_gesture", load = function() require("./lib/editor_gesture") end },
	{ name = "load_editor_label", load = function() require("./lib/editor_label") end },
	{ name = "load_editor_level", load = function() require("./lib/editor_level") end },
	{ name = "load_editor_palette_rules", load = function() require("./lib/editor_palette") end },
	{ name = "load_editor_core", load = function() require("./editor_core") end },
	{ name = "load_editor_lifecycle", load = function() require("./editor_lifecycle") end },
	{ name = "load_editor_closing", load = function() require("./editor_closing") end },
	{ name = "load_editor_build", load = function() require("./editor_build") end },
	{ name = "load_editor_capture", load = function() require("./editor_capture") end },
	{ name = "load_editor_text", load = function() require("./editor_text") end },
	{ name = "load_editor_nav", load = function() require("./editor_nav") end },
	{ name = "load_editor_loop", load = function() require("./editor_loop") end },
	{ name = "load_editor_start", load = function() require("./editor_start") end },
	{ name = "load_editor_adopt", load = function() require("./editor_adopt") end },
	{ name = "load_editor_palette", load = function() require("./editor_palette") end },
	{ name = "load_editor_board", load = function() require("./editor_board") end },
}

-- Loads the editor's modules, then runs `finish` in the tick after the last one with the time each load took.
local function loadEditor(cx: WindowCx, finish: (c: WindowCx, loads: { [string]: number }) -> ())
	Load.load(cx, EDITOR_LOADERS, finish)
end

tern.command({
	id = "editor",
	title = "Open Pencil editor",
	icon = "pen",
	run = function(cx: WindowCx)
		if Hooks.refuseNow(cx) then
			return
		end
		loadEditor(cx, function(c: WindowCx, loads: { [string]: number })
			require("./editor_board").run(c, loads)
		end)
	end,
})

tern.command({
	id = "editor_reopen_board",
	title = "Reopen Pencil editor board",
	icon = "pen",
	run = function(cx: WindowCx)
		if Hooks.refuseNow(cx) then
			return
		end
		loadEditor(cx, function(c: WindowCx, loads: { [string]: number })
			require("./editor_board").reopen(c, loads)
		end)
	end,
})

-- Save, Undo and Redo of the focused board's document (or of the only open editor).
for _, spec in {
	{ id = "editor_save", title = "Pencil: Save", action = "save" :: "save" | "undo" | "redo" | "mcp" },
	{ id = "editor_undo", title = "Pencil: Undo", action = "undo" :: "save" | "undo" | "redo" | "mcp" },
	{ id = "editor_redo", title = "Pencil: Redo", action = "redo" :: "save" | "undo" | "redo" | "mcp" },
	{ id = "editor_copy_mcp", title = "Pencil: Copy MCP configuration", action = "mcp" :: "save" | "undo" | "redo" | "mcp" },
} do
	tern.command({
		id = spec.id,
		title = spec.title,
		icon = "pen",
		run = function(cx: WindowCx)
			if Hooks.refuseNow(cx) then
				return
			end
			loadEditor(cx, function(c: WindowCx, loads: { [string]: number })
				require("./editor_board").palette(c, spec.action, loads)
			end)
		end,
	})
end

-- Smoke tests only: with TERN_PENCIL_TEST_KILL_HOOKS=1 in the environment, this command runs one callback over the 50 ms
-- budget on each scheduling hook, which is how Tern disables both (a plugin reload brings them back). Without the variable
-- no such command exists.
if tern.getenv("TERN_PENCIL_TEST_KILL_HOOKS") == "1" then
	local function burn(_fresh: WindowCx?)
		local t0 = tern.now()
		while tern.now() - t0 < 120 do
		end
	end
	tern.command({
		id = "test_kill_hooks",
		title = "Pencil test: disable the timer hooks",
		run = function(_cx: WindowCx)
			Hooks.timer(0, burn)
			Hooks.sleep(1, burn)
		end,
	})
end

tern.route.open(function(req: OpenRequest, cx: WindowCx): RouteDecision?
	if not enabled() then
		return nil
	end
	-- A line to reveal asks for Tern's editor.
	if req.line ~= nil then
		return nil
	end
	-- From the Files pane and the palette only a plain open counts (a
	-- placement asks for Tern's editor). `tern open` is claimed whatever its
	-- placement: the CLI picks one (e.g. "beside") for every file.
	if req.origin == "cli" then
		-- any placement
	elseif req.origin == "files" or req.origin == "palette" then
		if req.how ~= "default" then
			return nil
		end
	else
		return nil
	end
	if string.lower(string.sub(req.path, -4)) ~= ".pen" then
		return nil
	end
	local path = req.path
	if Hooks.refuseNow(cx) then
		return { handled = true }
	end
	loadEditor(cx, function(c: WindowCx, loads: { [string]: number })
		require("./editor_board").open(c, path, loads)
	end)
	return { handled = true }
end)

-- After a load (a plugin reload drops the VM, the editors this window had running keep running) and at window start,
-- whichever comes first and once per VM: two housekeeping chains, every step in a tick of its own (lib/editor_chain, so
-- a tick that dies in the middle is run once more on whichever hook finds it; nothing is said to the user, it is only
-- housekeeping). Nothing here runs a `require` in the tick that does the work (a cold require costs a tick's worth of
-- budget); the first tick loads lib/editor_chain itself, in every window.
--   1. editors of this window left by an earlier VM are picked up again: the registry is read, and only when there is
--      one is the editor chain loaded (a window with no editor loads no more than the chain and the registry);
--   2. a launch manifest an editor never consumed (it never started, and no later launch swept) is removed; the tick's
--      time and what it removed are kept under the `editor_sweep` key.
local booted = false
local function boot()
	if booted then
		return
	end
	booted = true
	Load.withChain(nil, false, function(chain, _first, _took)
		local options = { resumable = true, needs_cx = false }
		chain.step(Load.SCHEDULER, nil, options, function()
			require("./lib/editor_registry")
		end, function(_second)
			local adopt = false
			chain.step(Load.SCHEDULER, nil, options, function(fresh: WindowCx?)
				adopt = fresh ~= nil and #require("./lib/editor_registry").mine(require("./lib/editor_registry").scope(fresh)) > 0
			end, function(third: WindowCx?)
				-- Started here, not in the work above: `done` runs once, after `work` returned, so a resumed step never starts
				-- a second chain.
				if adopt and third then
					loadEditor(third, function(c: WindowCx, loads: { [string]: number })
						require("./editor_board").adopt(c, loads)
					end)
				end
				chain.step(Load.SCHEDULER, nil, options, function()
					require("./lib/editor_launch")
				end, function(_fourth)
					chain.step(Load.SCHEDULER, nil, options, function()
						local t0 = tern.now()
						local removed = 0
						local epoch_ok, now = pcall(os.time)
						if epoch_ok then
							-- An error here must not escape the timer: the sweep is housekeeping.
							local swept, count = pcall(function(): number
								return require("./lib/editor_launch").sweep(tern.plugin.data .. "/editor", now)
							end)
							if swept then
								removed = count
							end
						end
						pcall(tern.kv.set, "editor_sweep", { ms = math.floor((tern.now() - t0) * 10) / 10, removed = removed })
					end, function(_fifth) end)
				end)
			end)
		end)
	end)
end

tern.on("window_start", function(_cx: WindowCx)
	boot()
end)
Hooks.timer(0, function(_cx: WindowCx?)
	boot()
end)
