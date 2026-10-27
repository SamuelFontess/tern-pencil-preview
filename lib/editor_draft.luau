--!strict
-- Geometry of the board. A user's move or resize of a click target is read off the board here: this module turns a fresh
-- reading into candidate changes for the owner, which validates them against the document and builds the file operations
-- itself; a settled gesture is applied at once, with no confirmation step. A target that is missing from the board is never
-- a change: it says the board must be rebuilt (the user may have undone or deleted the shape on the board), not that the
-- node is gone.
local projection = require("./editor_projection")

local drafts = {}

-- Whiteboard coordinates are single precision; anything below this is not a gesture.
drafts.TOLERANCE = 0.05

-- The boxes the board was drawn with, by shape id.
export type Known = { [string]: { path: string, x: number, y: number, w: number, h: number } }
export type Change = { path: string, x: number, y: number, w: number, h: number, rotation: number? }
export type Draft = { changes: { Change }, needs_reconcile: boolean }
-- What the board was asked for: the shapes read and how many of those asked for were left out.
export type Listing = { shapes: { WhiteboardShape }, more: number }

-- The registry of drawn targets in the form `capture` compares against.
function drafts.known(targets: projection.Targets): Known
	local out: Known = {}
	for id, path in targets.by_id do
		local box = targets.box[id]
		if box then
			out[id] = { path = path, x = box.x, y = box.y, w = box.w, h = box.h }
		end
	end
	return out
end

-- A value that did not move beyond the tolerance keeps the exact drawn number, so single-precision noise on one
-- axis never becomes a position (or size) change on that axis.
function drafts.settle(now: number, drawn: number): number
	if math.abs(now - drawn) <= drafts.TOLERANCE then
		return drawn
	end
	return now
end

-- Whether the board shape stands at the box of `change`, within the tolerance.
function drafts.at_box(shape: WhiteboardShape, change: Change): boolean
	return math.abs(shape.x - change.x) <= drafts.TOLERANCE and math.abs(shape.y - change.y) <= drafts.TOLERANCE
		and math.abs(shape.w - change.w) <= drafts.TOLERANCE and math.abs(shape.h - change.h) <= drafts.TOLERANCE
end

-- Candidates from one complete reading. Only shapes of known targets count; shapes the user drew are ignored. A
-- listing that left shapes out cannot tell absent from not listed, so it yields no candidates and asks for a rebuild.
function drafts.capture(known: Known, state: Listing): Draft
	if state.more ~= 0 then
		return { changes = {}, needs_reconcile = true }
	end
	local seen: { [string]: boolean } = {}
	local changes: { Change } = {}
	for _, shape in state.shapes do
		local drawn = known[shape.id]
		if drawn then
			seen[shape.id] = true
			local x, y = drafts.settle(shape.x, drawn.x), drafts.settle(shape.y, drawn.y)
			local w, h = drafts.settle(shape.w, drawn.w), drafts.settle(shape.h, drawn.h)
			local rotation = shape.rotation or 0
			if x ~= drawn.x or y ~= drawn.y or w ~= drawn.w or h ~= drawn.h or rotation ~= 0 then
				table.insert(changes, {
					path = drawn.path,
					x = x,
					y = y,
					w = w,
					h = h,
					rotation = if rotation ~= 0 then rotation else nil,
				})
			end
		end
	end
	local reconcile = false
	for id in known do
		if not seen[id] then
			reconcile = true
		end
	end
	table.sort(changes, function(left, right): boolean
		return left.path < right.path
	end)
	return { changes = changes, needs_reconcile = reconcile }
end

return drafts
