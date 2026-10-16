--!strict
local stub = require("./stub")
local mirror = stub.attach(require("../lib/mirror"))

type T = {
	eq: (actual: any, expected: any, msg: string?) -> (),
	match: (s: string, pattern: string, msg: string?) -> (),
	truthy: (v: any, msg: string?) -> (),
	raises: (fn: () -> (), pattern: string?, msg: string?) -> (),
}

local tests: { [string]: (t: T) -> () } = {}

local function frame(id: string, key: string, exported: boolean, fill: boolean?, w: number?, h: number?): any
	return { id = id, x = 10, y = 20, w = w or 100, h = h or 50, key = key, fill = fill ~= false, exported = exported }
end

local function present(): (string) -> boolean
	return function(): boolean
		return true
	end
end

local function ops(plan: any): { string }
	local out = {}
	for _, ed in plan.edits do
		table.insert(out, ed.op .. (if ed.ref or ed.id then ":" .. (ed.ref or ed.id) elseif ed.ids then ":" .. table.concat(ed.ids, "+") else ""))
	end
	return out
end

tests.script_is_one_line_and_carries_what_decides_the_export = function(t)
	local tern = stub.install({})
	local js = mirror.script({ a = "k.1", ['b"c'] = "k.2" }, true, 'C:/x "y"')
	t.eq(js:find("\n", 1, true), nil)
	t.truthy(js:find(",F=true,", 1, true), "force")
	t.truthy(js:find(tern.json.encode('C:/x "y"'), 1, true), "the folder, escaped")
	t.truthy(js:find(tern.json.encode('b"c'), 1, true), "ids are escaped in the previous keys")
	t.truthy(mirror.script({}, false, "d"):find(",F=false,", 1, true))
end

tests.parse_reads_the_frame_list_among_other_output = function(t)
	stub.install({})
	local out = "WARN something\r\n" .. '{"v":1,"frames":[{"id":"A","x":1,"y":2,"w":3,"h":4,"k":"ab.9","f":true,"e":false},'
		.. '{"id":"B","x":-5,"y":0,"w":10,"h":20,"k":"cd.1","f":false,"e":true}]}\r\nmore\n'
	local frames = mirror.parse(out)
	t.eq(frames, {
		{ id = "A", x = 1, y = 2, w = 3, h = 4, key = "ab.9", fill = true, exported = false },
		{ id = "B", x = -5, y = 0, w = 10, h = 20, key = "cd.1", fill = false, exported = true },
	})
end

tests.parse_refuses_what_is_not_a_frame_list = function(t)
	stub.install({})
	t.eq({ mirror.parse("nothing here") }, { nil, "pen printed no frame list" })
	t.eq({ mirror.parse('{"v":1,"frames":[{"id":') }, { nil, "invalid frame list" })
	t.eq({ mirror.parse('{"v":1,"frames":3}') }, { nil, "invalid frame list" })
end

tests.parse_skips_entries_without_id_or_key_and_defaults_numbers = function(t)
	stub.install({})
	local frames = mirror.parse('{"v":1,"frames":[{"id":"A","k":"x"},{"k":"y"},{"id":"C"},7]}') :: any
	t.eq(frames, { { id = "A", x = 0, y = 0, w = 0, h = 0, key = "x", fill = false, exported = false } })
end

tests.the_first_plan_draws_every_frame_and_deletes_nothing = function(t)
	local plan = mirror.plan({}, { frame("A", "k1", true), frame("B", "k2", true, false) }, "/img/r1", present())
	t.eq(ops(plan), {
		"add:img:A",
		"order:img:A",
		"lock:img:A",
		"add:bg:B",
		"order:bg:B",
		"lock:bg:B",
		"add:img:B",
		"order:img:B",
		"lock:img:B",
	})
	t.eq(plan.replaced, { "A", "B" })
	t.eq(plan.edits[1].path, "/img/r1/A.png")
	t.eq({ plan.edits[1].x, plan.edits[1].y, plan.edits[1].w }, { 10, 20, 100 })
	t.eq(plan.edits[4].fill, "#ffffff", "a frame without a fill is backed with white")
end

tests.a_frame_pen_did_not_export_keeps_its_shapes = function(t)
	local shown = { A = { shape = "sa", key = "k1", dir = "/img/r1" } }
	local plan = mirror.plan(shown, { frame("A", "k1", false) }, "/img/r2", present())
	t.eq(plan.edits, {})
	t.eq(plan.replaced, {})
	t.eq(plan.gone, {})
end

tests.a_changed_frame_swaps_its_shapes_unlocking_before_deleting = function(t)
	local shown = {
		A = { shape = "sa", bg = "ba", key = "k1", dir = "/img/r1" },
		B = { shape = "sb", key = "k2", dir = "/img/r1" },
	}
	local plan = mirror.plan(shown, { frame("A", "k9", true, false), frame("B", "k2", false) }, "/img/r2", present())
	t.eq(ops(plan), { "unlock:sa+ba", "delete:sa+ba", "add:bg:A", "order:bg:A", "lock:bg:A", "add:img:A", "order:img:A", "lock:img:A" })
	t.eq(plan.replaced, { "A" })
end

tests.an_export_whose_file_is_missing_keeps_the_old_image = function(t)
	local shown = { A = { shape = "sa", key = "k1", dir = "/img/r1" } }
	local plan = mirror.plan(shown, { frame("A", "k9", true) }, "/img/r2", function(): boolean
		return false
	end)
	t.eq(plan.edits, {})
	t.eq(plan.missing, { "A" })
	t.eq(plan.gone, {}, "the frame still exists")
end

tests.frames_that_vanish_or_lose_their_area_lose_their_shapes_in_order = function(t)
	local shown = {
		C = { shape = "sc", key = "k", dir = "d" },
		A = { shape = "sa", key = "k", dir = "d" },
		Z = { shape = "sz", bg = "bz", key = "k", dir = "d" },
	}
	local plan = mirror.plan(shown, { frame("A", "k", false, true, 0, 50), frame("B", "k", false) }, "d", present())
	t.eq(plan.gone, { "A", "C", "Z" }, "A has no area now; sorted")
	t.eq(ops(plan), { "unlock:sa", "delete:sa", "unlock:sc", "delete:sc", "unlock:sz+bz", "delete:sz+bz" })
end

tests.adopt_records_what_the_board_answered = function(t)
	local shown: any = {
		A = { shape = "old-a", key = "k1", dir = "/img/r1" },
		G = { shape = "old-g", key = "k1", dir = "/img/r1" },
		K = { shape = "old-k", key = "k1", dir = "/img/r1" },
	}
	local frames = { frame("A", "k9", true, false), frame("N", "kn", true), frame("K", "k1", false) }
	local plan = mirror.plan(shown, frames, "/img/r2", present())
	mirror.adopt(shown, plan, frames, { ["img:A"] = "new-a", ["bg:A"] = "bg-a", ["img:N"] = "new-n" }, "/img/r2")
	t.eq(shown, {
		A = { shape = "new-a", bg = "bg-a", key = "k9", dir = "/img/r2" },
		N = { shape = "new-n", key = "kn", dir = "/img/r2" },
		K = { shape = "old-k", key = "k1", dir = "/img/r1" },
	})
end

tests.a_frame_the_board_did_not_draw_is_not_recorded_so_it_exports_again = function(t)
	local shown: any = { A = { shape = "old", key = "k1", dir = "/img/r1" } }
	local frames = { frame("A", "k9", true) }
	local plan = mirror.plan(shown, frames, "/img/r2", present())
	mirror.adopt(shown, plan, frames, {}, "/img/r2")
	t.eq(shown, {})
	t.eq(mirror.prev(shown), {}, "nothing to compare against: pen exports it")
end

tests.everything_exports_when_the_shared_seed_changes_or_nothing_is_shown = function(t)
	local shown = { A = { shape = "s", key = "k", dir = "d" } }
	t.eq(mirror.force(shown, "seed", "seed"), false)
	t.eq(mirror.force(shown, "seed", "other"), true, "a variable or component changed")
	t.eq(mirror.force(shown, nil, "seed"), true, "first run")
	t.eq(mirror.force({}, "seed", "seed"), true, "an empty board")
end

tests.prev_and_used_dirs_describe_what_is_shown = function(t)
	local shown = {
		A = { shape = "s", key = "ka", dir = "C:/data/board/img/r1_1" },
		B = { shape = "t", key = "kb", dir = "C:/data/board/img/r1_2" },
		C = { shape = "u", key = "kc", dir = "C:/data/board/img/r1_2" },
	}
	t.eq(mirror.prev(shown), { A = "ka", B = "kb", C = "kc" })
	t.eq(mirror.used_dirs(shown), { r1_1 = true, r1_2 = true })
end

return tests
