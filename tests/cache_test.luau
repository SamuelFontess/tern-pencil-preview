--!strict
local stub = require("./stub")
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

return tests
