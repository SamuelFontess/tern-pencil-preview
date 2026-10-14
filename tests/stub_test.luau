--!strict
local stub = require("./stub")

type T = {
	eq: (actual: any, expected: any, msg: string?) -> (),
	match: (s: string, pattern: string, msg: string?) -> (),
	truthy: (v: any, msg: string?) -> (),
	raises: (fn: () -> (), pattern: string?, msg: string?) -> (),
}

local function json(): any
	return stub.install({}).json
end

local tests: { [string]: (t: T) -> () } = {}

tests.install_exposes_runtime_env_files = function(t)
	local tern = stub.install({ os = "macos", env = { HOME = "/h" }, files = { ["/a"] = true } })
	t.eq(tern.runtime.os, "macos")
	t.eq(tern.runtime.jit, false)
	t.eq(tern.getenv("HOME"), "/h")
	t.eq(tern.getenv("NOPE"), nil)
	t.eq(tern.fs.exists("/a"), true)
	t.eq(tern.fs.exists("/b"), false)
	t.eq(stub.install({}).runtime.os, "windows")
end

tests.install_sets_caller_global = function(t)
	local tern = stub.install({ env = { K = "v" } })
	t.truthy((getfenv(1) :: any).tern == tern)
end

tests.encode_shapes = function(t)
	local j = json()
	t.eq(j.encode({ 1, 2, 3 }), "[1,2,3]")
	t.eq(j.encode({}), "{}")
	t.eq(j.encode({ b = 1, a = { 2 } }), '{"a":[2],"b":1}')
	t.eq(j.encode(3.0), "3")
	t.eq(j.encode(1.5), "1.5")
	t.eq(j.encode(true), "true")
	t.eq(j.encode(j.array()), "[]")
	t.eq(j.encode(j.array({ 1 })), "[1]")
	t.eq(j.encode(j.decode("[]")), "[]")
	t.eq(j.encode(j.decode('{"a":[]}')), '{"a":[]}')
end

tests.encode_numbers_round_trip = function(t)
	local j = json()
	t.eq(j.encode(0.1), "0.1")
	for _, n in { 0.1 + 0.2, 1 / 3, 1e-7, 123456.789, 2 ^ 60 } do
		t.eq(j.decode(j.encode(n)), n)
	end
	t.raises(function()
		j.encode(math.huge)
	end, "^tern%.json%.encode: ")
end

tests.attach_follows_later_installs = function(t)
	stub.install({ os = "windows" })
	local fn = setfenv(loadstring("return tern.runtime.os") :: any, {}) :: any
	stub.attach({ nested = { fn } })
	t.eq(fn(), "windows")
	stub.install({ os = "macos" })
	t.eq(fn(), "macos")
	stub.install({ os = "linux" })
	t.eq(fn(), "linux")
end

tests.encode_sparse_table_is_not_array = function(t)
	local j = json()
	t.raises(function()
		j.encode({ [1] = "x", [3] = "y" })
	end, "keys must be strings")
end

tests.encode_escapes = function(t)
	local j = json()
	t.eq(j.encode('a"b\\c\n\r\t'), '"a\\"b\\\\c\\n\\r\\t"')
	t.eq(j.encode("\1"), '"\\u0001"')
end

tests.encode_pretty_round_trips = function(t)
	local j = json()
	local v = { a = { 1, 2 }, b = { c = "d" } }
	local text = j.encode(v, true)
	t.match(text, "\n")
	t.eq(j.decode(text), v)
end

tests.round_trip = function(t)
	local j = json()
	local v = { list = { 1, "two", { three = 3 } }, s = "q\"\\\n\1é", n = -12.5, ok = false }
	t.eq(j.decode(j.encode(v)), v)
end

tests.decode_scalars = function(t)
	local j = json()
	t.eq(j.decode(" 42 "), 42)
	t.eq(j.decode("-1.5e2"), -150)
	t.eq(j.decode("true"), true)
	t.eq(j.decode("false"), false)
	t.eq(j.decode('"x"'), "x")
	t.eq(j.decode("{}"), {})
	t.eq(j.decode("[]"), {})
end

tests.decode_unicode_escapes = function(t)
	local j = json()
	t.eq(j.decode('"\\u00e9"'), "é")
	t.eq(j.decode('"\\ud83d\\ude00"'), "😀")
	t.eq(j.decode('"\\"\\\\\\/\\b\\f\\n\\r\\t"'), '"\\/\b\f\n\r\t')
	t.eq(j.decode('"é😀"'), "é😀")
end

tests.decode_null_handling = function(t)
	local j = json()
	t.eq(j.decode('{"a":null,"b":1}'), { b = 1 })
	local arr = j.decode("[1,null,3]")
	t.eq(arr[1], 1)
	t.truthy(arr[2] == j.null)
	t.eq(arr[3], 3)
end

tests.decode_errors = function(t)
	local j = json()
	for _, bad in { "", "{", "[1,", '{"a"}', "[1 2]", "tru", '"abc', '"\\x"', '"\\ud800"', "1 2", "{} x", "-" } do
		t.raises(function()
			j.decode(bad)
		end, "^tern%.json%.decode: ", "input " .. bad)
	end
end

tests.fs_in_memory = function(t)
	local tern = stub.install({ files = { ["/d/a.txt"] = "A", ["C:\\x\\y.bin"] = true }, data = "/pd" })
	t.eq(tern.plugin.data, "/pd")
	t.eq(tern.fs.read("/d/a.txt"), "A")
	t.eq(tern.fs.read("C:/x/y.bin"), "", "true means an empty file; both separators work")
	t.raises(function()
		tern.fs.read("/d/a.txt", 0)
	end, "too large")
	t.raises(function()
		tern.fs.write("/nope/f", "x")
	end)
	tern.fs.mkdir("/d/sub/deep")
	tern.fs.write("/d/sub/deep/f", "F")
	t.eq(tern.fs.list("/d"), { "a.txt", "sub" })
	t.eq(tern.fs.exists("/d/sub"), true)
	tern.fs.remove("/d/sub")
	t.eq(tern.fs.exists("/d/sub/deep/f"), false)
	t.eq(tern.fs.list("/d"), { "a.txt" })
	t.raises(function()
		tern.fs.list("/missing")
	end)
end

return tests
