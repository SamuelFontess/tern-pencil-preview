--!strict
local level = require("../lib/editor_level")

type T = {
	eq: (actual: any, expected: any, msg: string?) -> (),
	truthy: (v: any, msg: string?) -> (),
}

local tests: { [string]: (t: T) -> () } = {}

local ROWS = {
	{ path = "f1" },
	{ path = "f1/hero", parent_path = "f1" },
	{ path = "f1/hero/title", parent_path = "f1/hero" },
	{ path = "f1/hero/card", parent_path = "f1/hero" },
	{ path = "f1/hero/card/icon", parent_path = "f1/hero/card" },
	{ path = "f1/leaf", parent_path = "f1" },
}

tests.only_elements_with_children_are_levels_that_can_be_entered = function(t)
	local tree = level.tree(ROWS)
	t.eq(level.valid(tree, "f1/hero"), "f1/hero")
	t.eq(level.valid(tree, "f1/hero/card"), "f1/hero/card")
	t.eq(level.valid(tree, "f1/leaf"), nil, "nothing to go into")
	t.eq(level.valid(tree, "f1"), nil, "the frame is the top, not a level of its own")
	t.eq(level.valid(tree, "gone"), nil, "a level the document no longer has")
	t.eq(level.valid(tree, nil), nil)
end

tests.going_out_of_a_level_lands_on_its_parent_and_the_frame_is_the_top = function(t)
	local tree = level.tree(ROWS)
	t.eq(level.out(tree, "f1", "f1/hero/card"), "f1/hero")
	t.eq(level.out(tree, "f1", "f1/hero"), nil)
end

tests.the_label_editor_is_found_anywhere_in_the_boards_view_tree = function(t)
	local closed = { role = "Group", children = { { role = "Application" }, { role = "Group", children = { { role = "Button" } } } } }
	t.eq(level.editing(closed), false)
	local open = { role = "Group", children = { { role = "Application" }, { role = "Group", children = { { role = "MultilineTextInput", value = "" } } } } }
	t.eq(level.editing(open), true)
	t.eq(level.editing("no view"), false, "a board that cannot be read is not editing")
end

return tests
