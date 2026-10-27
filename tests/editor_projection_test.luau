--!strict
local stub = require("./stub")
local mirror = stub.attach(require("../lib/mirror"))
local projection = stub.attach(require("../lib/editor_projection"))

type T = {
	eq: (actual: any, expected: any, msg: string?) -> (),
	match: (s: string, pattern: string, msg: string?) -> (),
	truthy: (v: any, msg: string?) -> (),
	raises: (fn: () -> (), pattern: string?, msg: string?) -> (),
}

local tests: { [string]: (t: T) -> () } = {}

local function reply(request_id: string, cursor: number, revision: number, nodes: { any }): any
	return {
		request_id = request_id,
		status_seq = 3,
		view_generation = 2,
		page = { frame_id = "frame-a", cursor = cursor, next_cursor = nil, revision = revision, nodes = nodes },
	}
end

local function ref_property(t: T, batch: any, adopted: { [string]: boolean })
	local local_refs: { [string]: boolean } = {}
	for _, edit in batch.edits do
		if edit.op == "add" and edit.ref then
			local_refs[edit.ref] = true
		end
		for _, id in edit.ids or {} do
			t.truthy(local_refs[id] or adopted[id], "every id is local to this edit or adopted")
		end
		if edit.id then
			t.truthy(local_refs[edit.id] or adopted[edit.id], "every id is local to this edit or adopted")
		end
	end
end

tests.accept_rejects_a_different_session_pane_or_generation = function(t)
	stub.install({})
	local state = projection.begin("session-a", 7, 2)
	t.eq(projection.accept(state, { session_id = "session-a", pane = 7, generation = 2 }), true)
	t.eq(projection.accept(state, { session_id = "session-b", pane = 7, generation = 2 }), false)
	t.eq(projection.accept(state, { session_id = "session-a", pane = 8, generation = 2 }), false)
	t.eq(projection.accept(state, { session_id = "session-a", pane = 7, generation = 1 }), false)
end

tests.partial_page_is_consumed_once_and_pending_reply_is_not_overwritten = function(t)
	stub.install({})
	local state = projection.begin("session-a", 7, 2)
	local first = reply("request-1", 0, 4, { { path = "a" } })
	t.eq(projection.offer(state, first), true)
	t.eq(projection.offer(state, reply("request-2", 1, 4, {})), false)
	t.eq(projection.take(state, { request_id = "request-1", cursor = 0, revision = 4 }), first.page)
	t.eq(projection.offer(state, first), false, "a reply cannot be installed twice")
	t.eq(projection.take(state, { request_id = "request-1", cursor = 0, revision = 4 }), nil)
end

tests.take_discards_pages_that_do_not_match_the_current_request = function(t)
	stub.install({})
	local state = projection.begin("session-a", 7, 2)
	projection.offer(state, reply("request-1", 0, 4, {}))
	t.eq(projection.take(state, { request_id = "request-1", cursor = 1, revision = 4 }), nil)
	t.eq(state.latest_reply, nil)
	t.eq(state.last_error, "STALE_REPLY")
end

tests.take_enforces_the_page_node_limit = function(t)
	stub.install({})
	local state = projection.begin("session-a", 7, 2)
	local nodes: { any } = {}
	for i = 1, projection.MAX_PAGE_NODES + 1 do
		table.insert(nodes, { path = tostring(i) })
	end
	projection.offer(state, reply("request-1", 0, 4, nodes))
	t.eq(projection.take(state, { request_id = "request-1", cursor = 0, revision = 4 }), nil)
	t.eq(state.last_error, "METADATA_LIMIT")
end

tests.take_requires_a_dense_page_node_array = function(t)
	stub.install({})
	for _, nodes in {
		{ [1] = { path = "a" }, extra = { path = "b" } },
		{ first = { path = "a" }, second = { path = "b" } },
		{ [1] = { path = "a" }, [2] = { path = "b" }, [4] = { path = "d" } },
	} do
		local state = projection.begin("session-a", 7, 2)
		projection.offer(state, reply("request-1", 0, 4, nodes))
		t.eq(projection.take(state, { request_id = "request-1", cursor = 0, revision = 4 }), nil)
		t.eq(state.last_error, "BAD_REPLY")
	end
	local state = projection.begin("session-a", 7, 2)
	local many: { any } = {}
	for i = 1, projection.MAX_PAGE_NODES + 1 do
		table.insert(many, { path = tostring(i) })
	end
	projection.offer(state, reply("request-1", 0, 4, many))
	t.eq(projection.take(state, { request_id = "request-1", cursor = 0, revision = 4 }), nil)
	t.eq(state.last_error, "METADATA_LIMIT")
end

tests.batches_keep_distant_local_ref_uses_with_their_definition = function(t)
	stub.install({})
	local edits: { any } = {}
	for i = 1, 41 do
		table.insert(edits, { op = "add", type = "rect", ref = "ref-" .. tostring(i), x = i, y = 0, w = 1, h = 1 })
	end
	table.insert(edits, { op = "lock", id = "ref-1" })
	local batches = projection.batches({ edits = edits, replaced = {}, gone = {}, missing = {} })
	for _, batch in batches do
		t.truthy(batch.additions <= 40)
		ref_property(t, batch, {})
	end
	local first: any = nil
	for _, batch in batches do
		for _, edit in batch.edits do
			if edit.op == "add" and edit.ref == "ref-1" then
				first = batch
			end
		end
	end
	t.truthy(first)
	local definition_at, lock_at = 0, 0
	for index, edit in first.edits do
		if edit.op == "add" and edit.ref == "ref-1" then
			definition_at = index
		elseif edit.op == "lock" and edit.id == "ref-1" then
			lock_at = index
		end
	end
	t.truthy(definition_at > 0 and lock_at > definition_at)
end

tests.batches_reject_one_local_ref_group_that_exceeds_a_limit = function(t)
	stub.install({})
	local edits: { any } = {}
	for i = 1, projection.MAX_ADDITIONS + 1 do
		table.insert(edits, { op = "add", type = "rect", ref = "same", x = i, y = 0, w = 1, h = 1 })
	end
	table.insert(edits, { op = "lock", id = "same" })
	t.raises(function()
		projection.batches({ edits = edits, replaced = {}, gone = {}, missing = {} })
	end, "BATCH_TOO_LARGE")
end

tests.batches_preserve_the_order_of_each_distant_unlock_delete_group = function(t)
	stub.install({})
	local edits = {
		{ op = "unlock", ids = { "old-a" } },
		{ op = "unlock", ids = { "old-b" } },
		{ op = "delete", ids = { "old-a" } },
		{ op = "delete", ids = { "old-b" } },
	}
	local batches = projection.batches({ edits = edits, replaced = {}, gone = {}, missing = {} })
	t.eq(batches[1].edits, edits)
end

tests.batches_preserve_local_refs_and_respect_add_and_removal_limits = function(t)
	stub.install({})
	local edits: { any } = {}
	for i = 1, 41 do
		local ref = "new-" .. tostring(i)
		table.insert(edits, { op = "add", type = "rect", ref = ref, x = i, y = 0, w = 1, h = 1 })
		table.insert(edits, { op = "order", id = ref, to = "back" })
		table.insert(edits, { op = "lock", id = ref })
	end
	for i = 1, 61 do
		table.insert(edits, { op = "unlock", ids = { "old-" .. tostring(i) } })
		table.insert(edits, { op = "delete", ids = { "old-" .. tostring(i) } })
	end
	local batches = projection.batches({ edits = edits, replaced = {}, gone = {}, missing = {} })
	local adopted: { [string]: boolean } = {}
	for i = 1, 61 do
		adopted["old-" .. tostring(i)] = true
	end
	for _, batch in batches do
		t.truthy(batch.additions <= 40)
		t.truthy(batch.removals <= 60)
		ref_property(t, batch, adopted)
		for _, ref in batch.refs do
			adopted[ref] = true
		end
	end
	t.eq(#batches, 3)
end

tests.adopt_records_real_refs_only_after_a_successful_batch = function(t)
	stub.install({})
	local state = projection.begin("session-a", 7, 2)
	local batch = projection.batches({
		edits = {
			{ op = "add", type = "rect", ref = "target", x = 0, y = 0, w = 1, h = 1 },
			{ op = "lock", id = "target" },
		},
		replaced = {}, gone = {}, missing = {},
	})[1]
	projection.adopt(state, batch, { target = "uuid-target" })
	t.eq(projection.cancel(state), { "uuid-target" })
end

tests.cancel_returns_only_partial_owned_ids_and_preserves_annotations = function(t)
	stub.install({})
	local state = projection.begin("session-a", 7, 2)
	state.owned["annotation"] = false
	state.owned["existing-projection"] = true
	state.partial["existing-projection"] = true
	state.partial["new-projection"] = true
	state.owned["new-projection"] = true
	t.eq(projection.cancel(state), { "existing-projection", "new-projection" })
	t.eq(state.owned, { annotation = false })
end

tests.real_mirror_plans_keep_their_edit_order_across_batches = function(t)
	stub.install({})
	local function exists(): boolean
		return true
	end
	local function frame(id: string, exported: boolean, fill: boolean): any
		return { id = id, x = 10, y = 20, w = 100, h = 50, key = "key-" .. id, exported = exported, fill = fill }
	end
	local function assert_plan(plan: any, adopted: { [string]: boolean })
		local edits: { any } = {}
		for _, batch in projection.batches(plan) do
			t.truthy(batch.additions <= projection.MAX_ADDITIONS)
			t.truthy(batch.removals <= projection.MAX_REMOVALS)
			ref_property(t, batch, adopted)
			for _, ref in batch.refs do
				adopted[ref] = true
			end
			for _, edit in batch.edits do
				table.insert(edits, edit)
			end
		end
		t.eq(edits, plan.edits)
	end

	local shown = {
		replaced = { shape = "shape-replaced", key = "old", dir = "old" },
		transparent = { shape = "shape-transparent", bg = "background-transparent", key = "old", dir = "old" },
		gone = { shape = "shape-gone", bg = "background-gone", key = "old", dir = "old" },
	}
	local ordinary = mirror.plan(shown, {
		frame("replaced", true, true),
		frame("transparent", true, false),
		frame("new", true, true),
	}, "renders", exists)
	assert_plan(ordinary, {
		["shape-replaced"] = true,
		["shape-transparent"] = true,
		["background-transparent"] = true,
		["shape-gone"] = true,
		["background-gone"] = true,
	})

	local frames: { any } = {}
	for index = 1, projection.MAX_ADDITIONS + 1 do
		table.insert(frames, frame("large-" .. tostring(index), true, true))
	end
	assert_plan(mirror.plan({}, frames, "renders", exists), {})
end

tests.interleaved_shapes_keep_their_own_operation_order_when_batched = function(t)
	stub.install({})
	local batches = projection.batches({
		edits = {
			{ op = "add", type = "rect", ref = "r", x = 0, y = 0, w = 1, h = 1 },
			{ op = "unlock", ids = { "old" } },
			{ op = "lock", id = "r" },
			{ op = "delete", ids = { "old" } },
		},
		replaced = {}, gone = {}, missing = {},
	})
	local add_at, lock_at, unlock_at, delete_at = 0, 0, 0, 0
	local index = 0
	for _, batch in batches do
		for _, edit in batch.edits do
			index += 1
			if edit.op == "add" and edit.ref == "r" then
				add_at = index
			elseif edit.op == "lock" and edit.id == "r" then
				lock_at = index
			elseif edit.op == "unlock" and edit.ids and edit.ids[1] == "old" then
				unlock_at = index
			elseif edit.op == "delete" and edit.ids and edit.ids[1] == "old" then
				delete_at = index
			end
		end
	end
	t.truthy(add_at > 0 and lock_at > add_at, "the local ref is defined before it is locked")
	t.truthy(unlock_at > 0 and delete_at > unlock_at, "the old UUID is unlocked before deletion")
end

tests.take_accepts_the_first_page_of_a_scan_without_a_known_revision_and_pins_it_for_the_rest = function(t)
	stub.install({})
	local state = projection.begin("session-a", 7, 2)
	local first = reply("request-1", 0, 4, { { path = "a" } })
	first.page.next_cursor = 1
	projection.offer(state, first)
	local page = projection.take(state, { request_id = "request-1", cursor = 0, revision = nil })
	t.eq((page :: any).revision, 4)
	local second = reply("request-2", 1, 5, { { path = "b" } })
	second.status_seq = 4
	projection.offer(state, second)
	t.eq(projection.take(state, { request_id = "request-2", cursor = 1, revision = 4 }), nil, "a revision change mid-scan is stale")
	t.eq(state.last_error, "STALE_REPLY")
end

tests.a_reply_older_than_one_already_taken_is_stale = function(t)
	stub.install({})
	local state = projection.begin("session-a", 7, 2)
	local newer = reply("request-2", 0, 4, {})
	newer.status_seq = 8
	projection.offer(state, newer)
	t.truthy(projection.take(state, { request_id = "request-2", cursor = 0, revision = 4 }))
	local older = reply("request-1", 0, 4, {})
	older.status_seq = 7
	t.eq(projection.offer(state, older), false)
	t.eq(state.last_error, "STALE_REPLY")
	local same = reply("request-3", 0, 4, {})
	same.status_seq = 8
	t.eq(projection.offer(state, same), true, "an unchanged status_seq is a legitimate repeat poll")
end

tests.advance_starts_a_new_generation_that_keeps_owned_ids_but_drops_partial_and_old_replies = function(t)
	stub.install({})
	local state = projection.begin("session-a", 7, 2)
	state.owned["target"] = true
	state.owned["half-built"] = true
	state.partial["half-built"] = true
	projection.offer(state, reply("request-1", 0, 4, {}))
	t.eq(projection.cancel(state), { "half-built" })
	local next_state = projection.advance(state, 3)
	t.eq(next_state.generation, 3)
	t.eq(next_state.owned, { target = true })
	t.eq(next_state.latest_reply, nil)
	t.eq(next_state.seen_requests, {})
	t.eq(projection.accept(next_state, { session_id = "session-a", pane = 7, generation = 2 }), false)
	t.eq(projection.accept(next_state, { session_id = "session-a", pane = 7, generation = 3 }), true)
	t.eq(projection.offer(next_state, reply("request-9", 0, 4, {})), false, "a reply tagged with the old view generation is refused")
	t.eq(next_state.last_error, "BAD_REPLY")
end

local function frame_node(id: string, key: string, image: boolean, fill: boolean?): any
	return {
		id = id, x = 10, y = 20, w = 100, h = 50, key = key, fill = fill ~= false,
		image = if image then { path = "C:/renders/" .. key .. "-1.png", width = 100, height = 50 } else nil,
	}
end

tests.frames_export_only_what_changed_and_keep_frames_without_an_image = function(t)
	stub.install({})
	local shown = {
		same = { shape = "s1", key = "k-same", dir = "" },
		changed = { shape = "s2", key = "old", dir = "" },
		pending = { shape = "s3", key = "k-pending-old", dir = "" },
	}
	local frames = projection.frames({
		frame_node("same", "k-same", true),
		frame_node("changed", "k-changed", true),
		frame_node("new", "k-new", true),
		frame_node("pending", "k-pending", false),
	}, shown)
	t.eq(frames[1].exported, false)
	t.eq(frames[2].exported, true)
	t.eq(frames[3].exported, true)
	t.eq(frames[4].exported, false, "no image yet: the old one stays")
	t.eq(frames[2].file, "C:/renders/k-changed-1.png")
	local plan = mirror.plan(shown, frames, "", function(): boolean
		return true
	end)
	t.eq(plan.replaced, { "changed", "new" })
	local image_paths: { string } = {}
	for _, edit in plan.edits do
		if edit.op == "add" and edit.type == "image" then
			table.insert(image_paths, edit.path :: string)
		end
	end
	t.eq(image_paths, { "C:/renders/k-changed-1.png", "C:/renders/k-new-1.png" })
	t.eq(plan.gone, {})
end

tests.frames_without_a_fill_are_backed_by_white_and_images_end_up_locked = function(t)
	stub.install({})
	local plan = mirror.plan({}, projection.frames({ frame_node("clear", "k", true, false) }, {}), "", function(): boolean
		return true
	end)
	local locked: { [string]: boolean } = {}
	for _, edit in plan.edits do
		if edit.op == "lock" and edit.id then
			locked[edit.id] = true
		end
	end
	t.eq(locked, { ["bg:clear"] = true, ["img:clear"] = true })
end

local function row(path: string, parent: string?, x: number, y: number, w: number, h: number, extra: any?): any
	local geometry: any = { x = x, y = y, width = w, height = h, visible = true, captures = true, ambiguous = false, opacity = 1 }
	for key, value in extra or {} do
		geometry[key] = value
	end
	return { path = path, parent_path = parent, type = "frame", layout = "none", geometry = geometry, frame_id = "frame-a" }
end

tests.rest_targets_are_the_capturing_children_of_the_frame_in_document_order_clipped_to_their_ancestors_and_invisible = function(t)
	stub.install({})
	local plan = projection.targets({
		row("frame-a", nil, 0, 0, 800, 600),
		row("frame-a/one", "frame-a", 10, 20, 100, 40),
		row("frame-a/one/inner", "frame-a/one", 20, 30, 10, 10),
		row("frame-a/hidden", "frame-a", 0, 0, 50, 50, { visible = false, captures = false }),
		row("frame-a/rotated", "frame-a", 0, 0, 50, 50, { captures = false, ambiguous = true }),
		row("frame-a/clipped", "frame-a", 90, 0, 100, 40, { clip = { x = 0, y = 0, width = 120, height = 100 } }),
		row("frame-a/outside", "frame-a", 500, 0, 30, 30, { clip = { x = 0, y = 0, width = 100, height = 100 } }),
		row("frame-a/two", "frame-a", 0, 0, 5, 5),
	}, "frame-a")
	local paths: { string } = {}
	local boxes: { { number } } = {}
	for _, edit in plan.edits do
		t.eq(edit.op, "add")
		t.eq(edit.type, "rect")
		t.truthy(edit.ref and not edit.id, "a target is defined by a local ref")
		t.truthy(edit.fill ~= "none", "an unfilled rectangle cannot be clicked inside")
		t.truthy((edit.opacity :: number) <= 0.02, "the design shows through: a target is there to be clicked, not seen")
		table.insert(paths, plan.paths[edit.ref :: string])
		table.insert(boxes, { edit.x :: number, edit.y :: number, edit.w :: number, edit.h :: number })
	end
	t.eq(paths, { "frame-a/one", "frame-a/clipped", "frame-a/two" }, "the element inside another is not a target at rest")
	t.eq(boxes, { { 10, 20, 100, 40 }, { 90, 0, 30, 40 }, { 0, 0, 5, 5 } })
	t.eq(plan.capped, 0)
	t.eq(plan.up, nil)
end

tests.inside_a_container_the_targets_are_its_children_under_the_container_itself_under_the_level_above = function(t)
	stub.install({})
	local rows = {
		row("frame-a", nil, 0, 0, 800, 600),
		row("frame-a/hero", "frame-a", 10, 20, 400, 300),
		row("frame-a/hero/title", "frame-a/hero", 20, 30, 100, 40),
		row("frame-a/hero/card", "frame-a/hero", 20, 100, 200, 100),
		row("frame-a/hero/card/icon", "frame-a/hero/card", 30, 110, 10, 10),
		row("frame-a/other", "frame-a", 500, 20, 100, 100),
	}
	local plan = projection.targets(rows, "frame-a", "frame-a/hero")
	local order: { string } = {}
	for _, edit in plan.edits do
		table.insert(order, if edit.ref == plan.up then "up" else plan.paths[edit.ref :: string])
	end
	t.eq(order, { "up", "frame-a/hero", "frame-a/hero/title", "frame-a/hero/card" }, "back to front: what is outside, the container, its children")
	t.eq(plan.edits[1].w, 800, "clicking outside the container lands on the frame")
	t.eq(plan.paths[plan.up :: string], nil, "the catcher outside is nothing the user can move")
	local deeper = projection.targets(rows, "frame-a", "frame-a/hero/card")
	local up_box = deeper.edits[1]
	t.eq({ up_box.x, up_box.y, up_box.w, up_box.h }, { 10, 20, 400, 300 }, "out of the card is the hero")
end

tests.a_level_without_a_row_for_the_level_above_has_no_catcher_outside = function(t)
	stub.install({})
	local plan = projection.targets({
		row("frame-a/hero", "frame-a", 10, 20, 400, 300),
		row("frame-a/hero/title", "frame-a/hero", 20, 30, 100, 40),
	}, "frame-a", "frame-a/hero")
	t.eq(plan.up, nil)
	t.eq(#plan.edits, 2)
end

tests.targets_are_capped_and_the_cap_is_reported = function(t)
	stub.install({})
	local nodes: { any } = { row("frame-a", nil, 0, 0, 800, 600) }
	for i = 1, projection.MAX_TARGETS + 5 do
		table.insert(nodes, row("frame-a/n" .. tostring(i), "frame-a", i, 0, 1, 1))
	end
	local plan = projection.targets(nodes, "frame-a")
	t.eq(#plan.edits, projection.MAX_TARGETS)
	t.eq(plan.capped, 5)
	for _, batch in projection.batches({ edits = plan.edits, replaced = {}, gone = {}, missing = {} }) do
		t.truthy(batch.additions <= projection.MAX_ADDITIONS)
		ref_property(t, batch, {})
	end
end

tests.removals_are_chunked_to_the_removal_limit_and_never_lock_first = function(t)
	stub.install({})
	local ids: { string } = {}
	for i = 1, 130 do
		table.insert(ids, string.format("%016x", i))
	end
	local edits = projection.removals(ids)
	t.eq(#edits, 3)
	local total = 0
	for _, edit in edits do
		t.eq(edit.op, "delete")
		t.truthy(#(edit.ids :: { string }) <= projection.MAX_REMOVALS)
		total += #(edit.ids :: { string })
	end
	t.eq(total, 130)
	for _, batch in projection.batches({ edits = edits, replaced = {}, gone = {}, missing = {} }) do
		t.truthy(batch.removals <= projection.MAX_REMOVALS)
	end
	t.eq(projection.removals({}), {})
end

tests.adopt_targets_maps_shape_ids_to_nodes_only_for_refs_the_board_returned = function(t)
	stub.install({})
	local state = projection.begin("session-a", 7, 2)
	local registry =
		{ by_path = { ["frame-a/old"] = "uuid-old" }, by_id = { ["uuid-old"] = "frame-a/old" }, box = { ["uuid-old"] = { x = 0, y = 0, w = 1, h = 1 } } }
	state.owned["uuid-old"] = true
	local plan = projection.targets({
		row("frame-a", nil, 0, 0, 800, 600),
		row("frame-a/one", "frame-a", 1, 1, 10, 10),
		row("frame-a/two", "frame-a", 2, 2, 10, 10),
	}, "frame-a")
	local edits: { any } = projection.removals({ "uuid-old" })
	for _, edit in plan.edits do
		table.insert(edits, edit)
	end
	local batch = projection.batches({ edits = edits, replaced = {}, gone = {}, missing = {} })[1]
	local first_ref = plan.edits[1].ref :: string
	projection.adopt_targets(state, batch, { [first_ref] = "uuid-one" }, plan, registry)
	t.eq(registry.by_path, { ["frame-a/one"] = "uuid-one" })
	t.eq(registry.by_id, { ["uuid-one"] = "frame-a/one" })
	t.eq(registry.box, { ["uuid-one"] = { x = 1, y = 1, w = 10, h = 10 } }, "the box is what the board was drawn with")
	t.eq(state.owned, { ["uuid-one"] = true })
	t.eq(projection.cancel(state), { "uuid-one" })
	t.eq(registry.by_path, { ["frame-a/one"] = "uuid-one" }, "cancel hands the ids back; the caller prunes the registry")
end

tests.reconcile_forgets_only_owned_shapes_the_board_no_longer_has = function(t)
	stub.install({})
	local state = projection.begin("session-a", 7, 2)
	state.owned["kept"] = true
	state.owned["deleted-by-user"] = true
	state.partial["deleted-by-user"] = true
	local forgotten = projection.reconcile(state, { kept = true, ["annotation"] = true })
	t.eq(forgotten, { "deleted-by-user" })
	t.eq(state.owned, { kept = true })
	t.eq(state.partial, {})
	local shown = {
		whole = { shape = "a", bg = "b", key = "k", dir = "" },
		lost_image = { shape = "gone", key = "k", dir = "" },
		lost_bg = { shape = "c", bg = "gone-bg", key = "k", dir = "" },
	}
	local count = projection.reconcile_shown(shown, { a = true, b = true, c = true })
	t.eq(count, 2)
	t.eq(shown, { whole = { shape = "a", bg = "b", key = "k", dir = "" } })
end

tests.orphans_are_owned_frame_shapes_that_no_shown_entry_uses = function(t)
	stub.install({})
	local state = projection.begin("session-a", 7, 2)
	for _, id in { "image", "bg", "stray-b", "stray-a" } do
		state.owned[id] = true
	end
	local shown = { frame = { shape = "image", bg = "bg", key = "k", dir = "" } }
	t.eq(projection.orphans(state, shown), { "stray-a", "stray-b" })
end

tests.drift_names_what_changed_between_the_board_and_the_owner = function(t)
	stub.install({})
	local known = { scene = 4, focus = "frame-a", selected = "frame-a/title" }
	local function drift(revision: number, focus: string?, selected: string?): string?
		return projection.drift(known, {
			request_id = "r",
			status_seq = 1,
			view_generation = 2,
			page = { revision = revision, nodes = {} },
			focus = { frame_id = focus, selected_node = selected },
		})
	end
	t.eq(drift(4, "frame-a", "frame-a/title"), nil)
	t.eq(drift(5, "frame-a", "frame-a/title"), "revision")
	t.eq(drift(5, "frame-b", "frame-a/title"), "revision", "a new revision rebuilds before anything else")
	t.eq(drift(4, "frame-b", "frame-a/title"), "focus")
	t.eq(drift(4, nil, "frame-a/title"), nil, "an owner without a focus does not move the board")
	t.eq(drift(4, "frame-a", "frame-a/other"), "selection")
	t.eq(drift(4, "frame-a", nil), "selection")
end

tests.every_visible_state_has_its_own_message = function(t)
	stub.install({})
	local seen: { [string]: string } = {}
	for _, code in { "TRANSPORT", "METADATA_LIMIT", "BAD_REPLY", "VIEW_STALE", "OWNER_ABSENT", "OWNER_TIMEOUT", "BOARD_FAILED", "TARGETS_CAPPED" } do
		local title, detail = projection.message(code)
		t.truthy(#title > 0 and #detail > 0, code)
		t.eq(seen[title], nil, "titles are distinct: " .. code)
		seen[title] = code
	end
	local title = projection.message("SOMETHING_NEW")
	t.match(title, "SOMETHING_NEW")
end

tests.a_refusal_by_the_layout_tells_the_layout_apart_and_other_refusals_do_not_change = function(t)
	stub.install({})
	local title, horizontal = projection.message("GEOMETRY_CONTROLLED_BY_LAYOUT", "horizontal")
	local vertical_title, vertical = projection.message("GEOMETRY_CONTROLLED_BY_LAYOUT", "vertical")
	local unnamed_title, unnamed = projection.message("GEOMETRY_CONTROLLED_BY_LAYOUT", nil)
	t.truthy(#horizontal > 0 and #vertical > 0 and #unnamed > 0)
	t.eq(horizontal == vertical, false, "the layout decides what is said")
	t.eq(horizontal == unnamed or vertical == unnamed, false, "and so does knowing it")
	t.eq(title == vertical_title and title == unnamed_title, true, "the title is the same")
	local _, other = projection.message("NOT_RESIZABLE", "horizontal")
	t.eq(other, select(2, projection.message("NOT_RESIZABLE")), "only the layout refusal changes with the layout")
end

tests.retire_unlocks_before_deleting_within_the_removal_limit = function(t)
	stub.install({})
	local ids: { string } = {}
	for i = 1, 61 do
		table.insert(ids, string.format("%016x", i))
	end
	local edits = projection.retire(ids)
	t.eq(#edits, 4)
	t.eq({ edits[1].op, edits[2].op, edits[3].op, edits[4].op }, { "unlock", "delete", "unlock", "delete" })
	t.eq(edits[1].ids, edits[2].ids)
	t.eq(#(edits[3].ids :: { string }), 1)
	for _, batch in projection.batches({ edits = edits, replaced = {}, gone = {}, missing = {} }) do
		t.truthy(batch.removals <= projection.MAX_REMOVALS)
	end
	t.eq(projection.retire({}), {})
	local small = projection.retire(ids, 10)
	t.eq(#small, 14, "61 ids in chunks of 10 give 7 unlock/delete pairs")
	for _, batch in projection.batches({ edits = small, replaced = {}, gone = {}, missing = {} }, { removals = 10 }) do
		t.truthy(batch.removals <= 10)
	end
	t.eq(#projection.retire(ids, 1000), 4, "a larger size cannot exceed the removal limit")
end

tests.extent_brings_every_drawable_frame_into_view_with_a_margin = function(t)
	stub.install({})
	local frames: { any } = {
		{ id = "a", x = 0, y = 0, w = 100, h = 50, key = "a", fill = true, exported = true },
		{ id = "b", x = 300, y = 100, w = 100, h = 100, key = "b", fill = true, exported = true },
		{ id = "empty", x = -9000, y = -9000, w = 0, h = 0, key = "e", fill = true, exported = false },
	}
	local view = projection.extent(frames) :: any
	t.eq(view.op, "show")
	t.truthy(view.x < 0 and view.y < 0 and view.x + view.w > 400 and view.y + view.h > 200)
	t.truthy(view.x > -100 and view.y > -100, "an empty frame does not stretch the view")
	t.eq(projection.extent({}), nil)
	t.eq(projection.extent({ { id = "z", x = 0, y = 0, w = 0, h = 10, key = "z", fill = true, exported = false } }), nil)
end

tests.missing_shape_errors_are_recognised_by_the_hosts_real_wording_and_nothing_else = function(t)
	stub.install({})
	-- Captured from Tern 0.9.4 in a private window: `read` and `edit` naming an id that is not on the board.
	local read_error = "runtime error: no shape ffffffffffffffff\nstack traceback:\n\t[C]: in ?\n\t>[C]: in ?\n\tlua#5:2: in function <lua#5:2>"
	local edit_error = "runtime error: Nothing changed: edit 1 (delete): no shape ffffffffffffffff\nstack traceback:\n\t[C]: in ?"
	t.eq(projection.is_missing_shape(read_error), true)
	t.eq(projection.is_missing_shape(edit_error), true)
	for _, other in {
		"runtime error: unknown field `foo`",
		"runtime error: whiteboard is closed",
		"no shape",
		"runtime error: no shape added",
		"runtime error: no shape " .. string.rep("f", 15),
		"runtime error: no shape " .. string.rep("f", 17),
		"Nothing changed: edit 1 (delete): no shape added to the board",
		"",
	} do
		t.eq(projection.is_missing_shape(other), false, other)
	end
	t.eq(projection.is_missing_shape(nil), false)
end

tests.the_target_cap_is_announced_once_per_focused_frame = function(t)
	stub.install({})
	t.eq({ projection.cap_notice(nil, "f1", 0) }, { false, nil })
	t.eq({ projection.cap_notice(nil, "f1", 5) }, { true, "f1" })
	t.eq({ projection.cap_notice("f1", "f1", 5) }, { false, "f1" }, "a rebuild of the same focus stays quiet")
	t.eq({ projection.cap_notice("f1", "f2", 5) }, { true, "f2" }, "another capped frame is announced again")
	t.eq({ projection.cap_notice("f1", "f2", 0) }, { false, nil }, "a frame that fits clears the note")
	t.eq({ projection.cap_notice(nil, "f1", 5) }, { true, "f1" }, "and the cap is announced again when it returns")
end

tests.batches_accept_lower_limits_but_never_higher_ones = function(t)
	stub.install({})
	local edits: { any } = {}
	for i = 1, 5 do
		local ref = "img-" .. tostring(i)
		table.insert(edits, { op = "add", type = "image", ref = ref, path = "p", x = i, y = 0, w = 1 })
		table.insert(edits, { op = "lock", id = ref })
	end
	local plan = { edits = edits, replaced = {}, gone = {}, missing = {} }
	local one = projection.batches(plan, { additions = 1 })
	t.eq(#one, 5)
	for _, batch in one do
		t.eq(batch.additions, 1)
		ref_property(t, batch, {})
	end
	t.eq(#projection.batches(plan, { additions = 2 }), 3)
	t.eq(#projection.batches(plan, { additions = 1000 }), 1, "a larger limit cannot exceed MAX_ADDITIONS")
end

tests.missing_id_names_the_shape_the_host_could_not_find = function(t)
	stub.install({})
	t.eq(projection.missing_id("runtime error: no shape 0123456789abcdef"), "0123456789abcdef")
	t.eq(projection.missing_id("Nothing changed: edit 2 (delete): runtime error: no shape 0123456789abcdef"), "0123456789abcdef")
	t.eq(projection.missing_id("runtime error: no shape 0123"), nil, "not a shape id")
	t.eq(projection.missing_id("runtime error: board is closed"), nil)
end

tests.idle_polling_backs_off_after_quiet_probes_and_starts_over_at_zero = function(t)
	stub.install({})
	t.eq(projection.poll_wait(0), 0)
	t.eq(projection.poll_wait(projection.QUIET_PROBES - 1), 0, "a fresh change keeps the fast path for a while")
	local middle = projection.poll_wait(projection.QUIET_PROBES)
	local longest = projection.poll_wait(100)
	t.truthy(middle > 0 and middle < longest)
	t.eq(longest, projection.MAX_WAIT_MS)
	t.eq(projection.poll_wait(0), 0, "any change resets the count to zero")
end

tests.targets_the_board_lost_leave_both_the_registry_and_ownership = function(t)
	stub.install({})
	local state = projection.begin("session-a", 7, 2)
	local registry: projection.Targets = {
		by_path = { ["frame-a/one"] = "kept", ["frame-a/two"] = "gone" },
		by_id = { kept = "frame-a/one", gone = "frame-a/two" },
		box = { kept = { x = 0, y = 0, w = 1, h = 1 }, gone = { x = 2, y = 2, w = 1, h = 1 } },
	}
	state.owned = { kept = true, gone = true }
	projection.forget_targets(registry, projection.reconcile(state, { kept = true }))
	t.eq(registry.by_path, { ["frame-a/one"] = "kept" })
	t.eq(registry.by_id, { kept = "frame-a/one" })
	t.eq(registry.box, { kept = { x = 0, y = 0, w = 1, h = 1 } })
	t.eq(state.owned, { kept = true }, "what a rebuild reads is bounded by the live targets")
end

tests.a_step_during_a_held_probe_looks_at_the_board_but_not_during_any_other_wait = function(t)
	stub.install({})
	t.eq(projection.busy_action(false, false, 0), "run")
	t.eq(projection.busy_action(true, true, 900), "peek", "a click on the board must not wait for the hold")
	t.eq(projection.busy_action(true, false, 900), "wait", "other chains are not interrupted")
	t.eq(projection.busy_action(true, true, projection.BUSY_LIMIT_MS + 1), "bump")
	t.eq(projection.busy_action(true, false, projection.BUSY_LIMIT_MS + 1), "bump")
end

tests.closed_view_rejects_in_flight_pages_without_closing_another_document = function(t)
	stub.install({})
	local a = projection.begin("session-a", 7, 2)
	local b = projection.begin("session-b", 8, 2)
	projection.offer(a, reply("pending", 0, 4, {}))
	projection.close(a)
	t.eq(a.latest_reply, nil)
	t.eq(projection.accept(a, { session_id = "session-a", pane = 7, generation = 2 }), false)
	t.eq(projection.offer(a, reply("late", 0, 4, {})), false)
	t.eq(projection.accept(b, { session_id = "session-b", pane = 8, generation = 2 }), true)
	t.eq(projection.offer(b, reply("current", 0, 4, {})), true)
end

tests.reopened_view_binds_same_owner_to_new_board_and_rejects_old_callback = function(t)
	stub.install({})
	local old = projection.begin("session-a", 7, 2)
	old.owned.target = true
	projection.close(old)
	local reopened = projection.begin(old.session_id, 9, 3)
	t.eq(projection.accept(reopened, { session_id = "session-a", pane = 7, generation = 2 }), false)
	t.eq(projection.accept(reopened, { session_id = "session-a", pane = 9, generation = 3 }), true)
	t.eq(reopened.owned, {})
	t.eq(old.owned, { target = true }, "closure retains cleanup ownership until deletion succeeds")
end

tests.owner_cleanup_batches_only_private_targets_and_halos_not_images_or_annotations = function(t)
	stub.install({})
	local targets = projection.begin("session-a", 7, 2)
	local halos = projection.begin("session-a", 7, 2)
	local images = projection.begin("session-a", 7, 0)
	images.owned.png = true
	targets.owned.annotation = false
	for i = 1, 125 do
		targets.owned["target-" .. tostring(i)] = true
	end
	halos.owned.halo = true
	local ids = projection.owned_ids(targets)
	for _, id in projection.owned_ids(halos) do
		table.insert(ids, id)
	end
	local batches = projection.batches({ edits = projection.retire(ids), replaced = {}, gone = {}, missing = {} })
	t.eq(#batches, 3)
	local removed = 0
	for _, batch in batches do
		t.truthy(batch.removals <= 60)
		for _, id in batch.removed do
			t.truthy(id ~= "png" and id ~= "annotation")
			removed += 1
		end
	end
	t.eq(removed, 126)
	t.eq(images.owned.png, true)
end

local function activity_frames(): { any }
	return {
		{ id = "frame-a", x = 10, y = 20, w = 100, h = 50 },
		{ id = "frame-b", x = 200, y = 20, w = 80, h = 60 },
	}
end

tests.activity_known_frames_have_separate_locked_purple_halos_and_static_text = function(t)
	stub.install({})
	local plan = projection.activity_plan({
		state = "working", revision = 5, rendered_revision = 4, affected_frame_ids = { "frame-b" },
	}, activity_frames())
	t.eq(plan.state, "working")
	t.truthy(plan.text:find("5", 1, true))
	t.eq(#plan.edits, 2)
	t.eq(plan.edits[1].type, "rect")
	t.eq(plan.edits[1].color, "#7c3aed")
	t.eq(plan.edits[1].x, 196)
	t.eq(plan.edits[2].op, "lock")
	t.eq(plan.edits[2].id, plan.edits[1].ref)
	t.truthy(plan.edits[1].ref:find("halo", 1, true))
end

tests.unknown_affected_frames_show_general_activity_without_invented_frame_halos = function(t)
	stub.install({})
	local plan = projection.activity_plan({ state = "saving", revision = 5, rendered_revision = 5 }, activity_frames())
	t.eq(plan.state, "saving")
	t.eq(plan.edits, {})
	t.truthy(#plan.text > 0)
end

tests.activity_text_says_unsaved_only_while_the_document_has_unsaved_changes = function(t)
	stub.install({})
	local dirty = projection.activity_plan({ state = "ready", revision = 5, rendered_revision = 5, dirty = true }, activity_frames())
	t.match(dirty.text, "unsaved")
	for _, activity in { { state = "ready", revision = 5, rendered_revision = 5, dirty = false }, { state = "ready", revision = 5, rendered_revision = 5 } } do
		t.eq(projection.activity_plan(activity, activity_frames()).text:find("unsaved", 1, true), nil)
	end
end

tests.activity_loading_error_ready_and_disconnected_never_leave_working_halos = function(t)
	stub.install({})
	for _, state in { "loading", "error", "ready", "disconnected" } do
		local plan = projection.activity_plan({
			state = state, revision = 5, rendered_revision = if state == "loading" then nil else 4,
			affected_frame_ids = { "frame-a" },
		}, activity_frames())
		t.eq(plan.state, state)
		t.eq(plan.edits, {})
		t.truthy(#plan.text > 0)
	end
	local missing = projection.activity_plan(nil, activity_frames())
	t.eq(missing.state, "error", "a missing activity envelope cannot report a ready old image")
end

return tests
