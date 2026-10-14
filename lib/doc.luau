--!strict
-- Extracts and parses the summary line printed by the `refresh` snippet (lib/script.luau).
local doc = {}

export type Layer = {
	id: string,
	name: string,
	type: string,
	depth: number,
	parent: string?,
	x: number?,
	y: number?,
	w: number?,
	h: number?,
	content: string?,
	fill: string?,
	ref: string?,
	reusable: boolean?,
}
export type Frame = { id: string, name: string, type: string, w: number?, h: number?, layers: { Layer } }
export type Summary = { frames: { Frame }, exported: string?, scale: number? }

local MARK = '{"v":'

-- Index of the `}` closing the object opened at `start`, skipping string contents.
local function balancedEnd(s: string, start: number): number?
	local depth = 0
	local inString = false
	local escaped = false
	for i = start, #s do
		local c = s:byte(i)
		if inString then
			if escaped then
				escaped = false
			elseif c == 92 then -- backslash
				escaped = true
			elseif c == 34 then -- "
				inString = false
			end
		elseif c == 34 then
			inString = true
		elseif c == 123 then -- {
			depth += 1
		elseif c == 125 then -- }
			depth -= 1
			if depth == 0 then
				return i
			end
		end
	end
	return nil
end

local function findRaw(s: string): string?
	local start = s:find(MARK, 1, true)
	if not start then
		return nil
	end
	local stop = balancedEnd(s, start)
	if not stop then
		return nil
	end
	return s:sub(start, stop)
end

function doc.find_summary(stdout: string): string?
	local raw = findRaw(stdout)
	if raw then
		return raw
	end
	-- app mode: pretty JSON objects whose "message" string carries the print output
	local pos = 1
	while true do
		local open = stdout:find("{", pos, true)
		if not open then
			return nil
		end
		local stop = balancedEnd(stdout, open)
		if not stop then
			pos = open + 1
		else
			local obj = stdout:sub(open, stop)
			if obj:find('"message"', 1, true) then
				local ok, decoded = pcall(tern.json.decode, obj)
				if ok and typeof(decoded) == "table" then
					local message = (decoded :: any).message
					if typeof(message) == "string" then
						local found = findRaw(message)
						if found then
							return found
						end
					end
				end
			end
			pos = stop + 1
		end
	end
end

local function str(v: any): string?
	if typeof(v) == "string" then
		return v
	end
	return nil
end

local function num(v: any): number?
	if typeof(v) == "number" then
		return v
	end
	return nil
end

function doc.parse(line: string): (Summary?, string?)
	local ok, decoded = pcall(tern.json.decode, line)
	if not ok then
		return nil, "invalid summary: " .. tostring(decoded)
	end
	if typeof(decoded) ~= "table" or (decoded :: any).v ~= 1 then
		return nil, "unsupported summary version"
	end
	local root = decoded :: any
	local frames: { Frame } = {}
	local current: Frame? = nil
	local layers = root.layers
	if typeof(layers) == "table" then
		for _, raw in layers :: { any } do
			if typeof(raw) == "table" then
				local id, kind = str(raw.id), str(raw.type)
				if id and kind then
					local name = str(raw.name) or ""
					local depth = num(raw.d) or 0
					if depth == 0 then
						local frame: Frame = {
							id = id,
							name = name,
							type = kind,
							w = num(raw.w),
							h = num(raw.h),
							layers = {},
						}
						table.insert(frames, frame)
						current = frame
					elseif current then
						table.insert(current.layers, {
							id = id,
							name = name,
							type = kind,
							depth = depth,
							parent = str(raw.p),
							x = num(raw.x),
							y = num(raw.y),
							w = num(raw.w),
							h = num(raw.h),
							content = str(raw.content),
							fill = str(raw.fill),
							ref = str(raw.ref),
							reusable = if typeof(raw.reusable) == "boolean" then raw.reusable else nil,
						})
					end
				end
			end
		end
	end
	return { frames = frames, exported = str(root.exported), scale = num(root.scale) }, nil
end

return doc
