--!strict
local stub = require("./stub")
local util = stub.attach(require("../lib/util"))

type T = {
	eq: (actual: any, expected: any, msg: string?) -> (),
	match: (s: string, pattern: string, msg: string?) -> (),
	truthy: (v: any, msg: string?) -> (),
	raises: (fn: () -> (), pattern: string?, msg: string?) -> (),
}

local tests: { [string]: (t: T) -> () } = {}

local function frames(...: string): { any }
	local out = {}
	for _, id in { ... } do
		table.insert(out, { id = id, name = id, type = "frame", layers = {} })
	end
	return out
end

local function layers(...: string): { any }
	local out = {}
	for _, id in { ... } do
		table.insert(out, { id = id, name = id, type = "rectangle", depth = 1 })
	end
	return out
end

tests.key_is_fnv1a_32_hex = function(t)
	t.eq(util.key(""), "811c9dc5")
	t.eq(util.key("a"), "e40c292c")
	t.eq(util.key("foobar"), "bf9cf968")
	t.match(util.key("C:\\Users\\me\\design.pen"), "^%x%x%x%x%x%x%x%x$")
	t.truthy(util.key("C:/a.pen") ~= util.key("C:/b.pen"))
end

tests.resolve_joins_relative_paths_only = function(t)
	t.eq(util.resolve("d.pen", "/home/me"), "/home/me/d.pen")
	t.eq(util.resolve("d.pen", "/home/me/"), "/home/me/d.pen")
	t.eq(util.resolve("d.pen", "C:\\work"), "C:\\work\\d.pen")
	t.eq(util.resolve("/abs/d.pen", "/home/me"), "/abs/d.pen")
	t.eq(util.resolve("C:\\x\\d.pen", "D:\\y"), "C:\\x\\d.pen")
	t.eq(util.resolve("c:/x/d.pen", "/y"), "c:/x/d.pen")
	t.eq(util.resolve("d.pen", nil), "d.pen")
end

tests.basename_handles_both_separators = function(t)
	t.eq(util.basename("C:\\x\\design.pen"), "design.pen")
	t.eq(util.basename("/a/b/design.pen"), "design.pen")
	t.eq(util.basename("design.pen"), "design.pen")
end

tests.tail_strips_ansi_and_keeps_the_end = function(t)
	t.eq(util.tail("\27[31mError:\27[0m not logged in\r\n  ", 400), "Error: not logged in")
	t.eq(util.tail("\27]0;title\7ok", 400), "ok")
	t.eq(util.tail("abcdef", 3), "…def")
	t.eq(util.tail("", 10), "")
end

tests.tail_starts_on_a_utf8_boundary = function(t)
	local out = util.tail("xé", 1) -- é is two bytes; one byte would split it
	t.eq(out, "…")
	t.truthy(utf8.len(util.tail("ééé", 3)) ~= nil)
end

tests.tail_of_long_output_with_a_cut_escape = function(t)
	-- 11 bytes per unit, so the 80-byte slice starts inside an escape sequence.
	local long = string.rep("\27[31mab\27[0m", 5000) .. "done"
	t.eq(util.tail(long, 10), "…abababdone")
	t.eq(util.tail(long, 300):find("\27", 1, true), nil)
	t.eq(util.tail(string.rep("é", 1000), 5), "…éé")
end

tests.safe_id_rejects_path_tricks = function(t)
	t.eq(util.safe_id("abc12"), true)
	t.eq(util.safe_id("Frame-1_x"), true)
	t.eq(util.safe_id(""), false)
	t.eq(util.safe_id("a/b"), false)
	t.eq(util.safe_id("a\\b"), false)
	t.eq(util.safe_id(".."), false)
	t.eq(util.safe_id("a..b"), false)
	t.eq(util.safe_id("C:x"), false)
	t.eq(util.safe_id("a\nb"), false)
	t.eq(util.safe_id("a\0b"), false)
end

tests.tail_drops_a_split_character_at_the_slice_start = function(t)
	-- 17 bytes, max*8 = 16: the slice starts on é's second byte and the escapes strip to nothing.
	t.eq(util.tail("é" .. string.rep("\27[00m", 3), 2), "")
end

tests.neighbour_steps_without_wrapping = function(t)
	local f = frames("a", "b", "c")
	t.eq(util.neighbour(f, "a", 1), "b")
	t.eq(util.neighbour(f, "b", -1), "a")
	t.eq(util.neighbour(f, "c", 1), nil)
	t.eq(util.neighbour(f, "a", -1), nil)
	t.eq(util.neighbour(f, "gone", 1), "a")
	t.eq(util.neighbour(f, nil, -1), "a")
	t.eq(util.neighbour({}, "a", 1), nil)
end

tests.frame_finds_id_and_index = function(t)
	local f = frames("a", "b")
	local found, at = util.frame(f, "b")
	t.eq(found and found.id, "b")
	t.eq(at, 2)
	local missing, none = util.frame(f, "z")
	t.eq(missing, nil)
	t.eq(none, 0)
end

tests.step_layer_clamps_and_starts_at_first = function(t)
	local l = layers("x", "y", "z")
	t.eq(util.step_layer(l, nil, 1), "x")
	t.eq(util.step_layer(l, nil, -1), "x")
	t.eq(util.step_layer(l, "x", 1), "y")
	t.eq(util.step_layer(l, "z", 1), nil)
	t.eq(util.step_layer(l, "x", -1), nil)
	t.eq(util.step_layer(l, "gone", 1), "x")
	t.eq(util.step_layer({}, nil, 1), nil)
end

tests.has_layer_checks_the_frame = function(t)
	local frame = { id = "f", name = "f", type = "frame", layers = layers("x") }
	t.eq(util.has_layer(frame, "x"), true)
	t.eq(util.has_layer(frame, "y"), false)
	t.eq(util.has_layer(frame, nil), false)
	t.eq(util.has_layer(nil, "x"), false)
end

local function pngHeader(w: number, h: number): string
	return "\137PNG\r\n\26\n" .. string.pack(">I4", 13) .. "IHDR" .. string.pack(">I4I4", w, h) .. "\8\6\0\0\0"
end

local function jpegHeader(w: number, h: number): string
	return "\255\216" -- SOI
		.. "\255\224" .. string.pack(">I2", 16) .. string.rep("\0", 14) -- APP0
		.. "\255\192" .. string.pack(">I2", 17) .. "\8" .. string.pack(">I2I2", h, w) .. string.rep("\0", 10) -- SOF0
end

tests.image_size_reads_png_and_jpeg = function(t)
	t.eq({ util.image_size(pngHeader(4097, 568)) }, { 4097, 568, "image/png" })
	t.eq({ util.image_size(jpegHeader(2880, 2744)) }, { 2880, 2744, "image/jpeg" })
	t.eq(util.image_size("GIF89a" .. string.rep("\0", 30)), nil, "neither format")
	t.eq(util.image_size(pngHeader(1, 1):sub(1, 20)), nil, "truncated PNG")
	t.eq(util.image_size(jpegHeader(1, 1):sub(1, 22)), nil, "truncated JPEG")
end

tests.shrink_fits_a_real_oversize_export = function(t)
	-- A real 3040 px frame with a 1 px stroke came out 4097 px wide at 1.347 and 4094 px at 1.346.
	local cap = util.shrink(1.347, 4097, 4096) :: number
	t.truthy(cap <= 1.346, "at most the scale seen to fit")
	t.truthy(cap >= 1.345, "shrinks no more than needed")
end

tests.shrink_always_lowers_the_scale = function(t)
	t.eq(util.shrink(2, 4097, 4096), 1.999, "an overshoot that rounds away still lowers the scale")
	t.eq(util.shrink(0.001, 5000, 4096), nil, "no positive scale left")
end

return tests
