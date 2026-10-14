--!strict
-- Pure helpers for the preview block: paths, the data key, process output and selection steps.
local doc = require("./doc")

type Frame = doc.Frame
type Layer = doc.Layer

local util = {}

local TWO_32 = 2 ^ 32

-- FNV-1a, 32 bits, of `s` as 8 lowercase hex digits. The prime is 2^24 + 403; the product is split so
-- every intermediate stays exact in a double.
function util.key(s: string): string
	local hash = 2166136261
	for i = 1, #s do
		hash = bit32.bxor(hash, s:byte(i))
		hash = (hash * 403 + bit32.lshift(hash, 24)) % TWO_32
	end
	return string.format("%08x", hash)
end

local function isAbsolute(p: string): boolean
	return p:match("^[/\\]") ~= nil or p:match("^%a:[/\\]") ~= nil
end

-- `path` as given when absolute (or without `cwd`), else joined to `cwd`.
function util.resolve(path: string, cwd: string?): string
	if isAbsolute(path) or cwd == nil or cwd == "" then
		return path
	end
	if cwd:match("[/\\]$") then
		return cwd .. path
	end
	local sep = if cwd:find("\\", 1, true) then "\\" else "/"
	return cwd .. sep .. path
end

function util.basename(path: string): string
	return path:match("([^/\\]+)[/\\]*$") or path
end

-- The last `max` bytes (or a little less, to start on a UTF-8 boundary) of `text` without ANSI
-- escape sequences and carriage returns, trimmed.
function util.tail(text: string, max: number): string
	-- Only the end matters: escapes rarely take more than 8 bytes per shown character.
	if #text > max * 8 then
		text = text:sub(-max * 8):gsub("^[\128-\191]+", "")
	end
	local plain = text:gsub("\27%[[0-?]*[ -/]*[@-~]", "")
	plain = plain:gsub("\27%][^\7\27]*\7", ""):gsub("\27%][^\7\27]*\27\\", ""):gsub("\27.", ""):gsub("\r", "")
	plain = plain:gsub("^%s+", ""):gsub("%s+$", "")
	if #plain <= max then
		return plain
	end
	local start = #plain - max + 1
	while start <= #plain do
		local b = plain:byte(start)
		if b < 0x80 or b >= 0xC0 then
			break
		end
		start += 1
	end
	return "…" .. plain:sub(start)
end

-- The frame with `id` and its 1-based index, or nil and 0.
function util.frame(frames: { Frame }, id: string?): (Frame?, number)
	if id == nil then
		return nil, 0
	end
	for i, f in frames do
		if f.id == id then
			return f, i
		end
	end
	return nil, 0
end

-- The id of the frame `step` places from `id` (no wrap-around), or nil when that is no move. An unknown
-- `id` steps from before the first frame.
function util.neighbour(frames: { Frame }, id: string?, step: number): string?
	if #frames == 0 then
		return nil
	end
	local _, at = util.frame(frames, id)
	if at == 0 then
		return frames[1].id
	end
	local to = math.clamp(at + step, 1, #frames)
	if to == at then
		return nil
	end
	return frames[to].id
end

-- The id of the layer `step` places from `id` in `layers`, clamped; nil when that is no move. Without a
-- current layer, the first one.
function util.step_layer(layers: { Layer }, id: string?, step: number): string?
	if #layers == 0 then
		return nil
	end
	local at = 0
	if id ~= nil then
		for i, l in layers do
			if l.id == id then
				at = i
				break
			end
		end
	end
	if at == 0 then
		return layers[1].id
	end
	local to = math.clamp(at + step, 1, #layers)
	if to == at then
		return nil
	end
	return layers[to].id
end

function util.has_layer(frame: Frame?, id: string?): boolean
	if frame == nil or id == nil then
		return false
	end
	for _, l in frame.layers do
		if l.id == id then
			return true
		end
	end
	return false
end

-- Whether `id` is safe to join into a file name: non-empty, without separators, `..`, `:` or control
-- characters.
function util.safe_id(id: string): boolean
	return id ~= "" and id:find("[/\\:%c]") == nil and id:find("..", 1, true) == nil
end

return util