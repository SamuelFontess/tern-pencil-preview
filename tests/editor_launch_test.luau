--!strict
local stub = require("./stub")
local editor_launch = stub.attach(require("../lib/editor_launch"))

type T = {
	eq: (actual: any, expected: any, msg: string?) -> (),
	match: (s: string, pattern: string, msg: string?) -> (),
	truthy: (v: any, msg: string?) -> (),
	raises: (fn: () -> (), pattern: string?, msg: string?) -> (),
}

local tests: { [string]: (t: T) -> () } = {}

local LAUNCH_ID = "0123456789abcdef0123456789abcdef"

local function fetch(body: string, status: number?, error: string?): FetchResult
	return { status = status or 200, headers = {}, body = body, error = error, timed_out = false }
end

local function process(stdout: string, status: number?): ProcessResult
	return { status = status or 0, stdout = stdout, stderr = "", timed_out = false }
end

local function record_text(overrides: { [string]: any }?): string
	local value: { [string]: any } = {
		version = 1,
		original_path = "C:\\design.pen",
		endpoint = "http://127.0.0.1:43123",
		token = string.rep("t", 43),
		session_id = "session-a",
		pid = 7,
		launch_id = LAUNCH_ID,
	}
	for key, replacement in overrides or {} do
		value[key] = replacement
	end
	return tern.json.encode(value)
end

tests.manifest_keeps_paths_cli_and_data_dir_as_json_data = function(t)
	local tern = stub.install({})
	local hostile = "C:\\designs\\A & B's ação ; $x `n (1).pen"
	local encoded = editor_launch.manifest(hostile, { "node", "C:\\pen\\index.mjs" }, "C:\\plugin data\\editor", LAUNCH_ID)
	t.eq(tern.json.decode(encoded), {
		original_path = hostile,
		argv = { "node", "C:\\pen\\index.mjs" },
		data_dir = "C:\\plugin data\\editor",
		launch_id = LAUNCH_ID,
	})
end

tests.manifest_rejects_nonabsolute_paths_invalid_argv_and_bad_nonce = function(t)
	stub.install({})
	local function manifest(original: string, argv: { any }, data: string, id: string): () -> ()
		return function()
			editor_launch.manifest(original, argv, data, id)
		end
	end
	t.raises(manifest("design.pen", { "pen" }, "C:\\data", LAUNCH_ID), "ORIGINAL_PATH")
	t.raises(manifest("C:\\design.pen", {}, "C:\\data", LAUNCH_ID), "ARGV")
	t.raises(manifest("C:\\design.pen", { "pen", 7 }, "C:\\data", LAUNCH_ID), "ARGV")
	t.raises(manifest("C:\\design.pen", { "pen" }, "data", LAUNCH_ID), "DATA_DIR")
	t.raises(manifest("C:\\design.pen", { "pen" }, "", LAUNCH_ID), "DATA_DIR")
	for _, id in { "", "0123", string.upper(LAUNCH_ID), string.rep("g", 32), LAUNCH_ID .. "0" } do
		t.raises(manifest("C:\\design.pen", { "pen" }, "C:\\data", id), "LAUNCH_ID")
	end
end

tests.launch_id_is_a_32_digit_lowercase_nonce_that_depends_on_its_seed = function(t)
	stub.install({})
	local first = editor_launch.launch_id("path|1|0.5")
	t.eq(#first, 32)
	t.truthy(first:match("^%x+$") and first == first:lower())
	t.eq(editor_launch.launch_id("path|1|0.5"), first)
	t.truthy(editor_launch.launch_id("path|2|0.5") ~= first)
	t.eq(editor_launch.manifest("C:\\a.pen", { "pen" }, "C:\\d", first) ~= "", true)
end

tests.manifest_names_carry_their_time_and_only_old_unconsumed_ones_are_swept = function(t)
	stub.install({})
	local id = LAUNCH_ID
	t.eq(editor_launch.manifest_name(1760000000, id), "launch-1760000000-" .. id .. ".json")
	local now = 1760001000
	local names = {
		editor_launch.manifest_name(now - 5, id),
		editor_launch.manifest_name(now - editor_launch.MANIFEST_MAX_AGE_S - 1, id),
		editor_launch.manifest_name(now - editor_launch.MANIFEST_MAX_AGE_S, id),
		editor_launch.manifest_name(0, id),
		(editor_launch.manifest_name(now - editor_launch.MANIFEST_MAX_AGE_S - 1, id):gsub("%.json$", ".failed")),
		(editor_launch.manifest_name(now - 5, id):gsub("%.json$", ".failed")),
		"launch-1-" .. id .. ".failed.json",
		"launch-" .. id .. ".json",
		"launch-1-" .. id .. ".json.bak",
		"history",
		"sessions",
		"projection-status.json",
		"launch-abc-" .. id .. ".json",
	}
	t.eq(editor_launch.stale_manifests(names, now, editor_launch.MANIFEST_MAX_AGE_S), { names[2], names[5] })
	t.eq(editor_launch.stale_manifests({}, now, 1), {})
end

tests.sweep_removes_only_stale_manifests_from_the_data_folder_and_counts_them = function(t)
	local now = 1760001000
	local old = editor_launch.manifest_name(now - editor_launch.MANIFEST_MAX_AGE_S - 5, LAUNCH_ID)
	local fresh = editor_launch.manifest_name(now - 3, LAUNCH_ID)
	local tern = stub.install({
		files = {
			["C:/data/editor/" .. old] = "{}",
			["C:/data/editor/" .. fresh] = "{}",
			["C:/data/editor/projection-status.json"] = "{}",
			["C:/data/editor/sessions/a.json"] = "{}",
		},
	})
	t.eq(editor_launch.sweep("C:/data/editor", now), 1)
	t.eq(tern.fs.exists("C:/data/editor/" .. old), false)
	t.eq(tern.fs.exists("C:/data/editor/" .. fresh), true, "a manifest an owner may still read stays")
	t.eq(tern.fs.exists("C:/data/editor/projection-status.json"), true)
	t.eq(tern.fs.exists("C:/data/editor/sessions/a.json"), true)
	t.eq(editor_launch.sweep("C:/data/editor", now), 0, "nothing left to sweep")
	t.eq(editor_launch.sweep("C:/data/never-created", now), 0, "a data folder that does not exist yet is not an error")
end

tests.node_check_names_a_missing_old_or_unreadable_node = function(t)
	stub.install({})
	t.eq({ editor_launch.node_ok(process("v22.4.1\n")) }, { true, nil })
	t.eq({ editor_launch.node_ok(process("v24.0.0")) }, { true, nil })
	for _, result in {
		process("", 1),
		process("v18.19.0"),
		process("v21.7.3"),
		process("not a version"),
		{ status = -1, stdout = "", stderr = "", timed_out = true } :: ProcessResult,
	} do
		local ok, message = editor_launch.node_ok(result)
		t.eq(ok, false)
		t.match(message :: string, "Node%.js")
	end
end

tests.page_unwraps_the_result_and_distinguishes_every_failure = function(t)
	stub.install({})
	t.eq({ editor_launch.page(fetch('{"result":{"nodes":[]}}')) }, { { nodes = {} }, nil, nil })
	t.eq({ editor_launch.page(fetch("", 0, "connection refused")) }, { nil, "TRANSPORT", nil })
	t.eq({ editor_launch.page(fetch("{}", 500)) }, { nil, "BAD_REPLY", nil })
	t.eq({ editor_launch.page(fetch('{"error":{"code":"VIEW_STALE","message":"x"}}', 400)) }, { nil, "VIEW_STALE", "VIEW_STALE" })
	t.eq({ editor_launch.page(fetch('{"error":{"code":"SESSION_MISMATCH"}}', 409)) }, { nil, "OWNER_ABSENT", "SESSION_MISMATCH" })
	t.eq({ editor_launch.page(fetch(string.rep("x", editor_launch.MAX_BODY_BYTES + 1))) }, { nil, "METADATA_LIMIT", nil })
	t.eq({ editor_launch.page(fetch(string.rep("x", editor_launch.MAX_BODY_BYTES + 1), 500)) }, { nil, "METADATA_LIMIT", nil })
	for _, body in { "[]", "not json", "{}", '{"result":7}', '{"result":"text"}', "[{\"result\":{}}]" } do
		t.eq({ editor_launch.page(fetch(body)) }, { nil, "BAD_REPLY", nil }, body)
	end
end

tests.application_failures_preserve_remote_codes_without_disconnect_classification = function(t)
	stub.install({})
	for _, remote in { "RENDER_MISSING", "RENDER_FRAME_MISSING", "INTERNAL_ERROR", "REVISION_STALE", "INVALID_CURSOR", "OPERATIONS_REJECTED" } do
		local body = '{"error":{"code":"' .. remote .. '","message":"owner is still alive"}}'
		local value, code, detail = editor_launch.page(fetch(body, 400))
		t.eq(value, nil)
		t.eq(code, "REMOTE_ERROR", remote)
		t.eq(detail, remote)
	end
	t.eq({ editor_launch.page(fetch('{"error":{"code":"REVISION_STALE"}}', 409)) }, { nil, "REMOTE_ERROR", "REVISION_STALE" })
end

tests.connection_loss_and_explicit_unavailable_session_are_disconnects = function(t)
	stub.install({})
	t.eq({ editor_launch.page(fetch("", 0, "connection refused")) }, { nil, "TRANSPORT", nil })
	for _, remote in { "SESSION_MISSING", "SESSION_UNAVAILABLE", "SERVER_CLOSING" } do
		t.eq({ editor_launch.page(fetch('{"error":{"code":"' .. remote .. '"}}', 503)) }, { nil, "OWNER_ABSENT", remote })
	end
	t.eq({ editor_launch.page(fetch('{"error":{"code":"INTERNAL_ERROR"}}', 503)) }, { nil, "REMOTE_ERROR", "INTERNAL_ERROR" })
end

tests.a_page_at_the_server_bound_survives_the_result_wrapper = function(t)
	stub.install({})
	local padding = string.rep("x", editor_launch.MAX_PAGE_BYTES - #'{"pad":""}')
	local envelope = '{"pad":"' .. padding .. '"}'
	t.eq(#envelope, editor_launch.MAX_PAGE_BYTES)
	local page, code = editor_launch.page(fetch('{"result":' .. envelope .. "}"))
	t.eq(code, nil)
	t.eq(#(page :: any).pad, #padding)
end

tests.record_is_accepted_only_for_this_launch_nonce_and_a_loopback_owner = function(t)
	stub.install({})
	t.eq(editor_launch.record(record_text(), LAUNCH_ID), {
		endpoint = "http://127.0.0.1:43123",
		token = string.rep("t", 43),
		session_id = "session-a",
	})
	for _, overrides in {
		{ launch_id = "ffffffffffffffffffffffffffffffff" },
		{ launch_id = tern.json.null },
		{ version = 2 },
		{ endpoint = "http://localhost:43123" },
		{ endpoint = "http://127.0.0.1:43123/view" },
		{ endpoint = "http://10.0.0.1:43123" },
		{ endpoint = "http://127.0.0.1:99999" },
		{ token = "short" },
		{ token = 7 },
		{ session_id = "" },
	} do
		t.eq(editor_launch.record(record_text(overrides), LAUNCH_ID), nil)
	end
	t.eq(editor_launch.record("not json", LAUNCH_ID), nil)
	t.eq(editor_launch.record("[]", LAUNCH_ID), nil)
	t.eq(editor_launch.record(record_text() .. string.rep(" ", editor_launch.MAX_RECORD_BYTES), LAUNCH_ID), nil)
end

tests.a_record_is_found_by_the_document_it_serves_whatever_launch_made_it = function(t)
	stub.install({})
	local expected = { endpoint = "http://127.0.0.1:43123", token = string.rep("t", 43), session_id = "session-a" }
	t.eq(editor_launch.record_of(record_text(), "C:\\design.pen"), expected)
	t.eq(editor_launch.record_of(record_text({ launch_id = "ffffffffffffffffffffffffffffffff" }), "C:\\design.pen"), expected, "another launch's owner is the one to follow")
	t.eq(editor_launch.record_of(record_text({ launch_id = tern.json.null }), "C:\\design.pen"), expected, "an owner that was started without a nonce too")
	t.eq(editor_launch.record_of(record_text(), "c:/DESIGN.pen"), expected, "Windows paths compare without regard to case or the slash")
	t.eq(editor_launch.record_of(record_text({ original_path = "C:\\work\\design.pen\\" }), "C:/work/design.pen"), expected)
	for _, path in { "C:\\other.pen", "C:\\design.pen.bak", "C:\\sub\\design.pen", "" } do
		t.eq(editor_launch.record_of(record_text(), path), nil, path)
	end
	for _, overrides in { { original_path = 7 }, { original_path = tern.json.null }, { endpoint = "http://10.0.0.1:43123" }, { token = "short" }, { version = 2 } } do
		t.eq(editor_launch.record_of(record_text(overrides), "C:\\design.pen"), nil)
	end
	t.eq(editor_launch.record_of("not json", "C:\\design.pen"), nil)
end

tests.the_record_of_a_document_is_read_one_file_at_a_time = function(t)
	stub.install({
		files = {
			["C:\\data\\editor\\sessions\\aaa.json"] = record_text({ original_path = "C:\\other.pen", session_id = "other" }),
			["C:\\data\\editor\\sessions\\bbb.json"] = "{ torn",
			["C:\\data\\editor\\sessions\\ccc.json"] = record_text({ session_id = "mine" }),
		},
	})
	local found: { string } = {}
	for _, name in { "aaa.json", "bbb.json", "ccc.json", "missing.json" } do
		local record = editor_launch.read_record_of("C:\\data\\editor", name, "C:\\design.pen")
		if record then
			table.insert(found, record.session_id)
		end
	end
	t.eq(found, { "mine" })
end

tests.a_launch_is_as_old_as_the_time_its_manifest_name_carries = function(t)
	stub.install({})
	local id = LAUNCH_ID
	local max = 120000
	local name = "C:\\data\\editor\\" .. editor_launch.manifest_name(1760000000, id)
	t.eq(editor_launch.launch_age_ms(name, 1760000005, max), 5000)
	t.eq(editor_launch.launch_age_ms(name, 1760000000, max), 0)
	t.eq(editor_launch.launch_age_ms(name, 1759999990, max), 0, "a clock that went back is a launch just made")
	t.eq(editor_launch.launch_age_ms("C:\\data\\editor\\launch.json", 1760000005, max), max + 1, "no time in the name: nothing waits for it")
	t.eq(editor_launch.launch_age_ms("/data/editor/launch-1760000000-" .. id .. ".json", 1760000060, max), 60000)
end

tests.the_launch_record_is_found_one_file_at_a_time_among_stale_and_unreadable_ones = function(t)
	stub.install({
		files = {
			["C:\\data\\editor\\sessions\\aaa.json"] = record_text({ launch_id = "ffffffffffffffffffffffffffffffff", session_id = "stale" }),
			["C:\\data\\editor\\sessions\\bbb.json"] = "{ torn",
			["C:\\data\\editor\\sessions\\ccc.json.pending"] = record_text({ session_id = "pending" }),
			["C:\\data\\editor\\sessions\\ddd.json"] = record_text({ session_id = "mine" }),
		},
	})
	local names = editor_launch.record_names("C:\\data\\editor")
	table.sort(names)
	t.eq(names, { "aaa.json", "bbb.json", "ddd.json" }, "only the record files, never the pending ones")
	local found: { string } = {}
	for _, name in names do
		local record = editor_launch.read_record("C:\\data\\editor", name, LAUNCH_ID)
		if record then
			table.insert(found, record.session_id)
		end
	end
	t.eq(found, { "mine" })
	t.eq(editor_launch.read_record("C:\\data\\editor", "ddd.json", "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"), nil)
	t.eq(editor_launch.read_record("C:\\data\\editor", "missing.json", LAUNCH_ID), nil)
	t.eq(editor_launch.record_names("C:\\data\\missing"), {}, "no registry yet is not an error")
end

tests.only_a_plain_error_code_left_beside_the_manifest_is_a_reason = function(t)
	local manifest = "C:\\data\\editor\\" .. editor_launch.manifest_name(1760000000, LAUNCH_ID)
	local function reason(text: string?): string?
		stub.install({ files = if text then { [manifest:gsub("%.json$", ".failed")] = text } else {} })
		return editor_launch.read_failure(manifest)
	end
	t.eq(reason('{"code":"ALREADY_OPEN"}'), "ALREADY_OPEN")
	t.eq(reason(nil), nil, "none left")
	for _, text in { "not json", "[]", '{"code":7}', '{"code":"lower"}', '{"code":"A B"}', '{"code":"' .. string.rep("A", 41) .. '"}' } do
		t.eq(reason(text), nil, text)
	end
end

tests.poll_request_keeps_the_token_in_authorization_and_refuses_nonloopback = function(t)
	stub.install({})
	local request = editor_launch.poll_request("http://127.0.0.1:43123", "secret-token", { method = "poll_view" })
	t.eq(request.url, "http://127.0.0.1:43123")
	t.eq(request.options.headers, {
		Authorization = "Bearer secret-token",
		["Content-Type"] = "application/json",
	})
	t.eq(request.options.body, '{"method":"poll_view"}')
	t.eq(request.options.timeout_ms, 120000)
	t.eq(editor_launch.poll_request("http://127.0.0.1:43123", "secret-token", {}, 5000).options.timeout_ms, 5000)
	t.raises(function()
		editor_launch.poll_request("http://localhost:43123/view", "secret-token", {})
	end, "ENDPOINT")
	t.raises(function()
		editor_launch.poll_request("http://127.0.0.2:43123/view", "secret-token", {})
	end, "ENDPOINT")
end

tests.call_puts_the_session_in_the_body_and_the_token_only_in_the_header = function(t)
	local tern = stub.install({})
	local record = editor_launch.record(record_text(), LAUNCH_ID) :: editor_launch.Record
	local request = editor_launch.call(record, "list_frames", { request_id = "r1", view_id = "v", view_generation = 3 })
	t.eq(request.url, "http://127.0.0.1:43123")
	t.eq(request.url:find(record.token, 1, true), nil, "the token is never in the URL")
	t.eq(request.options.body:find(record.token, 1, true), nil, "the token is never in the body")
	t.eq(request.options.headers.Authorization, "Bearer " .. record.token)
	t.eq(tern.json.decode(request.options.body :: string), {
		method = "list_frames",
		session_id = "session-a",
		args = { request_id = "r1", view_id = "v", view_generation = 3 },
	})
end

tests.replies_to_attach_and_select_must_match_their_request_and_generation = function(t)
	stub.install({})
	local attach = { request_id = "r1", view_generation = 4, status_seq = 9, frame_id = "frame-a" }
	t.eq(editor_launch.attached(attach, "r1", 4), true)
	t.eq(editor_launch.attached(attach, "r2", 4), false)
	t.eq(editor_launch.attached(attach, "r1", 3), false)
	t.eq(editor_launch.attached({ request_id = "r1", view_generation = 4 }, "r1", 4), false)
	t.eq(editor_launch.attached("nope", "r1", 4), false)
	local select = { request_id = "r5", view_generation = 4, path = "frame-a/title" }
	t.eq(editor_launch.selected(select, "r5", 4, "frame-a/title"), true)
	t.eq(editor_launch.selected(select, "r5", 4, "frame-a/other"), false)
	t.eq(editor_launch.selected(select, "r5", 5, "frame-a/title"), false)
	t.eq(editor_launch.selected(select, "r6", 4, "frame-a/title"), false)
	local capture = { request_id = "r7", view_generation = 4, capture_id = "c1", outcome = "applied" }
	t.eq(editor_launch.captured(capture, "r7", 4, "c1"), true)
	t.eq(editor_launch.captured(capture, "r7", 4, "c2"), false, "another capture request")
	t.eq(editor_launch.captured(capture, "r7", 5, "c1"), false, "another view generation")
	t.eq(editor_launch.captured(capture, "r8", 4, "c1"), false)
	t.eq(editor_launch.captured({ request_id = "r7", view_generation = 4, capture_id = "c1" }, "r7", 4, "c1"), false)
end

return tests
