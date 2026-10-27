--!strict
-- The native editor, window half: starts the Node editor as a process of its own (no pane, nothing of it shown) and keeps
-- a whiteboard beside the user's pane in step with its document. The board shows every frame as the renderer's
-- official PNG (locked) and, only for the frame in focus, one rectangle per element that can be clicked: a click
-- selects that element in the editor. Closing the board ends the editor, asking first about unsaved work or a
-- recovery. The board never writes the document; it only reads small pages from the owner and asks it to act.
--
-- Every step runs in its own timer tick (a window callback that takes 50 ms is killed and the plugin's timers stop):
-- fetch callback, decode, offer/take, then one whiteboard batch per tick. A step belongs to one view generation; a
-- change of focus, revision or session bumps it and every step still in flight for the old one just stops.
--
-- The work is split by responsibility, each module loaded in a tick of its own by window.luau (see EDITOR_LOADERS there;
-- a module is compiled when first required, and a cold one costs a tick): editor_core (state, status, registry),
-- editor_lifecycle (ticks, calls to the owner, retiring), editor_closing (closing and recovery, the board again),
-- editor_build (drawing), editor_capture (the user's clicks and gestures), editor_text (the text typed on a target),
-- editor_loop (the session's step), editor_start (launching), editor_adopt (what a reload leaves behind). This is what
-- window.luau uses.
local EditorHooks = require("./lib/editor_hooks")
local util = require("./lib/util")
local Core = require("./editor_core")
local Closing = require("./editor_closing")
local Loop = require("./editor_loop")
local Start = require("./editor_start")
local Adopt = require("./editor_adopt")
local Palette = require("./editor_palette")
local PATH_KEY, deferFlush, record, sessions, tick, timed = Core.PATH_KEY, Core.deferFlush, Core.record, Core.sessions, Core.tick, Core.timed
local launchEditor, revealBoard = Start.launchEditor, Start.revealBoard
local whenAdopted = Adopt.whenAdopted
type Session = Core.Session

-- The two steps that lower modules take from higher ones (see Hooks in editor_core).
Core.hooks.step = Loop.step
Core.hooks.boardClosed = Closing.boardClosed

-- What window.luau asks when a hook of the plugin finds the timers dead: is there an editor whose work stopped with them.
EditorHooks.session_open = function(): boolean
	for _, sess in sessions do
		if sess.alive and not sess.retiring then
			return true
		end
	end
	return false
end

-- What window.luau's load chain says when it finds the timer hook gone: the editor starts without it (see editor_adopt).
EditorHooks.timers_cut = Adopt.cut

-- The milliseconds each lazy-loading tick of the window took (window.luau times them): kept in the status file with the
-- numbers of every other callback, whichever way the editor was reached.
local function recordLoads(loads: { [string]: number }?)
	if loads then
		for name, ms in loads do
			record(name, ms)
		end
		deferFlush()
	end
end

local function describe(e: any): string
	-- The text of an error can hold the document path, so only its fixed head is logged.
	tern.log.error("editor start failed: " .. (tostring(e):match("^[^\n]-:%d+: ([%w_ %.]*)") or "error"))
	return ""
end

-- Opens a known path directly (the window's `.pen` route): no prompt, same safety as the palette command.
local function open(cx: WindowCx, path: string, loads: { [string]: number }?)
	recordLoads(loads)
	whenAdopted(cx, function(c: WindowCx)
		if not xpcall(launchEditor, describe, c, path) then
			c:toast("error", "The editor could not be started")
		end
	end)
end

-- The palette command. window.luau registers it and calls this once the editor's modules are loaded (one per tick, see
-- EDITOR_LOADERS there), never at window load. `loads` are the milliseconds each of those ticks took.
local function run(cx: WindowCx, loads: { [string]: number }?)
	recordLoads(loads)
	local t0 = tern.now()
	local last = tern.kv.get(PATH_KEY)
	local focused = cx.session:focused()
	local pane = if focused then cx.session:pane(focused) else nil
	local cwd = if pane then pane.cwd else nil
	cx:prompt({
		placeholder = "Full path of a .pen file",
		value = if typeof(last) == "string" then last else nil,
		action = "open editor",
	}):next(timed("prompt", function(text: string?, _err: string?, fresh: WindowCx?)
		if text and text ~= "" then
			local path = util.resolve((text:gsub('^"(.*)"$', "%1")), cwd)
			tick("start", (fresh or cx) :: WindowCx, function(c)
				open(c, path)
			end)
		end
	end))
	record("command", tern.now() - t0)
end

-- The editor waiting without a board (it has no pane, so there is nothing to focus), when exactly one is.
local function waitingEditor(): Session?
	local waiting: Session? = nil
	local count = 0
	for _, sess in sessions do
		if sess.alive and not sess.retiring and not sess.closing and sess.board == 0 then
			waiting, count = sess, count + 1
		end
	end
	return if count == 1 then waiting else nil
end

-- Tests only: what a plugin reload does to this window's editor, which is to forget everything it kept in memory.
local function dropState()
	Core.reset()
	Adopt.reset()
	EditorHooks.live = EditorHooks.new()
end

return {
	run = run,
	open = open,
	adopt = function(c: WindowCx, loads: { [string]: number }?)
		recordLoads(loads)
		Adopt.startAdoption(c)
	end,
	drop_state = dropState,
	palette = function(c: WindowCx, action: "save" | "undo" | "redo" | "mcp", loads: { [string]: number }?)
		recordLoads(loads)
		Palette.run(c, action)
	end,
	reopen = function(c: WindowCx, loads: { [string]: number }?)
		recordLoads(loads)
		whenAdopted(c, function(c1: WindowCx)
			local sess = waitingEditor()
			if sess == nil then
				c1:toast("info", "No editor is waiting for its board", "Open the .pen file again to start an editor")
				return
			end
			revealBoard(c1, sess)
		end)
	end,
}
