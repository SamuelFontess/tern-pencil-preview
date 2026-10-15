--!strict
-- The render cache on disk, per file (`<plugin.data>/cache/<file key>/`): `img/<frame key>/` holds the image of
-- one frame version (`<id>.jpeg|png`) and, once checked, `ok`; each `<version>-<pane>/` folder holds
-- `summary.json` (the `refresh` output), `keys.json` (frame id → frame key), `used` and, written last,
-- `complete`. Frames rendered one per run go to their key folder when it is free, else to the version folder.
local cache = require("./cache")
local doc = require("./doc")
local util = require("./util")

local store = {}

local MAX_SUMMARY = 16 * 1024 * 1024
local MAX_IMAGE = 64 * 1024 * 1024

function store.root(): string
	return tern.plugin.data .. "/cache"
end

function store.file_dir(path: string): string
	return store.root() .. "/" .. util.key(path)
end

local function readOr(path: string, max: number): string?
	if not tern.fs.exists(path) then
		return nil
	end
	local ok, text = pcall(tern.fs.read, path, max)
	return if ok then text else nil
end

-- Entry names of folder `dir`; empty when it is missing or is a file.
local function names(dir: string): { string }
	local ok, list = pcall(tern.fs.list, dir)
	return if ok then list else {}
end

function store.list(file_dir: string): { cache.Entry }
	local out: { cache.Entry } = {}
	local file = file_dir:match("([^/\\]+)$") or file_dir
	for _, name in names(file_dir) do
		local version, pane = cache.parse(name)
		if version and pane then
			local dir = file_dir .. "/" .. name
			local used, bytes = cache.decode_used(readOr(dir .. "/used", 64))
			table.insert(out, {
				file = file,
				name = name,
				version = version,
				pane = pane,
				complete = tern.fs.exists(dir .. "/complete"),
				used = used,
				bytes = bytes,
			})
		end
	end
	return out
end

function store.list_all(): { cache.Entry }
	local out: { cache.Entry } = {}
	local root = store.root()
	for _, file in names(root) do
		for _, e in store.list(root .. "/" .. file) do
			table.insert(out, e)
		end
	end
	return out
end

function store.dir(e: cache.Entry): string
	return store.root() .. "/" .. e.file .. "/" .. e.name
end

function store.load(dir: string): (doc.Summary?, string?)
	local line = readOr(dir .. "/summary.json", MAX_SUMMARY)
	if line == nil then
		return nil, "no summary in the cache folder"
	end
	return doc.parse(line)
end

-- Bytes and MIME type of frame `id`'s image in `dir`, or nil when it has none.
function store.image(dir: string, id: string): (string?, string?)
	local jpeg = readOr(dir .. "/" .. id .. ".jpeg", MAX_IMAGE)
	if jpeg then
		return jpeg, "image/jpeg"
	end
	local png = readOr(dir .. "/" .. id .. ".png", MAX_IMAGE)
	if png then
		return png, "image/png"
	end
	return nil, nil
end

-- Whether `dir` holds an image of frame `id`, without reading it.
function store.has_image(dir: string, id: string): boolean
	return tern.fs.exists(dir .. "/" .. id .. ".jpeg") or tern.fs.exists(dir .. "/" .. id .. ".png")
end

function store.finish(dir: string, summary: string, bytes: number, keys: { [string]: string })
	tern.fs.write(dir .. "/summary.json", summary)
	tern.fs.write(dir .. "/keys.json", tern.json.encode(keys))
	tern.fs.write(dir .. "/used", cache.encode_used(os.time(), bytes))
	tern.fs.write(dir .. "/complete", "")
end

function store.touch(dir: string, bytes: number)
	tern.fs.write(dir .. "/used", cache.encode_used(os.time(), bytes))
end

function store.remove(entries: { cache.Entry })
	for _, e in entries do
		pcall(tern.fs.remove, store.dir(e))
	end
end

local MAX_KEYS = 4 * 1024 * 1024

function store.key_dir(file_dir: string, key: string): string
	return file_dir .. "/img/" .. key
end

-- Frame id → frame key of a version folder; empty when it has none (older layout, reserve renders).
function store.keys(dir: string): { [string]: string }
	local out: { [string]: string } = {}
	local text = readOr(dir .. "/keys.json", MAX_KEYS)
	if text == nil then
		return out
	end
	local ok, decoded = pcall(tern.json.decode, text)
	if not ok or typeof(decoded) ~= "table" then
		return out
	end
	for id, key in decoded :: { [any]: any } do
		if typeof(id) == "string" and typeof(key) == "string" then
			out[id] = key
		end
	end
	return out
end

-- Marks a key folder's image as checked; an export cut short by a timeout never gets the mark.
function store.seal(dir: string, bytes: number)
	tern.fs.write(dir .. "/ok", string.format("%d\n", bytes))
end

-- The bytes of a key folder's checked image, or nil when it has none.
function store.sealed(dir: string): number?
	local text = readOr(dir .. "/ok", 64)
	return if text then tonumber(text:match("^(%d+)")) else nil
end

-- Deletes the image folders of `file_dir` that no complete version uses, except those a running batch writes
-- (`busy`, by `key_dir` path).
function store.sweep(file_dir: string, busy: { [string]: boolean })
	local used: { [string]: boolean } = {}
	for _, e in store.list(file_dir) do
		if e.complete then
			for _, key in store.keys(file_dir .. "/" .. e.name) do
				used[key] = true
			end
		end
	end
	local imgs = names(file_dir .. "/img")
	local held: { [string]: boolean } = {}
	for _, n in imgs do
		if busy[store.key_dir(file_dir, n)] then
			held[n] = true
		end
	end
	for _, n in cache.orphans(imgs, used, held) do
		pcall(tern.fs.remove, store.key_dir(file_dir, n))
	end
end

-- Whether frame `id` of a version has an image to show: in its key folder only when that folder is sealed,
-- else in the version folder `dir` (frames without a key, reserve renders).
function store.frame_ready(file_dir: string, dir: string, key: string?, id: string): boolean
	if key then
		return store.sealed(store.key_dir(file_dir, key)) ~= nil
	end
	return store.has_image(dir, id)
end

return store
