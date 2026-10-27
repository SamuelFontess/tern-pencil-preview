--!strict
local stub = require("./stub")
local drafts = stub.attach(require("../lib/editor_draft"))
local projection = stub.attach(require("../lib/editor_projection"))

type T = {
	eq: (actual: any, expected: any, msg: string?) -> (),
	match: (s: string, pattern: string, msg: string?) -> (),
	truthy: (v: any, msg: string?) -> (),
	raises: (fn: () -> (), pattern: string?, msg: string?) -> (),
}

local tests: { [string]: (t: T) -> () } = {}

local function shape(id: string, x: number, y: number, w: number, h: number, extra: any?): any
	local out: any = { id = id, type = "rect", x = x, y = y, w = w, h = h }
	for key, value in extra or {} do
		out[key] = value
	end
	return out
end

local KNOWN: any = {
	one = { path = "frame-a/one", x = 10, y = 20, w = 100, h = 40 },
	two = { path = "frame-a/two", x = 200, y = 20, w = 50, h = 50 },
}

tests.missing_shape_is_not_document_delete = function(t)
	stub.install({})
	local draft = drafts.capture({ proxy = { path = "text", x = 0, y = 0, w = 100, h = 20 } }, { shapes = {}, more = 0 })
	t.eq(draft.changes, {})
	t.eq(draft.needs_reconcile, true)
end

tests.only_moved_or_resized_known_targets_become_candidates = function(t)
	stub.install({})
	local draft = drafts.capture(KNOWN, {
		shapes = {
			shape("one", 10, 20, 100, 40),
			shape("two", 230, 25, 80, 50),
			shape("drawing", 5, 5, 300, 300),
			shape("locked-png", 0, 0, 800, 600, { locked = true, type = "image" }),
		},
		more = 0,
	})
	t.eq(draft.changes, { { path = "frame-a/two", x = 230, y = 25, w = 80, h = 50 } })
	t.eq(draft.needs_reconcile, false, "annotations and the frame images are not ours to reconcile")
end

tests.an_axis_inside_the_tolerance_keeps_its_drawn_number = function(t)
	stub.install({})
	local noisy = 10 + drafts.TOLERANCE / 2
	local draft = drafts.capture(KNOWN, {
		shapes = { shape("one", noisy, 20 - drafts.TOLERANCE / 2, 160, 40), shape("two", 200, 20, 50, 50) },
		more = 0,
	})
	t.eq(draft.changes, { { path = "frame-a/one", x = 10, y = 20, w = 160, h = 40 } }, "a resize does not carry a position")
end

tests.a_user_who_returns_a_shape_to_where_it_was_leaves_no_draft = function(t)
	stub.install({})
	local draft = drafts.capture(KNOWN, { shapes = { shape("one", 10, 20, 100, 40), shape("two", 200, 20, 50, 50) }, more = 0 })
	t.eq(draft.changes, {})
	t.eq(draft.needs_reconcile, false)
end

tests.a_rotated_target_is_reported_so_the_owner_can_refuse_it = function(t)
	stub.install({})
	local draft = drafts.capture(KNOWN, {
		shapes = { shape("one", 10, 20, 100, 40, { rotation = 30 }), shape("two", 200, 20, 50, 50) },
		more = 0,
	})
	t.eq(draft.changes, { { path = "frame-a/one", x = 10, y = 20, w = 100, h = 40, rotation = 30 } })
end

tests.a_listing_that_left_shapes_out_gives_no_candidates = function(t)
	stub.install({})
	local draft = drafts.capture(KNOWN, { shapes = { shape("one", 99, 99, 100, 40) }, more = 3 })
	t.eq(draft.changes, {})
	t.eq(draft.needs_reconcile, true)
end

tests.a_target_the_user_deleted_asks_for_a_rebuild_and_the_others_still_count = function(t)
	stub.install({})
	local draft = drafts.capture(KNOWN, { shapes = { shape("one", 15, 20, 100, 40) }, more = 0 })
	t.eq(draft.changes, { { path = "frame-a/one", x = 15, y = 20, w = 100, h = 40 } })
	t.eq(draft.needs_reconcile, true)
end

tests.candidates_come_out_in_path_order = function(t)
	stub.install({})
	local draft = drafts.capture(KNOWN, { shapes = { shape("two", 1, 1, 50, 50), shape("one", 1, 1, 100, 40) }, more = 0 })
	t.eq({ draft.changes[1].path, draft.changes[2].path }, { "frame-a/one", "frame-a/two" })
end

local function row(path: string, x: number, y: number, w: number, h: number): any
	return {
		path = path,
		parent_path = "frame-a",
		type = "frame",
		layout = "none",
		geometry = { x = x, y = y, width = w, height = h, visible = true, captures = true, ambiguous = false, opacity = 1 },
		frame_id = "frame-a",
	}
end

tests.the_known_boxes_are_the_ones_the_board_was_drawn_with_and_retired_shapes_leave_them = function(t)
	stub.install({})
	local state = projection.begin("session-a", 7, 2)
	local registry: projection.Targets = { by_path = {}, by_id = {}, box = {} }
	local plan = projection.targets({ row("frame-a/one", 10, 20, 100, 40), row("frame-a/two", 200, 20, 50, 50) }, "frame-a")
	local batch = projection.batches({ edits = plan.edits, replaced = {}, gone = {}, missing = {} })[1]
	projection.adopt_targets(state, batch, { t1 = "shape-one", t2 = "shape-two" }, plan, registry)
	local known = drafts.known(registry)
	t.eq(known["shape-one"], { path = "frame-a/one", x = 10, y = 20, w = 100, h = 40 })
	t.eq(known["shape-two"], { path = "frame-a/two", x = 200, y = 20, w = 50, h = 50 })

	-- The targets are rebuilt: the old shapes are retired, so a late reading of them is neither a change nor a gap.
	local removal = projection.batches({ edits = projection.removals({ "shape-one", "shape-two" }), replaced = {}, gone = {}, missing = {} })[1]
	projection.adopt_targets(state, removal, {}, { edits = {}, paths = {}, boxes = {}, capped = 0 }, registry)
	local late = drafts.capture(drafts.known(registry), { shapes = { shape("shape-one", 90, 90, 100, 40) }, more = 0 })
	t.eq(late, { changes = {}, needs_reconcile = false })
end

return tests
