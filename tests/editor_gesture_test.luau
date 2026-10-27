--!strict
local stub = require("./stub")
local gesture = stub.attach(require("../lib/editor_gesture"))
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

-- Everything the board shows, `one` as given and `two` where it was drawn unless the test says otherwise.
local function board(...: any): drafts.Listing
	local shapes: { any } = { ... }
	local has_two = false
	for _, item in shapes do
		has_two = has_two or item.id == "two"
	end
	if not has_two then
		table.insert(shapes, shape("two", 200, 20, 50, 50))
	end
	return { shapes = shapes, more = 0 }
end

local KNOWN: drafts.Known = {
	one = { path = "frame-a/one", x = 10, y = 20, w = 100, h = 40 },
	two = { path = "frame-a/two", x = 200, y = 20, w = 50, h = 50 },
}

local NOTHING: gesture.Verdict = { changes = {}, ids = {}, bounced = {}, rebuild = nil }

local function row(path: string, x: number, y: number, w: number, h: number, extra: any?): any
	local node: any = {
		path = path, parent_path = "frame-a", type = "rectangle", layout = "none", frame_id = "frame-a",
		geometry = { x = x, y = y, width = w, height = h, visible = true, captures = true, ambiguous = false, opacity = 1 },
	}
	for key, value in extra or {} do
		node[key] = value
	end
	return node
end

-- Two looks at the same board: the end of a gesture, if there is one.
local function ends(state: gesture.State, known: drafts.Known, listing: drafts.Listing): gesture.Verdict
	gesture.observe(state, known, listing)
	return gesture.observe(state, known, listing)
end

tests.a_gesture_still_changing_is_not_applied = function(t)
	stub.install({})
	local state = gesture.new()
	for step = 1, 4 do
		local verdict = gesture.observe(state, KNOWN, board(shape("one", 10 + step * 20, 20, 100, 40)))
		t.eq(verdict.changes, {}, "the shape is still moving at look " .. step)
		t.eq(verdict.rebuild, nil)
	end
end

tests.the_same_difference_at_two_looks_in_a_row_is_the_end_of_the_gesture_and_applies_once = function(t)
	stub.install({})
	local state = gesture.new()
	local moved = board(shape("one", 90, 70, 100, 40))
	t.eq(gesture.observe(state, KNOWN, moved).changes, {})
	local verdict = gesture.observe(state, KNOWN, moved)
	t.eq(verdict.changes, { { path = "frame-a/one", x = 90, y = 70, w = 100, h = 40 } })
	t.eq(verdict.ids, { ["frame-a/one"] = "one" }, "and which shape it came from")
	t.eq(gesture.observe(state, KNOWN, moved).changes, {}, "the end of a gesture is not reported twice")
end

tests.a_pause_in_the_middle_of_a_gesture_restarts_the_count = function(t)
	stub.install({})
	local state = gesture.new()
	gesture.observe(state, KNOWN, board(shape("one", 90, 70, 100, 40)))
	t.eq(gesture.observe(state, KNOWN, board(shape("one", 120, 70, 100, 40))).changes, {})
	t.eq(#gesture.observe(state, KNOWN, board(shape("one", 120, 70, 100, 40))).changes, 1)
end

tests.a_shape_that_goes_back_to_where_it_was_drawn_is_not_a_gesture = function(t)
	stub.install({})
	local state = gesture.new()
	gesture.observe(state, KNOWN, board(shape("one", 90, 70, 100, 40)))
	t.eq(gesture.observe(state, KNOWN, board(shape("one", 10, 20, 100, 40))).changes, {})
	t.eq(gesture.observe(state, KNOWN, board(shape("one", 10, 20, 100, 40))).changes, {})
	t.eq(gesture.observe(state, KNOWN, board(shape("one", 90, 70, 100, 40))).changes, {}, "and the count starts over")
end

tests.a_target_moved_back_to_a_place_it_was_drawn_at_before_is_an_ordinary_move = function(t)
	stub.install({})
	local state = gesture.new()
	-- one was drawn at (10,20), moved to (90,70) and drawn again there; now the user drops it at (10,20) again.
	gesture.drawn(state, projection.targets({ row("frame-a/one", 10, 20, 100, 40) }, "frame-a"), { row("frame-a/one", 10, 20, 100, 40) })
	gesture.drawn(state, projection.targets({ row("frame-a/one", 90, 70, 100, 40) }, "frame-a"), { row("frame-a/one", 90, 70, 100, 40) })
	local now: drafts.Known = { one = { path = "frame-a/one", x = 90, y = 70, w = 100, h = 40 } }
	local verdict = ends(state, now, { shapes = { shape("one", 10, 20, 100, 40) }, more = 0 })
	t.eq(verdict.changes, { { path = "frame-a/one", x = 10, y = 20, w = 100, h = 40 } })
	t.eq(verdict.rebuild, nil)
end

tests.noise_below_the_tolerance_is_not_a_gesture = function(t)
	stub.install({})
	local state = gesture.new()
	local noisy = board(shape("one", 10 + drafts.TOLERANCE / 2, 20, 100, 40))
	t.eq(ends(state, KNOWN, noisy).changes, {})
end

tests.a_move_keeps_the_drawn_size_and_a_resize_keeps_the_drawn_position = function(t)
	stub.install({})
	local state = gesture.new()
	local moved = ends(state, KNOWN, board(shape("one", 50, 20, 100 + drafts.TOLERANCE / 2, 40)))
	t.eq(moved.changes, { { path = "frame-a/one", x = 50, y = 20, w = 100, h = 40 } })
	local resized = ends(state, KNOWN, board(shape("two", 200, 20, 80, 90)))
	t.eq(resized.changes, { { path = "frame-a/two", x = 200, y = 20, w = 80, h = 90 } })
end

tests.two_shapes_ending_together_are_one_verdict_in_a_fixed_order = function(t)
	stub.install({})
	local state = gesture.new()
	local both = board(shape("two", 260, 80, 50, 50), shape("one", 90, 70, 100, 40))
	local paths = {}
	for _, change in ends(state, KNOWN, both).changes do
		table.insert(paths, change.path)
	end
	t.eq(paths, { "frame-a/one", "frame-a/two" })
end

tests.a_rotation_is_carried_for_the_owner_to_refuse = function(t)
	stub.install({})
	local state = gesture.new()
	local verdict = ends(state, KNOWN, board(shape("one", 10, 20, 100, 40, { rotation = 30 })))
	t.eq(verdict.changes, { { path = "frame-a/one", x = 10, y = 20, w = 100, h = 40, rotation = 30 } })
end

tests.a_target_the_user_deleted_is_a_rebuild_and_never_a_change = function(t)
	stub.install({})
	local state = gesture.new()
	local verdict = ends(state, KNOWN, { shapes = { shape("two", 200, 20, 50, 50) }, more = 0 })
	t.eq(verdict.rebuild, "deleted")
	t.eq(verdict.changes, {})
end

tests.a_listing_that_left_shapes_out_says_nothing = function(t)
	stub.install({})
	local state = gesture.new()
	local partial: drafts.Listing = { shapes = { shape("one", 90, 70, 100, 40) }, more = 1 }
	gesture.observe(state, KNOWN, partial)
	t.eq(gesture.observe(state, KNOWN, partial), NOTHING)
end

tests.shapes_the_user_drew_and_the_plugins_own_shapes_are_never_looked_at = function(t)
	stub.install({})
	local state = gesture.new()
	local verdict = ends(state, KNOWN, board(
		shape("one", 10, 20, 100, 40),
		shape("drawing", 5, 5, 300, 300, { type = "ink" }),
		shape("halo", 0, 0, 40, 40),
		shape("png", 0, 0, 800, 600, { type = "image", locked = true })
	))
	t.eq(verdict, NOTHING)
end

tests.a_style_change_on_a_target_is_not_a_gesture = function(t)
	stub.install({})
	local state = gesture.new()
	local verdict = ends(state, KNOWN, board(shape("one", 10, 20, 100, 40, { opacity = 0.4, width = 3, color = "#ff0000" })))
	t.eq(verdict, NOTHING)
end

local function flagged(movable: boolean, resizable: { width: boolean, height: boolean }, reorderable: boolean?): (gesture.State, drafts.Known)
	local state = gesture.new()
	local node = row("frame-a/one", 10, 20, 100, 40, { movable = movable, resizable = resizable, reorderable = reorderable })
	gesture.drawn(state, projection.targets({ node }, "frame-a"), { node })
	return state, { one = KNOWN.one }
end

tests.an_element_the_layout_places_that_the_user_moves_is_bounced_with_the_reason = function(t)
	stub.install({})
	local state, known = flagged(false, { width = true, height = true })
	local verdict = ends(state, known, board(shape("one", 90, 70, 100, 40)))
	t.eq(verdict.changes, {})
	t.eq(verdict.bounced, { { path = "frame-a/one", note = "NOT_MOVABLE" } })
end

tests.an_element_the_layout_places_can_be_dropped_elsewhere_in_its_parent_and_the_owner_decides = function(t)
	stub.install({})
	local state, known = flagged(false, { width = true, height = true }, true)
	local verdict = ends(state, known, board(shape("one", 90, 70, 100, 40)))
	t.eq(verdict.changes, { { path = "frame-a/one", x = 90, y = 70, w = 100, h = 40 } })
	t.eq(verdict.bounced, {})
end

tests.a_resize_of_an_element_the_layout_places_still_obeys_the_size_flags = function(t)
	stub.install({})
	local state, known = flagged(false, { width = false, height = true }, true)
	local verdict = ends(state, known, board(shape("one", 10, 20, 160, 40)))
	t.eq(verdict.changes, {})
	t.eq(verdict.bounced, { { path = "frame-a/one", note = "NOT_RESIZABLE" } })
end

tests.an_element_of_automatic_size_that_the_user_resizes_is_bounced_with_the_reason = function(t)
	stub.install({})
	local state, known = flagged(true, { width = false, height = false })
	local verdict = ends(state, known, board(shape("one", 10, 20, 160, 90)))
	t.eq(verdict.changes, {})
	t.eq(verdict.bounced, { { path = "frame-a/one", note = "NOT_RESIZABLE" } })
	local moved = ends(state, known, board(shape("one", 90, 70, 100, 40)))
	t.eq(#moved.changes, 1, "moving it is still fine")
end

tests.an_element_with_one_fixed_axis_can_be_resized_on_that_axis_only = function(t)
	stub.install({})
	-- width is a number in the schema, height is fit-content.
	local state, known = flagged(true, { width = true, height = false })
	local wider = ends(state, known, board(shape("one", 10, 20, 160, 40)))
	t.eq(wider.changes, { { path = "frame-a/one", x = 10, y = 20, w = 160, h = 40 } })
	t.eq(wider.bounced, {})
	local taller = ends(state, known, board(shape("one", 10, 20, 100, 90)))
	t.eq(taller.changes, {})
	t.eq(taller.bounced, { { path = "frame-a/one", note = "NOT_RESIZABLE" } })
	local both = ends(state, known, board(shape("one", 10, 20, 160, 90)))
	t.eq(both.bounced, { { path = "frame-a/one", note = "NOT_RESIZABLE" } }, "a change of the automatic axis is never offered")
end

tests.a_bounce_waits_for_the_end_of_the_gesture_like_an_apply = function(t)
	stub.install({})
	local state, known = flagged(false, { width = true, height = true })
	local verdict = gesture.observe(state, known, board(shape("one", 90, 70, 100, 40)))
	t.eq(verdict.bounced, {})
end

tests.targets_with_no_flags_from_the_owner_are_left_to_the_owner_to_refuse = function(t)
	stub.install({})
	local state = gesture.new()
	t.eq(#ends(state, KNOWN, board(shape("one", 90, 70, 100, 40))).changes, 1)
end

tests.a_rebuild_forgets_what_waited_for_a_second_look = function(t)
	stub.install({})
	local state = gesture.new()
	local moved = board(shape("one", 90, 70, 100, 40))
	gesture.observe(state, KNOWN, moved)
	gesture.reset(state)
	t.eq(gesture.observe(state, KNOWN, moved).changes, {}, "a shape drawn anew starts its count over")
end

tests.targets_the_session_took_off_the_board_are_recognised_by_id_when_they_come_back = function(t)
	stub.install({})
	local state = gesture.new()
	t.eq(gesture.retire(state, { "old-b", "old-a" }), 0)
	t.eq(gesture.retire(state, { "old-a" }), 0, "twice is once")
	local on_board = { ["old-a"] = true, ["user-shape"] = true, ["purple-lookalike"] = true }
	t.eq(gesture.revived(state, on_board), { "old-a" }, "only by id: nothing that merely looks like a target")
end

tests.the_retired_ids_are_capped_oldest_first_and_the_cut_is_reported = function(t)
	stub.install({})
	local state = gesture.new()
	local ids: { string } = {}
	for index = 1, gesture.MAX_RETIRED + 3 do
		table.insert(ids, string.format("id-%04d", index))
	end
	t.eq(gesture.retire(state, ids), 3)
	t.eq(#state.retired, gesture.MAX_RETIRED)
	t.eq(gesture.revived(state, { ["id-0001"] = true, ["id-0003"] = true, ["id-0004"] = true }), { "id-0004" })
	t.eq(gesture.retire(state, { "id-9999" }), 1)
end

tests.a_rebuild_does_not_forget_the_retired_ids = function(t)
	stub.install({})
	local state = gesture.new()
	gesture.retire(state, { "old" })
	gesture.reset(state)
	t.eq(gesture.revived(state, { old = true }), { "old" })
end

return tests
