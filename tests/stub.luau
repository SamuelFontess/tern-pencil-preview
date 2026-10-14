--!strict
-- Minimal `tern` global stub for unit tests (runtime, getenv, fs.exists, json).

local NULL = {}

-- Tables tagged by json.array / decode: an empty one encodes as [] rather than {}.
local arrays: { [any]: boolean } = setmetatable({}, { __mode = "k" }) :: any

local function markArray(t: any): any
	arrays[t] = true
	return t
end

local function isArray(t: { [any]: any }): (boolean, number)
	local count = 0
	for _ in t do
		count += 1
	end
	if count == 0 then
		return false, 0
	end
	for i = 1, count do
		if t[i] == nil then
			return false, count
		end
	end
	return true, count
end

local function escapeString(s: string): string
	local out = s:gsub('[%c"\\]', function(c: string): string
		if c == '"' then
			return '\\"'
		elseif c == "\\" then
			return "\\\\"
		elseif c == "\n" then
			return "\\n"
		elseif c == "\r" then
			return "\\r"
		elseif c == "\t" then
			return "\\t"
		end
		return string.format("\\u%04X", string.byte(c))
	end)
	return '"' .. out .. '"'
end

local function encodeNumber(n: number): string
	if n ~= n or n == math.huge or n == -math.huge then
		error("tern.json.encode: non-finite number", 0)
	end
	if n == math.floor(n) and math.abs(n) < 2 ^ 53 then
		return string.format("%d", n)
	end
	local s = string.format("%.15g", n)
	if tonumber(s) ~= n then
		s = string.format("%.16g", n)
		if tonumber(s) ~= n then
			s = string.format("%.17g", n)
		end
	end
	return s
end

local function encode(value: any, pretty: boolean?, indent: string?): string
	local ind = indent or ""
	local kind = typeof(value)
	if value == nil or value == NULL then
		return "null"
	elseif kind == "boolean" then
		return if value then "true" else "false"
	elseif kind == "number" then
		return encodeNumber(value)
	elseif kind == "string" then
		return escapeString(value)
	elseif kind ~= "table" then
		error("tern.json.encode: unsupported type " .. kind, 0)
	end
	local isArr, count = isArray(value)
	if count == 0 then
		return if arrays[value] then "[]" else "{}"
	end
	local inner = ind .. "  "
	local sep = if pretty then ",\n" .. inner else ","
	local open = if pretty then "\n" .. inner else ""
	local close = if pretty then "\n" .. ind else ""
	local parts: { string } = {}
	if isArr then
		for i = 1, count do
			table.insert(parts, encode(value[i], pretty, inner))
		end
		return "[" .. open .. table.concat(parts, sep) .. close .. "]"
	end
	local keys: { string } = {}
	for k in value do
		if typeof(k) ~= "string" then
			error("tern.json.encode: object keys must be strings", 0)
		end
		table.insert(keys, k)
	end
	table.sort(keys)
	local colon = if pretty then ": " else ":"
	for _, k in keys do
		table.insert(parts, escapeString(k) .. colon .. encode(value[k], pretty, inner))
	end
	return "{" .. open .. table.concat(parts, sep) .. close .. "}"
end

local function decode(text: string): any
	local pos = 1

	local function fail(msg: string): never
		error("tern.json.decode: " .. msg .. " at position " .. pos, 0)
	end

	local function skip()
		pos = text:find("[^ \t\r\n]", pos) or #text + 1
	end

	local parseValue: () -> any

	local function parseString(): string
		pos += 1 -- opening quote
		local buf: { string } = {}
		while true do
			local c = text:sub(pos, pos)
			if c == "" then
				fail("unterminated string")
			elseif c == '"' then
				pos += 1
				return table.concat(buf)
			elseif c == "\\" then
				local e = text:sub(pos + 1, pos + 1)
				local simple = ({ ['"'] = '"', ["\\"] = "\\", ["/"] = "/", b = "\b", f = "\f", n = "\n", r = "\r", t = "\t" })[e]
				if simple then
					table.insert(buf, simple)
					pos += 2
				elseif e == "u" then
					local hex = text:match("^%x%x%x%x", pos + 2)
					if not hex then
						fail("invalid unicode escape")
					end
					local cp = tonumber(hex, 16) :: number
					pos += 6
					if cp >= 0xD800 and cp <= 0xDBFF then
						local lo = text:match("^\\u(%x%x%x%x)", pos)
						local lov = lo and tonumber(lo, 16)
						if lov and lov >= 0xDC00 and lov <= 0xDFFF then
							cp = 0x10000 + (cp - 0xD800) * 0x400 + (lov - 0xDC00)
							pos += 6
						else
							fail("unpaired surrogate")
						end
					elseif cp >= 0xDC00 and cp <= 0xDFFF then
						fail("unpaired surrogate")
					end
					table.insert(buf, utf8.char(cp))
				else
					fail("invalid escape")
				end
			elseif string.byte(c) < 0x20 then
				fail("control character in string")
			else
				local stop = text:find('["\\%c]', pos) or #text + 1
				table.insert(buf, text:sub(pos, stop - 1))
				pos = stop
			end
		end
	end

	local function parseNumber(): number
		local s = text:match("^-?%d+%.?%d*[eE]?[+-]?%d*", pos)
		local n = s and tonumber(s)
		if not s or not n then
			fail("invalid number")
		end
		pos += #s
		return n
	end

	local function parseLiteral(word: string, value: any): any
		if text:sub(pos, pos + #word - 1) ~= word then
			fail("invalid literal")
		end
		pos += #word
		return value
	end

	parseValue = function(): any
		skip()
		local c = text:sub(pos, pos)
		if c == "{" then
			pos += 1
			local obj: { [string]: any } = {}
			skip()
			if text:sub(pos, pos) == "}" then
				pos += 1
				return obj
			end
			while true do
				skip()
				if text:sub(pos, pos) ~= '"' then
					fail("expected string key")
				end
				local key = parseString()
				skip()
				if text:sub(pos, pos) ~= ":" then
					fail("expected ':'")
				end
				pos += 1
				local v = parseValue()
				if v ~= NULL then
					obj[key] = v
				end
				skip()
				local d = text:sub(pos, pos)
				pos += 1
				if d == "}" then
					return obj
				elseif d ~= "," then
					pos -= 1
					fail("expected ',' or '}'")
				end
			end
		elseif c == "[" then
			pos += 1
			local arr: { any } = markArray({})
			skip()
			if text:sub(pos, pos) == "]" then
				pos += 1
				return arr
			end
			while true do
				table.insert(arr, parseValue())
				skip()
				local d = text:sub(pos, pos)
				pos += 1
				if d == "]" then
					return arr
				elseif d ~= "," then
					pos -= 1
					fail("expected ',' or ']'")
				end
			end
		elseif c == '"' then
			return parseString()
		elseif c == "t" then
			return parseLiteral("true", true)
		elseif c == "f" then
			return parseLiteral("false", false)
		elseif c == "n" then
			return parseLiteral("null", NULL)
		elseif c == "-" or c:match("%d") then
			return parseNumber()
		elseif c == "" then
			fail("unexpected end of input")
		end
		fail("unexpected character '" .. c .. "'")
	end

	local result = parseValue()
	skip()
	if pos <= #text then
		fail("trailing text")
	end
	return result
end

export type Opts = {
	os: string?,
	env: { [string]: string }?,
	files: { [string]: boolean }?,
}

-- The Luau CLI freezes _G and gives every module its own globals table, so a stub cannot be
-- installed process-wide. install() returns the stub and sets `tern` in the caller's globals;
-- attach(module) sets it in the globals of a required module (all of its closures share them).
local M = {}

local current: any = nil
local attachedEnvs: { [{ [string]: any }]: boolean } = setmetatable({}, { __mode = "k" }) :: any

local function setGlobal(fn: any, tern: any)
	(getfenv(fn) :: any).tern = tern
end

local function attachTo(value: any, seen: { [any]: boolean })
	if typeof(value) == "function" then
		local fenv = getfenv(value) :: any
		attachedEnvs[fenv] = true
		fenv.tern = current
	elseif typeof(value) == "table" and not seen[value] then
		seen[value] = true
		for _, v in value do
			attachTo(v, seen)
		end
	end
end

function M.attach<T>(mod: T): T
	attachTo(mod, {})
	return mod
end

function M.install(opts: Opts): any
	local env = opts.env or {}
	local files = opts.files or {}
	local tern = {
		runtime = { os = opts.os or "windows", jit = false },
		getenv = function(name: string): string?
			return env[name]
		end,
		fs = {
			exists = function(path: string): boolean
				return files[path] == true
			end,
		},
		json = {
			null = NULL,
			encode = encode,
			decode = decode,
			array = function(t: { any }?): { any }
				return markArray(t or {})
			end,
		},
	}
	current = tern
	for attached in attachedEnvs do
		attached.tern = tern
	end
	setGlobal(3, tern)
	return tern
end

return M
