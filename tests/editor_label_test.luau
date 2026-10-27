--!strict
local stub = require("./stub")
local label = stub.attach(require("../lib/editor_label"))
local projection = stub.attach(require("../lib/editor_projection"))

type T = {
	eq: (actual: any, expected: any, msg: string?) -> (),
	match: (s: string, pattern: string, msg: string?) -> (),
	truthy: (v: any, msg: string?) -> (),
	raises: (fn: () -> (), pattern: string?, msg: string?) -> (),
}

local tests: { [string]: (t: T) -> () } = {}

local function row(path: string, kind: string, extra: any?): any
	local node: any = {
		path = path, parent_path = "frame-a", type = kind, layout = "none", frame_id = "frame-a",
		geometry = { x = 10, y = 20, width = 100, height = 40, visible = true, captures = true, ambiguous = false, opacity = 1 },
	}
	for key, value in extra or {} do
		node[key] = value
	end
	return node
end

-- Two targets of the focused frame: "lede" is a text node, "hero" a frame. Their shapes are "id-lede" and "id-hero".
local PATHS = { ["id-lede"] = "frame-a/lede", ["id-hero"] = "frame-a/hero", ["id-other"] = "frame-a/other" }
local LEDE = "Pencil renders every frame."

local function drawn(): label.State
	local state = label.new()
	local rows = {
		row("frame-a/lede", "text", { text = LEDE, font_size = 17 }),
		row("frame-a/hero", "frame"),
		row("frame-a/other", "text", { text = "Other", font_size = 200 }),
	}
	label.drawn(state, projection.targets(rows, "frame-a"), rows)
	return state
end

local function look(selected: string?, labels: { [string]: string }, now: number?, undo: number?): label.Look
	return { now = now or 0, selected = selected, undo = undo or 5, labels = labels, paths = PATHS }
end

local function find(edits: { any }, op: string): any
	for _, edit in edits do
		if edit.op == op then
			return edit
		end
	end
	return nil
end

-- The user selects the lede, the window puts its text on the target and the next look sees it there.
local function editing(): label.State
	local state = drawn()
	label.look(state, look("id-lede", { ["id-lede"] = "" }))
	label.look(state, look("id-lede", { ["id-lede"] = LEDE }))
	return state
end

tests.selecting_a_text_target_puts_its_text_on_it_without_changing_how_it_looks = function(t)
	stub.install({})
	local state = drawn()
	local plan = label.look(state, look("id-lede", { ["id-lede"] = "" }))
	local text, style = find(plan.edits, "text"), find(plan.edits, "style")
	t.eq(text.text, LEDE)
	t.eq(text.id, "id-lede")
	t.eq(style.ids, { "id-lede" })
	t.eq(style.font_size, 17, "the font size of the node")
	t.eq({ style.opacity, style.fill, style.width }, {}, "no tint, no white box: the label shows at the shape's opacity, which is nearly nothing")
	t.eq(plan.apply, nil)
end

tests.the_font_size_stays_in_a_range_the_board_can_show = function(t)
	stub.install({})
	local state = drawn()
	local plan = label.look(state, look("id-other", { ["id-other"] = "" }))
	t.eq(find(plan.edits, "style").font_size, label.MAX_FONT)
end

tests.selecting_something_that_is_not_text_edits_nothing = function(t)
	stub.install({})
	local state = drawn()
	t.eq(label.look(state, look("id-hero", { ["id-hero"] = "" })).edits, {})
	t.eq(label.look(state, look(nil, {})).edits, {})
end

tests.a_label_that_is_already_there_is_never_overwritten = function(t)
	stub.install({})
	local state = drawn()
	local plan = label.look(state, look("id-lede", { ["id-lede"] = "typed first" }))
	t.eq(find(plan.edits, "text"), nil, "the user got there before the window did")
	t.truthy(find(plan.edits, "style"), "the style still makes it legible")
	t.eq(label.look(state, look(nil, { ["id-lede"] = "typed first" })).apply, { path = "frame-a/lede", content = "typed first", base = LEDE, leaving = true })
end

tests.a_label_changed_and_left_applies_once_the_selection_leaves = function(t)
	stub.install({})
	local state = editing()
	local plan = label.look(state, look(nil, { ["id-lede"] = "A new lede" }, 100))
	t.eq(plan.apply, { path = "frame-a/lede", content = "A new lede", base = LEDE, leaving = true })
	t.eq(plan.edits, {}, "the board is cleaned by the rebuild that follows the apply, not before the owner has answered")
end

tests.a_label_changed_and_stable_for_a_second_and_a_half_applies_while_still_selected = function(t)
	stub.install({})
	local state = editing()
	local typed = { ["id-lede"] = "A new lede" }
	t.eq(label.look(state, look("id-lede", typed, 1000)).apply, nil)
	t.eq(label.look(state, look("id-lede", typed, 2000)).apply, nil, "1 s")
	t.eq(label.look(state, look("id-lede", typed, 2499)).apply, nil, "1.499 s")
	t.eq(label.look(state, look("id-lede", typed, 2500)).apply, { path = "frame-a/lede", content = "A new lede", base = LEDE, leaving = false })
end

tests.a_label_that_keeps_changing_never_counts_as_stable = function(t)
	stub.install({})
	local state = editing()
	for step = 0, 20 do
		t.eq(label.look(state, look("id-lede", { ["id-lede"] = "word " .. step }, 1000 + step * 1000)).apply, nil, "look " .. step)
	end
end

tests.a_label_equal_to_the_text_applies_nothing_whenever_the_selection_leaves = function(t)
	stub.install({})
	local state = editing()
	for now = 0, 10000, 500 do
		t.eq(label.look(state, look("id-lede", { ["id-lede"] = LEDE }, now)).apply, nil)
	end
	local plan = label.look(state, look(nil, { ["id-lede"] = LEDE }, 11000))
	t.eq(plan.apply, nil, "an Escape leaves the label as it was")
end

tests.leaving_an_untouched_target_clears_the_label = function(t)
	stub.install({})
	local state = editing()
	local plan = label.look(state, look(nil, { ["id-lede"] = LEDE }))
	t.eq(plan.edits, { { op = "text", id = "id-lede", text = "" } })
	t.eq(state.active, nil)
	t.eq(label.look(state, look(nil, {})).edits, {}, "and nothing more is done on the next look")
end

tests.a_label_typed_on_something_that_is_not_text_is_discarded_with_a_notice = function(t)
	stub.install({})
	local state = drawn()
	label.look(state, look("id-hero", { ["id-hero"] = "" }))
	t.eq(label.look(state, look("id-hero", { ["id-hero"] = "oops" }, 100)).discarded, false, "not while the user may still be typing")
	local plan = label.look(state, look(nil, { ["id-hero"] = "oops" }, 200))
	t.eq(plan.discarded, true)
	t.eq(find(plan.edits, "text").text, "")
	t.eq(plan.apply, nil, "never a document change")
	t.eq(state.active, nil)
end

tests.a_label_typed_on_something_that_is_not_text_is_discarded_when_it_is_stable_too = function(t)
	stub.install({})
	local state = drawn()
	label.look(state, look("id-hero", { ["id-hero"] = "" }))
	label.look(state, look("id-hero", { ["id-hero"] = "oops" }, 1000))
	local plan = label.look(state, look("id-hero", { ["id-hero"] = "oops" }, 2500))
	t.eq(plan.discarded, true)
	t.eq(find(plan.edits, "text").text, "")
	t.eq(label.look(state, look("id-hero", { ["id-hero"] = "" }, 2600)).discarded, false)
end

tests.switching_the_selection_in_the_middle_applies_the_first_target_and_the_new_one_enters_after = function(t)
	stub.install({})
	local state = editing()
	local labels = { ["id-lede"] = "A new lede", ["id-other"] = "" }
	local plan = label.look(state, look("id-other", labels, 100))
	t.eq(plan.apply, { path = "frame-a/lede", content = "A new lede", base = LEDE, leaving = true })
	t.eq(find(plan.edits, "text"), nil, "the second target is not drawn on while the first is being applied")
	label.settled(state, plan.apply :: label.Change, "applied")
	local next_plan = label.look(state, look("id-other", { ["id-other"] = "" }, 200))
	t.eq(find(next_plan.edits, "text").text, "Other")
	t.eq((state.active :: label.Active).path, "frame-a/other")
end

tests.switching_with_nothing_changed_gives_the_first_target_back_and_enters_the_second_at_once = function(t)
	stub.install({})
	local state = editing()
	local plan = label.look(state, look("id-other", { ["id-lede"] = LEDE, ["id-other"] = "" }))
	t.eq(plan.apply, nil)
	local texts: { string } = {}
	for _, edit in plan.edits do
		if edit.op == "text" then
			table.insert(texts, edit.id .. "=" .. edit.text)
		end
	end
	t.eq(texts, { "id-lede=", "id-other=Other" }, "the first is cleared, then the second filled, in this order")
end

tests.text_with_several_lines_accents_and_nothing_at_all_reaches_the_change_unchanged = function(t)
	stub.install({})
	for _, typed in { "linha 1\nlinha 2", "açaí — “aspas” & <tags> \\ $5 %s", "" } do
		local state = editing()
		local plan = label.look(state, look(nil, { ["id-lede"] = typed }))
		t.eq((plan.apply :: label.Change).content, typed)
	end
end

-- The Enter that ends the typing is a line break in the board's editor, not text the user meant to keep.
local function leaves(original: string, typed: string): label.Plan
	local state = drawn()
	state.nodes["frame-a/lede"].text = original
	label.look(state, look("id-lede", { ["id-lede"] = "" }))
	label.look(state, look("id-lede", { ["id-lede"] = original }))
	return label.look(state, look(nil, { ["id-lede"] = typed }))
end

tests.a_line_break_at_the_end_that_the_text_did_not_have_is_dropped = function(t)
	stub.install({})
	t.eq((leaves(LEDE, "testes\n").apply :: label.Change).content, "testes")
	t.eq((leaves(LEDE, "a\nb\n").apply :: label.Change).content, "a\nb")
	t.eq((leaves(LEDE, "a\r\nb\r\n\r\n").apply :: label.Change).content, "a\r\nb")
	t.eq((leaves(LEDE, "a\n\n\n").apply :: label.Change).content, "a")
end

tests.a_text_that_ended_in_a_line_break_keeps_as_many_as_it_had = function(t)
	stub.install({})
	t.eq((leaves("x\n", "y\n\n").apply :: label.Change).content, "y\n")
	t.eq((leaves("x\r\n", "y\r\n\r\n").apply :: label.Change).content, "y\r\n")
	t.eq((leaves("x\n\n", "y\n\n\n").apply :: label.Change).content, "y\n\n")
	t.eq((leaves("x\n", "y").apply :: label.Change).content, "y", "taking the break away is the user's choice")
end

tests.only_an_enter_at_the_end_of_an_equal_text_applies_nothing = function(t)
	stub.install({})
	for _, case in { { LEDE, LEDE .. "\n" }, { "x\n", "x\n\n" }, { LEDE, LEDE .. "\r\n" } } do
		t.eq(leaves(case[1], case[2]).apply, nil)
	end
	local state = editing()
	local typed = { ["id-lede"] = LEDE .. "\n" }
	label.look(state, look("id-lede", typed, 1000))
	t.eq(label.look(state, look("id-lede", typed, 2500)).apply, nil, "not while selected either")
	local plan = label.look(state, look(nil, typed, 3000))
	t.eq(plan.apply, nil)
	t.eq(state.active, nil, "the edit is over and the label is cleared")
	t.truthy(find(plan.edits, "text"))
end

tests.an_applied_text_is_the_new_original_so_it_is_not_applied_again = function(t)
	stub.install({})
	local state = editing()
	local typed = { ["id-lede"] = "A new lede" }
	label.look(state, look("id-lede", typed, 1000))
	local plan = label.look(state, look("id-lede", typed, 2500))
	label.settled(state, plan.apply :: label.Change, "applied")
	t.eq(label.look(state, look("id-lede", typed, 9000)).apply, nil)
	t.eq(label.look(state, look(nil, typed, 9500)).apply, nil)
end

tests.an_owner_refusal_is_not_tried_again_until_the_label_changes = function(t)
	stub.install({})
	local state = editing()
	local typed = { ["id-lede"] = "A new lede" }
	label.look(state, look("id-lede", typed, 1000))
	local plan = label.look(state, look("id-lede", typed, 2500))
	label.settled(state, plan.apply :: label.Change, "refused")
	t.eq(label.look(state, look("id-lede", typed, 9000)).apply, nil)
	label.look(state, look("id-lede", { ["id-lede"] = "A newer lede" }, 9500))
	t.eq((label.look(state, look("id-lede", { ["id-lede"] = "A newer lede" }, 11000)).apply :: label.Change).content, "A newer lede")
end

tests.a_conflict_keeps_the_text_to_be_applied_again_and_a_leaving_target_stays_until_the_owner_took_it = function(t)
	stub.install({})
	local state = editing()
	local typed = { ["id-lede"] = "A new lede" }
	local plan = label.look(state, look(nil, typed, 100))
	label.settled(state, plan.apply :: label.Change, "conflict")
	t.eq((label.look(state, look(nil, typed, 200)).apply :: label.Change).content, "A new lede")
	label.settled(state, plan.apply :: label.Change, "applied")
	t.eq(state.active, nil, "taken: the rebuild draws the target again")
end

tests.the_boards_own_undo_of_the_text_put_on_the_target_puts_it_back_instead_of_emptying_the_node = function(t)
	stub.install({})
	local state = drawn()
	label.look(state, look("id-lede", { ["id-lede"] = "" }, 0, 7))
	label.look(state, look("id-lede", { ["id-lede"] = LEDE }, 400, 7))
	-- Ctrl+Z took the step that put the text there: the label is empty and there is one step less to undo.
	local plan = label.look(state, look("id-lede", { ["id-lede"] = "" }, 800, 6))
	t.eq(plan.apply, nil)
	t.eq(find(plan.edits, "text").text, LEDE)
	t.eq(label.look(state, look("id-lede", { ["id-lede"] = "" }, 3000, 6)).apply, nil, "even a long time later")
end

tests.a_label_the_board_never_showed_is_not_the_user_emptying_the_text = function(t)
	stub.install({})
	local state = drawn()
	label.look(state, look("id-lede", { ["id-lede"] = "" }))
	local plan = label.look(state, look("id-lede", { ["id-lede"] = "" }, 400))
	t.eq(plan.apply, nil)
	t.eq(find(plan.edits, "text").text, LEDE, "the prefill is made again")
end

tests.the_user_emptying_the_text_after_seeing_it_is_applied_as_empty = function(t)
	stub.install({})
	local state = drawn()
	label.look(state, look("id-lede", { ["id-lede"] = "" }, 0, 7))
	label.look(state, look("id-lede", { ["id-lede"] = LEDE }, 400, 7))
	-- The user selected the text, deleted it and committed: one more step to undo.
	label.look(state, look("id-lede", { ["id-lede"] = "" }, 800, 8))
	local plan = label.look(state, look("id-lede", { ["id-lede"] = "" }, 2400, 8))
	t.eq(plan.apply, { path = "frame-a/lede", content = "", base = LEDE, leaving = false })
end

tests.a_shape_gone_from_the_board_ends_the_edit_without_touching_the_document = function(t)
	stub.install({})
	local state = editing()
	t.eq(label.look(state, look(nil, {})).apply, nil)
	t.eq(state.active, nil)
end

tests.a_rebuild_keeps_the_target_being_typed_on_and_does_not_draw_another = function(t)
	stub.install({})
	local state = editing()
	label.look(state, look("id-lede", { ["id-lede"] = "Typing on" }, 1000))
	local rows = { row("frame-a/lede", "text", { text = "Another text", font_size = 17 }) }
	local plan = projection.targets(rows, "frame-a")
	label.drawn(state, plan, rows)
	local shape: any = { id = "id-lede", x = 10, y = 20, w = 100, h = 40, text = "Typing on" }
	local held, edits = label.keep(state, plan, { ["id-lede"] = shape })
	t.eq(held, { t1 = "id-lede" })
	t.eq(find(edits, "text"), nil, "what the user typed is not replaced by the document's text")
	t.eq((state.active :: label.Active).original, LEDE, "the document's change is not adopted over what the user typed: it is the base the change is sent with")
	t.eq((label.look(state, look(nil, { ["id-lede"] = "Typing on" }, 2000)).apply :: label.Change).base, LEDE)
end

tests.a_node_changed_by_someone_else_holds_the_label_on_the_board_until_the_user_decides = function(t)
	stub.install({})
	local state = editing()
	local typed = { ["id-lede"] = "A new lede" }
	local plan = label.look(state, look(nil, typed, 100))
	label.settled(state, plan.apply :: label.Change, "text_conflict", "By the agent")
	for _, selected in { nil, "id-other" } do
		local again = label.look(state, look(selected, { ["id-lede"] = "A new lede", ["id-other"] = "" }, 200))
		t.eq(again.apply, nil, "never sent again over the agent's text")
		t.eq(again.edits, {}, "and the label is not taken away")
		t.truthy(state.active and state.active.held)
	end
	local edited = label.look(state, look(nil, { ["id-lede"] = "A new lede, edited" }, 300))
	t.eq((edited.apply :: label.Change).content, "A new lede, edited", "a label the user changes is offered again")
end

tests.keeping_my_text_sends_it_again_from_the_text_the_node_has_now = function(t)
	stub.install({})
	local state = editing()
	local plan = label.look(state, look(nil, { ["id-lede"] = "Mine" }, 100))
	label.settled(state, plan.apply :: label.Change, "text_conflict", "By the agent")
	t.eq(label.decide(state, true), {})
	t.eq(label.look(state, look(nil, { ["id-lede"] = "Mine" }, 200)).apply, { path = "frame-a/lede", content = "Mine", base = "By the agent", leaving = true })
end

tests.keeping_the_documents_text_brings_the_label_back_to_it_and_applies_nothing = function(t)
	stub.install({})
	local state = editing()
	local plan = label.look(state, look(nil, { ["id-lede"] = "Mine" }, 100))
	label.settled(state, plan.apply :: label.Change, "text_conflict", "By the agent")
	-- The agent changed the node again before the user chose: the rebuild that followed read the newest text.
	local rows = { row("frame-a/lede", "text", { text = "By the agent, again", font_size = 17 }) }
	label.drawn(state, projection.targets(rows, "frame-a"), rows)
	local edits = label.decide(state, false)
	t.eq(find(edits, "text").text, "By the agent, again", "the label takes what the node has now")
	t.eq((label.look(state, look("id-lede", { ["id-lede"] = "By the agent, again" }, 150)).apply), nil)
	t.eq(label.look(state, look("id-lede", { ["id-lede"] = "By the agent, again" }, 200)).apply, nil)
	t.eq(label.look(state, look(nil, { ["id-lede"] = "By the agent, again" }, 300)).apply, nil)
end

tests.a_commit_from_an_editor_that_was_open_while_the_node_changed_is_sent_from_the_text_the_user_started_with = function(t)
	stub.install({})
	local state = editing()
	local rows = { row("frame-a/lede", "text", { text = "Changed by the agent", font_size = 17 }) }
	local plan = projection.targets(rows, "frame-a")
	label.drawn(state, plan, rows)
	-- The open editor's text cannot be read: the label looks untouched, so the rebuild refreshes it to the agent's text.
	local shape: any = { id = "id-lede", x = 10, y = 20, w = 100, h = 40, text = LEDE }
	local _, edits = label.keep(state, plan, { ["id-lede"] = shape })
	t.eq(find(edits, "text").text, "Changed by the agent")
	-- Then the user commits what they typed.
	label.look(state, look("id-lede", { ["id-lede"] = "What the user typed" }, 1000))
	local apply = label.look(state, look("id-lede", { ["id-lede"] = "What the user typed" }, 2500)).apply :: label.Change
	t.eq(apply.base, LEDE, "so the owner sees a node that is not what the user started from")
end

tests.a_held_label_follows_the_selection_to_another_target_and_asks_once_for_each_selection = function(t)
	stub.install({})
	local state = editing()
	local plan = label.look(state, look(nil, { ["id-lede"] = "A new lede" }, 100))
	label.settled(state, plan.apply :: label.Change, "text_conflict", "By the agent")
	local labels = { ["id-lede"] = "A new lede", ["id-other"] = "", ["id-hero"] = "" }
	local first = label.look(state, look("id-other", labels, 200))
	t.eq(first.ask, true, "asked for the first selection")
	t.eq(state.next, { id = "id-other", path = "frame-a/other" }, "and the target is kept by the rebuilds")
	t.eq(label.look(state, look("id-other", labels, 300)).ask, nil, "not again while it stays selected")
	t.eq(label.look(state, look("id-other", labels, 400)).apply, nil)
	t.eq(label.look(state, look("id-hero", labels, 500)).ask, true, "asked again for the next selection")
	t.eq(label.look(state, look(nil, labels, 600)).ask, nil, "and not when nothing is selected")
end

tests.deciding_with_nothing_held_does_nothing = function(t)
	stub.install({})
	local state = editing()
	t.eq(label.decide(state, false), {})
	t.eq(label.decide(label.new(), true), {})
end

tests.the_target_selected_while_the_first_is_applied_is_kept_by_the_rebuild_as_it_is = function(t)
	stub.install({})
	local state = editing()
	local plan = label.look(state, look("id-other", { ["id-lede"] = "A new lede", ["id-other"] = "typed in B" }, 100))
	label.settled(state, plan.apply :: label.Change, "applied")
	local rows = { row("frame-a/lede", "text", { text = "A new lede" }), row("frame-a/other", "text", { text = "Other" }) }
	local rebuild = projection.targets(rows, "frame-a")
	label.drawn(state, rebuild, rows)
	local lede: any = { id = "id-lede", x = 10, y = 20, w = 100, h = 40, text = "A new lede" }
	local other: any = { id = "id-other", x = 10, y = 20, w = 100, h = 40, text = "typed in B" }
	local held = label.keep(state, rebuild, { ["id-lede"] = lede, ["id-other"] = other })
	t.eq(held, { t2 = "id-other" }, "the first target is drawn again, the second stays")
	t.eq(find(label.look(state, look("id-other", { ["id-other"] = "typed in B" }, 200)).edits, "text"), nil, "and its label is still the user's")
end

tests.emptying_a_label_that_was_already_there_is_a_deliberate_edit = function(t)
	stub.install({})
	local state = drawn()
	label.look(state, look("id-lede", { ["id-lede"] = "typed first" }, 0, 5))
	label.look(state, look("id-lede", { ["id-lede"] = "" }, 400, 6))
	local plan = label.look(state, look("id-lede", { ["id-lede"] = "" }, 2000, 6))
	t.eq(plan.apply, { path = "frame-a/lede", content = "", base = LEDE, leaving = false })
end

tests.a_target_that_could_not_be_read_during_a_rebuild_is_kept_as_it_is = function(t)
	stub.install({})
	local state = editing()
	label.look(state, look("id-lede", { ["id-lede"] = "Typed, not applied yet" }, 1000))
	local rows = { row("frame-a/lede", "text", { text = LEDE, font_size = 17 }) }
	local plan = projection.targets(rows, "frame-a")
	label.drawn(state, plan, rows)
	local held, edits = label.keep(state, plan, {}, { ["id-lede"] = true })
	t.eq(held, { t1 = "id-lede" }, "the board would not say what is on it, but the shape is there")
	t.eq(find(edits, "resize"), nil, "and nothing is done to it")
	t.eq(find(edits, "text"), nil)
	t.truthy(state.active)
end

tests.a_rebuild_brings_a_changed_document_text_to_a_label_the_user_has_not_touched = function(t)
	stub.install({})
	local state = editing()
	local rows = { row("frame-a/lede", "text", { text = "Changed elsewhere", font_size = 17 }) }
	local plan = projection.targets(rows, "frame-a")
	label.drawn(state, plan, rows)
	local shape: any = { id = "id-lede", x = 10, y = 20, w = 100, h = 40, text = LEDE }
	local held, edits = label.keep(state, plan, { ["id-lede"] = shape })
	t.eq(held, { t1 = "id-lede" })
	t.eq(find(edits, "text").text, "Changed elsewhere")
	t.eq(label.look(state, look("id-lede", { ["id-lede"] = "Changed elsewhere" }, 5000)).apply, nil)
end

tests.a_kept_target_is_moved_to_the_box_the_document_gives_it_now = function(t)
	stub.install({})
	local state = editing()
	local rows = { row("frame-a/lede", "text", { text = LEDE, font_size = 17 }) }
	rows[1].geometry.width, rows[1].geometry.height = 220, 60
	local plan = projection.targets(rows, "frame-a")
	label.drawn(state, plan, rows)
	local shape: any = { id = "id-lede", x = 10, y = 20, w = 100, h = 40, text = LEDE }
	local _, edits = label.keep(state, plan, { ["id-lede"] = shape })
	local fit = find(edits, "resize")
	t.eq({ fit.x, fit.y, fit.w, fit.h }, { 10, 20, 220, 60 })
	local same: any = { id = "id-lede", x = 10, y = 20, w = 220, h = 60, text = LEDE }
	local _, quiet = label.keep(state, plan, { ["id-lede"] = same })
	t.eq(find(quiet, "resize"), nil, "nothing to move when it is already there")
	t.eq(quiet[#quiet], { op = "order", ids = { "id-lede" }, to = "front" }, "but it always goes in front of the targets drawn after it, as the last edit")
end

tests.a_rebuild_that_no_longer_has_the_node_or_the_shape_lets_the_edit_go = function(t)
	stub.install({})
	local rows = { row("frame-a/lede", "text", { text = LEDE }) }
	local plan = projection.targets(rows, "frame-a")
	local shape: any = { id = "id-lede", x = 10, y = 20, w = 100, h = 40, text = LEDE }
	local state = editing()
	label.drawn(state, projection.targets({ row("frame-a/hero", "frame") }, "frame-a"), { row("frame-a/hero", "frame") })
	t.eq(label.keep(state, plan, { ["id-lede"] = shape }), {})
	t.eq(state.active, nil, "the node left the focused frame")
	local gone = editing()
	label.drawn(gone, plan, rows)
	t.eq(label.keep(gone, plan, {}), {})
	t.eq(gone.active, nil, "the shape is not on the board")
	local plain = editing()
	local boxes = { row("frame-a/lede", "rectangle") }
	label.drawn(plain, projection.targets(boxes, "frame-a"), boxes)
	t.eq(label.keep(plain, plan, { ["id-lede"] = shape }), {})
	t.eq(plain.active, nil, "the node is no longer text")
end

return tests
