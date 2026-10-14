--!strict
-- Views of the preview block: state in, `BlockView` out. No process or file access.
local doc = require("./doc")
local util = require("./util")

type Frame = doc.Frame
type Layer = doc.Layer

local ui = tern.ui

local view = {}

-- Why there is no image (`problem`) or what went wrong while one is shown (`notice`). Kinds: `nofile`,
-- `read`, `nocli`, `spawn`, `render`, `timeout`, `noframes`. `detail` is the tail of the CLI's output.
export type Problem = { kind: string, title: string, text: string, detail: string? }

export type State = {
	cx: BlockCx,
	path: string?,
	name: string,
	exports: string?, -- export dir of this file under the plugin's data dir
	scratch: string?, -- the `-o` file of `pen interactive`, never saved
	frames: { Frame },
	frame_id: string?,
	layer: string?,
	panel: boolean,
	blob: string?,
	png: string?,
	busy: boolean,
	paused: boolean,
	stopped: boolean,
	disk: string?,
	rendered: string?,
	problem: Problem?,
	notice: Problem?,
	updated_at: string?,
	timer: TimerHandle?,
}

-- Node ids are `<parent id>.<key>`: main → `preview` row → `panel` column → `layers` list → layer id.
view.LIST_ID = "main.preview.panel.layers."

local WARNING_KINDS: { [string]: boolean } = { nofile = true, noframes = true, nocli = true, timeout = true }
local MARKDOWN_KINDS: { [string]: boolean } = { nofile = true, nocli = true }

-- Characters of a notice shown in the dock.
local NOTICE_MAX = 120
local CONTENT_MAX = 200

local function set(node: Node, props: { [string]: any }): Node
	local p: { [string]: any } = node.p or {}
	for k, v in props do
		p[k] = v
	end
	node.p = p
	return node
end

local function button(label: string, act: string, tone: string): Node
	return set(ui.badge(label, tone), { actions = { click = act } })
end

local function num(n: number): string
	local r = math.floor(n * 10 + 0.5) / 10
	if r == math.floor(r) then
		return string.format("%d", r)
	end
	return string.format("%.1f", r)
end

local function clip(s: string, max: number): string
	if #s <= max then
		return s
	end
	local cut = utf8.offset(s, max + 1)
	if cut == nil or cut > #s then
		return s
	end
	return s:sub(1, cut - 1) .. "…"
end

local function problemView(state: State, problem: Problem): Node
	local children: { Node } = {}
	if MARKDOWN_KINDS[problem.kind] then
		table.insert(children, ui.md(problem.text))
	else
		table.insert(children, ui.text({ ui.span(problem.text) }))
	end
	local detail = problem.detail
	if detail then
		table.insert(children, ui.code(detail))
	end
	if state.path then
		table.insert(children, ui.row({ button("Render", "render", "accent"), button("Open in Pencil", "open", "neutral") }))
	end
	local card = ui.card({ ui.span(problem.title, "strong") }, children)
	return set(card, { tone = if WARNING_KINDS[problem.kind] then "warning" else "error" })
end

local function listLines(cx: BlockCx): number
	-- The inspector below the list takes about nine rows, the dock about four.
	return math.max(3, math.floor((cx.rows - 13) * 0.72))
end

local function layersList(state: State, frame: Frame, cx: BlockCx): Node
	local items: { Item } = {}
	local keys: { string } = {}
	local seen: { [string]: boolean } = {}
	for _, l in frame.layers do
		if not seen[l.id] then
			seen[l.id] = true
			local name = if l.name ~= "" then l.name else l.id
			table.insert(items, {
				label = { ui.span(string.rep("  ", math.max(0, l.depth - 1)) .. name) },
				detail = { ui.span(l.type, "dim") },
			})
			table.insert(keys, l.id)
		end
	end
	local list = ui.list(items)
	local kids = list.c or {}
	for i, key in keys do
		set(kids[i], { key = key })
	end
	local props: { [string]: any } = { key = "layers", max = { lines = listLines(cx) } }
	if state.layer then
		props.selected = view.LIST_ID .. state.layer
	end
	return set(list, props)
end

local function findLayer(frame: Frame, id: string?): Layer?
	if id == nil then
		return nil
	end
	for _, l in frame.layers do
		if l.id == id then
			return l
		end
	end
	return nil
end

local function pair(k: string, v: Spans): { Spans }
	return { k, v }
end

local function inspector(layer: Layer?): Node
	if layer == nil then
		return set(ui.text({ ui.span("Select a layer to inspect it", "muted") }), { key = "inspector" })
	end
	local rows: { { Spans } } = {
		pair("id", ui.span(layer.id, "mono")),
		pair("type", layer.type),
	}
	if layer.name ~= "" then
		table.insert(rows, pair("name", layer.name))
	end
	if layer.w and layer.h then
		table.insert(rows, pair("size", num(layer.w) .. "×" .. num(layer.h)))
	end
	if layer.x and layer.y then
		table.insert(rows, pair("position", num(layer.x) .. ", " .. num(layer.y)))
	end
	if layer.fill then
		table.insert(rows, pair("fill", ui.span(layer.fill, "mono")))
	end
	if layer.content then
		table.insert(rows, pair("content", clip(layer.content, CONTENT_MAX)))
	end
	if layer.ref then
		table.insert(rows, pair("ref", ui.span(layer.ref, "mono")))
	end
	if layer.reusable then
		table.insert(rows, pair("reusable", "yes"))
	end
	return set(ui.kv(rows), { key = "inspector" })
end

local function panelView(state: State, frame: Frame, cx: BlockCx): Node
	local children: { Node }
	if #frame.layers == 0 then
		children = { set(ui.text({ ui.span("No layers in this frame", "muted") }), { key = "empty" }) }
	else
		children = { layersList(state, frame, cx), inspector(findLayer(frame, state.layer)) }
	end
	return set(ui.col(children), { key = "panel", basis = 0.35 })
end

local function mainView(state: State, cx: BlockCx): Node
	local frame = util.frame(state.frames, state.frame_id)
	local props: { [string]: any } = {
		key = "image",
		blob = state.blob,
		alt = if frame then frame.name else state.name,
		max = { h = math.max(4, cx.rows - 4) .. "lines" },
		grow = 1,
	}
	if frame then
		props.w = frame.w
		props.h = frame.h
	end
	local children: { Node } = { ui.node("image", props) }
	if state.panel and frame then
		table.insert(children, panelView(state, frame, cx))
	end
	return set(ui.row(children), { key = "preview" })
end

local HINTS = "←→ frame  l layers  ↑↓ layer  r render  space pause  p open in Pencil  o open as text  y copy id"

local function dockView(state: State): Node
	local spans: { Span | string } = { ui.span(state.name, "strong") }
	local frame, at = util.frame(state.frames, state.frame_id)
	if frame then
		table.insert(spans, ui.span(string.format("  frame %d/%d · %s", at, #state.frames, frame.name), "muted"))
	end
	if state.paused then
		table.insert(spans, ui.span("  paused", "warning"))
	elseif state.updated_at then
		table.insert(spans, ui.span("  updated " .. state.updated_at, "muted"))
	end
	if state.busy then
		table.insert(spans, ui.span("  rendering…", "dim"))
	end
	local notice = state.notice
	if notice then
		local line = (notice.title .. ": " .. notice.text):gsub("%s+", " ")
		table.insert(spans, ui.span("  " .. clip(line, NOTICE_MAX), "warning"))
	end
	local status = ui.row({ ui.badge("File", "accent"), set(ui.text(spans), { grow = 1 }) })
	return ui.col({ status, ui.text({ ui.span(HINTS, "dim") }) })
end

function view.render(state: State, cx: BlockCx): BlockView
	-- A region draws its root's children, not the root, so every view sits inside a column.
	if state.blob then
		return { main = ui.col({ mainView(state, cx) }), dock = dockView(state) }
	end
	local problem = state.problem
	if problem then
		return { main = ui.col({ problemView(state, problem) }) }
	end
	local label = if state.busy then "Rendering " .. state.name .. "…" else state.name .. ": waiting to render"
	return { main = ui.col({ ui.progress(nil, label) }), dock = dockView(state) }
end

return view