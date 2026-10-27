--!strict
-- Starting an editor: the owner as a process of its own (no pane: nothing of it is ever shown, and a native layout call
-- is the one thing that can take most of a window hook's 50 ms) and the board beside the user's pane.
local gesture = require("./lib/editor_gesture")
local editor_launch = require("./lib/editor_launch")
local label = require("./lib/editor_label")
local launch = require("./lib/launch")
local registry = require("./lib/editor_registry")
local util = require("./lib/util")
local Core = require("./editor_core")
local Lifecycle = require("./editor_lifecycle")
local Closing = require("./editor_closing")
local NODE_TIMEOUT_MS = Core.NODE_TIMEOUT_MS
local PATH_KEY, holderOf, remember = Core.PATH_KEY, Core.holderOf, Core.remember
local sessions, quick, tick, timed = Core.sessions, Core.quick, Core.tick, Core.timed
local live = Core.live
local guard = Lifecycle.guard
local reopenBoard = Closing.reopenBoard
type Session = Core.Session
type Opening = Core.Opening

-- The key a file is known by among the sessions and the opens: a Windows path ignores case and slash direction.
local function keyOf(path: string): string
	if path:match("^%a:") then
		return (path:lower():gsub("\\", "/"))
	end
	return path
end

-- A session that has just come to exist: its owner not heard from yet, and no board.
local function newSession(path: string, data_dir: string, launch_id: string, manifest: string, scope: string): Session
	return {
		alive = true, busy = false, busy_since = 0, tick = 0,
		path = path, data_dir = data_dir, launch_id = launch_id, manifest = manifest,
		exited = nil, reconnect = false, adopted = false, keep = 0, board = 0, started = tern.now(), record = nil,
		generation = 1, attached = nil, proj = nil, frames_state = nil, halos = nil,
		activity_key = nil, activity_text = nil, frame_rows = {},
		retiring = false, opening_board = false, board_ask = nil, restarted = false, closing = false, recovery_asked = false, recovery_pick = false, close_waits = false,
		sweep_ids = nil, scope = scope, view_id = launch_id .. "-" .. holderOf():sub(1, 8), claim = false, taken_since = nil, shapes_cut = false,
		shown = {}, targets = { by_path = {}, by_id = {}, box = {} }, requests = 0,
		gesture = gesture.new(), label = label.new(), armed = nil, watching = nil, gestures = 0, applied = nil, marks = nil, retired_cut = false,
		scene = nil, focus = nil, built_focus = nil, selected = nil, chosen = nil, level = nil, tree = nil, framed = false,
		note = nil, capped_focus = nil, reset_seen = nil, quiet = 0, holding = false, change_seq = nil,
	}
end

type Step = (name: string, c: WindowCx, fn: (c: WindowCx) -> ()) -> ()
type Ticks = { tick: Step, quick: Step }

-- The ticks of one run of an open. The watch takes an open over when the timers its ticks were queued on stopped (see
-- `begin`), which starts a new run; whatever an earlier run left behind, such as the answer of a process it started, finds
-- its run over when it comes and does nothing.
local function ticksOf(op: Opening): Ticks
	local run = op.run
	local function current(fn: (c: WindowCx) -> ()): (c: WindowCx) -> ()
		return function(c: WindowCx)
			if op.run ~= run then
				return
			end
			-- A tick that raises ends the open: it would otherwise stay pending, and every later ask would only hear that it is
			-- already opening.
			local ok, err = pcall(fn :: (WindowCx) -> any, c)
			if not ok then
				if live.opening[keyOf(op.path)] == op then
					live.opening[keyOf(op.path)] = nil
				end
				error(err, 0)
			end
		end
	end
	return {
		tick = function(name: string, c: WindowCx, fn: (c: WindowCx) -> ())
			tick(name, c, current(fn))
		end,
		quick = function(name: string, c: WindowCx, fn: (c: WindowCx) -> ())
			quick(name, c, current(fn))
		end,
	}
end

-- Says why the editor did not start, in a tick of its own: a toast is a native call and shares its tick with no other.
-- A launch file still on disk is removed in the tick before (the failing tick has already made its one native call). The
-- open stops being pending with the notice, so one the timers cut before it is still told it.
local function failStart(op: Opening?, c: WindowCx, text: string, detail: string?, manifest: string?)
	local ticks: Ticks = if op then ticksOf(op) else { tick = tick, quick = quick }
	local function say(c1: WindowCx)
		ticks.tick("open_failed", c1, function(c2)
			if op then
				live.opening[keyOf(op.path)] = nil
			end
			c2:toast("error", text, detail)
		end)
	end
	if manifest == nil then
		say(c)
		return
	end
	ticks.tick("manifest_remove", c, function(c1)
		pcall(tern.fs.remove, manifest)
		say(c1)
	end)
end

-- Runs the owner with `tern.process.run`: no timeout, because it runs until it is asked to end (or no window asks for
-- it), and it outlives a plugin reload, which only drops the callback. The callback only notes that the process ended; the
-- loop acts on it. Then the board beside the user's pane. One native call per tick: a window hook that blocks on one call
-- over 50 ms is killed, and a busy window makes any single call slow, so the run is a tick of its own.
local function openSession(c: WindowCx, op: Opening, node: string, entry: string, data_dir: string, launch_id: string, manifest: string)
	local path = op.path
	local ticks = ticksOf(op)
	ticks.tick("owner_run", c, function(c1)
		-- The process cannot end before this tick does, but it may end before the next one starts.
		local sess: Session? = nil
		local early: number? = nil
		local ran = pcall(function()
			tern.process.run({ node, entry, "--launch", manifest }, { cwd = util.dirname(path) }, timed("owner_exit", function(result: ProcessResult, _fresh: WindowCx?)
				tern.log.info("editor program ended with status " .. tostring(result.status))
				if sess then
					sess.exited = result.status
				else
					early = result.status
				end
			end))
		end)
		if not ran then
			failStart(op, c1, "The editor could not be started", "The editor program could not be run", manifest)
			return
		end
		ticks.quick("session_start", c1, function(c2)
			live.opening[keyOf(path)] = nil
			local started = newSession(path, data_dir, launch_id, manifest, registry.scope(c2))
			started.exited, started.restarted = early, op.run > 1
			sess = started
			sessions[launch_id] = started
			remember(started)
			reopenBoard(c2, started)
		end)
	end)
end

local function nodeOf(cli: launch.Launch): string
	if #cli.argv >= 2 then
		return cli.argv[1]
	end
	return "node"
end

-- Starts the node check once the stale launch manifests (an owner never consumed them: a crashed launch) are gone. The
-- folder is listed in one tick and each file removed in a tick of its own. Names carry their creation time because
-- `tern.fs` has no file times.
local function sweepThen(ticks: Ticks, c: WindowCx, data_dir: string, next_step: (c: WindowCx) -> ())
	local epoch_ok, now = pcall(os.time)
	local stale = if epoch_ok then editor_launch.stale_in(data_dir, now) else {}
	local function remove(c1: WindowCx, index: number)
		local name = stale[index]
		if name == nil then
			next_step(c1)
			return
		end
		ticks.tick("sweep_remove", c1, function(c2)
			pcall(tern.fs.remove, data_dir .. "/" .. name)
			remove(c2, index + 1)
		end)
	end
	remove(c, 1)
end

-- Asks for the board of a running session: it opens again if it is gone. An editor that is closing says so.
local function revealBoard(c: WindowCx, sess: Session)
	if sess.claim then
		c:toast("info", "This editor is reconnecting", "Try again in a moment")
		return
	end
	guard(c, sess)
	if sess.closing then
		c:toast("info", "This editor is closing", "Open the file again once it has closed")
		return
	end
	reopenBoard(c, sess)
end

-- The node check's answer: the launch file is built here (no native call), then written in two ticks (the folder, then the
-- file); the path remembered, the toast and the owner's run follow in ticks of their own.
local function nodeChecked(c: WindowCx, op: Opening, version: ProcessResult, cli: launch.Launch, entry: string, data_dir: string)
	local path = op.path
	local ticks = ticksOf(op)
	local ok, why = editor_launch.node_ok(version)
	if not ok then
		failStart(op, c, "The editor needs Node.js", why)
		return
	end
	local launch_id = editor_launch.launch_id(path .. "|" .. tostring(tern.now()) .. "|" .. tostring(math.random()))
	local _, epoch = pcall(os.time)
	local manifest_path = data_dir .. "/" .. editor_launch.manifest_name(if typeof(epoch) == "number" then epoch else 0, launch_id)
	local written, manifest = pcall(editor_launch.manifest, path, cli.argv, data_dir, launch_id)
	if not written then
		failStart(op, c, "The editor could not be configured", (tostring(manifest):gsub("^.-:%d+: ", "")))
		return
	end
	local node = nodeOf(cli)
	local function unwritable(c1: WindowCx, remove: string?)
		failStart(op, c1, "The editor could not write its launch file", "Check that the plugin data folder is writable", remove)
	end
	ticks.tick("manifest_dir", c, function(c1)
		if not pcall(tern.fs.mkdir, data_dir) then
			unwritable(c1, nil)
			return
		end
		ticks.tick("manifest_write", c1, function(c2)
			if not pcall(tern.fs.write, manifest_path, manifest) then
				unwritable(c2, manifest_path)
				return
			end
			ticks.tick("remember_path", c2, function(c3)
				pcall(tern.kv.set, PATH_KEY, path)
				ticks.tick("open_toast", c3, function(c4)
					c4:toast("info", "Opening the editor", util.basename(path))
					openSession(c4, op, node, entry, data_dir, launch_id, manifest_path)
				end)
			end)
		end)
	end)
end

-- One run of an open: the folder sweep, the Node check, the launch file and the owner's run. Each process call is
-- asynchronous, and the first tick only looks (reads and checks); the folder sweep, each process, each file write and the
-- toast run in ticks of their own.
local function begin(c: WindowCx, op: Opening, cli: launch.Launch, entry: string, data_dir: string)
	local ticks = ticksOf(op)
	ticks.tick("launch_sweep", c, function(c1)
		sweepThen(ticks, c1, data_dir, function(c2)
			ticks.tick("node_start", c2, function(c3)
				local ran = pcall(function()
					tern.process.run({ nodeOf(cli), "--version" }, { timeout_ms = NODE_TIMEOUT_MS }, timed("node_version", function(version: ProcessResult, fresh: WindowCx?)
						ticks.quick("node_checked", (fresh or c3) :: WindowCx, function(c4)
							nodeChecked(c4, op, version, cli, entry, data_dir)
						end)
					end))
				end)
				if not ran then
					failStart(op, c3, "Node.js could not be run", "Check that Node.js is installed")
				end
			end)
		end)
	end)
end

-- Checks, then begins the open, which stays pending until its session exists or it fails: a second ask for the same file
-- meanwhile does not start another, and the watch carries it on if the timers its ticks wait on stop (a tick that went over
-- its budget disables the hook; nothing says what a late answer would have started). It begins again from its first
-- tick, which is safe wherever the run was cut: the steps before the owner's run leave only a launch file no one uses (swept
-- when stale, as after a crash), and an owner already started by the cut run holds the file, so the new one stops with
-- ALREADY_OPEN and the session follows the first (see `ownerExited`).
local function launchEditor(c: WindowCx, path: string)
	local key = keyOf(path)
	for _, sess in sessions do
		if keyOf(sess.path) == key and sess.alive and not sess.retiring then
			revealBoard(c, sess)
			return
		end
	end
	if live.opening[key] ~= nil then
		c:toast("info", "This editor is already opening", util.basename(path))
		return
	end
	local cli = launch.pen_cli()
	if cli == nil then
		failStart(nil, c, "The pen CLI was not found", "Install it with npm i -g @pen.dev/cli, or set TERN_PENCIL_CLI")
		return
	end
	local entry = tern.plugin.dir .. "/runtime/editor.mjs"
	if not tern.fs.exists(entry) then
		failStart(nil, c, "The editor runtime is missing", "Reinstall the plugin: runtime/editor.mjs was not found")
		return
	end
	if string.lower(string.sub(path, -4)) ~= ".pen" or not tern.fs.exists(path) then
		failStart(nil, c, "That is not an existing .pen file", util.basename(path))
		return
	end
	local data_dir = tern.plugin.data .. "/editor"
	local op: Opening = { path = path, run = 1, restart = function(_c: WindowCx) end }
	op.restart = function(c1: WindowCx)
		op.run += 1
		begin(c1, op, cli, entry, data_dir)
	end
	live.opening[key] = op
	begin(c, op, cli, entry, data_dir)
end

return {
	launchEditor = launchEditor,
	newSession = newSession,
	revealBoard = revealBoard,
}
