--!strict
-- The render cache on disk: `<plugin.data>/cache/<file key>/<version>-<pane>/` holds `<id>.jpeg|png`,
-- `summary.json` (the `refresh` output), `used` and, written last, `complete`.
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

function store.finish(dir: string, summary: string, bytes: number)
	tern.fs.write(dir .. "/summary.json", summary)
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

return store
