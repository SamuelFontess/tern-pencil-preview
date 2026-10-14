--!strict
-- Pure rules of the render cache: version keys, attempt folder names, and what to delete.
local util = require("./util")

local cache = {}

-- Bump when the cache layout or the render output changes; folders of older versions stop matching.
cache.RENDER_VERSION = 1

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

return cache
