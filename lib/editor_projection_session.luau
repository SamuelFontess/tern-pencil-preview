--!strict
-- The session half of the native editor projection: the state of one board view, the owner's replies it accepts,
-- and what the board shows against what the owner last said.
local mirror = require("./mirror")

local projection = {}

projection.MAX_PAGE_NODES = 64

-- The owner's reply envelope this module reads: `request_id`, `status_seq`, `view_generation`, `page`
-- ({frame_id, revision, nodes, cursor, next_cursor}) and `focus` ({frame_id, selected_node}).

export type Tag = { session_id: string, pane: number, generation: number }
export type ExpectedPage = { request_id: string, cursor: number, revision: number? }
export type State = {
	session_id: string,
	pane: number,
	generation: number,
	closed: boolean,
	last_error: string?,
	latest_reply: any?,
	status_seq: number,
	seen_requests: { [string]: boolean },
	owned: { [string]: boolean },
	partial: { [string]: boolean },
}

export type Known = { scene: number?, focus: string?, selected: string? }

function projection.begin(session_id: string, pane: number, generation: number): State
	return {
		session_id = session_id,
		pane = pane,
		generation = generation,
		closed = false,
		last_error = nil,
		latest_reply = nil,
		status_seq = 0,
		seen_requests = {},
		owned = {},
		partial = {},
	}
end

-- The state of the next view generation: the shapes already on the board stay owned, everything about the old
-- generation's requests is forgotten. Cancel the old state first to drop its half-built shapes.
function projection.advance(state: State, generation: number): State
	return {
		session_id = state.session_id,
		pane = state.pane,
		generation = generation,
		closed = state.closed,
		last_error = nil,
		latest_reply = nil,
		status_seq = state.status_seq,
		seen_requests = {},
		owned = table.clone(state.owned),
		partial = {},
	}
end

function projection.accept(state: State, tag: Tag): boolean
	return not state.closed and state.session_id == tag.session_id and state.pane == tag.pane and state.generation == tag.generation
end

function projection.close(state: State)
	state.closed = true
	state.latest_reply = nil
end

function projection.owned_ids(state: State): { string }
	local ids: { string } = {}
	for id, owned in state.owned do
		if owned then
			table.insert(ids, id)
		end
	end
	table.sort(ids)
	return ids
end

local function page_of(reply: any): any?
	if typeof(reply) ~= "table" then
		return nil
	end
	if typeof(reply.page) == "table" then
		return reply.page
	end
	if typeof(reply.projection) == "table" then
		return reply.projection
	end
	return nil
end

local function valid_reply(state: State, reply: any): boolean
	local page = page_of(reply)
	return not state.closed and typeof(reply) == "table"
		and typeof(reply.request_id) == "string"
		and typeof(reply.status_seq) == "number"
		and typeof(reply.view_generation) == "number"
		and reply.view_generation == state.generation
		and typeof(page) == "table"
end

-- Offers one decoded response to the next tick. A pending or repeated response cannot replace it.
function projection.offer(state: State, reply: any): boolean
	if state.latest_reply ~= nil then
		state.last_error = "REPLY_PENDING"
		return false
	end
	if not valid_reply(state, reply) then
		state.last_error = "BAD_REPLY"
		return false
	end
	local request_id = (reply :: any).request_id :: string
	-- An unchanged status_seq is a repeat poll; a smaller one is a reply that overtook a newer one.
	if state.seen_requests[request_id] or (reply :: any).status_seq < state.status_seq then
		state.last_error = "STALE_REPLY"
		return false
	end
	state.latest_reply = reply
	state.last_error = nil
	return true
end

local function dense_count(nodes: { [any]: any }): number?
	local count = 0
	for key in nodes do
		if typeof(key) ~= "number" or key < 1 or key ~= math.floor(key) then
			return nil
		end
		count += 1
	end
	for index = 1, count do
		if nodes[index] == nil then
			return nil
		end
	end
	return count
end

-- Takes the one pending page only when it belongs to the current request/cursor/revision. A nil expected revision
-- (the first page of a scan) accepts any; the caller pins the revision it reads for the rest of the scan.
function projection.take(state: State, expected: ExpectedPage): any?
	local reply = state.latest_reply
	state.latest_reply = nil
	if not valid_reply(state, reply) then
		state.last_error = "BAD_REPLY"
		return nil
	end
	local value = reply :: any
	local page = page_of(value) :: any
	state.seen_requests[value.request_id] = true
	if
		value.request_id ~= expected.request_id
		or page.cursor ~= expected.cursor
		or (expected.revision ~= nil and page.revision ~= expected.revision)
	then
		state.last_error = "STALE_REPLY"
		return nil
	end
	if typeof(page.frame_id) ~= "string" or typeof(page.nodes) ~= "table" then
		state.last_error = "BAD_REPLY"
		return nil
	end
	local count = dense_count(page.nodes)
	if count == nil then
		state.last_error = "BAD_REPLY"
		return nil
	end
	if count > projection.MAX_PAGE_NODES then
		state.last_error = "METADATA_LIMIT"
		return nil
	end
	if page.next_cursor ~= nil and (typeof(page.next_cursor) ~= "number" or page.next_cursor <= page.cursor) then
		state.last_error = "BAD_REPLY"
		return nil
	end
	state.status_seq = value.status_seq
	state.last_error = nil
	return page
end

-- Marks the current construction as stable after all batches have succeeded.
function projection.complete(state: State)
	state.partial = {}
end

-- Returns and forgets just the shapes constructed by this projection generation.
function projection.cancel(state: State): { string }
	local ids: { string } = {}
	for id in state.partial do
		table.insert(ids, id)
		state.owned[id] = nil
	end
	table.sort(ids)
	state.partial = {}
	return ids
end

-- Forgets owned shapes the board no longer has (the user deleted or undid them) and returns their ids. Only call it
-- with a complete listing of the board: a shape missing from a partial one is not gone.
function projection.reconcile(state: State, existing: { [string]: boolean }): { string }
	local forgotten: { string } = {}
	for id, owned in state.owned do
		if owned and not existing[id] then
			table.insert(forgotten, id)
		end
	end
	table.sort(forgotten)
	for _, id in forgotten do
		state.owned[id] = nil
		state.partial[id] = nil
	end
	return forgotten
end

-- Drops the frames whose image or backing shape is gone from the board, so they are drawn again. Returns how many.
function projection.reconcile_shown(shown: { [string]: mirror.Shown }, existing: { [string]: boolean }): number
	local lost: { string } = {}
	for id, entry in shown do
		if not existing[entry.shape] or (entry.bg ~= nil and not existing[entry.bg]) then
			table.insert(lost, id)
		end
	end
	for _, id in lost do
		shown[id] = nil
	end
	return #lost
end

-- Owned shapes no frame uses any more (a replaced image whose deletion did not land): delete them next time.
function projection.orphans(state: State, shown: { [string]: mirror.Shown }): { string }
	local used: { [string]: boolean } = {}
	for _, entry in shown do
		used[entry.shape] = true
		if entry.bg then
			used[entry.bg] = true
		end
	end
	local out: { string } = {}
	for id, owned in state.owned do
		if owned and not used[id] then
			table.insert(out, id)
		end
	end
	table.sort(out)
	return out
end

-- What differs between the board and the owner's latest answer: "revision" and "focus" rebuild the targets,
-- "selection" only restyles. A new revision wins over a focus change, which wins over a selection change.
function projection.drift(known: Known, reply: any): string?
	local page = page_of(reply)
	if page == nil then
		return nil
	end
	if page.revision ~= known.scene then
		return "revision"
	end
	local focus = (reply :: any).focus
	local wanted = if typeof(focus) == "table" then focus.frame_id else nil
	if wanted ~= nil and wanted ~= known.focus then
		return "focus"
	end
	local selected = if typeof(focus) == "table" then focus.selected_node else nil
	if selected ~= known.selected then
		return "selection"
	end
	return nil
end

-- What a step does when it runs: "run" a new chain, "wait" for the one in flight, "peek" at the board while the owner
-- holds a probe (a click on the board is a change the owner cannot see), or "bump" a chain stuck for too long.
projection.BUSY_LIMIT_MS = 240000

function projection.busy_action(busy: boolean, holding: boolean, busy_ms: number): string
	if not busy then
		return "run"
	elseif busy_ms > projection.BUSY_LIMIT_MS then
		return "bump"
	elseif holding then
		return "peek"
	end
	return "wait"
end

-- Probes with nothing to report before the owner is asked to hold the answer, and the longest hold. The owner answers
-- at once when anything changes, so a longer wait only trades the board's own clicks (found by the window on its
-- next step) for fewer callbacks.
projection.QUIET_PROBES = 5
projection.MAX_WAIT_MS = 1600

-- How long the next probe asks the owner to hold its answer for `quiet` probes in a row with nothing to report.
function projection.poll_wait(quiet: number): number
	if quiet < projection.QUIET_PROBES then
		return 0
	elseif quiet < 2 * projection.QUIET_PROBES then
		return projection.MAX_WAIT_MS // 2
	end
	return projection.MAX_WAIT_MS
end

return projection
