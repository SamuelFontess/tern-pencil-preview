--!strict
local stub = require("./stub")
stub.attach(require("../lib/canon"))
local cache = stub.attach(require("../lib/cache"))

type T = {
	eq: (actual: any, expected: any, msg: string?) -> (),
	match: (s: string, pattern: string, msg: string?) -> (),
	truthy: (v: any, msg: string?) -> (),
	raises: (fn: () -> (), pattern: string?, msg: string?) -> (),
}

local tests: { [string]: (t: T) -> () } = {}

local function e(file: string, version: string, pane: number, complete: boolean, used: number, bytes: number): any
	return { file = file, name = cache.attempt(version, pane), version = version, pane = pane, complete = complete, used = used, bytes = bytes }
end

local function names(list: { any }): { string }
	local out = {}
	for _, x in list do
		table.insert(out, x.file .. "/" .. x.name)
	end
	table.sort(out)
	return out
end

tests.version_follows_content_and_is_a_safe_name = function(t)
	local a, b = cache.version("abc"), cache.version("abd")
	t.truthy(a ~= b)
	t.eq(cache.version("abc"), a)
	t.match(a, "^[0-9a-z]+$")
end

tests.version_follows_render_version = function(t)
	local before = cache.version("abc")
	cache.RENDER_VERSION += 1
	local after = cache.version("abc")
	cache.RENDER_VERSION -= 1
	t.truthy(before ~= after)
end

tests.attempt_names_round_trip = function(t)
	t.eq({ cache.parse(cache.attempt("ab12r1", 2113123909651)) }, { "ab12r1", 2113123909651 })
	t.eq(cache.parse("junk"), nil)
	t.eq(cache.parse("ab-cd"), nil)
	t.eq(cache.parse("junk-1"), nil)
	t.eq(cache.parse("ab12r1-07"), nil)
end

tests.used_round_trips_and_defaults_to_zero = function(t)
	t.eq({ cache.decode_used(cache.encode_used(1760000000, 5395226)) }, { 1760000000, 5395226 })
	t.eq({ cache.decode_used(nil) }, { 0, 0 })
	t.eq({ cache.decode_used("x") }, { 0, 0 })
end

tests.pick_takes_the_newest_complete_folder_of_the_version = function(t)
	local list = { e("f", "v1", 1, true, 10, 1), e("f", "v1", 2, true, 20, 1), e("f", "v1", 3, false, 30, 1), e("f", "v2", 4, true, 40, 1) }
	t.eq((cache.pick(list, "v1") :: any).pane, 2)
	t.eq(cache.pick(list, "v9"), nil)
end

tests.stale_own_lists_unfinished_attempts_of_other_versions = function(t)
	local list = { e("f", "old", 7, false, 0, 0), e("f", "new", 7, false, 0, 0), e("f", "old", 8, false, 0, 0), e("f", "x", 7, true, 1, 1) }
	t.eq(names(cache.stale_own(list, 7, "new")), { "f/old-7" })
end

tests.prune_drops_dead_unfinished_and_old_versions = function(t)
	local list = {
		e("f", "v1", 1, true, 10, 1),
		e("f", "v2", 1, true, 20, 1),
		e("f", "v3", 1, true, 30, 1),
		e("f", "v3", 2, true, 25, 1), -- an older copy of v3
		e("f", "v4", 5, false, 0, 0), -- pane 5 is gone
		e("f", "v4", 6, false, 0, 0), -- pane 6 still runs
	}
	local out = cache.prune(list, { [1] = true, [2] = true, [6] = true }, {}, 2, math.huge)
	t.eq(names(out), { "f/v1-1", "f/v3-2", "f/v4-5" })
end

tests.prune_keeps_the_byte_budget_oldest_first_and_spares_protected = function(t)
	local list = { e("a", "x", 1, true, 10, 60), e("b", "y", 1, true, 20, 60), e("c", "z", 1, true, 30, 60) }
	t.eq(names(cache.prune(list, {}, {}, 2, 130)), { "a/x-1" })
	t.eq(names(cache.prune(list, {}, { ["a/x-1"] = true }, 2, 130)), { "b/y-1" })
end

tests.prune_counts_protected_toward_keep = function(t)
	local list = { e("f", "v1", 1, true, 30, 1), e("f", "v2", 1, true, 20, 1), e("f", "v3", 1, true, 10, 1) }
	t.eq(names(cache.prune(list, { [1] = true }, { ["f/v1-1"] = true }, 2, math.huge)), { "f/v3-1" })
end

local DOC = '{"version":"2.20","variables":{"bg":{"type":"color","value":"#fff"}},"children":['
	.. '{"type":"frame","id":"A","children":[{"type":"text","id":"t1","content":"x"},{"type":"frame","id":"C","reusable":true,"fill":"#111"}]},'
	.. '{"type":"frame","id":"B","children":[{"type":"text","id":"t2","content":"y"}]},'
	.. '{"type":"note","id":"N","content":"n"}]}'

tests.frame_keys_change_only_for_the_edited_frame = function(t)
	stub.install({})
	local k0 = cache.frame_keys(DOC)
	t.truthy(k0.A and k0.B and k0.A ~= k0.B)
	t.eq(k0.N, nil, "only frames get keys")
	local k1 = cache.frame_keys((DOC:gsub('"content":"y"', '"content":"z"')))
	t.eq(k1.A, k0.A)
	t.truthy(k1.B ~= k0.B)
end

tests.frame_keys_change_everywhere_for_shared_parts = function(t)
	stub.install({})
	local k0 = cache.frame_keys(DOC)
	for what, edited in {
		variable = (DOC:gsub('"#fff"', '"#000"')),
		reusable = (DOC:gsub('"#111"', '"#222"')),
		top_node = (DOC:gsub('"content":"n"', '"content":"m"')),
	} do
		local k = cache.frame_keys(edited)
		t.truthy(k.A ~= k0.A and k.B ~= k0.B, what)
	end
end

tests.frame_keys_ignore_member_order = function(t)
	stub.install({})
	local reordered = '{"children":['
		.. '{"id":"A","type":"frame","children":[{"content":"x","id":"t1","type":"text"},{"fill":"#111","reusable":true,"id":"C","type":"frame"}]},'
		.. '{"type":"frame","id":"B","children":[{"type":"text","id":"t2","content":"y"}]},'
		.. '{"type":"note","id":"N","content":"n"}],'
		.. '"variables":{"bg":{"value":"#fff","type":"color"}},"version":"2.20"}'
	t.eq(cache.frame_keys(reordered), cache.frame_keys(DOC))
end

tests.frame_keys_change_with_the_render_version = function(t)
	stub.install({})
	local before = cache.frame_keys(DOC).A
	cache.RENDER_VERSION += 1
	local after = cache.frame_keys(DOC).A
	cache.RENDER_VERSION -= 1
	t.truthy(before ~= after)
end

tests.frame_keys_of_something_else_are_empty = function(t)
	stub.install({})
	t.eq(cache.frame_keys("not json"), {})
	t.eq(cache.frame_keys('{"children":3}'), {})
end

tests.orphans_spare_used_and_busy_images = function(t)
	t.eq(cache.orphans({ "k1r2", "k2r2", "k3r2" }, { k1r2 = true }, { k3r2 = true }), { "k2r2" })
end

tests.stale_render_lists_other_render_versions = function(t)
	local function entry(version: string): any
		return { file = "f", name = version .. "-1", version = version, pane = 1, complete = true, used = 0, bytes = 0 }
	end
	local old, cur = entry("ab1r1"), entry("ab1r" .. tostring(cache.RENDER_VERSION))
	t.eq(cache.stale_render({ old, cur }), { old })
end

tests.reserve_plan_reuses_a_sealed_key_folder = function(t)
	t.eq(cache.reserve_plan("k1r2", true, false), "show")
	t.eq(cache.reserve_plan("k1r2", true, true), "show", "a sealed folder is read, never written")
end

tests.reserve_plan_exports_into_a_free_unsealed_key_folder = function(t)
	t.eq(cache.reserve_plan("k1r2", false, false), "key")
end

tests.reserve_plan_uses_the_version_folder_when_the_key_is_busy_or_missing = function(t)
	t.eq(cache.reserve_plan("k1r2", false, true), "version")
	t.eq(cache.reserve_plan(nil, false, false), "version")
end

tests.reserve_outcome_seals_only_the_exact_checked_frame = function(t)
	t.eq(cache.reserve_outcome("A", "A", false, true), "seal")
	t.eq(cache.reserve_outcome("A", "A", true, true), "drop", "timeout")
	t.eq(cache.reserve_outcome("A", "B", false, true), "drop", "another frame")
	t.eq(cache.reserve_outcome("A", nil, false, true), "drop", "no frame exported")
	t.eq(cache.reserve_outcome(nil, nil, false, true), "drop", "no frame asked")
	t.eq(cache.reserve_outcome("A", "A", false, false), "drop", "image did not check")
end

return tests
