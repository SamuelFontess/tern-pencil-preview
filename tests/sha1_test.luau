--!strict
local sha1 = require("../lib/sha1")

type T = {
	eq: (actual: any, expected: any, msg: string?) -> (),
	match: (s: string, pattern: string, msg: string?) -> (),
	truthy: (v: any, msg: string?) -> (),
	raises: (fn: () -> (), pattern: string?, msg: string?) -> (),
}

local tests: { [string]: (t: T) -> () } = {}

tests.matches_reference_digests = function(t)
	t.eq(sha1.hex(""), "da39a3ee5e6b4b0d3255bfef95601890afd80709")
	t.eq(sha1.hex("abc"), "a9993e364706816aba3e25717850c26c9cd0d89d")
	t.eq(sha1.hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"), "84983e441c3bd26ebaae4aa1f95129e5e54670f1")
end

tests.spans_several_blocks = function(t)
	t.eq(sha1.hex(string.rep("a", 1000)), "291e9a6c66994949b57ba5e650361e98fc36b1ba")
end

tests.names_a_real_pencil_backup = function(t)
	-- The backup of D:\pen-probe\probe.pen, seen on disk on 2026-10-14.
	t.eq(sha1.hex("file:///D:/pen-probe/probe.pen"), "c4cfa63fde8a8cca804041af59b55cc06e98b6d9")
end

return tests
