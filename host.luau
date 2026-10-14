--!strict
-- The `preview` block: a `.pen` file rendered by the headless `pen interactive` CLI. The path is the
-- block's first launch argument ("Open with › Pencil Preview" or the window's route).
local doc = require("./lib/doc")
local launch = require("./lib/launch")
local script = require("./lib/script")
local util = require("./lib/util")
local view = require("./lib/view")

type State = view.State

local EVERY_MS = 2000
local MAX_PEN = 16 * 1024 * 1024
local MAX_PNG = 64 * 1024 * 1024
local MAX_SIDE = 4096
local RENDER_TIMEOUT_MS = 60000
local OPEN_TIMEOUT_MS = 10000
local TAIL = 400

-- Whether pane `pane` still runs; a block that ended is gone from the list.
local function running(pane: number): boolean
	for _, p in tern.pane.list() do
		if p.pane == pane then
			return true
		end
	end
	return false
end

-- Records an error: a problem card when no image is shown, else a notice in the dock over the image (with a
-- toast when the notice first appears).
local function report(state: State, kind: string, title: string, text: string, detail: string?)
	local problem: view.Problem = { kind = kind, title = title, text = text, detail = detail }
	if state.blob then
		if state.notice == nil then
			-- ToastLevel has no "warning"; the notice reports a failure.
			state.cx:toast("error", problem.title, problem.detail or problem.text)
		end
		state.notice = problem
	else
		state.problem = problem
	end
end

-- After a failed render, the same content and frame are not tried again until one changes (or `r`).
local function settle(state: State, content: string)
	state.disk = content
	state.rendered = state.frame_id
end

local function failRender(state: State, content: string, why: string, r: ProcessResult)
	local out = util.tail(r.stdout .. "\n" .. r.stderr, TAIL)
	local text = why .. ". If the pen CLI is not signed in, run pen login once."
	report(state, "render", "Could not render " .. state.name, text, if out ~= "" then out else nil)
	settle(state, content)
end

local function succeed(state: State, content: string, want: string?, summary: doc.Summary, r: ProcessResult)
	local cx = state.cx
	state.frames = summary.frames
	local exported = summary.exported
	-- A frame chosen while the render ran stays chosen when it still exists; the next tick renders it.
	if state.frame_id == want or util.frame(state.frames, state.frame_id) == nil then
		state.frame_id = exported
	end
	state.disk = content
	state.rendered = exported
	state.updated_at = os.date("%H:%M:%S")
	if exported == nil then
		state.blob, state.png, state.layer, state.notice = nil, nil, nil, nil
		state.problem = {
			kind = "noframes",
			title = "No top-level frames",
			text = state.name .. " has no top-level frame to preview.",
		}
		return
	end
	local png = (state.exports :: string) .. "/" .. exported .. ".png"
	-- An export can fail while pen still exits 0.
	if not tern.fs.exists(png) then
		failRender(state, content, "pen exported no image", r)
		return
	end
	local ok, bytes = pcall(tern.fs.read, png, MAX_PNG)
	if not ok then
		failRender(state, content, "Could not read the exported image: " .. tostring(bytes), r)
		return
	end
	if bytes ~= state.png then
		state.blob = cx:blob(bytes, "image/png")
		state.png = bytes
	end
	state.problem, state.notice = nil, nil
	if not util.has_layer(util.frame(state.frames, state.frame_id), state.layer) then
		state.layer = nil
	end
end

-- Reads the file and renders it when its content or the chosen frame changed since the last render.
-- Returns whether the state changed (a problem, a cleared one, a render started).
local function check(state: State): boolean
	local path = state.path
	if path == nil or state.busy or state.stopped then
		return false
	end
	local cx = state.cx
	local read, content = pcall(tern.fs.read, path, MAX_PEN)
	if not read then
		report(state, "read", "Could not read " .. state.name, tostring(content))
		return true
	end
	local changed = false
	local problem, notice = state.problem, state.notice
	if problem and problem.kind == "read" then
		state.problem, changed = nil, true
	end
	if notice and notice.kind == "read" then
		state.notice, changed = nil, true
	end
	if content == state.disk and state.rendered == state.frame_id then
		return changed
	end
	local cli = launch.pen_cli()
	if cli == nil then
		report(
			state,
			"nocli",
			"pen CLI not found",
			"Install it with `npm i -g @pen.dev/cli`, or point `TERN_PENCIL_CLI` at `pen`, `pen.cmd`, `pen.exe` or its `index.mjs`."
		)
		settle(state, content)
		return true
	end
	local exports, scratch = state.exports :: string, state.scratch :: string
	local prepared, perr = pcall(function()
		-- A fresh export dir, so a PNG left by an earlier render never passes for this one.
		if tern.fs.exists(exports) then
			tern.fs.remove(exports)
		end
		tern.fs.mkdir(exports)
		tern.fs.mkdir((scratch:match("^(.*)[/\\]") or scratch))
	end)
	if not prepared then
		report(state, "spawn", "Could not prepare the export folder", tostring(perr))
		settle(state, content)
		return true
	end
	local argv = table.clone(cli.argv)
	for _, a in { "interactive", "-i", path, "-o", scratch } do
		table.insert(argv, a)
	end
	local want = state.frame_id
	local opts: ProcessOptions = {
		stdin = script.session({ script.refresh(want, exports, MAX_SIDE) }),
		timeout_ms = RENDER_TIMEOUT_MS,
	}
	state.busy = true
	local started, err = pcall(function()
		tern.process.run(argv, opts, function(r: ProcessResult, _: WindowCx?)
			state.busy = false
			if not running(cx.pane) then
				state.stopped = true
				return
			end
			local again = false
			if r.timed_out then
				report(state, "timeout", "Render timed out", "pen took longer than 60 s; the preview tries again.")
			else
				local line = doc.find_summary(r.stdout)
				local summary: doc.Summary? = nil
				local why: string? = "pen printed no summary"
				if line then
					summary, why = doc.parse(line)
				end
				if summary then
					succeed(state, content, want, summary, r)
					-- A frame chosen while this render ran renders right away.
					again = state.frame_id ~= state.rendered
				else
					failRender(state, content, why or "invalid summary", r)
				end
			end
			if again then
				check(state)
			end
			cx:render()
		end)
	end)
	if not started then
		state.busy = false
		report(state, "spawn", "Could not start " .. cli.label, tostring(err))
		settle(state, content)
	end
	return true
end

local function schedule(state: State)
	if state.paused or state.stopped or state.timer then
		return
	end
	local cx = state.cx
	if not running(cx.pane) then
		state.stopped = true
		return
	end
	local handle: TimerHandle? = nil
	handle = tern.timer(EVERY_MS, function()
		-- A timer cancelled by a pause may still fire; only the current one ticks.
		if state.timer ~= handle then
			return
		end
		state.timer = nil
		if not running(cx.pane) then
			state.stopped = true
			return
		end
		if state.paused then
			return
		end
		if check(state) then
			cx:render()
		end
		schedule(state)
	end)
	state.timer = handle
end

local function forceRender(state: State)
	state.disk = nil
	check(state)
end

local function openInApp(state: State, cx: BlockCx)
	local path = state.path
	if path == nil then
		return
	end
	local opener = launch.opener(path)
	local ok, err = pcall(function()
		tern.process.run(opener.argv, { timeout_ms = OPEN_TIMEOUT_MS }, function(_: ProcessResult, _: WindowCx?) end)
	end)
	if not ok then
		cx:toast("error", "Could not start " .. opener.label, tostring(err))
	end
end

local function chooseFrame(state: State, id: string)
	state.frame_id = id
	state.rendered = nil
	check(state)
end

local function currentLayers(state: State): { doc.Layer }
	local frame = util.frame(state.frames, state.frame_id)
	return if frame then frame.layers else {}
end

local preview: BlockDef<State> = {
	init = function(cx: BlockCx, args: { string }, saved: any): State
		local arg: string? = args[1]
		local path = if arg and arg ~= "" then util.resolve(arg, cx.cwd) else nil
		local state: State = {
			cx = cx,
			path = path,
			name = if path then util.basename(path) else "Pencil Preview",
			exports = nil,
			scratch = nil,
			frames = {},
			frame_id = nil,
			layer = nil,
			panel = false,
			blob = nil,
			png = nil,
			busy = false,
			paused = false,
			stopped = false,
			disk = nil,
			rendered = nil,
			problem = nil,
			notice = nil,
			updated_at = nil,
			timer = nil,
		}
		if type(saved) == "table" then
			if type(saved.frame_id) == "string" then
				state.frame_id = saved.frame_id
			end
			if type(saved.layer) == "string" then
				state.layer = saved.layer
			end
			if type(saved.panel) == "boolean" then
				state.panel = saved.panel
			end
			if type(saved.paused) == "boolean" then
				state.paused = saved.paused
			end
		end
		if path == nil then
			state.problem = {
				kind = "nofile",
				title = "No file to preview",
				text = "Open a `.pen` file from the Files pane, or choose **Open with › Pencil Preview** in its menu.",
			}
			return state
		end
		local key = util.key(path)
		-- Per pane: a render empties its export dir, which must never hold another pane's image.
		state.exports = tern.plugin.data .. "/exports/" .. key .. "/" .. tostring(cx.pane)
		state.scratch = tern.plugin.data .. "/scratch/" .. key .. "-" .. tostring(cx.pane) .. ".pen"
		-- The first render runs even when paused, so a restored block shows its design.
		check(state)
		schedule(state)
		return state
	end,

	title = function(state: State): string?
		return state.name
	end,

	view = function(state: State, cx: BlockCx): BlockView
		return view.render(state, cx)
	end,

	key = function(state: State, key: Key, cx: BlockCx): boolean?
		if key.ctrl or key.alt or key.meta then
			return false
		end
		local name = key.name
		local k = key.text or name
		if name == "left" or k == "[" or name == "right" or k == "]" then
			local step = if name == "left" or k == "[" then -1 else 1
			local to = util.neighbour(state.frames, state.frame_id, step)
			if to == nil then
				return false
			end
			chooseFrame(state, to)
		elseif k == "l" then
			state.panel = not state.panel
		elseif name == "up" or k == "k" or name == "down" or k == "j" then
			if not state.panel then
				return false
			end
			local step = if name == "up" or k == "k" then -1 else 1
			local to = util.step_layer(currentLayers(state), state.layer, step)
			if to == nil then
				return false
			end
			state.layer = to
		elseif k == "r" then
			if state.path == nil then
				return false
			end
			forceRender(state)
		elseif name == "space" then
			if state.path == nil then
				return false
			end
			state.paused = not state.paused
			if state.paused then
				local timer = state.timer
				if timer then
					timer:cancel()
					state.timer = nil
				end
			else
				schedule(state)
			end
		elseif k == "p" then
			if state.path == nil then
				return false
			end
			openInApp(state, cx)
		elseif k == "o" then
			local path = state.path
			if path == nil then
				return false
			end
			-- A block's open has origin `link`, which the window's route leaves to the editor.
			cx:open(path)
		elseif k == "y" then
			local layer = state.layer
			if layer == nil then
				return false
			end
			cx:copy(layer)
			cx:toast("success", "Copied layer id", layer)
		else
			return false
		end
		return true
	end,

	event = function(state: State, ev: UiEvent, cx: BlockCx)
		if ev.ev == "action" and ev.act == "render" then
			forceRender(state)
		elseif ev.ev == "action" and ev.act == "open" then
			openInApp(state, cx)
		elseif (ev.ev == "select" or ev.ev == "activate") and type(ev.item) == "string" then
			local item: string = ev.item
			if item:sub(1, #view.LIST_ID) == view.LIST_ID then
				local id = item:sub(#view.LIST_ID + 1)
				if util.has_layer(util.frame(state.frames, state.frame_id), id) then
					state.layer = id
				end
			end
		end
	end,

	save = function(state: State): any
		return { frame_id = state.frame_id, layer = state.layer, panel = state.panel, paused = state.paused }
	end,
}

tern.block.define("preview", preview)