--!strict
-- SHA-1 of a string, for the name Pencil gives the backup of an open file. Not used for security.
local sha1 = {}

local TWO_32 = 4294967296

function sha1.hex(msg: string): string
	local len = #msg
	local padded = msg .. "\128" .. string.rep("\0", (55 - len) % 64) .. string.pack(">I8", len * 8)
	local h0, h1, h2, h3, h4 = 0x67452301, 0xEFCDAB89, 0x98BADCFE, 0x10325476, 0xC3D2E1F0
	local w = table.create(80, 0)
	for chunk = 1, #padded, 64 do
		for i = 1, 16 do
			w[i] = string.unpack(">I4", padded, chunk + (i - 1) * 4)
		end
		for i = 17, 80 do
			w[i] = bit32.lrotate(bit32.bxor(w[i - 3], w[i - 8], w[i - 14], w[i - 16]), 1)
		end
		local a, b, c, d, e = h0, h1, h2, h3, h4
		for i = 1, 80 do
			local f, k = 0, 0
			if i <= 20 then
				f, k = bit32.bor(bit32.band(b, c), bit32.band(bit32.bnot(b), d)), 0x5A827999
			elseif i <= 40 then
				f, k = bit32.bxor(b, c, d), 0x6ED9EBA1
			elseif i <= 60 then
				f, k = bit32.bor(bit32.band(b, c), bit32.band(b, d), bit32.band(c, d)), 0x8F1BBCDC
			else
				f, k = bit32.bxor(b, c, d), 0xCA62C1D6
			end
			local temp = (bit32.lrotate(a, 5) + f + e + k + w[i]) % TWO_32
			a, b, c, d, e = temp, a, bit32.lrotate(b, 30), c, d
		end
		h0 = (h0 + a) % TWO_32
		h1 = (h1 + b) % TWO_32
		h2 = (h2 + c) % TWO_32
		h3 = (h3 + d) % TWO_32
		h4 = (h4 + e) % TWO_32
	end
	return string.format("%08x%08x%08x%08x%08x", h0, h1, h2, h3, h4)
end

return sha1
