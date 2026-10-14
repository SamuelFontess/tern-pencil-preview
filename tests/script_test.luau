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
	local js = script.refresh(nil, "C:/x y", 4096)
	t.match(js, "const want=null;", "no id means null")
	t.truthy(js:find('"C:/x y"', 1, true))
	t.truthy(js:find("Export(", 1, true))
	t.truthy(js:find("maxSide=4096;", 1, true))
	t.eq(js:find("\n", 1, true), nil)
end

tests.refresh_escapes_want_id = function(t)
	stub.install({})
	local js = script.refresh('a"b', "d", 4096)
	t.truthy(js:find('const want="a\\"b";', 1, true))
	t.eq(js:find("\n", 1, true), nil)
end

tests.refresh_formats_max_side = function(t)
	stub.install({})
	t.truthy(script.refresh(nil, "d", 2048.5):find("maxSide=2048.5;", 1, true))
end

return tests
