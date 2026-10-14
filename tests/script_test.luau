--!strict
local stub = require("./stub")
local script = stub.attach(require("../lib/script"))

type T = {
	eq: (actual: any, expected: any, msg: string?) -> (),
	match: (s: string, pattern: string, msg: string?) -> (),
	truthy: (v: any, msg: string?) -> (),
	raises: (fn: () -> (), pattern: string?, msg: string?) -> (),
}

local tests: { [string]: (t: T) -> () } = {}

tests.js_string_round_trips_without_raw_newline = function(t)
	local tern = stub.install({})
	local s = 'a"b\\c\nd'
	local lit = script.js_string(s)
	t.eq(tern.json.decode(lit), s)
	t.eq(lit:find("\n", 1, true), nil)
end

tests.session_wraps_each_snippet = function(t)
	stub.install({})
	t.eq(script.session({ "X" }), 'execute({ input: "X" })\nexit()\n')
	t.eq(script.session({ "A", "B" }), 'execute({ input: "A" })\nexecute({ input: "B" })\nexit()\n')
end

tests.session_escapes_snippet = function(t)
	stub.install({})
	t.eq(script.session({ 'say("hi")' }), 'execute({ input: "say(\\"hi\\")" })\nexit()\n')
end

tests.refresh_is_single_line_with_inputs = function(t)
	stub.install({})
	local js = script.refresh(nil, "C:/x y", 4096, nil, true)
	t.match(js, "const want=null;", "no id means null")
	t.truthy(js:find('"C:/x y"', 1, true))
	t.truthy(js:find("Export(", 1, true))
	t.truthy(js:find("maxSide=4096;", 1, true))
	t.eq(js:find("\n", 1, true), nil)
end

tests.refresh_escapes_want_id = function(t)
	stub.install({})
	local js = script.refresh('a"b', "d", 4096, nil, true)
	t.truthy(js:find('const want="a\\"b";', 1, true))
	t.eq(js:find("\n", 1, true), nil)
end

tests.refresh_formats_max_side = function(t)
	stub.install({})
	t.truthy(script.refresh(nil, "d", 2048.5, nil, true):find("maxSide=2048.5;", 1, true))
end

tests.fit_scale_keeps_frames_within_limits = function(t)
	t.eq(script.fit_scale(1440, 1372, 4096), 2, "small frames export at 2x")
	t.eq(script.fit_scale(3040, 420, 4096), 1.347, "wide frames fit 4096 px, rounded down")
	t.truthy(3040 * script.fit_scale(3040, 420, 4096) <= 4096)
	t.eq(script.fit_scale(3040, 420, 4096, 1.346), 1.346, "a cap below the fit wins")
	t.eq(script.fit_scale(100, 100, 4096, 3), 2, "a cap above the fit changes nothing")
	t.eq(script.fit_scale(0, 0, 4096), 2, "a sizeless frame still gets a scale")
end

tests.plan_batch_puts_the_chosen_frame_first = function(t)
	local tops = {
		{ id = "wide", w = 3040, h = 420, stroke = 1, fill = true },
		{ id = "home", w = 1440, h = 1372, stroke = 0, fill = true },
		{ id = "clear", w = 100, h = 100, stroke = 0, fill = false },
	}
	t.eq(script.plan_batch(tops, "home", {}, 4096), {
		{ id = "home", scale = 2, format = "jpeg" },
		{ id = "wide", scale = 1.346, format = "jpeg" },
		{ id = "clear", scale = 2, format = "png" },
	})
	t.eq(script.plan_batch(tops, "gone", {}, 4096)[1].id, "wide", "an unknown choice keeps document order")
	t.eq(script.plan_batch(tops, nil, { wide = 1.2 }, 4096)[1].scale, 1.2, "a cap below the fit wins")
	t.truthy(3042 * script.plan_batch(tops, nil, {}, 4096)[1].scale <= 4096, "the stroke fits too")
end

tests.plan_batch_leaves_out_unsafe_ids = function(t)
	local tops = {
		{ id = "../x", w = 10, h = 10, stroke = 0, fill = true },
		{ id = "a:b", w = 10, h = 10, stroke = 0, fill = true },
		{ id = "ok", w = 10, h = 10, stroke = 0, fill = false },
	}
	t.eq(script.plan_batch(tops, "../x", {}, 4096), { { id = "ok", scale = 2, format = "png" } })
end

tests.exports_writes_one_export_per_item = function(t)
	stub.install({})
	local js = script.exports({ { id = 'a"b', scale = 2, format = "jpeg" }, { id = "c", scale = 1.5, format = "png" } }, "C:/o")
	t.eq(js, 'Export(["a\\"b"],"jpeg","C:/o",{scale:2,quality:92});Export(["c"],"png","C:/o",{scale:1.5})')
end

return tests
