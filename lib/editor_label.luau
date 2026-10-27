--!strict
-- Text typed on the board. The board edits the label of a rectangle natively (a double click), so the target of a text node
-- carries the node's text as its label while the user has it selected, and loses it when the selection leaves. What the
-- user changed is applied as the node's content: when the selection has left, or when the label has stayed as it is for
-- a while. A label equal to the document's text applies nothing (so an Escape, which leaves the label as it was, is
-- nothing). A label typed on an element that is not text is cleared. Nothing here writes the document or the board: it
-- says what to do (`look`), and the window does it and says how it went (`settled`).
local projection = require("./editor_projection")

local label = {}

-- How long a label that differs from the document's text has to stay as it is to be applied while the target is selected.
label.STABLE_MS = 1500
-- The board's font size for a node's: the node's, within what a label can show. The board shares the document's units
-- (frames are drawn at their own size), so a node's font size is the board's.
label.MIN_FONT = 10
label.MAX_FONT = 64
local DEFAULT_FONT = 16
local TOLERANCE = 0.05

-- The text of a text node (and its font size) that the board can edit, by element path.
export type Node = { text: string, font_size: number? }
-- The target whose label is being looked after (one at a time: the one the user has selected). `original` is the text the
-- user started from: the document's text for an editable node and "" for an element that has no text to edit, whose label
-- is a mistake. It is also the `base` a change is sent with, so the owner can tell a node someone else changed meanwhile.
export type Active = {
	id: string,
	path: string,
	editable: boolean,
	original: string,
	-- The text the owner is told the user started from (`base` of a change): moves only when the owner took a text or the
	-- user decided, never when a rebuild refreshes `original`, so a commit from an editor that was open while someone else
	-- changed the node is a conflict and not an overwrite.
	base: string,
	-- The target whose selection the user was last asked about while this label is held.
	asked: string?,
	-- The label last seen when it differed from `original`, and since when.
	last: string?,
	since: number?,
	-- A label the owner refused: not sent again until it changes.
	refused: string?,
	-- The owner said the node's text changed since the user started: the label stays on the board, undecided, and is not
	-- sent again until the user decides (`decide`) or changes it. `current` is what the node has now.
	held: boolean?,
	current: string?,
	-- The board's undo steps at the last look that found the label as it should be (nil: it was never seen so).
	undo: number?,
}
-- `next` is the target selected while the first one was being applied: a rebuild keeps it as it is (`keep`). `picking`: a
-- decision about a held label is being asked.
export type State = { nodes: { [string]: Node }, active: Active?, next: { id: string, path: string }?, watching: number?, picking: boolean? }
export type Change = { path: string, content: string, base: string, leaving: boolean }
-- What the window sees: the id of the one target selected (nil: none, or something else), the board's undo steps, the label
-- of each shape read (a shape that is not there is not in `labels`) and the path of every target.
export type Look = { now: number, selected: string?, undo: number, labels: { [string]: string }, paths: { [string]: string } }
-- What to do, in this order: `edits` on the board, tell the user about a discarded label, send `apply` to the owner.
export type Plan = { edits: { WhiteboardEdit }, apply: Change?, discarded: boolean, ask: boolean? }

function label.new(): State
	return { nodes = {}, active = nil, next = nil, watching = nil, picking = nil }
end

-- Remembers the text of the text nodes among the targets just drawn (`rows` are the owner's: `text` is there only for a
-- text node the board may edit).
function label.drawn(state: State, plan: projection.TargetPlan, rows: { any })
	local by_path: { [string]: any } = {}
	for _, node in rows do
		if typeof(node) == "table" and typeof(node.path) == "string" then
			by_path[node.path] = node
		end
	end
	state.nodes = {}
	for _, path in plan.paths do
		local node = by_path[path]
		if node and node.type == "text" and typeof(node.text) == "string" then
			state.nodes[path] = { text = node.text, font_size = if typeof(node.font_size) == "number" then node.font_size else nil }
		end
	end
end

-- The label goes on the target at the shape's own (almost nothing) opacity: it is there so that a double click opens the
-- board's editor with the node's text, and nothing of it shows over the design. The font size is the node's, so what the
-- user types is the size the element has.
local function fill_edits(id: string, node: Node?, with_text: boolean): { WhiteboardEdit }
	local edits: { WhiteboardEdit } = {}
	if with_text and node then
		table.insert(edits, { op = "text", id = id, text = node.text })
	end
	local size = if node and node.font_size then node.font_size else DEFAULT_FONT
	table.insert(edits, { op = "style", ids = { id }, font_size = math.clamp(math.floor(size + 0.5), label.MIN_FONT, label.MAX_FONT) })
	return edits
end

-- The target without its label.
local function clear_edits(id: string): { WhiteboardEdit }
	return { { op = "text", id = id, text = "" } }
end

local function append(into: { WhiteboardEdit }, edits: { WhiteboardEdit })
	for _, edit in edits do
		table.insert(into, edit)
	end
end

-- Enter in the board's editor adds a line break and keeps the editor open, so the one that ends up at the end of the
-- label is not the text's: a break at the end beyond the ones the original had goes (taking one away stays).
local function ends(text: string): number
	local count = 0
	local rest = text
	while true do
		local shorter = rest:gsub("\r?\n$", "")
		if shorter == rest then
			return count
		end
		count += 1
		rest = shorter
	end
end

local function trimmed(text: string, original: string): string
	for _ = 1, ends(text) - ends(original) do
		text = text:gsub("\r?\n$", "")
	end
	return text
end

-- What a label that differs from the text asks for: the owner applies it, or it is a mistake and goes. Applying leaves the
-- target in place until the owner has answered (`settled`): a busy owner is asked again at the next look. A label that is
-- only the text with a line break more asks nothing (it is not sent again until it changes).
local function resolve(state: State, plan: Plan, active: Active, text: string, leaving: boolean)
	active.last, active.since = nil, nil
	if active.editable then
		local content = trimmed(text, active.original)
		if content ~= active.original then
			plan.apply = { path = active.path, content = content, base = active.base, leaving = leaving }
			return
		end
		active.refused = text
		if leaving then
			append(plan.edits, clear_edits(active.id))
			state.active = nil
		end
		return
	end
	append(plan.edits, clear_edits(active.id))
	plan.discarded = true
	if leaving then
		state.active = nil
	end
end

-- One look at the board. The selection decides which target is being edited; `plan` is what to do about it.
function label.look(state: State, look: Look): Plan
	local plan: Plan = { edits = {}, apply = nil, discarded = false }
	local active = state.active
	if active and look.labels[active.id] == nil then
		-- The shape is gone from the board (deleted, or an Undo took it): nothing to look after.
		state.active, active = nil, nil
	end
	if active then
		local text = look.labels[active.id]
		local typed = text ~= active.original
		local restored = false
		-- The label is empty because the board never showed the text, or its own Undo took it back (one step less to undo):
		-- that is not the user emptying the node. The text is put back.
		if typed and active.editable and ((active.undo == nil and text == "") or (active.undo ~= nil and look.undo < active.undo)) then
			append(plan.edits, fill_edits(active.id, state.nodes[active.path], true))
			active.last, active.since, active.undo = nil, nil, nil
			typed, restored = false, true
		end
		if look.selected == active.id then
			if not typed then
				if not restored then
					active.undo = look.undo
				end
				active.last, active.since = nil, nil
			elseif text ~= active.refused then
				if active.last ~= text then
					active.last, active.since = text, look.now
				elseif look.now - (active.since :: number) >= label.STABLE_MS then
					resolve(state, plan, active, text, false)
				end
			end
			return plan
		end
		-- The selection has left.
		if typed and active.held and text == active.refused then
			-- Undecided: the label stays on the board. What is selected instead is kept by the rebuilds, and the user is
			-- asked again, once for each target they select.
			local selected = look.selected
			if selected and selected ~= active.id and look.paths[selected] then
				state.next = { id = selected, path = look.paths[selected] }
				if active.asked ~= selected then
					active.asked = selected
					plan.ask = true
				end
			end
			return plan
		end
		if typed and text ~= active.refused then
			-- Whatever is selected now is kept by the rebuild that follows the apply.
			local selected = look.selected
			local path = if selected then look.paths[selected] else nil
			state.next = if selected and path then { id = selected, path = path } else nil
			resolve(state, plan, active, text, true)
			return plan
		end
		if active.editable or text ~= "" then
			append(plan.edits, clear_edits(active.id))
		end
		state.active = nil
	end
	local selected = look.selected
	local path = if selected then look.paths[selected] else nil
	local current = if selected then look.labels[selected] else nil
	if selected == nil or path == nil or current == nil then
		return plan
	end
	local node = state.nodes[path]
	state.next = nil
	state.active = {
		id = selected, path = path, editable = node ~= nil, original = if node then node.text else "",
		base = if node then node.text else "", asked = nil,
		last = nil, since = nil, refused = nil, held = nil, current = nil,
		-- A label already there is the user's, seen as it is: emptying it later is a deliberate edit.
		undo = if current ~= "" then look.undo else nil,
	}
	if node ~= nil then
		-- A label that is already there was typed by the user before the window got to it: it stays.
		append(plan.edits, fill_edits(selected, node, current == ""))
	end
	return plan
end

-- The owner's answer to `apply`. What it took is the document's text now; a refusal is remembered; a conflict leaves
-- everything to be asked again. A target the owner took while the selection was away is drawn again by the rebuild. A
-- "text_conflict" (the node's text changed since the user started, `current` is what it has now) keeps the label on the
-- board, undecided, until the user decides.
function label.settled(state: State, change: Change, outcome: string, current: string?)
	local active = state.active
	if active == nil or active.path ~= change.path then
		return
	end
	if outcome == "applied" or outcome == "unchanged" then
		active.original, active.base, active.last, active.since = change.content, change.content, nil, nil
	elseif outcome == "refused" or outcome == "text_conflict" then
		active.refused = change.content
	end
	if outcome == "text_conflict" then
		active.held, active.current = true, current
		return
	end
	if change.leaving and outcome ~= "conflict" then
		state.active = nil
	end
end

-- What the user decided about a held label: keep their text (it is sent again, from the text the owner said the node had,
-- so a newer change by someone else conflicts again) or the document's (the label goes back to the text the node has now,
-- as the last rebuild read it). Returns the edits for the board.
function label.decide(state: State, keep_mine: boolean): { WhiteboardEdit }
	local edits: { WhiteboardEdit } = {}
	local active = state.active
	if active == nil or not active.held then
		return edits
	end
	local node = state.nodes[active.path]
	local owners = active.current or (if node then node.text else "")
	local document = if node then node.text else owners
	local current = if keep_mine then owners else document
	active.original, active.base, active.refused, active.held, active.current = current, current, nil, nil, nil
	active.last, active.since = nil, nil
	if not keep_mine then
		table.insert(edits, { op = "text", id = active.id, text = current })
	end
	return edits
end

local function inside(shape: WhiteboardShape, box: projection.Box): boolean
	return math.abs(shape.x - box.x) <= TOLERANCE and math.abs(shape.y - box.y) <= TOLERANCE
		and math.abs(shape.w - box.w) <= TOLERANCE and math.abs(shape.h - box.h) <= TOLERANCE
end

-- A rebuild draws every target again, but not the one whose label the user may be typing in, nor the one they went on to
-- select while this one was applied (a new shape would take the editor from under their hands): they stay. `read` is the
-- board's shapes as read just before, `have` the ids it still has (a shape that could not be read now is kept too, as it
-- is). What the user typed is never replaced by the document's text: the label keeps the `original` it started from, so
-- the owner can tell a node somebody else changed. Returns the refs of the plan that keep their shape (ref to id) and the
-- edits that go with it, to be made after the targets are drawn again: the last brings each shape to the front, where it
-- was never covered by the parents drawn after it (an older shape is below them, and a click in its box would select the
-- parent).
function label.keep(
	state: State,
	plan: projection.TargetPlan,
	read: { [string]: WhiteboardShape },
	have: { [string]: boolean }?
): ({ [string]: string }, { WhiteboardEdit })
	local held: { [string]: string } = {}
	local edits: { WhiteboardEdit } = {}
	local function hold(id: string, path: string): boolean
		local ref: string? = nil
		for candidate, target in plan.paths do
			if target == path then
				ref = candidate
			end
		end
		local shape = read[id]
		if ref == nil or (shape == nil and not (have and have[id])) then
			return false
		end
		held[ref] = id
		local box = plan.boxes[ref]
		if shape and box and not inside(shape, box) then
			table.insert(edits, { op = "resize", ids = { id }, x = box.x, y = box.y, w = box.w, h = box.h })
		end
		table.insert(edits, { op = "order", ids = { id }, to = "front" })
		return true
	end
	local active = state.active
	if active then
		local node, shape = state.nodes[active.path], read[active.id]
		if node == nil or not active.editable or not hold(active.id, active.path) then
			state.active = nil
		else
			active.last, active.since = nil, nil
			if shape and (shape.text or "") == active.original and node.text ~= active.original then
				-- Untouched, and the document's text has changed meanwhile.
				table.insert(edits, 1, { op = "text", id = active.id, text = node.text })
				active.original = node.text
			end
		end
	end
	local following = state.next
	state.next = nil
	if following and not (state.active and state.active.id == following.id) then
		hold(following.id, following.path)
	end
	return held, edits
end

-- `keep` for a rebuild of the targets: the nodes are those of the plan, and what is kept is registered as the target of
-- its element (at the box the document gives it). `keep_refs` gets the refs that keep their shape.
function label.hold(
	state: State,
	plan: projection.TargetPlan,
	rows: { any },
	read: { [string]: WhiteboardShape },
	have: { [string]: boolean },
	targets: projection.Targets,
	keep_refs: { [string]: string }
): { WhiteboardEdit }
	label.drawn(state, plan, rows)
	local held, edits = label.keep(state, plan, read, have)
	for ref, id in held do
		keep_refs[ref] = id
		local path = plan.paths[ref]
		targets.by_path[path], targets.by_id[id], targets.box[id] = id, path, plan.boxes[ref]
	end
	return edits
end

return label
