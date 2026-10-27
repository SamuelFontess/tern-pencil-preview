--!strict
local stub = require("./stub")
local registry = stub.attach(require("../lib/editor_registry"))

type T = {
	eq: (actual: any, expected: any, msg: string?) -> (),
	match: (s: string, pattern: string, msg: string?) -> (),
	truthy: (v: any, msg: string?) -> (),
	raises: (fn: () -> (), pattern: string?, msg: string?) -> (),
}

local tests: { [string]: (t: T) -> () } = {}

local function store(): any
	local tern = stub.install({})
	local kv: { [string]: any } = {}
	tern.kv = {
		get = function(key: string): any
			return kv[key]
		end,
		set = function(key: string, value: any)
			kv[key] = value
		end,
	}
	return kv
end

local function entry(id: string, scope: string, board: number?): registry.Entry
	return {
		launch_id = id, path = "/work/" .. id .. ".pen", board = board or 0, follow = false,
		data_dir = "/data/editor", manifest = "/data/editor/launch-" .. id .. ".json", scope = scope, shapes = { "s1", "s2" },
	}
end

tests.the_scope_names_the_host_and_the_session_the_window_shows = function(t)
	local cx: any = {
		hosts = { current = function(): any return { id = 3 } end },
		sessions = { current = function(): any return { id = 7 } end },
	}
	t.eq(registry.scope(cx), "3:7")
	local broken: any = { hosts = { current = function(): any error("no host") end }, sessions = cx.sessions }
	t.eq(registry.scope(broken), "", "never raises into the window")
end

tests.a_stored_session_comes_back_to_the_scope_that_stored_it = function(t)
	store()
	registry.apply({ b = entry("b", "1:1", 30), a = entry("a", "1:1") })
	local mine = registry.mine("1:1")
	t.eq(#mine, 2)
	t.eq(mine[1].launch_id, "a", "in launch order")
	t.eq(mine[2].board, 30)
	t.eq(mine[2].shapes, { "s1", "s2" }, "with the shapes it drew")
end

tests.another_scopes_session_is_listed_for_nobody_else_and_survives_a_write = function(t)
	local kv = store()
	registry.apply({ other = entry("other", "1:2"), own = entry("own", "1:1") })
	t.eq(#registry.mine("1:1"), 1)
	t.eq(registry.mine("1:1")[1].launch_id, "own")
	registry.apply({ own = false })
	t.eq(#registry.mine("1:1"), 0)
	t.truthy(kv.editor_sessions.other, "the other scope's record is still there")
end

tests.forgetting_the_last_session_clears_the_key = function(t)
	local kv = store()
	registry.apply({ a = entry("a", "") })
	t.truthy(kv.editor_sessions)
	registry.apply({ a = false })
	t.eq(kv.editor_sessions, nil)
end

tests.a_malformed_record_is_never_adopted_and_is_cleaned_by_the_next_write = function(t)
	local kv = store()
	kv.editor_sessions = { bad = { launch_id = "bad", path = 5 }, worse = "text", good = entry("good", "1:1") }
	local mine = registry.mine("1:1")
	t.eq(#mine, 1)
	t.eq(mine[1].launch_id, "good")
	registry.apply({ extra = entry("extra", "1:1") })
	t.eq(kv.editor_sessions.bad, nil)
	t.eq(kv.editor_sessions.worse, nil)
end

tests.a_session_stored_by_the_version_with_a_pane_is_read_without_it = function(t)
	local kv = store()
	local old = entry("old", "1:1", 30)
	;(old :: any).terminal = 11
	;(old :: any).follow = nil
	kv.editor_sessions = { old = old }
	local mine = registry.mine("1:1")
	t.eq(#mine, 1, "its owner is found by its session record all the same")
	t.eq((mine[1] :: any).terminal, nil, "and no pane is remembered")
	t.eq(mine[1].board, 30)
	t.eq(mine[1].follow, false, "one that never followed anything")
end

tests.shape_ids_that_are_not_text_are_dropped = function(t)
	local kv = store()
	local odd = entry("odd", "1:1")
	;(odd :: any).shapes = { "a", 5, "b" }
	kv.editor_sessions = { odd = odd }
	t.eq(registry.mine("1:1")[1].shapes, { "a", "b" })
end

tests.a_board_with_many_shapes_keeps_every_id_up_to_the_stated_limit = function(t)
	local kv = store()
	local many = entry("many", "1:1")
	local ids: { string } = {}
	for index = 1, registry.MAX_SHAPES + 50 do
		table.insert(ids, string.format("%016x", index))
	end
	many.shapes = ids
	kv.editor_sessions = { many = many }
	local shapes = registry.mine("1:1")[1].shapes
	t.eq(#shapes, registry.MAX_SHAPES, "the limit is the stated one, not a silent smaller one")
	t.eq(shapes[1], ids[1], "the first ids are the ones kept")
	t.truthy(registry.MAX_SHAPES >= 2000)
end

tests.a_store_that_cannot_be_read_is_not_overwritten = function(t)
	local tern = stub.install({})
	local wrote = false
	tern.kv = {
		get = function(_key: string): any
			error("kv.json is not valid JSON")
		end,
		set = function(_key: string, _value: any)
			wrote = true
		end,
	}
	t.eq(#registry.mine("1:1"), 0)
	registry.apply({ a = entry("a", "1:1") })
	t.eq(wrote, false)
end

return tests
