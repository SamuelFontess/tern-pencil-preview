--!strict
-- A canonical text of a decoded JSON value: object members in key order, so equal documents give equal text
-- whatever order the file had them in. Arrays are tables keyed 1..n; an empty table is `{}`.
local canon = {}

local function write(v: any, out: { string })
	local kind = typeof(v)
	if kind == "string" then
		table.insert(out, tern.json.encode(v))
	elseif kind == "number" then
		table.insert(out, string.format("%.17g", v))
	elseif kind == "boolean" then
		table.insert(out, if v then "true" else "false")
	elseif kind == "table" and v ~= tern.json.null then
		local n, count = #v, 0
		for _ in v do
			count += 1
		end
		if n > 0 and count == n then
			table.insert(out, "[")
			for i = 1, n do
				if i > 1 then
					table.insert(out, ",")
				end
				write(v[i], out)
			end
			table.insert(out, "]")
		else
			local keys: { string } = {}
			for key in v do
				table.insert(keys, tostring(key))
			end
			table.sort(keys)
			table.insert(out, "{")
			for i, key in keys do
				if i > 1 then
					table.insert(out, ",")
				end
				table.insert(out, tern.json.encode(key))
				table.insert(out, ":")
				write(v[key], out)
			end
			table.insert(out, "}")
		end
	else
		table.insert(out, "null")
	end
end

function canon.encode(v: any): string
	local out: { string } = {}
	write(v, out)
	return table.concat(out)
end

return canon
