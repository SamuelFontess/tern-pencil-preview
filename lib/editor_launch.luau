--!strict
-- Pure validation and request construction for the native editor launcher.
local sha1 = require("./sha1")

local editor_launch = {}

editor_launch.MAX_PAGE_BYTES = 32768
editor_launch.MAX_PAGE_NODES = 64
-- The server wraps every reply in `{"result":…}`, which its 32 KiB page bound does not count.
editor_launch.MAX_BODY_BYTES = editor_launch.MAX_PAGE_BYTES + 64
editor_launch.MAX_RECORD_BYTES = 65536
editor_launch.MIN_NODE_MAJOR = 22

export type PollRequest = {
	url: string,
	options: FetchOptions,
}
-- What a session record gives the plugin: enough to call the owner, nothing about the document.
export type Record = { endpoint: string, token: string, session_id: string }

local function absolute(path: string): boolean
	return path:match("^%a:[/\\]") ~= nil or path:sub(1, 1) == "/"
end

local function valid_argv(argv: { any }): boolean
	if #argv == 0 then
		return false
	end
	for key, value in argv do
		if typeof(key) ~= "number" or key < 1 or key ~= math.floor(key) or typeof(value) ~= "string" then
			return false
		end
	end
	for index = 1, #argv do
		if typeof(argv[index]) ~= "string" then
			return false
		end
	end
	return true
end

-- 32 lowercase hex digits from `seed`: the nonce that lets the plugin find its own session record. Not a secret.
function editor_launch.launch_id(seed: string): string
	return sha1.hex(seed):sub(1, 32)
end

local function valid_launch_id(id: string): boolean
	return id:match("^%x+$") ~= nil and #id == 32 and id == id:lower()
end

-- Encodes the private launch manifest as data; it never builds a shell command.
function editor_launch.manifest(original_path: string, argv: { any }, data_dir: string, launch_id: string): string
	if original_path == "" or not absolute(original_path) then
		error("ORIGINAL_PATH must be a nonempty absolute path", 2)
	end
	if not valid_argv(argv) then
		error("ARGV must be a nonempty list of strings", 2)
	end
	if data_dir == "" or not absolute(data_dir) then
		error("DATA_DIR must be a nonempty absolute path", 2)
	end
	if not valid_launch_id(launch_id) then
		error("LAUNCH_ID must be 32 lowercase hex digits", 2)
	end
	return tern.json.encode({ original_path = original_path, argv = argv, data_dir = data_dir, launch_id = launch_id })
end

editor_launch.MANIFEST_MAX_AGE_S = 600

-- The manifest's file name: it carries its creation time (`tern.fs` has no file times) and the launch nonce.
function editor_launch.manifest_name(epoch: number, launch_id: string): string
	return string.format("launch-%d-%s.json", epoch, launch_id)
end

-- The launch files among `names` made more than `max_age` seconds before `now`: manifests no owner ever consumed, and
-- the reasons (`.failed`) an owner left that no window read. Anything that is not exactly one of those names, or has no
-- creation time, is never named.
function editor_launch.stale_manifests(names: { string }, now: number, max_age: number): { string }
	local out: { string } = {}
	for _, name in names do
		local epoch = name:match("^launch%-(%d+)%-%x+%.json$") or name:match("^launch%-(%d+)%-%x+%.failed$")
		local made = if epoch then tonumber(epoch) else nil
		if made and made > 0 and now - made > max_age then
			table.insert(out, name)
		end
	end
	return out
end

-- The stale manifests in `data_dir`, by file name: the one `fs.list`. A folder that does not exist yet has none.
function editor_launch.stale_in(data_dir: string, now: number): { string }
	local listed, names = pcall(tern.fs.list, data_dir)
	if not listed then
		return {}
	end
	return editor_launch.stale_manifests(names, now, editor_launch.MANIFEST_MAX_AGE_S)
end

-- Removes the stale manifests in `data_dir` and returns how many it removed. Best effort: a folder that does not exist
-- yet or a file that cannot be removed is not an error. Synchronous, for the window's start-up housekeeping (window.luau,
-- a chain step of its own); the open path lists with `stale_in` and removes one file per tick instead.
function editor_launch.sweep(data_dir: string, now: number): number
	local removed = 0
	for _, name in editor_launch.stale_in(data_dir, now) do
		if pcall(tern.fs.remove, data_dir .. "/" .. name) then
			removed += 1
		end
	end
	return removed
end

-- Whether `node --version` printed a Node the editor bundle runs on, else why not (one visible, actionable sentence).
function editor_launch.node_ok(result: ProcessResult): (boolean, string?)
	if result.timed_out or result.status ~= 0 then
		return false, "Node.js was not found. Install Node.js " .. editor_launch.MIN_NODE_MAJOR .. " or newer and try again."
	end
	local major = tonumber(result.stdout:match("^%s*v(%d+)%."))
	if major == nil then
		return false, "Node.js did not report a version. Install Node.js " .. editor_launch.MIN_NODE_MAJOR .. " or newer."
	end
	if major < editor_launch.MIN_NODE_MAJOR then
		return false, string.format("Node.js %d is too old; the editor needs Node.js %d or newer.", major, editor_launch.MIN_NODE_MAJOR)
	end
	return true, nil
end

-- Parses a bounded fetch response. Transport/session loss is distinct from a live owner's application error;
-- the third return preserves its remote code for visible error reporting, never for disconnect decisions.
function editor_launch.page(result: FetchResult): (any?, string?, string?)
	if result.error ~= nil or result.status == 0 then
		return nil, "TRANSPORT", nil
	end
	if #result.body > editor_launch.MAX_BODY_BYTES then
		return nil, "METADATA_LIMIT", nil
	end
	local ok, decoded = pcall(tern.json.decode, result.body)
	local object = ok and typeof(decoded) == "table" and result.body:match("^%s*%[") == nil
	if result.status ~= 200 then
		local failure = if object then (decoded :: any).error else nil
		local code = if typeof(failure) == "table" and typeof(failure.code) == "string" then failure.code else nil
		if code == "VIEW_STALE" then
			return nil, "VIEW_STALE", code
		elseif code == "SESSION_MISSING" or code == "SESSION_UNAVAILABLE" or code == "SERVER_CLOSING" or code == "SESSION_MISMATCH" then
			return nil, "OWNER_ABSENT", code
		end
		return nil, if code then "REMOTE_ERROR" else "BAD_REPLY", code
	end
	if not object or typeof((decoded :: any).result) ~= "table" then
		return nil, "BAD_REPLY", nil
	end
	return (decoded :: any).result, nil, nil
end

local function loopback_endpoint(endpoint: string): boolean
	local port = endpoint:match("^http://127%.0%.0%.1:(%d+)$") or endpoint:match("^http://127%.0%.0%.1:(%d+)/.*$")
	if port == nil then
		return false
	end
	local number = tonumber(port)
	return number ~= nil and number >= 1 and number <= 65535
end

-- A well-formed session record, whoever it is for.
local function parse_record(text: string): any?
	if #text > editor_launch.MAX_RECORD_BYTES then
		return nil
	end
	local ok, decoded = pcall(tern.json.decode, text)
	if not ok or typeof(decoded) ~= "table" then
		return nil
	end
	local value = decoded :: any
	if
		value.version ~= 1
		or typeof(value.endpoint) ~= "string"
		or value.endpoint:match("^http://127%.0%.0%.1:%d+$") == nil
		or not loopback_endpoint(value.endpoint)
		or typeof(value.token) ~= "string"
		or #value.token < 32
		or typeof(value.session_id) ~= "string"
		or value.session_id == ""
	then
		return nil
	end
	return value
end

local function kept(value: any): Record
	return { endpoint = value.endpoint, token = value.token, session_id = value.session_id }
end

-- Reads one private session record. Only the record this launch's nonce names is accepted, and only its endpoint,
-- token and session id are kept.
function editor_launch.record(text: string, launch_id: string): Record?
	local value = parse_record(text)
	if value == nil or value.launch_id ~= launch_id then
		return nil
	end
	return kept(value)
end

local function same_file(a: string, b: string): boolean
	local function normal(path: string): string
		return (path:lower():gsub("\\", "/"):gsub("/+$", ""))
	end
	return normal(a) == normal(b)
end

-- The record of whichever owner serves the document `path`, whatever launch it came from: an owner that is still alive
-- when the window knows nothing about it (a Tern opened again, another window). Only the document it names counts.
function editor_launch.record_of(text: string, path: string): Record?
	local value = parse_record(text)
	if value == nil or typeof(value.original_path) ~= "string" or not same_file(value.original_path, path) then
		return nil
	end
	return kept(value)
end

-- How long ago a launch began, in ms, from the creation time in its manifest's name (see `manifest_name`): an owner still
-- starting publishes its session soon, and one that has not in `max_age` ms never will. A name without one is as old as
-- can be, so nothing waits for it.
function editor_launch.launch_age_ms(manifest: string, now: number, max_age: number): number
	local epoch = tonumber(manifest:match("launch%-(%d+)%-%x+%.json$"))
	if epoch == nil then
		return max_age + 1
	end
	return math.max(0, now - epoch) * 1000
end

-- The file names of the owner's private session records: the one `fs.list`. A folder that does not exist yet has none.
function editor_launch.record_names(data_dir: string): { string }
	local listed, names = pcall(tern.fs.list, data_dir .. "/sessions")
	if not listed then
		return {}
	end
	local out: { string } = {}
	for _, name in names do
		if name:match("%.json$") then
			table.insert(out, name)
		end
	end
	return out
end

-- This launch's record, if the session record file `name` holds it: the one `fs.read`. An unreadable or foreign file is not.
function editor_launch.read_record(data_dir: string, name: string, launch_id: string): Record?
	local read, text = pcall(tern.fs.read, data_dir .. "/sessions/" .. name, editor_launch.MAX_RECORD_BYTES)
	if not read then
		return nil
	end
	return editor_launch.record(text, launch_id)
end

-- The record of the owner that serves `path`, if the session record file `name` is it: the one `fs.read`.
function editor_launch.read_record_of(data_dir: string, name: string, path: string): Record?
	local read, text = pcall(tern.fs.read, data_dir .. "/sessions/" .. name, editor_launch.MAX_RECORD_BYTES)
	if not read then
		return nil
	end
	return editor_launch.record_of(text, path)
end

-- Where an owner that stopped before it published its session leaves the reason: beside its manifest, under its name
-- with `.failed` for `.json` (so `stale_manifests` sweeps both).
function editor_launch.failure_path(manifest_path: string): string
	return (manifest_path:gsub("%.json$", ".failed"))
end

-- The owner's error code for this launch, if it left one: the one `fs.read`. Anything but a plain code is not one.
function editor_launch.read_failure(manifest_path: string): string?
	local read, text = pcall(tern.fs.read, editor_launch.failure_path(manifest_path), 1024)
	if not read then
		return nil
	end
	local ok, decoded = pcall(tern.json.decode, text)
	if not ok or typeof(decoded) ~= "table" then
		return nil
	end
	local code = (decoded :: any).code
	if typeof(code) == "string" and #code <= 40 and code:match("^[A-Z][A-Z_]*$") ~= nil then
		return code
	end
	return nil
end

-- Produces a request for the owner. The token is deliberately present only in an HTTP header.
function editor_launch.poll_request(endpoint: string, token: string, body: any, timeout_ms: number?): PollRequest
	if not loopback_endpoint(endpoint) then
		error("ENDPOINT must be http://127.0.0.1:<port>", 2)
	end
	if token == "" then
		error("TOKEN must be nonempty", 2)
	end
	return {
		url = endpoint,
		options = {
			method = "POST",
			headers = {
				Authorization = "Bearer " .. token,
				["Content-Type"] = "application/json",
			},
			body = tern.json.encode(body),
			timeout_ms = timeout_ms or 120000,
		},
	}
end

-- One method call on the session a record names: the session id travels in the envelope, the token in the header.
function editor_launch.call(record: Record, method: string, args: { [string]: any }, timeout_ms: number?): PollRequest
	return editor_launch.poll_request(record.endpoint, record.token, { method = method, args = args, session_id = record.session_id }, timeout_ms)
end

-- Whether `reply` answers this attach_view call for this view generation.
function editor_launch.attached(reply: any, request_id: string, generation: number): boolean
	return typeof(reply) == "table"
		and reply.request_id == request_id
		and reply.view_generation == generation
		and typeof(reply.status_seq) == "number"
end

-- Whether `reply` answers this select_node call for this view generation and path.
function editor_launch.selected(reply: any, request_id: string, generation: number, path: string): boolean
	return typeof(reply) == "table" and reply.request_id == request_id and reply.view_generation == generation and reply.path == path
end

-- Whether `reply` answers this submit_capture call for this view generation and capture request.
function editor_launch.captured(reply: any, request_id: string, generation: number, capture_id: string): boolean
	return typeof(reply) == "table"
		and reply.request_id == request_id
		and reply.view_generation == generation
		and reply.capture_id == capture_id
		and typeof(reply.outcome) == "string"
end

return editor_launch
