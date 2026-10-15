--!strict
-- Pure rules of the render cache: version keys, attempt folder names, and what to delete.
local util = require("./util")
local canon = require("./canon")

local cache = {}

-- Bump when the cache layout or the render output changes; folders of older versions stop matching.
cache.RENDER_VERSION = 2

-- One attempt folder `<file>/<version>-<pane>`; `used` and `bytes` come from its `used` file.
export type Entry = { file: string, name: string, version: string, pane: number, complete: boolean, used: number, bytes: number }

-- FNV-1a of the content, its length and the render version: letters and digits only.
function cache.version(content: string): string
	return util.key(content) .. string.format("%x", #content) .. "r" .. tostring(cache.RENDER_VERSION)
end

function cache.attempt(version: string, pane: number): string
	return version .. "-" .. string.format("%d", pane)
end

function cache.parse(name: string): (string?, number?)
	local version, pane = name:match("^(%x+r%d+)%-(%d+)$")
	local n = if pane then tonumber(pane) else nil
	if version == nil or n == nil or n >= 2 ^ 53 or cache.attempt(version, n) ~= name then
		return nil, nil
	end
	return version, n
end

function cache.encode_used(time: number, bytes: number): string
	return string.format("%d %d\n", time, bytes)
end

function cache.decode_used(text: string?): (number, number)
	local t, b = (text or ""):match("^(%d+) (%d+)")
	return tonumber(t) or 0, tonumber(b) or 0
end

-- The complete folder of `version` used most recently.
function cache.pick(entries: { Entry }, version: string): Entry?
	local best: Entry? = nil
	for _, e in entries do
		if e.complete and e.version == version and (best == nil or e.used > best.used) then
			best = e
		end
	end
	return best
end

-- Unfinished folders of `pane` for other versions: attempts it will never finish.
function cache.stale_own(entries: { Entry }, pane: number, version: string): { Entry }
	local out: { Entry } = {}
	for _, e in entries do
		if not e.complete and e.pane == pane and e.version ~= version then
			table.insert(out, e)
		end
	end
	return out
end

local function keyOf(e: Entry): string
	return e.file .. "/" .. e.name
end

-- Folders to delete: unfinished ones of panes that are gone; per file, older copies of a version and
-- versions past the `keep` most recently used; then the least recently used until the complete ones total
-- at most `max_bytes`. Entries in `protect` are never deleted.
function cache.prune(entries: { Entry }, live: { [number]: boolean }, protect: { [string]: boolean }, keep: number, max_bytes: number): { Entry }
	local out: { Entry } = {}
	local kept: { Entry } = {}
	local byFile: { [string]: { Entry } } = {}
	for _, e in entries do
		if e.complete then
			local list = byFile[e.file] or {}
			byFile[e.file] = list
			table.insert(list, e)
		elseif not live[e.pane] and not protect[keyOf(e)] then
			table.insert(out, e)
		end
	end
	for _, list in byFile do
		table.sort(list, function(a: Entry, b: Entry): boolean
			return a.used > b.used
		end)
		local versions: { [string]: boolean } = {}
		local count = 0
		for _, e in list do
			local fresh = not versions[e.version]
			if protect[keyOf(e)] or (fresh and count < keep) then
				if fresh then
					versions[e.version] = true
					count += 1
				end
				table.insert(kept, e)
			else
				table.insert(out, e)
			end
		end
	end
	table.sort(kept, function(a: Entry, b: Entry): boolean
		return a.used < b.used
	end)
	local total = 0
	for _, e in kept do
		total += e.bytes
	end
	for _, e in kept do
		if total <= max_bytes then
			break
		end
		if not protect[keyOf(e)] then
			table.insert(out, e)
			total -= e.bytes
		end
	end
	return out
end

-- One key per top-level frame of `content`: the hash of the frame and of what any frame may draw from (members of
-- the root other than `children`, top-level nodes that are not frames, `reusable` nodes anywhere), so an edit
-- inside one frame changes only its key and an edit to a variable or a component changes them all. Empty when
-- `content` is not a `.pen` document.
function cache.frame_keys(content: string): { [string]: string }
	local out: { [string]: string } = {}
	local ok, decoded = pcall(tern.json.decode, content)
	if not ok or typeof(decoded) ~= "table" or typeof((decoded :: any).children) ~= "table" then
		return out
	end
	local root = decoded :: any
	local shared: { string } = {}
	for k, v in root do
		if k ~= "children" then
			table.insert(shared, tostring(k) .. "=" .. canon.encode(v))
		end
	end
	table.sort(shared)
	local function reusables(n: any)
		if typeof(n) ~= "table" then
			return
		end
		if n.reusable == true then
			table.insert(shared, canon.encode(n))
		end
		if typeof(n.children) == "table" then
			for _, c in n.children do
				reusables(c)
			end
		end
	end
	local frames: { any } = {}
	for _, node in root.children :: { any } do
		if typeof(node) == "table" and node.type == "frame" then
			table.insert(frames, node)
		else
			table.insert(shared, canon.encode(node))
		end
		reusables(node)
	end
	local base = table.concat(shared, "\n")
	local seed = util.key(base) .. string.format("%x", #base)
	for _, f in frames do
		if typeof(f.id) == "string" then
			local text = seed .. "\n" .. canon.encode(f)
			out[f.id] = util.key(text) .. string.format("%x", #text) .. "r" .. tostring(cache.RENDER_VERSION)
		end
	end
	return out
end

-- Names under `img/` that no kept version uses and no running batch writes.
function cache.orphans(img_names: { string }, used: { [string]: boolean }, busy: { [string]: boolean }): { string }
	local out: { string } = {}
	for _, name in img_names do
		if not used[name] and not busy[name] then
			table.insert(out, name)
		end
	end
	return out
end

-- Version folders written by another RENDER_VERSION; their layout or output no longer matches.
function cache.stale_render(entries: { Entry }): { Entry }
	local out: { Entry } = {}
	for _, e in entries do
		if tonumber(e.version:match("r(%d+)$")) ~= cache.RENDER_VERSION then
			table.insert(out, e)
		end
	end
	return out
end

-- Where a reserve render of a frame with `key` goes: a sealed key folder is shown as is (no process); an unsealed one
-- that no other batch holds (`busy`) gets the export; otherwise, or with no key, the version folder does.
function cache.reserve_plan(key: string?, sealed: boolean, busy: boolean): "show" | "key" | "version"
	if key == nil then
		return "version"
	end
	if sealed then
		return "show"
	end
	return if busy then "version" else "key"
end

-- Whether a reserve export into a key folder earns the seal: only the exact frame asked for (`want`), not cut short,
-- with an image that checked. Anything else is dropped from the folder.
function cache.reserve_outcome(want: string?, exported: string?, timed_out: boolean, image_ok: boolean): "seal" | "drop"
	if timed_out or want == nil or exported ~= want or not image_ok then
		return "drop"
	end
	return "seal"
end

return cache
