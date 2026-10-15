--!strict
-- Pure helpers for the preview block: paths, the data key, process output and selection steps.
local doc = require("./doc")
local sha1 = require("./sha1")

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

-- Width, height and MIME type of a PNG or JPEG, or nil when `bytes` is neither or is cut short.
function util.image_size(bytes: string): (number?, number?, string?)
	if #bytes >= 24 and bytes:sub(1, 8) == "\137PNG\r\n\26\n" and bytes:sub(13, 16) == "IHDR" then
		local w, h = string.unpack(">I4I4", bytes, 17)
		return w, h, "image/png"
	end
	if bytes:sub(1, 2) ~= "\255\216" then
		return nil, nil, nil
	end
	local i = 3
	while i + 8 <= #bytes do
		if bytes:byte(i) ~= 0xFF then
			return nil, nil, nil
		end
		local marker = bytes:byte(i + 1)
		if marker == 0xFF then
			i += 1 -- fill byte
		elseif marker >= 0xC0 and marker <= 0xCF and marker ~= 0xC4 and marker ~= 0xC8 and marker ~= 0xCC then
			local h, w = string.unpack(">I2I2", bytes, i + 5)
			return w, h, "image/jpeg"
		else
			i += 2 + string.unpack(">I2", bytes, i + 2)
		end
	end
	return nil, nil, nil
end

-- The scale (3 decimals, rounded down) at which an export that came out `side` px at `scale` fits
-- `max_side`; always below `scale`, nil when no positive scale is left.
function util.shrink(scale: number, side: number, max_side: number): number?
	local fit = math.min(math.floor(scale * max_side / side * 1000), math.floor(scale * 1000 + 0.5) - 1) / 1000
	return if fit > 0 then fit else nil
end

-- Bytes Node's url.pathToFileURL percent-encodes in a path: what is outside these, as %XX.
local function percent(s: string): string
	return (s:gsub("[^%w!$&'()*+,%-%.;=@_/:]", function(ch: string): string
		return string.format("%%%02X", ch:byte())
	end))
end

-- `path` as Node's `url.pathToFileURL(path).href`: dot segments resolved, the drive letter as given. Nil for a
-- relative path. On Windows, `\` separates and `\\server\share` is a UNC path.
function util.file_uri(path: string, windows: boolean): string?
	local p = if windows then path:gsub("\\", "/") else path
	local prefix: string, body: string
	local server, stail = p:match("^//([^/]+)(/.*)$")
	local drive, dtail = p:match("^(%a:)(/.*)$")
	if windows and server and stail then
		prefix, body = "file://" .. server:lower(), stail
	elseif windows and drive and dtail then
		prefix, body = "file:///" .. drive, dtail
	elseif not windows and p:sub(1, 1) == "/" then
		prefix, body = "file://", p
	else
		return nil
	end
	local parts: { string } = {}
	for seg in body:gmatch("[^/]+") do
		if seg == ".." then
			if #parts > 0 then
				table.remove(parts)
			end
		elseif seg ~= "." then
			table.insert(parts, seg)
		end
	end
	return prefix .. "/" .. percent(table.concat(parts, "/"))
end

-- Where Pencil keeps unsaved edits of `path`: `<home>/.pencil/backup/<sha1 of its file URL>`. The app writes the
-- drive letter as it opened the file, so on Windows both spellings are listed.
function util.backup_paths(home: string?, path: string, windows: boolean): { string }
	local out: { string } = {}
	local uri = util.file_uri(path, windows)
	if home == nil or home == "" or uri == nil then
		return out
	end
	local dir = home .. "/.pencil/backup/"
	table.insert(out, dir .. sha1.hex(uri))
	local drive = if windows then uri:match("^file:///(%a):") else nil
	if drive then
		local other = if drive == drive:upper() then drive:lower() else drive:upper()
		table.insert(out, dir .. sha1.hex("file:///" .. other .. uri:sub(10)))
	end
	return out
end

-- `content` with each relative `"url": "…"` value (no scheme, not rooted, no escapes) as a file URL resolved in
-- `base_dir`, and how many it changed. pen reads a copy of Pencil's backup from another folder; relative assets
-- would resolve there and silently drop out.
function util.rewrite_urls(content: string, base_dir: string, windows: boolean): (string, number)
	local count = 0
	local out = content:gsub('("url"%s*:%s*")([^"\\]*)(")', function(open: string, ...: string): string
		local value, close = ...
		if value == "" or value:match("^%a[%w+.%-]*:") or value:match("^[/\\]") then
			return open .. value .. close
		end
		local uri = util.file_uri(base_dir .. "/" .. value, windows)
		if uri == nil then
			return open .. value .. close
		end
		count += 1
		return open .. uri .. close
	end)
	return out, count
end

function util.dirname(path: string): string
	return path:match("^(.*)[/\\][^/\\]*$") or "."
end

return util