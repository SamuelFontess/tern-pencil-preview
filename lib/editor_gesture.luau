--!strict
-- Gestures on the board. The window compares, at every poll, the box of every click target to the box it was drawn
-- with. A difference that is the same at two polls in a row is the end of a gesture and goes to the owner as a
-- candidate change (the owner validates it against the document); one that is still changing is a gesture under way and
-- waits. A shape that is gone was deleted: the board is drawn again and nothing is applied. Nothing here writes the
-- document or the board, and only shapes of known targets ever count, so the user's own drawings and every shape the
-- plugin draws (frames, halos, status) are never gestures.
--
-- The board's own Undo can bring back targets this session drew and later replaced. They are known by id, never by how
-- they look, and are cleaned up when they show up again (`retire`, `revived`).
local drafts = require("./editor_draft")
local projection = require("./editor_projection")

local gesture = {}

-- Retired ids kept per session; past this the oldest go first.
gesture.MAX_RETIRED = 600

-- What the document lets the board change of one element (the owner's `movable`, `reorderable` and, per axis,
-- `resizable`). A `reorderable` element is placed by its parent's auto-layout but may be dropped elsewhere among its
-- siblings: the owner decides where, so such a move is offered rather than bounced.
export type Flags = { movable: boolean, reorderable: boolean, resizable_width: boolean, resizable_height: boolean }
type Reading = { x: number, y: number, w: number, h: number, rotation: number }
export type State = {
	flags: { [string]: Flags },
	-- By shape id: the difference seen at the last look, waiting for a second equal one.
	seen: { [string]: Reading },
	-- The ids of targets this session removed from the board, oldest first.
	retired: { string },
	retired_set: { [string]: boolean },
}
export type Bounce = { path: string, note: string }
-- `changes` are gestures that ended and may be applied (`ids` says which shape each came from, by element path);
-- `bounced` ended on elements the document will not let move or resize; `rebuild` says the board no longer shows what
-- was drawn ("deleted").
export type Verdict = { changes: { drafts.Change }, ids: { [string]: string }, bounced: { Bounce }, rebuild: string? }

function gesture.new(): State
	return { flags = {}, seen = {}, retired = {}, retired_set = {} }
end

-- A rebuild draws every target again: what waited for a second look belonged to shapes that are gone.
function gesture.reset(state: State)
	state.seen = {}
end

-- Remembers target shapes taken off the board, so that a native Undo bringing them back is told from the user's own
-- drawings. Returns how many of the oldest were dropped to stay within MAX_RETIRED.
function gesture.retire(state: State, ids: { string }): number
	for _, id in ids do
		if not state.retired_set[id] then
			state.retired_set[id] = true
			table.insert(state.retired, id)
		end
	end
	local cut = math.max(0, #state.retired - gesture.MAX_RETIRED)
	for _ = 1, cut do
		local oldest = table.remove(state.retired, 1) :: string
		state.retired_set[oldest] = nil
	end
	return cut
end

-- Which of the shapes on the board (ids present) this session had retired, sorted.
function gesture.revived(state: State, present: { [string]: boolean }): { string }
	local out: { string } = {}
	for _, id in state.retired do
		if present[id] then
			table.insert(out, id)
		end
	end
	table.sort(out)
	return out
end

local function near(left: number, right: number): boolean
	return math.abs(left - right) <= drafts.TOLERANCE
end

-- Remembers what the document lets each target's element do (`rows` are the owner's, with `movable`, `reorderable` and
-- `resizable` as `{ width, height }`; an owner that says nothing leaves the decision to its refusal).
function gesture.drawn(state: State, plan: projection.TargetPlan, rows: { any })
	local by_path: { [string]: any } = {}
	for _, node in rows do
		if typeof(node) == "table" and typeof(node.path) == "string" then
			by_path[node.path] = node
		end
	end
	for _, path in plan.paths do
		local node = by_path[path]
		local axes = if node and typeof(node.resizable) == "table" then node.resizable else {}
		state.flags[path] = {
			movable = node == nil or node.movable ~= false,
			reorderable = node ~= nil and node.reorderable == true,
			resizable_width = axes.width ~= false,
			resizable_height = axes.height ~= false,
		}
	end
end

local function sameReading(left: Reading, right: Reading): boolean
	return near(left.x, right.x) and near(left.y, right.y) and near(left.w, right.w) and near(left.h, right.h) and left.rotation == right.rotation
end

-- One look at every known target (read in full: a listing that left shapes out says nothing).
function gesture.observe(state: State, known: drafts.Known, listing: drafts.Listing): Verdict
	local verdict: Verdict = { changes = {}, ids = {}, bounced = {}, rebuild = nil }
	if listing.more ~= 0 then
		return verdict
	end
	local found: { [string]: WhiteboardShape } = {}
	for _, shape in listing.shapes do
		found[shape.id] = shape
	end
	for id, drawn in known do
		local shape = found[id]
		if shape == nil then
			state.seen[id] = nil
			verdict.rebuild = "deleted"
		else
			local reading: Reading = {
				x = drafts.settle(shape.x, drawn.x),
				y = drafts.settle(shape.y, drawn.y),
				w = drafts.settle(shape.w, drawn.w),
				h = drafts.settle(shape.h, drawn.h),
				rotation = shape.rotation or 0,
			}
			local moved = reading.x ~= drawn.x or reading.y ~= drawn.y
			local width_changed, height_changed = reading.w ~= drawn.w, reading.h ~= drawn.h
			if not moved and not width_changed and not height_changed and reading.rotation == 0 then
				state.seen[id] = nil
			else
				local earlier = state.seen[id]
				if earlier == nil or not sameReading(earlier, reading) then
					state.seen[id] = reading
				else
					state.seen[id] = nil
					local flags = state.flags[drawn.path]
					if moved and flags and not flags.movable and not flags.reorderable then
						table.insert(verdict.bounced, { path = drawn.path, note = "NOT_MOVABLE" })
					elseif flags and ((width_changed and not flags.resizable_width) or (height_changed and not flags.resizable_height)) then
						table.insert(verdict.bounced, { path = drawn.path, note = "NOT_RESIZABLE" })
					else
						verdict.ids[drawn.path] = id
						table.insert(verdict.changes, {
							path = drawn.path,
							x = reading.x,
							y = reading.y,
							w = reading.w,
							h = reading.h,
							rotation = if reading.rotation ~= 0 then reading.rotation else nil,
						})
					end
				end
			end
		end
	end
	table.sort(verdict.changes, function(left, right): boolean
		return left.path < right.path
	end)
	table.sort(verdict.bounced, function(left, right): boolean
		return left.path < right.path
	end)
	return verdict
end

return gesture
