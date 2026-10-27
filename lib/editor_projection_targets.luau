--!strict
-- Click targets, status halos and the other shapes the projection draws on the board, and the registries that follow them.
local mirror = require("./mirror")
local session = require("./editor_projection_session")
local batching = require("./editor_projection_batch")

local projection = {}


-- Shapes the board gets for one focused frame; more would only slow it down (Layers in the panel reach the rest).
projection.MAX_TARGETS = 300

local TARGET_COLOR = "#7c3aed"
-- A target needs a fill to be clicked inside (an unfilled shape is only hit on its edge), but it must not tint the design:
-- the board hits a shape at any opacity above 0, and one percent is below what the eye sees. The label of a target takes
-- the shape's opacity, so a text node's label rests invisible too; the board's label editor draws its own field. A
-- selected target looks like any other: the board's own selection box marks it (a fill-less shape is not hit inside, so
-- a double click on it would draw a new text instead of opening its label).
local TARGET_OPACITY = 0.01
local TARGET_WIDTH = 1
projection.TARGET_COLOR, projection.TARGET_OPACITY, projection.TARGET_WIDTH = TARGET_COLOR, TARGET_OPACITY, TARGET_WIDTH

-- The target shapes on the board: node path to shape id and back, and the box each was drawn with (what a user's
-- move or resize is compared against).
export type Box = { x: number, y: number, w: number, h: number }
export type Targets = {
	by_path: { [string]: string },
	by_id: { [string]: string },
	box: { [string]: Box },
	-- The shape that catches clicks outside the level the user is in (nil at the top). It is no element's target.
	up: string?,
}
-- `up` is the ref of the catcher outside the level, which has no path.
export type TargetPlan = {
	edits: { WhiteboardEdit },
	paths: { [string]: string },
	boxes: { [string]: Box },
	capped: number,
	up: string?,
}

type State = session.State
type Batch = batching.Batch

-- The frames of a list_frames scan as mirror frames, ready for `mirror.plan`. Only a frame whose content key differs
-- from what the board shows is exported again; a frame whose image is not published yet keeps what it has.
function projection.frames(nodes: { any }, shown: { [string]: mirror.Shown }): { mirror.Frame }
	local out: { mirror.Frame } = {}
	for _, node in nodes do
		if typeof(node) == "table" and typeof(node.id) == "string" and typeof(node.key) == "string" then
			local image = node.image
			local file = if typeof(image) == "table" and typeof(image.path) == "string" then image.path else nil
			local old = shown[node.id]
			table.insert(out, {
				id = node.id,
				x = if typeof(node.x) == "number" then node.x else 0,
				y = if typeof(node.y) == "number" then node.y else 0,
				w = if typeof(node.w) == "number" then node.w else 0,
				h = if typeof(node.h) == "number" then node.h else 0,
				key = node.key,
				fill = node.fill == true,
				exported = file ~= nil and (old == nil or old.key ~= node.key),
				file = file,
			})
		end
	end
	return out
end

export type ActivityPlan = { state: string, text: string, edits: { WhiteboardEdit } }

local ACTIVITY_TEXT: { [string]: string } = {
	loading = "Loading document",
	working = "Updating document",
	saving = "Saving document",
	ready = "Ready",
	error = "Document or render error; image may be out of date",
	disconnected = "Disconnected; images are read-only",
}

-- Halos have their own refs and ownership, never the editable target registry.
function projection.activity_plan(activity: any, frames: { any }): ActivityPlan
	local state = if typeof(activity) == "table" and ACTIVITY_TEXT[activity.state] then activity.state else "error"
	local text = ACTIVITY_TEXT[state] :: string
	if typeof(activity) == "table" and typeof(activity.revision) == "number" then
		text ..= " · document revision " .. tostring(activity.revision)
		text ..= if typeof(activity.rendered_revision) == "number"
			then " · image revision " .. tostring(activity.rendered_revision)
			else " · no published image"
		if activity.dirty == true then
			text ..= " · unsaved"
		end
	end
	local edits: { WhiteboardEdit } = {}
	local affected: { [string]: boolean } = {}
	if (state == "working" or state == "saving") and typeof(activity.affected_frame_ids) == "table" then
		for _, id in activity.affected_frame_ids do
			if typeof(id) == "string" then
				affected[id] = true
			end
		end
	end
	for _, frame in frames do
		if affected[frame.id] and frame.w > 0 and frame.h > 0 then
			local ref = "halo-" .. tostring(#edits + 1)
			table.insert(edits, {
				op = "add", type = "rect", ref = ref,
				x = frame.x - 4, y = frame.y - 4, w = frame.w + 8, h = frame.h + 8,
				color = TARGET_COLOR, fill = "none", width = 3,
			})
			table.insert(edits, { op = "lock", id = ref })
		end
	end
	return { state = state, text = text, edits = edits }
end

local function clipped(geometry: any): (number, number, number, number)
	local x, y, w, h = geometry.x :: number, geometry.y :: number, geometry.width :: number, geometry.height :: number
	local clip = geometry.clip
	if typeof(clip) == "table" then
		local left = math.max(x, clip.x)
		local top = math.max(y, clip.y)
		local right = math.min(x + w, clip.x + clip.width)
		local bottom = math.min(y + h, clip.y + clip.height)
		return left, top, math.max(0, right - left), math.max(0, bottom - top)
	end
	return x, y, w, h
end

local function finite_box(geometry: any): boolean
	for _, key in { "x", "y", "width", "height" } do
		local value = geometry[key]
		if typeof(value) ~= "number" or value ~= value or value == math.huge or value == -math.huge then
			return false
		end
	end
	return true
end

local function drawable(node: any): boolean
	return typeof(node) == "table"
		and typeof(node.path) == "string"
		and typeof(node.geometry) == "table"
		and node.geometry.captures == true
		and finite_box(node.geometry)
end

-- Click targets for the level of the focused `frame` the user is at: its direct children (`inside` nil), or the children
-- of the container `inside`. Targets are drawn back to front, so a click lands on the outer element, never on one inside
-- it. Inside a container, behind its children, the container is a target of its own (a click in its gaps keeps it), and
-- behind that a catcher the size of the level above: a click there is the way out. Each target is cut to its ancestors'
-- clips. Refs are local to the batch that adds them; `paths` maps each ref back to its node and `boxes` to the box it
-- was drawn with.
function projection.targets(nodes: { any }, frame: string, inside: string?): TargetPlan
	local edits: { WhiteboardEdit } = {}
	local paths: { [string]: string } = {}
	local boxes: { [string]: Box } = {}
	local capped = 0
	local up: string? = nil
	local by_path: { [string]: any } = {}
	for _, node in nodes do
		if typeof(node) == "table" and typeof(node.path) == "string" then
			by_path[node.path] = node
		end
	end
	local function place(node: any, outside: boolean)
		local x, y, w, h = clipped(node.geometry)
		if w <= 0 or h <= 0 then
			return
		end
		if #edits >= projection.MAX_TARGETS then
			capped += 1
			return
		end
		local ref = "t" .. tostring(#edits + 1)
		if outside then
			up = ref
		else
			paths[ref] = node.path
			boxes[ref] = { x = x, y = y, w = w, h = h }
		end
		table.insert(edits, {
			op = "add",
			type = "rect",
			ref = ref,
			x = x,
			y = y,
			w = w,
			h = h,
			color = TARGET_COLOR,
			fill = TARGET_COLOR,
			opacity = TARGET_OPACITY,
			width = TARGET_WIDTH,
		})
	end
	if inside ~= nil then
		local row = by_path[inside]
		local above = if row then by_path[row.parent_path] else nil
		if drawable(above) then
			place(above, true)
		end
		if drawable(row) then
			place(row, false)
		end
	end
	local parent = inside or frame
	for _, node in nodes do
		if drawable(node) and node.parent_path == parent then
			place(node, false)
		end
	end
	return { edits = edits, paths = paths, boxes = boxes, capped = capped, up = up }
end

-- Delete edits for `ids`, each within the removal limit. Targets are never locked, so there is nothing to unlock.
function projection.removals(ids: { string }): { WhiteboardEdit }
	local edits: { WhiteboardEdit } = {}
	for first = 1, #ids, batching.MAX_REMOVALS do
		local chunk: { string } = {}
		for index = first, math.min(first + batching.MAX_REMOVALS - 1, #ids) do
			table.insert(chunk, ids[index])
		end
		table.insert(edits, { op = "delete", ids = chunk })
	end
	return edits
end

-- Unlock-then-delete edits for locked shapes of ours (replaced images), each chunk within `size` ids (default, and at
-- most, the removal limit).
function projection.retire(ids: { string }, size: number?): { WhiteboardEdit }
	local step = math.min(size or batching.MAX_REMOVALS, batching.MAX_REMOVALS)
	local edits: { WhiteboardEdit } = {}
	for first = 1, #ids, step do
		local chunk: { string } = {}
		for index = first, math.min(first + step - 1, #ids) do
			table.insert(chunk, ids[index])
		end
		table.insert(edits, { op = "unlock", ids = chunk })
		table.insert(edits, { op = "delete", ids = chunk })
	end
	return edits
end

-- The edit that brings all drawable frames into view, with a margin, or nil when none can be drawn.
function projection.extent(frames: { mirror.Frame }): WhiteboardEdit?
	local left, top, right, bottom = math.huge, math.huge, -math.huge, -math.huge
	for _, frame in frames do
		if frame.w > 0 and frame.h > 0 then
			left, top = math.min(left, frame.x), math.min(top, frame.y)
			right, bottom = math.max(right, frame.x + frame.w), math.max(bottom, frame.y + frame.h)
		end
	end
	if left == math.huge then
		return nil
	end
	local margin = 0.05 * math.max(right - left, bottom - top)
	return { op = "show", x = left - margin, y = top - margin, w = right - left + 2 * margin, h = bottom - top + 2 * margin }
end

-- Like `adopt`, and keeps the target registry in step: refs the board returned become shape ids for their nodes (and
-- remember the box drawn for each), deleted shapes leave the registry.
function projection.adopt_targets(
	state: State,
	batch: Batch,
	refs: { [string]: string },
	plan: TargetPlan,
	targets: Targets
)
	for _, id in batch.removed do
		local path = targets.by_id[id]
		targets.by_id[id] = nil
		targets.box[id] = nil
		if path and targets.by_path[path] == id then
			targets.by_path[path] = nil
		end
		if targets.up == id then
			targets.up = nil
		end
	end
	batching.adopt(state, batch, refs)
	for _, ref in batch.refs do
		local id, path = refs[ref], plan.paths[ref]
		if id and id ~= "" and path then
			targets.by_path[path] = id
			targets.by_id[id] = path
			targets.box[id] = plan.boxes[ref]
		elseif id and id ~= "" and ref == plan.up then
			targets.up = id
		end
	end
end

-- Forgets target shapes the board no longer has (the user deleted or undid them) from the node registry.
function projection.forget_targets(targets: Targets, ids: { string })
	for _, id in ids do
		local path = targets.by_id[id]
		targets.by_id[id] = nil
		targets.box[id] = nil
		if path and targets.by_path[path] == id then
			targets.by_path[path] = nil
		end
		if targets.up == id then
			targets.up = nil
		end
	end
end

-- The target cap is announced once per focused frame, not on every rebuild. Returns whether to announce now and the
-- frame the cap note belongs to (nil when the targets fit).
function projection.cap_notice(noted_focus: string?, focus: string, capped: number): (boolean, string?)
	if capped <= 0 then
		return false, nil
	end
	return noted_focus ~= focus, focus
end

return projection
