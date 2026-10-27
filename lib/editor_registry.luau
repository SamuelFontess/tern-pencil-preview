--!strict
-- The editor sessions of this window, kept in `tern.kv` so a plugin reload (which drops the VM and everything in it)
-- can find them again: where the board is, which launch it belongs to and which board shapes the session drew. The owner
-- is a process nobody holds a handle to; it is found again by its own session record under `data_dir`, which is also
-- where its token lives: never a token or a secret here.
local registry = {}

local KEY = "editor_sessions"
-- More shape ids than this are not kept: the caller cuts its list (deterministically) before it stores one.
registry.MAX_SHAPES = 4000

export type Entry = {
	launch_id: string,
	path: string,
	-- 0 while the session has no board.
	board: number,
	data_dir: string,
	manifest: string,
	-- `registry.scope` of the window that owns the session; another scope's entries are never touched.
	scope: string,
	-- The ids of the board shapes the session drew (and so the only ones it may delete after a reload).
	shapes: { string },
	-- The session follows an owner it did not launch (found by the document's path): after a reload it looks for that
	-- owner's record the same way.
	follow: boolean,
}

-- What to change: an entry to store, or false to forget that launch.
export type Ops = { [string]: Entry | false }

-- Which host and named session the window shows. The SDK has no window id (TERN_WINDOW_KEY is "" in a window), so two
-- windows on the same session count as one: they see the same panes. shortcut: upgrade when the SDK offers one.
function registry.scope(cx: WindowCx): string
	local ok, scope = pcall(function(): string
		return tostring(cx.hosts:current().id) .. ":" .. tostring(cx.sessions:current().id)
	end)
	return if ok then scope else ""
end

local function entry_of(id: string, value: any): Entry?
	if typeof(value) ~= "table" then
		return nil
	end
	local v = value :: any
	if
		v.launch_id ~= id
		or typeof(v.path) ~= "string"
		or typeof(v.board) ~= "number"
		or typeof(v.data_dir) ~= "string"
		or typeof(v.manifest) ~= "string"
		or typeof(v.scope) ~= "string"
	then
		return nil
	end
	local shapes: { string } = {}
	if typeof(v.shapes) == "table" then
		for _, shape in v.shapes do
			if typeof(shape) == "string" and #shapes < registry.MAX_SHAPES then
				table.insert(shapes, shape)
			end
		end
	end
	return {
		launch_id = id, path = v.path, board = v.board,
		data_dir = v.data_dir, manifest = v.manifest, scope = v.scope, shapes = shapes, follow = v.follow == true,
	}
end

-- Every well-formed entry, or nil when the store could not be read (never overwrite what could not be read).
local function stored(): { [string]: Entry }?
	local ok, raw = pcall(tern.kv.get, KEY)
	if not ok then
		return nil
	end
	local out: { [string]: Entry } = {}
	if typeof(raw) == "table" then
		for id, value in raw :: { [any]: any } do
			local entry = if typeof(id) == "string" then entry_of(id, value) else nil
			if entry then
				out[id :: string] = entry
			end
		end
	end
	return out
end

-- The entries of `scope`, in launch order.
function registry.mine(scope: string): { Entry }
	local out: { Entry } = {}
	local all = stored()
	if all then
		for _, entry in all do
			if entry.scope == scope then
				table.insert(out, entry)
			end
		end
	end
	table.sort(out, function(a: Entry, b: Entry): boolean
		return a.launch_id < b.launch_id
	end)
	return out
end

-- Applies `ops` to the store in one write; the entries of other launches stay as they are. Synchronous and small: call
-- it from a timer tick of its own. Raises when the store cannot be written.
function registry.apply(ops: Ops)
	local all = stored()
	if all == nil then
		return
	end
	for id, op in ops do
		if typeof(op) == "table" then
			all[id] = op
		else
			all[id] = nil
		end
	end
	tern.kv.set(KEY, if next(all) ~= nil then all else nil)
end

return registry
