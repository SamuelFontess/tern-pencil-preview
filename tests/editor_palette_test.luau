--!strict
local palette = require("../lib/editor_palette")

type T = {
	eq: (actual: any, expected: any, msg: string?) -> (),
	match: (s: string, pattern: string, msg: string?) -> (),
	truthy: (v: any, msg: string?) -> (),
	raises: (fn: () -> (), pattern: string?, msg: string?) -> (),
}

local tests: { [string]: (t: T) -> () } = {}

local A: palette.Candidate = { id = "a", board = 30 }
local B: palette.Candidate = { id = "b", board = 31 }

tests.the_session_of_the_focused_board_is_chosen_among_several = function(t)
	t.eq(palette.choose({ A, B }, 31), { kind = "one", id = "b" })
	t.eq(palette.choose({ A, B }, 30), { kind = "one", id = "a" })
end

tests.the_only_session_is_chosen_whatever_has_focus = function(t)
	t.eq(palette.choose({ A }, 2), { kind = "one", id = "a" })
	t.eq(palette.choose({ A }, nil), { kind = "one", id = "a" })
end

tests.no_session_is_nothing_to_act_on = function(t)
	t.eq(palette.choose({}, 30), { kind = "none" })
end

tests.several_sessions_without_a_focused_board_ask_for_focus = function(t)
	t.eq(palette.choose({ A, B }, 2), { kind = "ask" })
	t.eq(palette.choose({ A, B }, nil), { kind = "ask" })
end

tests.a_session_without_a_board_is_never_taken_for_the_focused_one = function(t)
	local waiting: palette.Candidate = { id = "w", board = 0 }
	t.eq(palette.choose({ waiting, A }, 0), { kind = "ask" })
end

tests.a_save_that_wrote_the_file_is_a_success = function(t)
	local v = palette.verdict("save", "d.pen", { saved = true, revision = 4 }, nil, nil)
	t.eq(v.level, "success")
	t.eq(v.lost, false)
end

tests.a_save_with_nothing_unsaved_says_so = function(t)
	t.eq(palette.verdict("save", "d.pen", { saved = false }, nil, nil).level, "info")
end

tests.undo_with_no_earlier_step_is_news_not_a_fault = function(t)
	local v = palette.verdict("undo", "d.pen", nil, "HTTP", "HISTORY_UNAVAILABLE")
	t.eq(v.level, "info")
	t.eq(v.lost, false)
	t.eq(palette.verdict("redo", "d.pen", nil, "HTTP", "HISTORY_UNAVAILABLE").level, "info")
end

tests.a_save_over_a_changed_original_points_to_the_conflict_choices_of_closing = function(t)
	local v = palette.verdict("save", "d.pen", nil, "HTTP", "SOURCE_CHANGED")
	t.eq(v.level, "error")
	t.eq(v.lost, false)
end

tests.a_lost_owner_is_flagged_for_the_window_to_end_the_session = function(t)
	t.eq(palette.verdict("undo", "d.pen", nil, "TRANSPORT", nil).lost, true)
	t.eq(palette.verdict("save", "d.pen", nil, "OWNER_ABSENT", nil).lost, true)
end

tests.any_other_refusal_reports_the_owners_code = function(t)
	local v = palette.verdict("redo", "d.pen", nil, "HTTP", "DOCUMENT_BLOCKED")
	t.eq(v.level, "error")
	t.eq(v.detail, "DOCUMENT_BLOCKED")
end

tests.with_the_focus_off_the_boards_the_only_board_in_the_focused_tab_is_chosen = function(t)
	local here: palette.Candidate = { id = "a", board = 30, tab = 1 }
	local there: palette.Candidate = { id = "b", board = 31, tab = 2 }
	t.eq(palette.choose({ here, there }, 2, 2), { kind = "one", id = "b" })
	t.eq(palette.choose({ here, there }, 2, 1), { kind = "one", id = "a" })
end

tests.several_boards_in_the_focused_tab_or_none_there_still_ask = function(t)
	local a: palette.Candidate = { id = "a", board = 30, tab = 1 }
	local b: palette.Candidate = { id = "b", board = 31, tab = 1 }
	local c: palette.Candidate = { id = "c", board = 32, tab = 3 }
	t.eq(palette.choose({ a, b, c }, 2, 1), { kind = "ask" })
	t.eq(palette.choose({ a, b, c }, 2, 9), { kind = "ask" })
	t.eq(palette.choose({ a, b, c }, 2, nil), { kind = "ask" })
end

return tests
