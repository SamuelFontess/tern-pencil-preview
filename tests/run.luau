--!strict
-- Test runner: `luau tests/run.luau` from the repo root.
-- Suites are modules returning { [name]: (t: T) -> () }. Suites annotate with a structural copy of T
-- (requiring this file from a suite would re-run it).

local SUITES: { string } = {
	"./stub_test",
	"./script_test",
	"./launch_test",
	"./doc_test",
	"./util_test",
	"./cache_test",
	"./store_test",
	"./sha1_test",
	"./mirror_test",
}

export type T = {
	eq: (actual: any, expected: any, msg: string?) -> (),
	match: (s: string, pattern: string, msg: string?) -> (),
	truthy: (v: any, msg: string?) -> (),
	raises: (fn: () -> (), pattern: string?, msg: string?) -> (),
}

local function show(v: any): string
	if typeof(v) == "string" then
		return string.format("%q", v)
	elseif typeof(v) ~= "table" then
		return tostring(v)
	end
	local keys: { any } = {}
	for k in v do
		table.insert(keys, k)
	end
	table.sort(keys, function(a: any, b: any): boolean
		return tostring(a) < tostring(b)
	end)
	local parts: { string } = {}
	for _, k in keys do
		table.insert(parts, tostring(k) .. "=" .. show(v[k]))
	end
	return "{" .. table.concat(parts, ", ") .. "}"
end

local function deepEq(a: any, b: any): boolean
	if a == b then
		return true
	end
	if typeof(a) ~= "table" or typeof(b) ~= "table" then
		return false
	end
	for k, v in a do
		if not deepEq(v, b[k]) then
			return false
		end
	end
	for k in b do
		if a[k] == nil then
			return false
		end
	end
	return true
end

local function withMsg(base: string, msg: string?): string
	if msg then
		return msg .. ": " .. base
	end
	return base
end

local t: T = {
	eq = function(actual, expected, msg)
		if not deepEq(actual, expected) then
			error(withMsg("expected " .. show(expected) .. ", got " .. show(actual), msg), 0)
		end
	end,
	match = function(s, pattern, msg)
		if typeof(s) ~= "string" or not s:find(pattern) then
			error(withMsg(show(s) .. " does not match " .. show(pattern), msg), 0)
		end
	end,
	truthy = function(v, msg)
		if not v then
			error(withMsg("expected truthy, got " .. show(v), msg), 0)
		end
	end,
	raises = function(fn, pattern, msg)
		local ok, err = pcall(fn)
		if ok then
			error(withMsg("expected an error, none raised", msg), 0)
		end
		if pattern and not tostring(err):find(pattern) then
			error(withMsg("error " .. show(tostring(err)) .. " does not match " .. show(pattern), msg), 0)
		end
	end,
}

local passed, failed = 0, 0
for _, path in SUITES do
	local suite = (require :: any)(path) :: { [string]: (t: T) -> () }
	local names: { string } = {}
	for name in suite do
		table.insert(names, name)
	end
	table.sort(names)
	local label = path:gsub("^%./", "")
	for _, name in names do
		local ok, err = pcall(suite[name], t)
		if ok then
			passed += 1
		else
			failed += 1
			print(string.format("FAIL %s.%s: %s", label, name, tostring(err)))
		end
	end
end

print(string.format("%d passed, %d failed", passed, failed))
if failed > 0 then
	-- the Luau CLI has no os.exit; an uncaught error exits with status 1
	error(string.format("%d test(s) failed", failed), 0)
end
