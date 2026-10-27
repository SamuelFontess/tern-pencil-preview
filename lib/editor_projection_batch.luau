--!strict
-- Splits a mirror plan into whiteboard batches within the board's limits, and records what each batch created.
local mirror = require("./mirror")
local session = require("./editor_projection_session")

local projection = {}

projection.MAX_ADDITIONS = 40
projection.MAX_REMOVALS = 60

export type Batch = {
	edits: { WhiteboardEdit },
	additions: number,
	removals: number,
	refs: { string },
	removed: { string },
}

-- Smaller per-batch limits than MAX_ADDITIONS / MAX_REMOVALS, for edits that cost more per shape (images).
export type Limits = { additions: number?, removals: number? }

type State = session.State
type Plan = mirror.Plan

local function edit_ids(edit: WhiteboardEdit): { string }
	local ids: { string } = {}
	if edit.id then
		table.insert(ids, edit.id)
	end
	if edit.ids then
		for _, id in edit.ids do
			table.insert(ids, id)
		end
	end
	return ids
end

local function addition_count(edits: { WhiteboardEdit }): number
	local count = 0
	for _, edit in edits do
		if edit.op == "add" then
			count += 1
		end
	end
	return count
end

local function removal_count(edits: { WhiteboardEdit }): number
	local count = 0
	for _, edit in edits do
		if edit.op == "delete" then
			count += #edit_ids(edit)
		end
	end
	return count
end

local function local_refs(edit: WhiteboardEdit, definitions: { [string]: boolean }): { string }
	local out: { string } = {}
	local seen: { [string]: boolean } = {}
	local function add(id: string?)
		if id and definitions[id] and not seen[id] then
			seen[id] = true
			table.insert(out, id)
		end
	end
	add(edit.id)
	add(edit.from_shape)
	add(edit.to_shape)
	if edit.ids then
		for _, id in edit.ids do
			add(id)
		end
	end
	return out
end

local function groups(edits: { WhiteboardEdit }): { { WhiteboardEdit } }
	local definitions: { [string]: boolean } = {}
	local parent: { [string]: string } = {}
	for _, edit in edits do
		if edit.op == "add" and edit.ref then
			definitions[edit.ref] = true
			parent[edit.ref] = edit.ref
		end
	end
	local function root(ref: string): string
		local current = parent[ref]
		while current ~= parent[current] do
			parent[current] = parent[parent[current]]
			current = parent[current]
		end
		return current
	end
	local function join(left: string, right: string)
		local a, b = root(left), root(right)
		if a ~= b then
			parent[b] = a
		end
	end
	for _, edit in edits do
		local refs = local_refs(edit, definitions)
		for index = 2, #refs do
			join(refs[1], refs[index])
		end
	end
	local members: { [string]: { WhiteboardEdit } } = {}
	local order: { [string]: number } = {}
	local standalone: { { at: number, edits: { WhiteboardEdit } } } = {}
	for index, edit in edits do
		local refs = local_refs(edit, definitions)
		local key: string? = nil
		if edit.op == "add" and edit.ref then
			key = root(edit.ref)
		elseif #refs > 0 then
			key = root(refs[1])
		end
		if key then
			if members[key] == nil then
				members[key] = {}
				order[key] = index
			end
			table.insert(members[key], edit)
		else
			table.insert(standalone, { at = index, edits = { edit } })
		end
	end
	local ordered: { { at: number, edits: { WhiteboardEdit } } } = standalone
	for key, member in members do
		table.insert(ordered, { at = order[key], edits = member })
	end
	table.sort(ordered, function(left, right): boolean
		return left.at < right.at
	end)
	local out: { { WhiteboardEdit } } = {}
	for _, group in ordered do
		table.insert(out, group.edits)
	end
	return out
end

local function batch_from(edits: { WhiteboardEdit }): Batch
	local refs: { string } = {}
	local removed: { string } = {}
	for _, edit in edits do
		if edit.op == "add" and edit.ref then
			table.insert(refs, edit.ref)
		elseif edit.op == "delete" then
			for _, id in edit_ids(edit) do
				table.insert(removed, id)
			end
		end
	end
	return {
		edits = edits,
		additions = addition_count(edits),
		removals = removal_count(edits),
		refs = refs,
		removed = removed,
	}
end

-- Splits an existing mirror plan without separating local refs from the edits that use them.
function projection.batches(plan: Plan, limits: Limits?): { Batch }
	local max_additions = math.min(if limits and limits.additions then limits.additions else projection.MAX_ADDITIONS, projection.MAX_ADDITIONS)
	local max_removals = math.min(if limits and limits.removals then limits.removals else projection.MAX_REMOVALS, projection.MAX_REMOVALS)
	local out: { Batch } = {}
	local pending: { WhiteboardEdit } = {}
	local additions, removals = 0, 0
	local function flush()
		if #pending > 0 then
			table.insert(out, batch_from(pending))
			pending = {}
			additions, removals = 0, 0
		end
	end
	for _, group in groups(plan.edits) do
		local adding, removing = addition_count(group), removal_count(group)
		if adding > max_additions or removing > max_removals then
			error("BATCH_TOO_LARGE", 2)
		end
		if additions + adding > max_additions or removals + removing > max_removals then
			flush()
		end
		for _, edit in group do
			table.insert(pending, edit)
		end
		additions += adding
		removals += removing
	end
	flush()
	return out
end

-- Registers only refs the successful whiteboard result returned for this batch.
function projection.adopt(state: State, batch: Batch, refs: { [string]: string })
	for _, id in batch.removed do
		if state.owned[id] then
			state.owned[id] = nil
			state.partial[id] = nil
		end
	end
	for _, ref in batch.refs do
		local id = refs[ref]
		if id and id ~= "" then
			state.owned[id] = true
			state.partial[id] = true
		end
	end
end

return projection
