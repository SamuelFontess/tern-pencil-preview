--!strict
-- The window half of the editor, driven through a fake Tern (timers on a virtual clock, panes, board, a fake owner that
-- answers fetches one by one). Nothing here looks at source text: each test opens a session, makes the user or the owner
-- do something, and checks what the window then did with the panes, the owner's requests and the toasts.
local stub = require("./stub")

local editor_board: any = stub.attach(require("../editor_board"))
for _, name in { "sha1", "util", "doc", "script", "canon", "cache", "launch", "mirror", "editor_launch", "editor_projection", "editor_draft", "editor_gesture", "editor_label", "editor_level", "editor_close", "editor_hooks", "editor_palette", "editor_chain", "editor_load" } do
	stub.attach((require :: any)("../lib/" .. name))
end
for _, name in { "core", "lifecycle", "closing", "build", "capture", "text", "nav", "loop", "start", "adopt", "palette" } do
	stub.attach((require :: any)("../editor_" .. name))
end
local Core: any = require("../editor_core")
local projection = require("../lib/editor_projection")

type T = {
	eq: (actual: any, expected: any, msg: string?) -> (),
	match: (s: string, pattern: string, msg: string?) -> (),
	truthy: (v: any, msg: string?) -> (),
	raises: (fn: () -> (), pattern: string?, msg: string?) -> (),
}

local tests: { [string]: (t: T) -> () } = {}

local SCRATCH = 0

local function world(): any
	SCRATCH += 1
	local path = "/work/design" .. SCRATCH .. ".pen"
	local tern = stub.install({
		os = "linux",
		data = "/data",
		files = { ["/plugin/runtime/editor.mjs"] = true, [path] = true },
	})
	tern.plugin.dir = "/plugin"
	-- Every test is a fresh window VM: nothing of the module's state survives from an earlier one.
	editor_board.drop_state()
	local w: any = {
		path = path, now = 0, timers = {}, seq = 0, panes = { [2] = { cwd = "/work" } },
		toasts = {}, picks = {}, requests = {}, boards_requested = {}, kv = {}, launches = 0, owner_runs = {}, pane_calls = 0,
		shapes = {}, deleted = {}, timers_off = false, session_id = 1, read_failures = 0, selection = {}, status_seq = 1, owner_selected = nil,
		undo = 0, redo = 0, created = {}, tick_no = 0, ledger = nil, held_versions = {},
	}
	w.tern = tern

	-- Virtual time: a timer runs when `run_for` reaches it, in due order.
	tern.now = function(): number
		return w.now
	end
	tern.timer = function(ms: number, fn: (any) -> ())
		w.seq += 1
		table.insert(w.timers, { due = w.now + ms, seq = w.seq, fn = fn })
	end
	-- `Awaitable:next` runs on the await hook, which keeps going when the timer hook is disabled.
	tern.sleep = function(ms: number): any
		return {
			next = function(_self: any, fn: any)
				w.seq += 1
				table.insert(w.timers, { due = w.now + ms, seq = w.seq, sleep = true, fn = function(c: any)
					fn(nil, nil, if w.sleep_without_cx then nil else c)
				end })
			end,
		}
	end
	tern.log = { error = function() end, warn = function() end, info = function() end }
	tern.kv = {
		get = function(key: string): any
			return w.kv[key]
		end,
		set = function(key: string, value: any)
			w.kv[key] = value
		end,
	}

	local function awaitable(): any
		local a: any = { settled = false }
		function a:next(fn: any)
			self.fn = fn
			if self.settled then
				fn(self.value, nil, w.cx)
			end
		end
		function a.resolve(self: any, value: any)
			self.settled, self.value = true, value
			if self.fn then
				self.fn(value, nil, w.cx)
			end
		end
		return a
	end

	local cx: any = {}
	w.cx = cx
	cx.toast = function(_self: any, level: string, title: string, sub: string?)
		table.insert(w.toasts, { level = level, title = title, sub = sub })
	end
	w.copied = {}
	cx.copy = function(_self: any, text: string)
		table.insert(w.copied, text)
	end
	cx.pick = function(_self: any, opts: any): any
		local a = awaitable()
		table.insert(w.picks, { items = opts.items, placeholder = opts.placeholder, awaiting = a })
		return a
	end
	cx.prompt = function(): any
		return awaitable()
	end
	cx.session = {
		focused = function(): number
			return 2
		end,
		pane = function(_self: any, id: number): any
			return w.panes[id]
		end,
		-- The board's view tree: the label editor is a text field in it while a double click has it open (`w.editor_open`).
		view = function(_self: any, _id: number): any
			return { role = "Group", children = { { role = "Application" }, if w.editor_open then { role = "MultilineTextInput", value = "" } else { role = "Button" } } }
		end,
	}
	cx.sessions = {
		current = function(): any
			return { id = w.session_id }
		end,
	}
	cx.hosts = {
		current = function(): any
			return { id = 1 }
		end,
	}
	-- The editor has no pane: any of these is a regression, counted and checked by the tests that open and close one.
	cx.layout = {
		new_tab = function(): number?
			w.pane_calls += 1
			return nil
		end,
		park = function(): (boolean, string?)
			w.pane_calls += 1
			return false, nil
		end,
		close = function()
			w.pane_calls += 1
		end,
		focus = function() end,
	}
	cx.whiteboard = {
		open = function(_self: any, opts: any): any
			local a = awaitable()
			table.insert(w.boards_requested, { opts = opts, awaiting = a })
			return a
		end,
		read = function(_self: any, _pane: any, query: any): any
			if w.read_failures > 0 and query and query.area then
				w.read_failures -= 1
				error("the board could not be read right now")
			end
			if w.unreadable and query and query.ids then
				for _, id in query.ids do
					if w.unreadable[id] then
						error("the board is busy and could not read that shape")
					end
				end
			end
			local shapes: { any } = {}
			local ids: { [string]: boolean }? = nil
			if query and query.ids then
				ids = {}
				for _, id in query.ids do
					(ids :: any)[id] = true
				end
			end
			for _, shape in w.shapes do
				if ids == nil or ids[shape.id] then
					table.insert(shapes, shape)
				end
			end
			return { shapes = shapes, more = 0, selection = w.selection, total = #shapes, undo = w.undo, redo = w.redo }
		end,
		edit = function(_self: any, _pane: any, edits: any): any
			if w.edit_fails then
				error("the board refused the edit")
			end
			local refs: { [string]: string } = {}
			local function each(edit: any, fn: (shape: any) -> ())
				for _, id in if edit.ids then edit.ids else { edit.id } do
					for _, shape in w.shapes do
						if shape.id == id then
							fn(shape)
						end
					end
				end
			end
			-- Every call is one undo step, and a new step leaves nothing to redo.
			w.undo, w.redo = w.undo + 1, 0
			for _, edit in edits do
				if edit.op == "add" then
					-- Ids are never reused, as on the real board (the first of a ref is plain, later ones are numbered).
					w.created[edit.ref] = (w.created[edit.ref] or 0) + 1
					local id = "shape-" .. edit.ref .. (if w.created[edit.ref] > 1 and edit.ref ~= "activity-text" then "#" .. w.created[edit.ref] else "")
					refs[edit.ref] = id
					table.insert(w.shapes, { id = id, type = edit.type, color = edit.color, fill = edit.fill, opacity = edit.opacity, width = edit.width, text = edit.text, x = edit.x, y = edit.y, w = edit.w, h = edit.h })
				elseif edit.op == "move" or edit.op == "resize" then
					each(edit, function(shape: any)
						shape.x, shape.y = edit.x or shape.x, edit.y or shape.y
						shape.w, shape.h = edit.w or shape.w, edit.h or shape.h
					end)
				elseif edit.op == "text" then
					each(edit, function(shape: any)
						shape.text = edit.text
					end)
				elseif edit.op == "style" then
					each(edit, function(shape: any)
						shape.opacity, shape.fill, shape.font_size = edit.opacity or shape.opacity, edit.fill or shape.fill, edit.font_size or shape.font_size
						shape.width = edit.width or shape.width
					end)
				elseif edit.op == "order" and (edit.to == "front" or edit.to == "back") then
					-- The list is back to front: a shape brought to the front is the last of it.
					for index, shape in w.shapes do
						if shape.id == (edit.id or edit.ids[1]) then
							table.remove(w.shapes, index)
							table.insert(w.shapes, if edit.to == "front" then #w.shapes + 1 else 1, shape)
							break
						end
					end
				elseif edit.op == "lock" or edit.op == "unlock" then
					each(edit, function(shape: any)
						shape.locked = if edit.op == "lock" then true else nil
					end)
				elseif edit.op == "delete" then
					for _, id in edit.ids or {} do
						for index, shape in w.shapes do
							if shape.id == id then
								table.insert(w.deleted, id)
								table.remove(w.shapes, index)
								break
							end
						end
					end
				end
			end
			return { refs = refs }
		end,
	}

	-- The node check answers at once; the owner is a process that runs until the test ends it (`w.owner_exits`), as it does
	-- in Tern, where its callback is the only thing that says it is gone.
	tern.process = {
		run = function(argv: { string }, opts: any, cb: any)
			if argv[3] == "--launch" then
				if w.owner_run_error then
					error("tern.process.run " .. argv[1] .. ": " .. w.owner_run_error)
				end
				w.launches += 1
				table.insert(w.owner_runs, { argv = argv, opts = opts, cb = cb })
				return
			end
			if w.hold_versions and w.hold_versions > 0 and argv[2] == "--version" then
				w.hold_versions -= 1
				table.insert(w.held_versions, cb)
				return
			end
			w.arrive(function(fresh: any)
				cb({ status = 0, stdout = if argv[2] == "--version" then "v22.1.0\n" else "", stderr = "", timed_out = false }, fresh)
			end)
		end,
	}
	tern.fetch = function(url: string, options: any, cb: any)
		local body = tern.json.decode(options.body)
		table.insert(w.requests, { url = url, method = body.method, args = body.args, raw = options.body, cb = cb, answered = false })
	end

	-- A process's answer reaches the window on the await hook, so it still comes when the timer hook is dead.
	function w.arrive(fn: (fresh: any) -> ())
		if w.timers_off then
			tern.sleep(0):next(function(_r: any, _e: any, fresh: any)
				fn(fresh)
			end)
		else
			tern.timer(0, fn)
		end
	end

	function w.run_for(ms: number)
		local target = w.now + ms
		for _ = 1, 20000 do
			local best: any = nil
			local at = 0
			for index, timer in w.timers do
				if timer.due <= target and (best == nil or timer.due < best.due or (timer.due == best.due and timer.seq < best.seq)) then
					best, at = timer, index
				end
			end
			if best == nil then
				break
			end
			table.remove(w.timers, at)
			w.now = math.max(w.now, best.due)
			-- A timer hook the host disabled runs nothing; the await hook (sleeps) is a separate budget.
			if best.sleep or not w.timers_off then
				w.tick_no += 1
				w.hook = if best.sleep then "await" else "timer"
				local ran, err = pcall(best.fn, cx)
				-- A tick killed for going over its budget (`killing` in a loader) leaves its callback half run and the timer
				-- hook disabled; any other error is the test's.
				if not ran then
					if best.sleep or not tostring(err):find("timer exceeded 50 ms", 1, true) then
						error(err, 0)
					end
					w.timers_off = true
				end
				w.hook = nil
				-- The timer hook dies right after the tick `cut_at.name` has run (or, with `before`, its mark): the budget trip
				-- Tern makes of a tick that is too slow. Whatever the tick scheduled is lost with it.
				local cut = w.cut_at
				if cut and not best.sleep then
					local done = Core.stats.by[cut.name] ~= nil
					if Core.stats.entering == cut.name and done ~= cut.before then
						w.cut_at, w.timers_off = nil, true
					end
				end
				-- The timer hook dies after this many more timers have run (a budget trip at an awkward moment).
				if w.kill_after and not best.sleep then
					w.kill_after -= 1
					if w.kill_after <= 0 then
						w.kill_after, w.timers_off = nil, true
					end
				end
			end
		end
		w.now = target
	end

	-- The newest unanswered request for `method`, or nil.
	function w.pending(method: string): any
		for index = #w.requests, 1, -1 do
			local request = w.requests[index]
			if request.method == method and not request.answered then
				return request
			end
		end
		return nil
	end

	function w.count(method: string): number
		local n = 0
		for _, request in w.requests do
			if request.method == method then
				n += 1
			end
		end
		return n
	end

	local function deliver(method: string, result: any)
		local request = w.pending(method)
		if request == nil then
			error("the owner was not asked " .. method, 3)
		end
		request.answered = true
		w.tick_no += 1
		request.cb(result, cx)
	end

	-- `value` is the owner's result (or a function of the request's arguments), as the owner would answer it.
	function w.answer(method: string, value: any)
		local request = w.pending(method)
		if request == nil then
			error("the owner was not asked " .. method, 2)
		end
		local result = if typeof(value) == "function" then value(request.args) else value
		deliver(method, { status = 200, headers = {}, body = tern.json.encode({ result = result }), timed_out = false })
		w.run_for(50)
	end
	function w.refuse(method: string, status: number, code: string)
		deliver(method, { status = status, headers = {}, body = tern.json.encode({ error = { code = code, message = code } }), timed_out = false })
		w.run_for(50)
	end
	function w.lose(method: string)
		deliver(method, { status = 0, headers = {}, body = "", error = "connection refused", timed_out = false })
		w.run_for(50)
	end

	-- The owner's process ends (a crash, a start that failed, an exit nobody asked for) and Tern calls back, if the VM that
	-- started it is still there.
	function w.owner_exits(status: number)
		local run = w.owner_runs[#w.owner_runs]
		w.tick_no += 1
		run.cb({ status = status, stdout = "", stderr = "", timed_out = false }, cx)
		w.run_for(3000)
	end

	function w.last_pick(): any
		return w.picks[#w.picks]
	end
	-- Chooses the row of the newest picker that `matches`, as the user would; nil dismisses it.
	function w.choose(matches: ((item: any) -> boolean)?)
		local picker = w.last_pick()
		local chosen: any = nil
		if matches then
			for _, item in picker.items do
				if matches(item) then
					chosen = item
				end
			end
			if chosen == nil then
				error("no such row in the picker", 2)
			end
		end
		w.tick_no += 1
		picker.awaiting:resolve(chosen)
		w.run_for(50)
	end

	function w.toast_titled(pattern: string): any
		for _, toast in w.toasts do
			if toast.title:find(pattern) then
				return toast
			end
		end
		return nil
	end

	-- From here on every slow native call of the window is noted with the number of the timer callback it ran in (the
	-- ones the test itself makes while `w.harness` is set are not the window's). A call outside any callback (the route's
	-- open) counts as callback 0 of its run.
	function w.watch_natives(): { { tick: number, call: string } }
		local calls: { { tick: number, call: string } } = {}
		local function wrap(owner: any, key: string, label: string)
			local inner = owner[key]
			owner[key] = function(...: any): ...any
				if not w.harness then
					table.insert(calls, { tick = w.tick_no, call = label })
				end
				return inner(...)
			end
		end
		for _, name in { "write", "mkdir", "remove", "list", "read" } do
			wrap(tern.fs, name, "fs." .. name)
		end
		wrap(tern.kv, "set", "kv.set")
		wrap(tern.process, "run", "process.run")
		wrap(cx, "toast", "toast")
		wrap(cx, "pick", "pick")
		for _, name in { "new_tab", "park", "close" } do
			wrap(cx.layout, name, "layout." .. name)
		end
		for _, name in { "open", "read", "edit" } do
			wrap(cx.whiteboard, name, "whiteboard." .. name)
		end
		return calls
	end

	-- Opens the editor for `w.path` and runs it up to the owner's attach request, with the board on screen.
	function w.start()
		w.tick_no += 1
		editor_board.open(cx, w.path)
		w.run_for(100)
		local dir = "/data/editor"
		w.harness = true
		local launch_id: string? = nil
		for _, name in tern.fs.list(dir) do
			if name:match("^launch%-") then
				launch_id = tern.json.decode(tern.fs.read(dir .. "/" .. name)).launch_id
			end
		end
		tern.fs.mkdir(dir .. "/sessions")
		tern.fs.write(dir .. "/sessions/record.json", tern.json.encode({
			version = 1, launch_id = launch_id, original_path = w.path, endpoint = "http://127.0.0.1:43123", token = string.rep("t", 43), session_id = "S",
		}))
		w.harness = false
		w.launch_id = launch_id
		w.board_pane = 30
		w.panes[w.board_pane] = { cwd = "/work", kind = "canvas" }
		w.tick_no += 1
		w.boards_requested[1].awaiting:resolve(w.board_pane)
		w.run_for(1500)
	end
	-- The user closes the board; the window notices on its next step.
	function w.close_board()
		w.panes[w.board_pane] = nil
		w.run_for(1000)
	end
	function w.board_opens(): number
		return #w.boards_requested
	end
	-- A plugin reload: the window VM, its timers and its pending callbacks are gone; panes, the owner, the board's
	-- shapes, files and `tern.kv` stay. Boards opened and toasts are counted from here on.
	function w.reload()
		editor_board.drop_state()
		w.timers = {}
		for _, request in w.requests do
			request.answered = true
		end
		w.toasts, w.boards_requested, w.timers_off = {}, {}, false
	end
	return w
end

local function document(fields: { [string]: any }): { [string]: any }
	local doc: { [string]: any } = { session_id = "S", revision = 3, phase = "ready", dirty = false, activity = { state = "ready" } }
	for key, value in fields do
		doc[key] = value
	end
	return doc
end

local function by(key: string, value: string): (any) -> boolean
	return function(item: any): boolean
		return item[key] == value
	end
end

local RECOVERY_CHOICES = {
	{ choice = "recover", label = "Recover my edits", detail = "Continue from the last confirmed edits" },
	{ choice = "discard", label = "Use the file on disk", detail = "Starts from the original" },
}

tests.opening_runs_the_owner_as_a_process_without_a_pane_and_puts_the_board_beside_the_current_pane = function(t)
	local w = world()
	w.start()
	t.eq(w.launches, 1)
	local run = w.owner_runs[1]
	t.eq(run.argv[2], "/plugin/runtime/editor.mjs")
	t.eq(run.argv[3], "--launch")
	t.match(run.argv[4], "^/data/editor/launch%-%d+%-%x+%.json$")
	t.eq(#run.argv, 4)
	t.eq(run.opts, { cwd = "/work" }, "in the document's folder, and with no timeout: it runs until it is asked to end")
	t.eq(w.pane_calls, 0, "no tab, no park, no pane of any kind")
	t.eq(w.boards_requested[1].opts.how, "beside")
end

tests.a_clean_board_closed_ends_the_editor_without_asking = function(t)
	local w = world()
	w.start()
	w.close_board()
	w.answer("get_document", document({ dirty = false }))
	t.eq(w.count("close_editor"), 1)
	t.eq(#w.picks, 0)
end

tests.an_unsaved_board_closed_asks_and_back_puts_the_board_back_in_the_same_session = function(t)
	local w = world()
	w.start()
	w.close_board()
	w.answer("get_document", document({ dirty = true }))
	t.eq(#w.picks, 1)
	w.choose(by("answer", "reopen"))
	t.eq(w.count("close_editor"), 0)
	t.eq(w.board_opens(), 2)
	t.eq(w.launches, 1, "no second editor was started")
end

tests.a_dismissed_picker_over_unsaved_work_is_back_too = function(t)
	local w = world()
	w.start()
	w.close_board()
	w.answer("get_document", document({ dirty = true }))
	w.choose(nil)
	t.eq(w.count("close_editor"), 0)
	t.eq(w.board_opens(), 2)
end

tests.discard_asks_the_owner_for_the_current_revision_then_ends_the_editor = function(t)
	local w = world()
	w.start()
	w.close_board()
	w.answer("get_document", document({ dirty = true, revision = 7 }))
	w.choose(by("answer", "discard"))
	t.eq(w.pending("discard_unsaved").args, { session_id = "S", base_revision = 7 })
	t.eq(w.count("close_editor"), 0, "nothing is closed before the owner has dropped the changes")
	w.answer("discard_unsaved", { discarded = true, revision = 8 })
	t.eq(w.count("close_editor"), 1)
end

tests.save_ends_the_editor_only_after_the_owner_saved = function(t)
	local w = world()
	w.start()
	w.close_board()
	w.answer("get_document", document({ dirty = true, revision = 4 }))
	w.choose(by("answer", "save"))
	t.eq(w.pending("save_document").args, { session_id = "S", base_revision = 4 })
	t.eq(w.count("close_editor"), 0)
	w.answer("save_document", { saved = true })
	t.eq(w.count("close_editor"), 1)
end

tests.a_refused_save_brings_the_board_back_and_keeps_the_editor = function(t)
	local w = world()
	w.start()
	w.close_board()
	w.answer("get_document", document({ dirty = true }))
	w.choose(by("answer", "save"))
	w.refuse("save_document", 409, "REVISION_STALE")
	t.eq(w.count("close_editor"), 0)
	t.eq(w.board_opens(), 2)
	t.truthy(w.toast_titled("not saved"))
end

tests.a_refused_discard_brings_the_board_back_and_keeps_the_editor = function(t)
	local w = world()
	w.start()
	w.close_board()
	w.answer("get_document", document({ dirty = true }))
	w.choose(by("answer", "discard"))
	w.refuse("discard_unsaved", 409, "REVISION_STALE")
	t.eq(w.count("close_editor"), 0)
	t.eq(w.board_opens(), 2)
	t.truthy(w.toast_titled("not discarded"))
end

tests.an_owner_that_stops_answering_while_saving_ends_the_session = function(t)
	local w = world()
	w.start()
	w.close_board()
	w.answer("get_document", document({ dirty = true }))
	w.choose(by("answer", "save"))
	w.lose("save_document")
	t.eq(w.count("close_editor"), 0, "an owner that cannot be reached is not asked again")
	t.truthy(w.toast_titled("disconnected"))
	t.eq(w.kv.editor_sessions, nil)
	t.eq(w.board_opens(), 1)
end

tests.an_owner_that_is_unreachable_when_the_board_closes_ends_the_session = function(t)
	local w = world()
	w.start()
	w.close_board()
	w.lose("get_document")
	t.eq(w.count("close_editor"), 0)
	t.truthy(w.toast_titled("disconnected"))
	t.eq(w.board_opens(), 1)
end

tests.an_owner_that_cannot_say_whether_it_has_unsaved_work_is_never_closed = function(t)
	local w = world()
	w.start()
	w.close_board()
	w.refuse("get_document", 500, "INTERNAL_ERROR")
	t.eq(w.count("close_editor"), 0)
	t.eq(w.board_opens(), 2)
end

tests.an_owner_lost_while_attaching_ends_the_session_with_one_notice = function(t)
	local w = world()
	w.start()
	w.lose("attach_view")
	w.run_for(60000)
	t.eq(w.count("close_editor"), 0)
	t.eq(w.kv.editor_sessions, nil)
	local told = 0
	for _, toast in w.toasts do
		told += if toast.title:find("disconnected") then 1 else 0
	end
	t.eq(told, 1, "told once")
end

tests.opening_the_same_file_while_the_editor_is_closing_says_so = function(t)
	local w = world()
	w.start()
	w.close_board()
	w.answer("get_document", document({ dirty = true }))
	editor_board.open(w.cx, w.path)
	w.run_for(50)
	t.truthy(w.toast_titled("closing"))
	t.eq(w.board_opens(), 1)
end

tests.closing_over_a_recovery_offers_the_choices_the_owner_gave_and_resolves_the_pick = function(t)
	local w = world()
	w.start()
	w.close_board()
	w.answer("get_document", document({ phase = "recovering", dirty = true, recovery_choices = RECOVERY_CHOICES }))
	local labels = {}
	for _, item in w.last_pick().items do
		table.insert(labels, item.choice)
	end
	t.eq(labels, { "recover", "discard" }, "exactly what the document accepts")
	w.choose(by("choice", "recover"))
	t.eq(w.pending("resolve_recovery").args, { choice = "recover" })
	w.answer("resolve_recovery", document({}))
	t.eq(w.count("close_editor"), 0)
	t.eq(w.board_opens(), 2, "the board comes back showing what was recovered")
end

tests.closing_over_a_recovery_without_choosing_ends_the_editor_and_keeps_the_edits_on_disk = function(t)
	local w = world()
	w.start()
	w.close_board()
	w.answer("get_document", document({ phase = "recovering", dirty = true, recovery_choices = RECOVERY_CHOICES }))
	w.choose(nil)
	t.eq(w.count("close_editor"), 1)
	t.eq(w.board_opens(), 1, "never an endless reopen")
	t.eq(w.count("resolve_recovery"), 0)
end

tests.a_recovery_the_owner_refuses_ends_the_editor_with_the_reason = function(t)
	local w = world()
	w.start()
	w.close_board()
	w.answer("get_document", document({ phase = "recovering", dirty = true, recovery_choices = RECOVERY_CHOICES }))
	w.choose(by("choice", "discard"))
	w.refuse("resolve_recovery", 409, "SOURCE_CHANGED")
	t.eq(w.count("close_editor"), 1)
	t.eq(w.toasts[#w.toasts].level, "error")
	t.eq(w.toasts[#w.toasts].sub, "SOURCE_CHANGED")
end

tests.closing_a_blocked_document_ends_the_editor_instead_of_looping = function(t)
	local w = world()
	w.start()
	w.close_board()
	w.answer("get_document", document({ phase = "blocked", dirty = true, recovery_choices = {} }))
	t.eq(#w.picks, 0)
	t.eq(w.count("close_editor"), 1)
	t.eq(w.toasts[#w.toasts].level, "error")
end

local function attach_reply(activity: any): (any) -> any
	return function(args: any): any
		return {
			request_id = args.request_id, view_generation = args.view_generation, status_seq = 1, reset = 0,
			focus = {}, activity = activity,
		}
	end
end

tests.opening_a_document_that_needs_recovery_offers_the_choices_on_the_board_once = function(t)
	local w = world()
	w.start()
	w.answer("attach_view", attach_reply({ state = "loading", phase = "recovering", revision = 0 }))
	w.answer("get_document", document({ phase = "recovering", dirty = true, recovery_choices = RECOVERY_CHOICES }))
	t.eq(#w.picks, 1)
	w.choose(by("choice", "discard"))
	t.eq(w.pending("resolve_recovery").args, { choice = "discard" })
	w.answer("resolve_recovery", document({}))
	t.eq(w.count("close_editor"), 0)
	t.eq(w.toasts[#w.toasts].level, "info", "the user is told what the choice did")
end

tests.a_recovery_picker_dismissed_on_opening_is_not_asked_again_until_the_board_closes = function(t)
	local w = world()
	w.start()
	w.answer("attach_view", attach_reply({ state = "loading", phase = "recovering", revision = 0 }))
	w.answer("get_document", document({ phase = "recovering", dirty = true, recovery_choices = RECOVERY_CHOICES }))
	w.choose(nil)
	w.run_for(5000)
	t.eq(#w.picks, 1)
	t.eq(w.count("get_document"), 1)
	t.eq(w.count("close_editor"), 0)
	w.close_board()
	w.answer("get_document", document({ phase = "recovering", dirty = true, recovery_choices = RECOVERY_CHOICES }))
	t.eq(#w.picks, 2, "the choice comes back when the board closes")
end

local function conflict_pick(w: any)
	w.start()
	w.close_board()
	w.answer("get_document", document({ dirty = true, revision = 5 }))
	w.choose(by("answer", "save"))
	w.refuse("save_document", 409, "SOURCE_CHANGED")
end

tests.a_save_refused_because_the_file_changed_offers_a_recovery_copy_and_ends_the_editor_after_it = function(t)
	local w = world()
	conflict_pick(w)
	t.eq(#w.picks, 2, "the user is asked again, not just told")
	t.eq(w.count("close_editor"), 0)
	t.eq(w.board_opens(), 1)
	w.choose(by("answer", "copy"))
	t.eq(w.pending("save_recovery_copy").args, { session_id = "S", base_revision = 5 })
	t.eq(w.count("close_editor"), 0, "nothing is closed before the copy exists")
	w.answer("save_recovery_copy", { path = "/work/design.tern-recovery-x.pen" })
	t.eq(w.count("close_editor"), 1)
	t.eq(w.toasts[#w.toasts].sub, "/work/design.tern-recovery-x.pen")
end

tests.a_recovery_copy_that_fails_brings_the_board_back_and_closes_nothing = function(t)
	local w = world()
	conflict_pick(w)
	w.choose(by("answer", "copy"))
	w.refuse("save_recovery_copy", 409, "DOCUMENT_BUSY")
	t.eq(w.count("close_editor"), 0)
	t.eq(w.board_opens(), 2)
	t.eq(w.toasts[#w.toasts].level, "error")
end

tests.after_a_file_conflict_discard_and_back_still_work = function(t)
	local w = world()
	conflict_pick(w)
	t.eq(#w.picks, 2)
	w.choose(by("answer", "discard"))
	t.eq(w.pending("discard_unsaved").args, { session_id = "S", base_revision = 5 })
	w.answer("discard_unsaved", { discarded = true })
	t.eq(w.count("close_editor"), 1)
	local back = world()
	conflict_pick(back)
	back.choose(nil)
	t.eq(back.count("close_editor"), 0)
	t.eq(back.board_opens(), 2)
end

tests.a_save_refused_for_another_reason_does_not_offer_a_copy = function(t)
	local w = world()
	w.start()
	w.close_board()
	w.answer("get_document", document({ dirty = true }))
	w.choose(by("answer", "save"))
	w.refuse("save_document", 409, "REVISION_STALE")
	t.eq(#w.picks, 1)
end

tests.closing_the_board_while_the_recovery_picker_is_open_does_not_stack_a_second_picker = function(t)
	local w = world()
	w.start()
	w.answer("attach_view", attach_reply({ state = "loading", phase = "recovering", revision = 0 }))
	w.answer("get_document", document({ phase = "recovering", dirty = true, recovery_choices = RECOVERY_CHOICES }))
	w.close_board()
	t.eq(#w.picks, 1, "the open picker is the one the user answers")
	t.eq(w.count("get_document"), 1)
	w.choose(by("choice", "recover"))
	t.eq(w.pending("resolve_recovery").args, { choice = "recover" })
	w.answer("resolve_recovery", document({}))
	t.eq(w.count("close_editor"), 0)
	t.eq(w.board_opens(), 2, "the board comes back with what was recovered")
end

tests.dismissing_the_recovery_picker_after_the_board_was_closed_ends_the_editor = function(t)
	local w = world()
	w.start()
	w.answer("attach_view", attach_reply({ state = "loading", phase = "recovering", revision = 0 }))
	w.answer("get_document", document({ phase = "recovering", dirty = true, recovery_choices = RECOVERY_CHOICES }))
	w.close_board()
	w.choose(nil)
	t.eq(w.count("close_editor"), 1)
	t.eq(#w.picks, 1)
end

-- Closing the board while the recovery offered on opening is undecided (owner being asked, picker open, answer being
-- applied) never stacks a second picker: the offer settles it.
tests.closing_the_board_while_the_owner_is_asked_about_a_recovery_does_not_stack_a_second_picker = function(t)
	local w = world()
	w.start()
	w.answer("attach_view", attach_reply({ state = "loading", phase = "recovering", revision = 0 }))
	w.close_board()
	for _ = 1, 3 do
		if w.pending("get_document") then
			w.answer("get_document", document({ phase = "recovering", dirty = true, recovery_choices = RECOVERY_CHOICES }))
		end
	end
	t.eq(#w.picks, 1, "one question for one recovery")
	w.choose(by("choice", "recover"))
	w.answer("resolve_recovery", document({}))
	t.eq(w.count("close_editor"), 0)
	t.eq(w.board_opens(), 2, "the board comes back with what was recovered")
end

tests.closing_the_board_while_a_recovery_choice_is_being_applied_does_not_stack_a_second_picker = function(t)
	local w = world()
	w.start()
	w.answer("attach_view", attach_reply({ state = "loading", phase = "recovering", revision = 0 }))
	w.answer("get_document", document({ phase = "recovering", dirty = true, recovery_choices = RECOVERY_CHOICES }))
	w.choose(by("choice", "recover"))
	t.truthy(w.pending("resolve_recovery"))
	w.close_board()
	-- The owner has not finished resolving: a question asked now would still see the document recovering.
	for _ = 1, 3 do
		if w.pending("get_document") then
			w.answer("get_document", document({ phase = "recovering", dirty = true, recovery_choices = RECOVERY_CHOICES }))
		end
	end
	t.eq(#w.picks, 1, "no second picker over a choice that is still being applied")
	w.answer("resolve_recovery", document({}))
	t.eq(w.count("close_editor"), 0)
	t.eq(w.board_opens(), 2, "the board comes back with what was recovered")
	t.truthy(w.toast_titled("recovered"), "the user is told what the choice did")
end

-- What a session of this window leaves in `tern.kv` for the next VM.
tests.a_session_is_recorded_for_a_reload_without_secrets = function(t)
	local w = world()
	w.start()
	local entry = w.kv.editor_sessions[w.launch_id]
	t.truthy(entry, "recorded")
	t.eq(entry.terminal, nil, "there is no pane to remember")
	t.eq(entry.board, w.board_pane)
	t.eq(entry.path, w.path)
	t.eq(entry.scope, "1:1", "host and session of the window")
	local allowed = { launch_id = true, path = true, follow = true, board = true, data_dir = true, manifest = true, scope = true, shapes = true }
	for key in entry do
		t.truthy(allowed[key], key .. " is not something to keep")
	end
end

tests.the_record_follows_the_board_and_goes_with_the_session = function(t)
	local w = world()
	w.start()
	w.close_board()
	w.answer("get_document", document({ dirty = true }))
	w.choose(by("answer", "reopen"))
	w.panes[31] = { cwd = "/work", kind = "canvas" }
	w.boards_requested[2].awaiting:resolve(31)
	w.run_for(500)
	t.eq(w.kv.editor_sessions[w.launch_id].board, 31)
	w.board_pane = 31
	w.close_board()
	w.answer("get_document", document({ dirty = false }))
	w.run_for(500)
	t.eq(w.kv.editor_sessions, nil, "an ended session is not picked up again")
end

local function adopt(w: any)
	editor_board.adopt(w.cx)
	w.run_for(3000)
end

-- The user's own shapes on the board a session drew on: none of them is the session's, however it looks.
local function users_shapes(): { any }
	return {
		{ id = "u-image", type = "image", locked = true },
		{ id = "u-white", type = "rect", fill = "#ffffff", locked = true },
		{ id = "u-accent", type = "text", color = "#7c3aed", locked = true },
		{ id = "u-box", type = "rect", color = "#7c3aed", fill = "#7c3aed" },
		{ id = "u-ink", type = "ink" },
	}
end

local function shape_ids(w: any): { string }
	local ids: { string } = {}
	for _, shape in w.shapes do
		table.insert(ids, shape.id)
	end
	table.sort(ids)
	return ids
end

tests.a_reload_picks_up_the_session_and_removes_only_the_shapes_it_drew = function(t)
	local w = world()
	w.start()
	w.answer("attach_view", attach_reply({ state = "ready", phase = "ready", revision = 3 }))
	w.run_for(500)
	t.truthy(w.shapes[1] and w.shapes[1].id == "shape-activity-text", "the session drew its status line")
	local entry = w.kv.editor_sessions[w.launch_id]
	t.eq(entry.shapes, { "shape-activity-text" }, "and recorded it")
	table.insert(entry.shapes, "t-old")
	table.insert(w.shapes, { id = "t-old", type = "rect", color = "#7c3aed", fill = "#7c3aed" })
	for _, shape in users_shapes() do
		table.insert(w.shapes, shape)
	end
	w.reload()
	adopt(w)
	t.eq(w.launches, 1, "no second owner")
	t.eq(w.board_opens(), 0, "the board that is there stays")
	t.eq(w.count("close_editor"), 0)
	t.truthy(w.pending("attach_view"), "the session asks for the owner's lease")
	w.answer("attach_view", attach_reply({ state = "ready", phase = "ready", revision = 3 }))
	w.run_for(500)
	t.truthy(w.toast_titled("econnected"))
	t.eq(shape_ids(w), { "shape-activity-text", "u-accent", "u-box", "u-image", "u-ink", "u-white" }, "what the user put there stays whatever it looks like (the status line is the new window's own)")
	t.truthy(w.pending("list_frames"), "and the board is built again")
end

tests.a_board_that_holds_none_of_the_sessions_shapes_is_not_its_board = function(t)
	for _, recorded in { { "gone-1" }, {} } do
		local w = world()
		w.start()
		w.kv.editor_sessions[w.launch_id].shapes = recorded
		w.shapes = users_shapes()
		w.reload()
		adopt(w)
		t.eq(w.board_opens(), 0, "nothing is opened before the lease is won")
		w.answer("attach_view", attach_reply({ state = "ready", phase = "ready", revision = 3 }))
		w.run_for(500)
		t.eq(#w.shapes, 5, "a whiteboard that only looks like the session's is never touched")
		t.eq(w.board_opens(), 1, "the session gets a board of its own")
		t.eq(w.launches, 1)
		t.eq(w.count("close_editor"), 0)
	end
end

-- A board with something of the session's on it: the status line, drawn once the owner has said it is ready.
local function drawn(w: any)
	w.answer("attach_view", attach_reply({ state = "ready", phase = "ready", revision = 3 }))
	w.run_for(500)
end

tests.a_second_reload_before_the_old_shapes_are_swept_still_knows_them = function(t)
	local w = world()
	w.start()
	drawn(w)
	w.reload()
	-- The owner has not published its record again yet, so the session waits and sweeps nothing.
	w.tern.fs.remove("/data/editor/sessions/record.json")
	adopt(w)
	t.eq(w.kv.editor_sessions[w.launch_id].shapes, { "shape-activity-text" }, "what the first VM drew is still on the board")
end

tests.a_reload_with_the_board_gone_reopens_it_in_the_same_session = function(t)
	local w = world()
	w.start()
	w.reload()
	w.panes[w.board_pane] = nil
	adopt(w)
	t.eq(w.board_opens(), 0, "no board before the owner's lease is won")
	w.answer("attach_view", attach_reply({ state = "ready", phase = "ready", revision = 3 }))
	w.run_for(500)
	t.eq(w.launches, 1)
	t.eq(w.board_opens(), 1)
	t.eq(#w.picks, 0, "nothing to ask: the board is simply back")
end

local function requests_of(w: any, method: string): number
	local n = 0
	for _, request in w.requests do
		if request.method == method then
			n += 1
		end
	end
	return n
end

-- A launch old enough that its owner has either published its session or never will.
local function age_the_launch(w: any)
	local entry = w.kv.editor_sessions[w.launch_id]
	entry.manifest = "/data/editor/launch-1-" .. w.launch_id .. ".json"
end

tests.a_reload_with_no_session_record_from_an_old_launch_forgets_the_session = function(t)
	local w = world()
	w.start()
	age_the_launch(w)
	w.reload()
	w.tern.fs.remove("/data/editor/sessions/record.json")
	adopt(w)
	w.run_for(5000)
	t.eq(w.kv.editor_sessions, nil, "the owner ended while nobody was looking: nothing to pick up")
	t.eq(w.launches, 1)
	t.eq(w.board_opens(), 0)
	t.eq(w.count("attach_view"), 1, "nobody asked an owner that is not there (only the first attach)")
	t.eq(w.toasts, {}, "and nobody is bothered by a session that ended cleanly")
	t.eq(w.pane_calls, 0)
end

tests.an_owner_that_died_while_nobody_watched_is_forgotten_without_a_word_even_when_its_record_is_left = function(t)
	local w = world()
	w.start()
	drawn(w)
	w.reload()
	adopt(w)
	w.lose("attach_view")
	w.run_for(60000)
	t.eq(w.count("close_editor"), 0, "not asked to end: it may be another window's owner that was only slow")
	t.eq(w.kv.editor_sessions, nil)
	t.eq(w.toasts, {}, "nobody is told about a session that ended")
	t.eq(w.launches, 1)
end

tests.an_owner_that_goes_away_after_the_window_held_its_lease_is_still_told = function(t)
	local w = world()
	w.start()
	drawn(w)
	w.reload()
	adopt(w)
	w.answer("attach_view", attach_reply({ state = "ready", phase = "ready", revision = 3 }))
	w.run_for(500)
	editor_board.palette(w.cx, "save")
	w.run_for(50)
	w.answer("get_document", document({ dirty = true }))
	w.lose("save_document")
	t.truthy(w.toast_titled("disconnected"), "an owner the window was driving that vanishes is news")
end

-- The registry only says which launch and which board. The owner's own record gives the endpoint, found by the launch id.
tests.a_reload_finds_the_owner_by_its_session_record_and_asks_for_the_lease = function(t)
	local w = world()
	w.start()
	drawn(w)
	w.reload()
	adopt(w)
	local attach = w.pending("attach_view")
	t.truthy(attach, "the lease is asked of the endpoint the record names")
	t.eq(attach.args.holder ~= nil, true)
	t.eq(w.launches, 1)
	t.eq(w.pane_calls, 0)
end

tests.an_owner_that_has_not_published_yet_after_a_reload_is_waited_for_and_then_followed = function(t)
	local w = world()
	w.start()
	drawn(w)
	w.reload()
	local record = w.tern.fs.read("/data/editor/sessions/record.json")
	w.tern.fs.remove("/data/editor/sessions/record.json")
	adopt(w)
	w.run_for(10000)
	t.truthy(w.kv.editor_sessions[w.launch_id], "a launch that is still starting is not forgotten on a guess")
	t.eq(w.count("attach_view"), 1)
	w.harness = true
	w.tern.fs.write("/data/editor/sessions/record.json", record)
	w.harness = false
	w.run_for(3000)
	t.truthy(w.pending("attach_view"), "and it is followed once it publishes")
	t.eq(w.count("close_editor"), 0)
end

tests.a_session_of_another_host_or_session_is_left_alone_by_a_reload = function(t)
	local w = world()
	w.start()
	drawn(w)
	w.kv.editor_sessions.elsewhere = {
		launch_id = "elsewhere", path = "/other/x.pen", terminal = 77, board = 78,
		data_dir = "/data/editor", manifest = "/data/editor/launch-elsewhere.json", scope = "1:2", shapes = {},
	}
	w.reload()
	adopt(w)
	t.truthy(w.kv.editor_sessions.elsewhere, "not this window's scope, not this window's to forget")
	t.truthy(w.kv.editor_sessions[w.launch_id])
	t.eq(w.launches, 1)
	t.eq(w.count("close_editor"), 0)
end

tests.a_window_that_shows_another_session_does_not_touch_this_ones_editor = function(t)
	local w = world()
	w.start()
	drawn(w)
	w.reload()
	w.session_id = 2
	adopt(w)
	t.truthy(w.kv.editor_sessions[w.launch_id], "its owner is not visible here, which proves nothing about it")
	t.eq(w.count("close_editor"), 0)
end

tests.opening_the_file_of_a_picked_up_session_shows_it_instead_of_starting_a_second_editor = function(t)
	local w = world()
	w.start()
	drawn(w)
	w.reload()
	editor_board.adopt(w.cx)
	-- The user opens the file in the very tick after the reload, before the session is picked up.
	editor_board.open(w.cx, w.path)
	w.run_for(3000)
	t.eq(w.launches, 1, "no second owner, so no ALREADY_OPEN")
	t.truthy(w.toast_titled("econnecting"), "told to wait: the lease is not won yet")
	w.answer("attach_view", attach_reply({ state = "ready", phase = "ready", revision = 3 }))
	editor_board.open(w.cx, w.path)
	w.run_for(100)
	t.truthy(w.toast_titled("already has a board"), "and once it is, the open shows the board")
end

tests.opening_the_file_of_a_picked_up_session_whose_board_is_gone_brings_the_board_back_once = function(t)
	local w = world()
	w.start()
	w.reload()
	w.panes[w.board_pane] = nil
	editor_board.adopt(w.cx)
	editor_board.open(w.cx, w.path)
	w.run_for(3000)
	w.answer("attach_view", attach_reply({ state = "ready", phase = "ready", revision = 3 }))
	w.run_for(500)
	t.eq(w.launches, 1)
	t.eq(w.board_opens(), 1, "one board, not two")
end

-- A budget trip while the sessions are still being picked up: what waited for them must still happen.
tests.a_timer_hook_that_stops_during_the_pick_up_does_not_strand_the_open_that_waits = function(t)
	local w = world()
	w.start()
	drawn(w)
	w.reload()
	editor_board.adopt(w.cx)
	editor_board.open(w.cx, w.path)
	w.timers_off = true
	w.run_for(30000)
	t.truthy(w.toast_titled("stopped"))
	t.eq(w.launches, 1)
	t.truthy(w.toast_titled("econnecting"), "the open that waited has been served")
end

tests.a_stop_seen_without_a_window_context_is_acted_on_at_the_next_pass = function(t)
	local w = world()
	w.start()
	w.timers_off = true
	w.sleep_without_cx = true
	w.run_for(15000)
	t.eq(w.toast_titled("stopped"), nil, "nothing to say it on yet")
	w.sleep_without_cx = false
	w.run_for(5000)
	t.truthy(w.toast_titled("stopped"))
	t.eq(w.count("attach_view"), 2, "the session starts over")
end

-- A window timer hook that went over its budget is disabled until the next reload and its timers silently never fire;
-- the await hook has a budget of its own.
tests.a_stopped_timer_chain_is_taken_over_by_the_await_hook_once = function(t)
	local w = world()
	w.start()
	t.eq(w.count("attach_view"), 1)
	w.timers_off = true
	w.run_for(15000)
	local function stopped(): number
		local n = 0
		for _, toast in w.toasts do
			if toast.title:find("stopped") then
				n += 1
			end
		end
		return n
	end
	t.eq(stopped(), 1, "said once")
	t.eq(w.count("attach_view"), 2, "the session starts over from the await hook")
	w.answer("attach_view", attach_reply({ state = "ready", phase = "ready", revision = 3 }))
	t.truthy(w.pending("list_frames"), "and keeps going")
	w.run_for(60000)
	t.eq(stopped(), 1, "still once")
end

tests.live_timers_are_never_mistaken_for_a_stopped_chain = function(t)
	local w = world()
	w.start()
	w.run_for(60000)
	t.eq(w.toast_titled("stopped"), nil)
	t.eq(w.count("attach_view"), 1, "no second chain beside the live one")
end

tests.a_long_pause_of_the_whole_window_is_not_taken_for_stopped_timers = function(t)
	local w = world()
	w.start()
	-- The machine sleeps: the clock moves on, every timer and sleep is overdue, and they all run when it wakes.
	w.now += 30000
	w.run_for(10000)
	t.eq(w.toast_titled("stopped"), nil)
end

-- Two windows on one session must not both drive its owner: the owner lets one view hold a lease, and a window that is
-- refused waits, quietly, without drawing or sweeping anything, until the lease is its own.
local function refuse_the_lease(w: any)
	w.refuse("attach_view", 409, "VIEW_TAKEN")
end

tests.the_attach_names_the_window_that_asks_and_a_reloaded_window_asks_under_another_name = function(t)
	local w = world()
	w.start()
	local first = w.pending("attach_view").args
	t.truthy(first.holder and first.holder ~= "", "the lease needs a name")
	w.reload()
	adopt(w)
	local second = w.pending("attach_view").args
	t.truthy(second.holder ~= first.holder, "the new VM is another holder")
	t.truthy(second.view_id ~= first.view_id, "and has a view of its own")
end

tests.a_window_that_is_refused_the_lease_draws_and_sweeps_nothing_until_it_gets_it = function(t)
	local w = world()
	w.start()
	drawn(w)
	w.reload()
	editor_board.adopt(w.cx)
	w.run_for(3000)
	refuse_the_lease(w)
	w.run_for(2500)
	refuse_the_lease(w)
	w.run_for(2500)
	t.eq(w.deleted, {}, "what the other window drew is still there")
	t.eq(w.board_opens(), 0)
	t.eq(w.count("close_editor"), 0)
	t.eq(#w.picks, 0)
	t.eq(#w.toasts > 0 and w.toast_titled("rror") or nil, nil, "waiting is not an error")
	w.answer("attach_view", attach_reply({ state = "ready", phase = "ready", revision = 3 }))
	w.run_for(500)
	t.eq(w.deleted, { "shape-activity-text" }, "swept by the window that now holds the lease")
	t.truthy(w.pending("list_frames"), "and the board is built")
	t.truthy(w.kv.editor_sessions[w.launch_id], "recorded once the lease was won")
end

tests.a_window_that_never_gets_the_lease_forgets_the_session_and_closes_nothing = function(t)
	local w = world()
	w.start()
	drawn(w)
	local before = shape_ids(w)
	w.reload()
	editor_board.adopt(w.cx)
	w.run_for(3000)
	for _ = 1, 12 do
		if w.pending("attach_view") then
			refuse_the_lease(w)
		end
		w.run_for(2000)
	end
	t.eq(shape_ids(w), before, "the other window's shapes are untouched")
	t.eq(w.deleted, {})
	t.eq(w.board_opens(), 0, "no second board")
	t.eq(w.count("close_editor"), 0)
	t.eq(#w.picks, 0)
	t.eq(w.launches, 1)
	t.truthy(w.kv.editor_sessions[w.launch_id], "the record belongs to the window that holds the lease")
	t.truthy(w.toast_titled("another window"), "and says where the editor is")
	local attaches = w.count("attach_view")
	for _ = 1, 10 do
		if w.pending("attach_view") then
			refuse_the_lease(w)
		end
		w.run_for(2000)
	end
	t.eq(w.count("attach_view"), attaches, "it has stopped asking")
end

tests.a_session_started_after_switching_to_another_named_session_is_recorded_under_that_session = function(t)
	local w = world()
	w.start()
	w.session_id = 2
	local second = "/work/second.pen"
	w.tern.fs.write(second, "")
	editor_board.open(w.cx, second)
	w.run_for(500)
	local scopes: { [string]: string } = {}
	for _, entry in w.kv.editor_sessions do
		scopes[entry.path] = entry.scope
	end
	t.eq(scopes[w.path], "1:1")
	t.eq(scopes[second], "1:2", "the window shows another session now")
end

tests.a_budget_trip_while_a_registry_write_is_queued_does_not_stop_the_registry_or_the_status = function(t)
	for kill in { 1, 2, 3, 4, 5, 6, 7, 8 } do
		local w = world()
		w.start()
		w.panes[w.board_pane] = nil
		w.kill_after = kill
		w.run_for(40000)
		t.eq(w.kv.editor_sessions[w.launch_id].board, 0, "the record follows the closed board (trip after " .. kill .. " timers)")
	end
end

tests.a_board_that_cannot_be_read_for_a_moment_is_read_again_before_it_is_judged = function(t)
	local w = world()
	w.start()
	drawn(w)
	w.reload()
	w.read_failures = 2
	editor_board.adopt(w.cx)
	w.run_for(3000)
	w.answer("attach_view", attach_reply({ state = "ready", phase = "ready", revision = 3 }))
	w.run_for(20000)
	t.eq(w.board_opens(), 0, "its own board, merely unreadable for a moment")
	t.eq(w.kv.editor_sessions[w.launch_id].board, w.board_pane)
	t.eq(w.deleted, { "shape-activity-text" }, "and what the old window drew was swept once it could be read")
end

tests.a_session_that_has_not_won_the_lease_only_says_it_is_reconnecting_when_the_file_is_opened_again = function(t)
	local w = world()
	w.start()
	drawn(w)
	w.reload()
	w.panes[w.board_pane] = nil
	editor_board.adopt(w.cx)
	w.run_for(3000)
	refuse_the_lease(w)
	w.run_for(500)
	local recorded = w.kv.editor_sessions[w.launch_id]
	editor_board.open(w.cx, w.path)
	w.run_for(100)
	t.eq(w.board_opens(), 0, "no board for a window that does not hold the lease")
	t.truthy(w.toast_titled("econnecting"))
	t.eq(w.kv.editor_sessions[w.launch_id], recorded, "the record is the one the holder wrote")
	editor_board.reopen(w.cx)
	w.run_for(100)
	t.eq(w.board_opens(), 0)
	t.eq(w.launches, 1)
end

tests.a_board_that_goes_while_the_lease_is_still_being_waited_for_is_not_closed_over = function(t)
	local w = world()
	w.start()
	drawn(w)
	w.reload()
	editor_board.adopt(w.cx)
	w.run_for(3000)
	refuse_the_lease(w)
	local recorded = w.kv.editor_sessions[w.launch_id]
	w.panes[w.board_pane] = nil
	w.run_for(3000)
	t.eq(#w.picks, 0, "no close dialog from a window that does not hold the lease")
	t.eq(w.count("close_editor"), 0)
	t.eq(w.kv.editor_sessions[w.launch_id], recorded)
	t.eq(w.count("get_document"), 0, "the owner is not asked about unsaved work either")
	-- Once the lease is won the closed board is dealt with like any other.
	w.answer("attach_view", attach_reply({ state = "ready", phase = "ready", revision = 3 }))
	w.run_for(2000)
	w.answer("get_document", document({ dirty = true }))
	t.eq(#w.picks, 1, "the user is asked what to do with the unsaved work")
	t.eq(w.board_opens(), 0, "and no board came back behind their back")
end

tests.a_board_with_more_shapes_than_the_record_holds_says_so_once = function(t)
	local registry = (require :: any)("../lib/editor_registry")
	local logged = 0
	local w = world()
	w.tern.log.warn = function(text: string)
		if text:find("shapes") then
			logged += 1
		end
	end
	local limit = registry.MAX_SHAPES
	registry.MAX_SHAPES = 0
	local ok, err = pcall(function()
		w.start()
		drawn(w)
		w.run_for(3000)
		-- Another write of the record (the board closes) must not say it again.
		w.close_board()
		w.run_for(3000)
	end)
	registry.MAX_SHAPES = limit
	assert(ok, err)
	t.eq(logged, 1, "a visible note, once per session")
end

-- Moving and resizing on the board. The owner is fake: it answers the reads of a build with one frame and the rows
-- given, and every poll with "nothing new"; the user is `w.selection` and the boxes of the shapes on the board.
local FRAMES = { { id = "frame-a", key = "k1", x = 0, y = 0, w = 800, h = 600, fill = true } }
local BOTH = { width = true, height = true }

local function element(path: string, x: number, y: number, w: number, h: number, extra: any?): any
	local node: any = {
		path = path, parent_path = "frame-a", type = "rectangle", layout = "none", frame_id = "frame-a",
		geometry = { x = x, y = y, width = w, height = h, visible = true, captures = true, ambiguous = false, opacity = 1 },
		movable = true, resizable = BOTH,
	}
	for key, value in extra or {} do
		node[key] = value
	end
	return node
end

local function owner_reply(w: any, args: any, revision: number, nodes: { any }, state: string?): any
	w.status_seq += 1
	return {
		request_id = args.request_id, view_generation = args.view_generation, status_seq = w.status_seq, reset = 0, change_seq = w.status_seq,
		focus = { frame_id = "frame-a", selected_node = w.owner_selected },
		activity = { state = state or "ready", phase = "ready", revision = revision, dirty = false },
		page = { frame_id = "frame-a", revision = revision, nodes = nodes, cursor = 0, next_cursor = nil },
	}
end

-- The probe the window sent when its build ended is answered, so the next look is a poll like any other.
local function settle(w: any)
	if w.pending("list_frames") then
		w.answer("list_frames", function(args: any): any
			return owner_reply(w, args, w.revision, w.frames or FRAMES)
		end)
	end
end

-- Opens the editor and lets it build the board: the frame, then the focused frame's click targets `rows`.
local function built(w: any, rows: { any }, revision: number?)
	local at = revision or 3
	w.rows, w.revision = rows, at
	w.start()
	w.answer("attach_view", attach_reply({ state = "ready", phase = "ready", revision = at }))
	w.run_for(500)
	w.answer("list_frames", function(args: any): any
		return owner_reply(w, args, at, w.frames or FRAMES)
	end)
	w.run_for(500)
	w.answer("poll_view", function(args: any): any
		return owner_reply(w, args, at, w.rows)
	end)
	w.run_for(1000)
	settle(w)
end

-- The board is drawn again after a rebuild: the owner is asked to attach, list the frames and the targets once more.
local function rebuilt(w: any)
	w.answer("attach_view", attach_reply({ state = "ready", phase = "ready", revision = w.revision }))
	w.run_for(500)
	w.answer("list_frames", function(args: any): any
		return owner_reply(w, args, w.revision, w.frames or FRAMES)
	end)
	w.run_for(500)
	w.answer("poll_view", function(args: any): any
		return owner_reply(w, args, w.revision, w.rows)
	end)
	w.run_for(1000)
	settle(w)
end

-- One look of the window: it reads the board, then asks the owner where it stands, and the owner has nothing new.
local function poll(w: any)
	w.run_for(600)
	if w.pending("select_node") then
		w.answer("select_node", function(args: any): any
			w.owner_selected = args.path
			return { request_id = args.request_id, view_generation = args.view_generation, path = args.path }
		end)
	end
	if w.pending("list_frames") then
		w.answer("list_frames", function(args: any): any
			return owner_reply(w, args, w.revision, w.frames or FRAMES)
		end)
	end
end

local function shape_of(w: any, id: string): any
	for _, shape in w.shapes do
		if shape.id == id then
			return shape
		end
	end
	return nil
end

-- The id of the newest target the window drew for `ref` ("t1" is the first element of the rows, and so on).
local function target(w: any, ref: string): any
	local count = w.created[ref] or 0
	return shape_of(w, "shape-" .. ref .. (if count > 1 then "#" .. count else ""))
end

-- The user drags (or resizes) the target `ref` and holds it selected.
local function drag(w: any, ref: string, x: number, y: number, width: number?, height: number?)
	local shape = target(w, ref)
	shape.x, shape.y = x, y
	shape.w, shape.h = width or shape.w, height or shape.h
	w.selection = { shape.id }
end

local function answer_capture(w: any, outcome: string, fields: any?)
	w.answer("submit_capture", function(args: any): any
		local reply: any = { request_id = args.request_id, view_generation = args.view_generation, capture_id = args.capture_id, outcome = outcome, revision = 4 }
		for key, value in fields or {} do
			reply[key] = value
		end
		return reply
	end)
end

local function box_of(shape: any): { number }
	return { shape.x, shape.y, shape.w, shape.h }
end

local function one_at(x: number, y: number): any
	return element("frame-a/one", x, y, 100, 40)
end

local TWO = function(): { any }
	return { one_at(10, 20), element("frame-a/two", 200, 20, 50, 50) }
end

-- The first element is dragged to (90, 70), the second look finds it there and the owner is asked.
local function dragged_and_asked(w: any)
	built(w, TWO())
	drag(w, "t1", 90, 70)
	poll(w)
	poll(w)
end

-- The owner applied it: the document has the element at (90, 70) from revision 4.
local function applied_and_rebuilt(w: any)
	w.revision = 4
	w.rows = { one_at(90, 70), TWO()[2] }
	answer_capture(w, "applied")
	w.run_for(500)
	rebuilt(w)
end

tests.a_shape_still_being_dragged_is_not_applied = function(t)
	local w = world()
	built(w, TWO())
	t.truthy(target(w, "t1"), "the targets are on the board")
	for step = 1, 4 do
		drag(w, "t1", 10 + step * 30, 20)
		poll(w)
	end
	t.eq(w.count("submit_capture"), 0)
end

tests.a_gesture_that_ends_is_applied_once_and_the_board_is_drawn_again = function(t)
	local w = world()
	built(w, TWO())
	drag(w, "t1", 90, 70)
	poll(w)
	t.eq(w.count("submit_capture"), 0, "one look is not the end of a gesture")
	poll(w)
	local request = w.pending("submit_capture")
	t.truthy(request, "two looks at the same place are")
	t.eq(request.args.direct, true, "the window asks without the panel")
	t.eq(request.args.scene_revision, 3)
	t.eq(request.args.changes, { { path = "frame-a/one", x = 90, y = 70, w = 100, h = 40 } })
	applied_and_rebuilt(w)
	t.eq(box_of(target(w, "t1")), { 90, 70, 100, 40 }, "the target sits where the document now has it")
	poll(w)
	poll(w)
	t.eq(w.count("submit_capture"), 1, "the same gesture is never applied twice")
end

tests.the_activity_line_says_the_owner_is_working_while_it_applies = function(t)
	local w = world()
	dragged_and_asked(w)
	t.truthy(w.pending("submit_capture"))
	local line = shape_of(w, "shape-activity-text")
	t.match(line.text, "Updating", "said before the owner has answered")
	applied_and_rebuilt(w)
	t.match(shape_of(w, "shape-activity-text").text, "Ready", "and back to ready once it has")
end

tests.a_resize_is_applied_as_a_capture_of_the_new_box = function(t)
	local w = world()
	built(w, TWO())
	drag(w, "t2", 200, 20, 120, 90)
	poll(w)
	poll(w)
	t.eq(w.pending("submit_capture").args.changes, { { path = "frame-a/two", x = 200, y = 20, w = 120, h = 90 } })
end

tests.a_target_moved_back_to_where_it_was_drawn_before_is_an_ordinary_move = function(t)
	local w = world()
	dragged_and_asked(w)
	applied_and_rebuilt(w)
	-- The user drops it where it started: that is a move like any other.
	drag(w, "t1", 10, 20)
	poll(w)
	poll(w)
	t.eq(w.count("submit_capture"), 2)
	t.eq(w.pending("submit_capture").args.changes, { { path = "frame-a/one", x = 10, y = 20, w = 100, h = 40 } })
	t.eq(w.count("attach_view"), 2, "and it is not mistaken for an undo")
end

tests.a_target_the_user_deleted_is_drawn_again_and_never_becomes_a_document_change = function(t)
	local w = world()
	built(w, TWO())
	w.selection = { "shape-t1" }
	poll(w)
	for index, shape in w.shapes do
		if shape.id == "shape-t1" then
			table.remove(w.shapes, index)
			break
		end
	end
	local attached = w.count("attach_view")
	poll(w)
	poll(w)
	t.eq(w.count("submit_capture"), 0)
	t.eq(w.count("attach_view"), attached + 1)
	t.truthy(w.toast_titled("missing"), "the user is told the shape came back")
end

-- The board's own Undo after an applied gesture: the shapes the rebuild replaced come back with their old ids.
local function board_undo(w: any, brings_back: { any }, takes_away: { string }?)
	for _, shape in brings_back do
		table.insert(w.shapes, shape)
	end
	for _, id in takes_away or {} do
		for index, shape in w.shapes do
			if shape.id == id then
				table.remove(w.shapes, index)
				break
			end
		end
	end
	w.undo, w.redo = w.undo - 1, w.redo + 1
end

tests.targets_the_board_undo_brings_back_are_removed_by_id_and_silently = function(t)
	local w = world()
	dragged_and_asked(w)
	applied_and_rebuilt(w)
	local user = { id = "u-ink", type = "ink", x = 5, y = 5, w = 30, h = 30 }
	-- Something that merely looks like a target, and the very target the session replaced.
	local lookalike = { id = "look-alike", type = "rect", color = "#7c3aed", fill = "#7c3aed", x = 400, y = 400, w = 10, h = 10 }
	table.insert(w.shapes, user)
	table.insert(w.shapes, lookalike)
	board_undo(w, { { id = "shape-t1", type = "rect", color = "#7c3aed", fill = "#7c3aed", x = 90, y = 70, w = 100, h = 40 } })
	local attached, toasts = w.count("attach_view"), #w.toasts
	poll(w)
	t.eq(shape_of(w, "shape-t1"), nil, "the replaced target is gone again")
	t.truthy(shape_of(w, "u-ink"), "the user's drawing is not touched")
	t.truthy(shape_of(w, "look-alike"), "nor is anything that only looks like a target")
	t.truthy(target(w, "t1"), "the current targets stay")
	t.eq(w.count("submit_capture"), 1, "nothing is applied")
	t.eq(w.count("attach_view"), attached, "and nothing is rebuilt for it")
	t.eq(#w.toasts, toasts, "without a word")
end

tests.an_undo_that_also_takes_the_current_targets_rebuilds_without_the_missing_shapes_note = function(t)
	local w = world()
	dragged_and_asked(w)
	applied_and_rebuilt(w)
	local attached, toasts = w.count("attach_view"), #w.toasts
	local first, second = target(w, "t1").id, target(w, "t2").id
	board_undo(w, { { id = "shape-t1", type = "rect", x = 90, y = 70, w = 100, h = 40 }, { id = "shape-t2", type = "rect", x = 200, y = 20, w = 50, h = 50 } }, { first, second })
	poll(w)
	poll(w)
	t.eq(shape_of(w, "shape-t1"), nil)
	t.eq(shape_of(w, "shape-t2"), nil)
	t.eq(w.count("submit_capture"), 1, "nothing is applied")
	t.eq(w.count("attach_view"), attached + 1, "the board is drawn again from the document")
	t.eq(#w.toasts, toasts, "and nobody is told shapes were missing: it was their Undo")
end

tests.the_ids_the_session_retired_are_remembered_only_up_to_a_limit_and_the_cut_is_logged = function(t)
	local gesture_lib: any = (require :: any)("../lib/editor_gesture")
	local limit = gesture_lib.MAX_RETIRED
	gesture_lib.MAX_RETIRED = 1
	local warned = 0
	local w = world()
	w.tern.log.warn = function(text: string)
		if text:find("replaced shapes") then
			warned += 1
		end
	end
	local ok, err = pcall(function()
		dragged_and_asked(w)
		applied_and_rebuilt(w)
		drag(w, "t1", 10, 20)
		poll(w)
		poll(w)
		answer_capture(w, "applied")
		w.run_for(500)
		rebuilt(w)
	end)
	gesture_lib.MAX_RETIRED = limit
	assert(ok, err)
	t.eq(warned, 1, "said once")
end

tests.a_gesture_the_user_keeps_dragging_while_it_is_applied_is_not_pulled_from_under_them = function(t)
	local w = world()
	dragged_and_asked(w)
	-- The pause was taken for the end of the gesture; the pointer has moved on while the owner worked.
	drag(w, "t1", 150, 110)
	local held = target(w, "t1").id
	applied_and_rebuilt(w)
	t.truthy(shape_of(w, held), "the shape in their hand is still there")
	t.eq(table.find(w.deleted, held), nil, "and was never deleted")
	t.eq(box_of(shape_of(w, held)), { 150, 110, 100, 40 })
	t.eq(w.created.t1, 1, "and no second target was drawn for the element")
	-- Where they let go is the next gesture, from the document's box.
	poll(w)
	poll(w)
	local second = w.pending("submit_capture")
	t.truthy(second, "the rest of the drag is a second step")
	t.eq(second.args.changes, { { path = "frame-a/one", x = 150, y = 110, w = 100, h = 40 } })
	t.eq(w.count("submit_capture"), 2)
end

tests.a_target_moved_after_the_owner_answered_is_kept_through_a_render_that_takes_a_while = function(t)
	local w = world()
	dragged_and_asked(w)
	local held = target(w, "t1").id
	w.revision = 4
	w.rows = { one_at(90, 70), TWO()[2] }
	answer_capture(w, "applied")
	w.run_for(500)
	w.answer("attach_view", attach_reply({ state = "ready", phase = "ready", revision = 4 }))
	w.run_for(500)
	-- The new revision is still rendering: the owner says it is working, and the board waits.
	w.answer("list_frames", function(args: any): any
		return owner_reply(w, args, 4, w.frames or FRAMES, "working")
	end)
	w.run_for(500)
	-- The pointer goes on while it renders.
	drag(w, "t1", 150, 110)
	w.run_for(600)
	settle(w)
	rebuilt(w)
	t.truthy(shape_of(w, held), "the shape in their hand survived the rebuild")
	t.eq(table.find(w.deleted, held), nil, "it was never deleted")
	t.eq(box_of(shape_of(w, held)), { 150, 110, 100, 40 })
	t.eq(w.created.t1, 1, "and no second target was drawn for the element")
	poll(w)
	poll(w)
	t.eq(w.pending("submit_capture").args.changes, { { path = "frame-a/one", x = 150, y = 110, w = 100, h = 40 } }, "the rest of the drag is the second step")
end

tests.revived_targets_are_removed_even_when_the_first_delete_fails = function(t)
	local w = world()
	dragged_and_asked(w)
	applied_and_rebuilt(w)
	board_undo(w, { { id = "shape-t1", type = "rect", color = "#7c3aed", fill = "#7c3aed", x = 90, y = 70, w = 100, h = 40 } })
	w.edit_fails = true
	poll(w)
	t.truthy(shape_of(w, "shape-t1"), "the board refused: still there")
	w.edit_fails = false
	w.run_for(5000)
	t.eq(shape_of(w, "shape-t1"), nil, "tried again, without waiting for another Undo")
	t.truthy(target(w, "t1"), "and the current targets stay")
	t.eq(w.count("submit_capture"), 1)
end

local function image_shapes(w: any): { any }
	local out: { any } = {}
	for _, shape in w.shapes do
		if shape.type == "image" then
			table.insert(out, shape)
		end
	end
	return out
end

tests.frame_images_a_rebuild_replaced_are_removed_too_if_the_board_undo_brings_them_back = function(t)
	local w = world()
	w.tern.fs.write("/work/f1.png", "x")
	w.tern.fs.write("/work/f2.png", "x")
	w.frames = { { id = "frame-a", key = "k1", x = 0, y = 0, w = 800, h = 600, fill = true, image = { path = "/work/f1.png" } } }
	built(w, TWO())
	local old = image_shapes(w)[1]
	t.truthy(old, "the frame's image is on the board")
	-- A new revision with a new image: the old one is replaced.
	w.frames = { { id = "frame-a", key = "k2", x = 0, y = 0, w = 800, h = 600, fill = true, image = { path = "/work/f2.png" } } }
	w.revision = 4
	poll(w)
	rebuilt(w)
	t.eq(#image_shapes(w), 1)
	t.eq(shape_of(w, old.id), nil, "the old image is gone")
	board_undo(w, { { id = old.id, type = "image", locked = true, x = 0, y = 0, w = 800, h = 600 } })
	poll(w)
	t.eq(shape_of(w, old.id), nil, "and goes again when the board's Undo brings it back")
	t.eq(#image_shapes(w), 1, "the current one stays")
end

tests.a_gesture_that_is_not_moved_again_is_drawn_again_as_usual = function(t)
	local w = world()
	dragged_and_asked(w)
	local first = target(w, "t1").id
	applied_and_rebuilt(w)
	t.eq(shape_of(w, first), nil, "the old target was replaced")
	t.truthy(target(w, "t1"))
end

tests.a_refusal_puts_the_target_back_in_the_confirmed_box_and_says_why = function(t)
	local w = world()
	dragged_and_asked(w)
	-- Even a target the user went on moving goes back when the owner said no.
	drag(w, "t1", 150, 110)
	answer_capture(w, "refused", { code = "GEOMETRY_CONTROLLED_BY_LAYOUT" })
	w.run_for(500)
	t.eq(w.toasts[#w.toasts].level, "info")
	t.truthy(w.toast_titled("move"), "the toast says what could not be done")
	rebuilt(w)
	t.eq(box_of(target(w, "t1")), { 10, 20, 100, 40 }, "nothing is left out of place")
end

tests.an_old_revision_conflict_rebuilds_the_board_without_a_word = function(t)
	local w = world()
	dragged_and_asked(w)
	local toasts = #w.toasts
	answer_capture(w, "conflict", { code = "REVISION_STALE" })
	w.run_for(500)
	t.truthy(w.pending("attach_view"))
	t.eq(#w.toasts, toasts)
end

tests.an_owner_error_on_the_capture_still_puts_the_board_back = function(t)
	local w = world()
	dragged_and_asked(w)
	w.refuse("submit_capture", 500, "INTERNAL_ERROR")
	w.run_for(3000)
	t.truthy(w.pending("attach_view"), "the targets are drawn again from the document")
end

tests.a_capture_the_owner_is_too_busy_for_leaves_the_board_and_tries_again_later = function(t)
	local w = world()
	dragged_and_asked(w)
	local attached = w.count("attach_view")
	w.refuse("submit_capture", 400, "GEOMETRY_CAPTURE_STALE")
	t.eq(w.count("attach_view"), attached, "the user's gesture is not undone under their hand")
	settle(w)
	poll(w)
	poll(w)
	t.eq(w.count("submit_capture"), 2, "the same gesture is offered again")
end

tests.a_bounce_is_told_once_however_often_a_busy_owner_makes_the_window_try_again = function(t)
	local w = world()
	built(w, { element("frame-a/one", 10, 20, 100, 40, { movable = false }), element("frame-a/two", 200, 20, 50, 50) })
	drag(w, "t1", 90, 70)
	drag(w, "t2", 260, 80)
	poll(w)
	poll(w)
	t.truthy(w.pending("submit_capture"), "the element that may move is offered")
	local titled = function(): number
		local n = 0
		for _, toast in w.toasts do
			if toast.title:find("move") then
				n += 1
			end
		end
		return n
	end
	w.refuse("submit_capture", 400, "GEOMETRY_CAPTURE_STALE")
	settle(w)
	poll(w)
	poll(w)
	w.refuse("submit_capture", 400, "GEOMETRY_CAPTURE_STALE")
	t.eq(titled(), 0, "not while the owner has not answered")
	settle(w)
	poll(w)
	poll(w)
	answer_capture(w, "applied")
	w.run_for(500)
	t.eq(titled(), 1, "and once when it has")
end

tests.moving_an_element_an_auto_layout_places_puts_it_back_at_once_with_the_reason = function(t)
	local w = world()
	built(w, { element("frame-a/one", 10, 20, 100, 40, { movable = false }) })
	drag(w, "t1", 90, 70)
	poll(w)
	local attached = w.count("attach_view")
	poll(w)
	t.eq(w.count("submit_capture"), 0, "the owner is not even asked")
	t.eq(w.count("attach_view"), attached + 1, "the target goes back")
	t.truthy(w.toast_titled("move"))
end

tests.an_element_an_auto_layout_places_that_is_dropped_in_its_parent_is_offered_to_the_owner = function(t)
	local w = world()
	built(w, { element("frame-a/one", 10, 20, 100, 40, { movable = false, reorderable = true }) })
	drag(w, "t1", 90, 20)
	poll(w)
	poll(w)
	t.eq(w.pending("submit_capture").args.changes, { { path = "frame-a/one", x = 90, y = 20, w = 100, h = 40 } })
	w.revision = 4
	answer_capture(w, "applied")
	w.run_for(500)
	t.eq(w.toast_titled("move"), nil, "a reorder is not news to apologise for")
	rebuilt(w)
	t.eq(box_of(target(w, "t1")), { 10, 20, 100, 40 })
end

tests.a_reorder_the_owner_refuses_puts_the_target_back_and_names_the_layout = function(t)
	local w = world()
	built(w, { element("frame-a/one", 10, 20, 100, 40, { movable = false, reorderable = true }) })
	drag(w, "t1", 90, 400)
	poll(w)
	poll(w)
	answer_capture(w, "refused", { code = "GEOMETRY_CONTROLLED_BY_LAYOUT", layout = "horizontal" })
	w.run_for(500)
	local toast = w.toast_titled("move")
	t.truthy(toast)
	t.match(toast.sub, "horizontal")
	rebuilt(w)
	t.eq(box_of(target(w, "t1")), { 10, 20, 100, 40 }, "nothing is left out of place")
end

tests.resizing_an_element_of_automatic_size_puts_it_back_with_the_reason = function(t)
	local w = world()
	built(w, { element("frame-a/one", 10, 20, 100, 40, { resizable = { width = false, height = false } }) })
	drag(w, "t1", 10, 20, 160, 90)
	poll(w)
	local attached = w.count("attach_view")
	poll(w)
	t.eq(w.count("submit_capture"), 0)
	t.eq(w.count("attach_view"), attached + 1)
	t.truthy(w.toast_titled("resize"))
end

tests.an_element_with_one_fixed_size_is_stretched_on_that_axis_and_not_on_the_other = function(t)
	local w = world()
	built(w, { element("frame-a/one", 10, 20, 100, 40, { resizable = { width = true, height = false } }) })
	drag(w, "t1", 10, 20, 160, 40)
	poll(w)
	poll(w)
	t.eq(w.pending("submit_capture").args.changes, { { path = "frame-a/one", x = 10, y = 20, w = 160, h = 40 } })
	answer_capture(w, "refused", { code = "GEOMETRY_SIZE_AMBIGUOUS" })
	w.run_for(500)
	rebuilt(w)
	drag(w, "t1", 10, 20, 100, 90)
	poll(w)
	local attached = w.count("attach_view")
	poll(w)
	t.eq(w.count("submit_capture"), 1, "a taller one is not even offered")
	t.eq(w.count("attach_view"), attached + 1)
	t.truthy(w.toast_titled("resize"))
end

tests.the_users_own_drawings_are_never_gestures_and_never_touched = function(t)
	local w = world()
	built(w, TWO())
	table.insert(w.shapes, { id = "u-ink", type = "ink", x = 5, y = 5, w = 300, h = 300 })
	w.selection = { "u-ink" }
	poll(w)
	shape_of(w, "u-ink").x = 400
	poll(w)
	poll(w)
	t.eq(w.count("submit_capture"), 0)
	t.eq(w.deleted, {}, "nothing was removed (a rebuild only removes the plugin's own shapes)")
	t.eq(w.count("attach_view"), 1)
	t.eq(shape_of(w, "u-ink").x, 400)
end

tests.the_plugins_own_selection_and_status_edits_are_not_gestures = function(t)
	local w = world()
	built(w, TWO())
	w.selection = { "shape-t1" }
	for _ = 1, 4 do
		poll(w)
	end
	t.eq(w.count("submit_capture"), 0)
	t.eq(w.count("attach_view"), 1, "and no rebuild either")
end

tests.a_gesture_and_a_click_in_the_same_look_both_reach_the_owner = function(t)
	local w = world()
	built(w, TWO())
	drag(w, "t2", 260, 80)
	poll(w)
	t.eq(w.count("select_node"), 1, "the click on the target is still sent")
	poll(w)
	t.eq(#w.pending("submit_capture").args.changes, 1)
end

tests.a_gesture_is_seen_whether_or_not_the_board_has_the_shape_selected = function(t)
	local w = world()
	built(w, TWO())
	local shape = target(w, "t2")
	shape.x, shape.y = 260, 80
	t.eq(w.selection, {})
	poll(w)
	poll(w)
	t.eq(w.pending("submit_capture").args.changes, { { path = "frame-a/two", x = 260, y = 80, w = 50, h = 50 } })
end

-- Text typed on the board: a double click edits the label of the target, so the target of a text node carries the node's
-- text while it is selected. "t1" is the Lede text node, "t2" a frame, "t3" another text node.
local LEDE = "Pencil renders every frame."

local function text_rows(): { any }
	return {
		element("frame-a/lede", 10, 20, 300, 40, { type = "text", text = LEDE, font_size = 17 }),
		element("frame-a/hero", 10, 100, 300, 200, { type = "frame" }),
		element("frame-a/other", 10, 320, 300, 30, { type = "text", text = "Other", font_size = 14 }),
	}
end

local function select_target(w: any, ref: string)
	w.selection = { target(w, ref).id }
end

-- The user selects the Lede, the window puts its text on the target and the next looks find it there.
local function lede_selected(w: any)
	built(w, text_rows())
	select_target(w, "t1")
	poll(w)
	poll(w)
end

-- The document after the owner applied `text` to the Lede, from revision 4.
local function lede_applied_as(w: any, text: string)
	w.revision = 4
	w.rows = text_rows()
	w.rows[1].text = text
	answer_capture(w, "applied")
	w.run_for(500)
end

-- Polls until the window asks the owner to apply something: the user waiting, the target not changing by itself.
local function polls_until_asked(w: any)
	local polls = 0
	while w.pending("submit_capture") == nil and polls < 12 do
		poll(w)
		polls += 1
	end
end

tests.selecting_a_text_target_puts_its_text_on_it_as_a_label_that_does_not_show = function(t)
	local w = world()
	built(w, text_rows())
	select_target(w, "t1")
	poll(w)
	local shape = target(w, "t1")
	t.eq(shape.text, LEDE)
	t.eq(shape.font_size, 17)
	poll(w)
	poll(w)
	t.eq(shape.text, LEDE)
	t.truthy(shape.opacity <= 0.02, "the label takes the shape's opacity: nothing of it covers the text of the design")
	t.eq(shape.fill, projection.TARGET_COLOR, "and no white box either")
	t.eq(w.count("submit_capture"), 0, "and putting the text there is not a change of the document")
end

tests.selecting_a_frame_target_puts_no_text_on_it = function(t)
	local w = world()
	built(w, text_rows())
	select_target(w, "t2")
	poll(w)
	poll(w)
	t.eq(target(w, "t2").text, nil)
end

tests.a_label_changed_and_left_is_applied_once_as_the_content_of_the_node_and_the_board_is_drawn_again = function(t)
	local w = world()
	lede_selected(w)
	local first = target(w, "t1").id
	target(w, "t1").text = "A new lede"
	w.selection = {}
	poll(w)
	local request = w.pending("submit_capture")
	t.truthy(request, "the selection left with a different label")
	t.eq(request.args.direct, true, "the window asks without the panel")
	t.eq(request.args.scene_revision, 3)
	t.eq(request.args.texts, { { path = "frame-a/lede", content = "A new lede", base = LEDE } })
	t.truthy(request.raw:find('"changes":[]', 1, true), "the geometry changes are an empty array, not an object")
	lede_applied_as(w, "A new lede")
	rebuilt(w)
	t.truthy(target(w, "t1").id ~= first, "the target is drawn again from the document")
	t.eq(target(w, "t1").text, nil, "without a label")
	poll(w)
	poll(w)
	t.eq(w.count("submit_capture"), 1, "the same text is never applied twice")
end

tests.a_label_that_stays_changed_for_a_second_and_a_half_is_applied_while_still_selected = function(t)
	local w = world()
	lede_selected(w)
	target(w, "t1").text = "Typing"
	local typed_at = w.now
	polls_until_asked(w)
	t.truthy(w.pending("submit_capture"))
	t.truthy(w.now - typed_at >= 1500, "not before the label has held still for that long")
	t.eq(w.pending("submit_capture").args.texts, { { path = "frame-a/lede", content = "Typing", base = LEDE } })
end

tests.a_label_that_goes_on_changing_is_never_applied_while_selected = function(t)
	local w = world()
	lede_selected(w)
	for step = 1, 10 do
		target(w, "t1").text = "word " .. step
		poll(w)
	end
	t.eq(w.count("submit_capture"), 0)
end

tests.a_label_equal_to_the_text_applies_nothing_and_leaving_gives_the_target_its_faint_look_back = function(t)
	local w = world()
	lede_selected(w)
	for _ = 1, 5 do
		poll(w)
	end
	w.selection = {}
	poll(w)
	poll(w)
	t.eq(w.count("submit_capture"), 0)
	local shape = target(w, "t1")
	t.eq(shape.text, "", "the label is gone")
	t.truthy(shape.opacity <= 0.1, "and the target is faint again")
end

tests.an_escape_that_brings_the_old_label_back_before_it_was_applied_applies_nothing = function(t)
	local w = world()
	lede_selected(w)
	target(w, "t1").text = "Half a thought"
	poll(w)
	target(w, "t1").text = LEDE
	for _ = 1, 6 do
		poll(w)
	end
	w.selection = {}
	poll(w)
	t.eq(w.count("submit_capture"), 0)
end

tests.a_label_typed_on_a_frame_is_removed_with_a_notice_and_never_reaches_the_document = function(t)
	local w = world()
	built(w, text_rows())
	select_target(w, "t2")
	poll(w)
	target(w, "t2").text = "oops"
	w.selection = {}
	poll(w)
	poll(w)
	t.eq(w.count("submit_capture"), 0)
	t.eq(target(w, "t2").text, "")
	t.truthy(w.toast_titled("Only text elements"))
end

tests.switching_to_another_target_in_the_middle_applies_the_first_and_the_second_is_kept_as_it_is = function(t)
	local w = world()
	lede_selected(w)
	target(w, "t1").text = "A new lede"
	select_target(w, "t3")
	poll(w)
	local request = w.pending("submit_capture")
	t.truthy(request)
	t.eq(request.args.texts, { { path = "frame-a/lede", content = "A new lede", base = LEDE } })
	t.eq(target(w, "t3").text, nil, "the second target waits for the first to be settled")
	-- The user goes on with the second while the owner works: double click, type, commit.
	local second = target(w, "t3").id
	target(w, "t3").text = "Typed in the second"
	lede_applied_as(w, "A new lede")
	rebuilt(w)
	t.eq(target(w, "t3").id, second, "the rebuild leaves the second target alone: its editor is not taken away")
	t.eq(w.created.t3, 1, "and draws no other for it")
	t.eq(target(w, "t3").text, "Typed in the second", "with what was typed")
	t.eq(w.selection, { second }, "and it is still selected")
	t.eq(w.shapes[#w.shapes].id, second, "in front of the targets drawn after it")
	poll(w)
	poll(w)
	t.eq(target(w, "t3").text, "Typed in the second")
	t.eq(w.count("submit_capture"), 1, "its text is applied later, by the usual rules")
	t.truthy(target(w, "t1").id ~= "shape-t1", "the first target was drawn again")
end

tests.switching_with_nothing_changed_hands_the_label_over_at_once = function(t)
	local w = world()
	lede_selected(w)
	select_target(w, "t3")
	poll(w)
	t.eq(target(w, "t1").text, "")
	t.eq(target(w, "t3").text, "Other")
	t.eq(w.count("submit_capture"), 0)
end

tests.the_rebuild_after_an_apply_keeps_the_target_the_user_is_still_typing_on = function(t)
	local w = world()
	lede_selected(w)
	local first = target(w, "t1").id
	target(w, "t1").text = "First half"
	polls_until_asked(w)
	t.truthy(w.pending("submit_capture"))
	-- The owner took it; the user has gone on typing meanwhile, and the board is drawn again.
	target(w, "t1").text = "First half and more"
	lede_applied_as(w, "First half")
	rebuilt(w)
	t.eq(target(w, "t1").id, first, "the same shape: an editor open on it is not taken away")
	t.eq(target(w, "t1").text, "First half and more", "with what the user typed")
	t.eq(w.created.t1, 1, "no second target for the same element")
	t.eq(w.shapes[#w.shapes].id, first, "and in front of the targets drawn after it: a click in its box selects it, not its parent")
	polls_until_asked(w)
	t.eq(w.pending("submit_capture").args.texts, { { path = "frame-a/lede", content = "First half and more", base = "First half" } })
end

tests.the_rebuild_after_an_apply_does_not_keep_a_label_nobody_touched = function(t)
	local w = world()
	lede_selected(w)
	target(w, "t1").text = "Done"
	polls_until_asked(w)
	lede_applied_as(w, "Done")
	rebuilt(w)
	t.eq(target(w, "t1").text, "Done", "the kept target says what the document says now")
	poll(w)
	poll(w)
	poll(w)
	poll(w)
	t.eq(w.count("submit_capture"), 1, "and nothing more is sent")
end

tests.a_text_the_owner_refuses_says_why_and_is_not_sent_again_until_it_changes = function(t)
	local w = world()
	lede_selected(w)
	target(w, "t1").text = "Bound text"
	polls_until_asked(w)
	answer_capture(w, "refused", { code = "GEOMETRY_NOT_TEXT" })
	w.run_for(500)
	t.truthy(w.toast_titled("edit that text"))
	rebuilt(w)
	for _ = 1, 8 do
		poll(w)
	end
	t.eq(w.count("submit_capture"), 1)
	target(w, "t1").text = "Bound text, edited"
	polls_until_asked(w)
	t.eq(w.pending("submit_capture").args.texts[1].content, "Bound text, edited")
end

tests.several_lines_accents_and_an_empty_text_reach_the_owner_unchanged = function(t)
	for _, typed in { "linha 1\nlinha 2 — açaí, “aspas” & <tags> $5 \\ fim", "" } do
		local w = world()
		lede_selected(w)
		target(w, "t1").text = typed
		w.selection = {}
		poll(w)
		t.eq(w.pending("submit_capture").args.texts, { { path = "frame-a/lede", content = typed, base = LEDE } })
	end
end

tests.a_busy_owner_gets_the_same_text_again_at_a_later_look_and_the_board_is_not_redrawn = function(t)
	local w = world()
	lede_selected(w)
	target(w, "t1").text = "A new lede"
	w.selection = {}
	poll(w)
	local attached = w.count("attach_view")
	w.refuse("submit_capture", 400, "GEOMETRY_CAPTURE_STALE")
	t.eq(w.count("attach_view"), attached)
	settle(w)
	poll(w)
	poll(w)
	t.eq(w.count("submit_capture"), 2)
	t.eq(w.pending("submit_capture").args.texts, { { path = "frame-a/lede", content = "A new lede", base = LEDE } })
end

tests.a_revision_conflict_draws_the_board_again_and_sends_the_text_again_from_the_same_base_when_another_node_changed = function(t)
	local w = world()
	lede_selected(w)
	target(w, "t1").text = "A new lede"
	w.selection = {}
	poll(w)
	answer_capture(w, "conflict", { code = "REVISION_STALE" })
	w.run_for(500)
	w.revision = 5
	w.rows = text_rows()
	w.rows[3].text = "Another node, changed by the agent"
	rebuilt(w)
	w.selection = {}
	poll(w)
	poll(w)
	t.eq(w.count("submit_capture"), 2, "what the user typed is not lost to a conflict")
	t.eq(w.pending("submit_capture").args.scene_revision, 5)
	t.eq(w.pending("submit_capture").args.texts, { { path = "frame-a/lede", content = "A new lede", base = LEDE } })
	t.eq(#w.picks, 0, "nobody is asked: the node the user typed on is as it was")
end

-- The agent changes the node the user typed on, while the label waits to be applied.
local function conflicted(w: any)
	lede_selected(w)
	target(w, "t1").text = "Mine"
	polls_until_asked(w)
	w.revision = 4
	w.rows = text_rows()
	w.rows[1].text = "By the agent"
	answer_capture(w, "conflict", { code = "REVISION_STALE" })
	w.run_for(500)
	rebuilt(w)
	for _ = 1, 8 do
		poll(w)
	end
end

tests.the_node_changed_by_the_agent_while_a_label_waits_gives_the_user_the_choice_and_no_text_is_lost = function(t)
	local w = world()
	conflicted(w)
	local sent = w.count("submit_capture")
	t.eq(sent, 2, "the text was sent again once, from the new revision")
	w.answer("submit_capture", function(args: any): any
		t.eq(args.texts[1].base, LEDE, "from the text the user started with, not the agent's")
		return {
			request_id = args.request_id, view_generation = args.view_generation, capture_id = args.capture_id,
			outcome = "refused", code = "GEOMETRY_TEXT_CONFLICT", current = "By the agent",
		}
	end)
	w.run_for(500)
	t.eq(#w.picks, 1, "the user is asked, on the board")
	local labels: { string } = {}
	for _, item in w.last_pick().items do
		table.insert(labels, item.label)
	end
	t.eq(labels, { "Keep my text", "Keep the document's text" })
	rebuilt(w)
	for _ = 1, 6 do
		poll(w)
	end
	t.eq(w.count("submit_capture"), 2, "and nothing is sent over the agent's text meanwhile")
	t.eq(target(w, "t1").text, "Mine", "the user's label is still on the board")
	t.eq(w.rows[1].text, "By the agent", "and the document still has the agent's")
end

local function asked(w: any)
	conflicted(w)
	w.answer("submit_capture", function(args: any): any
		return {
			request_id = args.request_id, view_generation = args.view_generation, capture_id = args.capture_id,
			outcome = "refused", code = "GEOMETRY_TEXT_CONFLICT", current = "By the agent",
		}
	end)
	w.run_for(500)
	rebuilt(w)
end

tests.keeping_my_text_sends_it_again_from_the_agents_text = function(t)
	local w = world()
	asked(w)
	w.choose(by("answer", "mine"))
	polls_until_asked(w)
	t.eq(w.pending("submit_capture").args.texts, { { path = "frame-a/lede", content = "Mine", base = "By the agent" } })
end

tests.keeping_the_documents_text_puts_it_on_the_label_and_sends_nothing = function(t)
	local w = world()
	asked(w)
	local sent = w.count("submit_capture")
	w.choose(by("answer", "document"))
	for _ = 1, 8 do
		poll(w)
	end
	t.eq(target(w, "t1").text, "By the agent")
	t.eq(w.count("submit_capture"), sent)
end

tests.a_dismissed_choice_keeps_the_label_and_asks_again_only_when_it_changes = function(t)
	local w = world()
	asked(w)
	w.choose(nil)
	local sent = w.count("submit_capture")
	for _ = 1, 8 do
		poll(w)
	end
	t.eq(w.count("submit_capture"), sent, "nothing is sent")
	t.eq(#w.picks, 1, "and nobody is asked again")
	t.eq(target(w, "t1").text, "Mine", "the label stays")
	target(w, "t1").text = "Mine, edited"
	polls_until_asked(w)
	t.eq(w.pending("submit_capture").args.texts[1].content, "Mine, edited", "a label the user changes is sent, and refused, again")
end

tests.a_held_label_does_not_block_the_next_target_and_the_user_is_asked_once_for_each_selection = function(t)
	local w = world()
	asked(w)
	w.choose(nil)
	t.eq(#w.picks, 1)
	select_target(w, "t3")
	for _ = 1, 4 do
		poll(w)
	end
	t.eq(#w.picks, 2, "asked again for the new selection")
	w.choose(nil)
	for _ = 1, 6 do
		poll(w)
	end
	t.eq(#w.picks, 2, "and not again while it stays selected")
	-- The user types on the second target; a change of the document draws the board again.
	local second = target(w, "t3").id
	target(w, "t3").text = "Typed on the second"
	w.revision = 5
	w.rows = text_rows()
	w.rows[1].text = "By the agent, once more"
	poll(w)
	w.run_for(500)
	rebuilt(w)
	t.eq(target(w, "t3").id, second, "the second target keeps its shape")
	t.eq(target(w, "t3").text, "Typed on the second", "and what was typed on it")
	t.eq(w.selection, { second }, "and is still selected")
	t.eq(target(w, "t1").text, "Mine", "the held label is still there")
end

tests.a_target_the_board_cannot_read_during_the_rebuild_is_not_taken_off_it = function(t)
	local w = world()
	lede_selected(w)
	local first = target(w, "t1").id
	target(w, "t1").text = "Committed, not applied"
	w.selection = {}
	poll(w)
	t.truthy(w.pending("submit_capture"))
	w.unreadable = { [first] = true }
	answer_capture(w, "conflict", { code = "REVISION_STALE" })
	w.run_for(500)
	rebuilt(w)
	w.unreadable = nil
	t.truthy(shape_of(w, first), "the shape is still there")
	t.eq(shape_of(w, first).text, "Committed, not applied", "with the label the user committed")
	t.eq(w.created.t1, 1, "and no second target was drawn for it")
end

tests.a_user_drawing_text_on_the_board_is_never_a_document_change = function(t)
	local w = world()
	built(w, text_rows())
	table.insert(w.shapes, { id = "u-text", type = "text", text = "my note", x = 5, y = 5, w = 100, h = 20 })
	w.selection = { "u-text" }
	for _ = 1, 6 do
		poll(w)
	end
	w.selection = {}
	poll(w)
	t.eq(w.count("submit_capture"), 0)
	t.eq(shape_of(w, "u-text").text, "my note")
end

-- The window times each lazy-loading tick and hands the numbers over; whichever way the editor is reached they end up
-- in the status file the smokes read.
local function loadsInStatus(w: any): { [string]: number }
	-- The folder exists once an editor ever ran in this plugin's data.
	w.tern.fs.mkdir("/data/editor")
	w.run_for(3000)
	local status = w.tern.json.decode(w.tern.fs.read("/data/editor/projection-status.json"))
	local loads: { [string]: number } = {}
	for name, ms in status.by do
		if name:match("^load_") then
			loads[name] = ms
		end
	end
	return loads
end

tests.the_loads_of_the_pen_route_reach_the_status_file = function(t)
	local w = world()
	editor_board.open(w.cx, w.path, { load_editor_core = 12.5, load_editor_loop = 3 })
	t.eq(loadsInStatus(w), { load_editor_core = 12.5, load_editor_loop = 3 })
end

tests.the_loads_of_the_pick_up_reach_the_status_file = function(t)
	local w = world()
	editor_board.adopt(w.cx, { load_editor_core = 9 })
	t.eq(loadsInStatus(w), { load_editor_core = 9 })
end

tests.the_loads_of_the_reopen_command_reach_the_status_file = function(t)
	local w = world()
	editor_board.reopen(w.cx, { load_editor_core = 7 })
	t.eq(loadsInStatus(w), { load_editor_core = 7 })
end

tests.the_loads_of_the_open_command_reach_the_status_file = function(t)
	local w = world()
	editor_board.run(w.cx, { load_editor_core = 5 })
	t.eq(loadsInStatus(w), { load_editor_core = 5 })
end

tests.an_open_without_loads_leaves_the_status_file_without_them = function(t)
	local w = world()
	editor_board.open(w.cx, w.path)
	t.eq(loadsInStatus(w), {})
end

tests.palette_save_asks_the_owner_for_the_revision_then_saves_it = function(t)
	local w = world()
	w.start()
	editor_board.palette(w.cx, "save")
	w.run_for(50)
	w.answer("get_document", document({ revision = 6, dirty = true }))
	t.eq(w.pending("save_document").args, { session_id = "S", base_revision = 6 })
	w.answer("save_document", { saved = true, revision = 6 })
	t.eq(w.toasts[#w.toasts].level, "success")
	t.eq(w.count("close_editor"), 0, "saving does not end the editor")
end

tests.palette_undo_and_redo_are_the_documents_own_calls_without_a_view_tag = function(t)
	local w = world()
	w.start()
	editor_board.palette(w.cx, "undo")
	w.run_for(50)
	w.answer("get_document", document({ revision = 8 }))
	t.eq(w.pending("undo_document").args, { session_id = "S", base_revision = 8 })
	w.answer("undo_document", { revision = 9 })
	t.eq(w.toasts[#w.toasts].level, "success")
	editor_board.palette(w.cx, "redo")
	w.run_for(50)
	w.answer("get_document", document({ revision = 9 }))
	t.eq(w.pending("redo_document").args, { session_id = "S", base_revision = 9 })
end

tests.palette_undo_with_nothing_to_undo_is_news = function(t)
	local w = world()
	w.start()
	editor_board.palette(w.cx, "undo")
	w.run_for(50)
	w.answer("get_document", document({}))
	w.refuse("undo_document", 409, "HISTORY_UNAVAILABLE")
	t.eq(w.toasts[#w.toasts].level, "info")
	t.eq(w.count("close_editor"), 0)
end

tests.palette_save_over_a_changed_original_reports_it_and_keeps_the_editor = function(t)
	local w = world()
	w.start()
	editor_board.palette(w.cx, "save")
	w.run_for(50)
	w.answer("get_document", document({ dirty = true }))
	w.refuse("save_document", 409, "SOURCE_CHANGED")
	t.eq(w.toasts[#w.toasts].level, "error")
	t.eq(w.count("close_editor"), 0)
	t.eq(#w.picks, 0)
end

tests.palette_with_a_lost_owner_ends_the_session = function(t)
	local w = world()
	w.start()
	editor_board.palette(w.cx, "save")
	w.run_for(50)
	w.answer("get_document", document({ dirty = true }))
	w.lose("save_document")
	t.eq(w.count("close_editor"), 0, "a lost owner is not asked again")
	t.truthy(w.toast_titled("disconnected"))
end

tests.palette_without_an_open_editor_says_so = function(t)
	local w = world()
	editor_board.palette(w.cx, "save")
	w.run_for(50)
	t.eq(w.toasts[#w.toasts].level, "info")
	t.eq(#w.requests, 0)
end

local MCP_ANSWER = { mcp = { command = "node", args = { "C:\\plugin\\runtime\\mcp.mjs", "--document", "C:\\d\\a b.pen", "--data-dir", "C:\\data" } } }

tests.palette_copy_mcp_puts_the_owners_configuration_in_the_clipboard_and_changes_nothing_else = function(t)
	local w = world()
	w.start()
	editor_board.palette(w.cx, "mcp")
	w.run_for(50)
	t.eq(w.pending("get_mcp_config").args, {}, "no view tag: it is the document's own call")
	w.answer("get_mcp_config", MCP_ANSWER)
	t.eq(#w.copied, 1)
	t.eq(
		tern.json.decode(w.copied[1]),
		{ mcpServers = { ["pencil-editor"] = { command = "node", args = MCP_ANSWER.mcp.args } } }
	)
	t.eq(w.toasts[#w.toasts].level, "success")
	t.match(w.toasts[#w.toasts].sub, "design%d*%.pen")
end

tests.palette_copy_mcp_without_an_open_editor_says_so_and_copies_nothing = function(t)
	local w = world()
	editor_board.palette(w.cx, "mcp")
	w.run_for(50)
	t.eq(w.toasts[#w.toasts].level, "info")
	t.eq(#w.requests, 0)
	t.eq(#w.copied, 0)
end

tests.palette_copy_mcp_refused_or_malformed_copies_nothing = function(t)
	local w = world()
	w.start()
	editor_board.palette(w.cx, "mcp")
	w.run_for(50)
	w.refuse("get_mcp_config", 404, "METHOD_NOT_FOUND")
	t.eq(#w.copied, 0)
	t.eq(w.toasts[#w.toasts].level, "error")
	editor_board.palette(w.cx, "mcp")
	w.run_for(50)
	w.answer("get_mcp_config", { mcp = { command = "node", args = { 1 } } })
	t.eq(#w.copied, 0)
	t.eq(w.toasts[#w.toasts].level, "error")
end

-- A second editor in the same window: its own owner endpoint and a board of its own in tab 2.
local function second_editor(w: any)
	local second = "/work/second.pen"
	w.tern.fs.write(second, "")
	local fetch = w.tern.fetch
	w.tern.fetch = function(url: string, options: any, cb: any)
		fetch(url, options, cb)
		w.requests[#w.requests].url = url
	end
	editor_board.open(w.cx, second)
	w.run_for(100)
	for _, name in w.tern.fs.list("/data/editor") do
		local id = if name:match("^launch%-") then w.tern.json.decode(w.tern.fs.read("/data/editor/" .. name)).launch_id else nil
		if id and id ~= w.launch_id then
			w.tern.fs.write("/data/editor/sessions/second.json", w.tern.json.encode({
				version = 1, launch_id = id, endpoint = "http://127.0.0.1:43124", token = string.rep("u", 43), session_id = "S2",
			}))
		end
	end
	w.panes[31] = { cwd = "/work", kind = "canvas", tab = 2 }
	w.boards_requested[2].awaiting:resolve(31)
	w.run_for(1500)
end

tests.palette_with_two_editors_and_the_terminal_focused_acts_on_the_board_in_its_tab = function(t)
	local w = world()
	w.start()
	w.panes[w.board_pane].tab = 1
	second_editor(w)
	w.panes[2].tab = 2
	editor_board.palette(w.cx, "save")
	w.run_for(50)
	local asked = w.pending("get_document")
	t.truthy(asked, "the focused tab's editor was asked")
	t.match(asked.url, "43124")
	t.eq(asked.args, {})
	w.panes[2].tab = 1
	w.requests = {}
	editor_board.palette(w.cx, "save")
	w.run_for(50)
	t.match(w.pending("get_document").url, "43123", "the other tab, the other editor")
end

tests.palette_with_two_editors_and_no_way_to_tell_them_apart_sends_nothing = function(t)
	local w = world()
	w.start()
	w.panes[w.board_pane].tab = 1
	second_editor(w)
	w.panes[2].tab = 7
	w.requests = {}
	editor_board.palette(w.cx, "undo")
	w.run_for(50)
	t.eq(w.count("get_document"), 0)
	t.eq(w.toasts[#w.toasts].level, "info")
end

tests.palette_copy_mcp_with_two_editors_and_no_way_to_tell_them_apart_asks_for_focus = function(t)
	local w = world()
	w.start()
	w.panes[w.board_pane].tab = 1
	second_editor(w)
	w.requests = {}
	editor_board.palette(w.cx, "mcp")
	w.run_for(50)
	t.eq(w.count("get_mcp_config"), 0)
	t.eq(w.toasts[#w.toasts].level, "info")
	t.eq(#w.copied, 0)
end

-- The timer callbacks in which the window made more than one slow native call (see `w.watch_natives`), each as the list
-- of its calls. A window hook that blocks over 50 ms is killed, and on a busy window any one native call can be that slow,
-- so a callback holds at most one. The one exception, `read_then_write`, is a board read whose answer decides a write to
-- the same shape (the label of a target): apart, what the user types in between would be overwritten.
local function crowded(calls: { { tick: number, call: string } }, read_then_write: boolean?): { { string } }
	local by_tick: { [number]: { string } } = {}
	local order: { number } = {}
	for _, entry in calls do
		if by_tick[entry.tick] == nil then
			by_tick[entry.tick] = {}
			table.insert(order, entry.tick)
		end
		table.insert(by_tick[entry.tick], entry.call)
	end
	local out: { { string } } = {}
	for _, tick in order do
		local group = by_tick[tick]
		local pair = #group == 2 and group[1] == "whiteboard.read" and group[2] == "whiteboard.edit"
		if #group > 1 and not (read_then_write and pair) then
			table.insert(out, group)
		end
	end
	return out
end

-- Whether some callback made both calls.
local function together(calls: { { tick: number, call: string } }, first: string, second: string): boolean
	for _, a in calls do
		if a.call == first then
			for _, b in calls do
				if b.call == second and b.tick == a.tick then
					return true
				end
			end
		end
	end
	return false
end

tests.opening_an_editor_makes_at_most_one_slow_native_call_in_each_timer_callback = function(t)
	local w = world()
	local calls = w.watch_natives()
	w.start()
	t.eq(w.launches, 1, "the editor opened")
	t.truthy(#calls > 8, "the calls were seen")
	t.eq(crowded(calls), {})
end

tests.the_opening_toast_is_alone_in_its_callback = function(t)
	local w = world()
	local calls = w.watch_natives()
	editor_board.open(w.cx, w.path)
	w.run_for(100)
	local alone = 0
	for _, entry in calls do
		if entry.call == "toast" then
			alone += 1
			for _, other in calls do
				if other ~= entry and other.tick == entry.tick then
					error("the toast shared a callback with " .. other.call)
				end
			end
		end
	end
	t.eq(alone, 1, "the opening toast")
end

local function refusing_step(name: string, setup: (w: any) -> (), title: string, extra: ((t: T, w: any) -> ())?)
	tests[name] = function(t)
		local w = world()
		setup(w)
		local calls = w.watch_natives()
		editor_board.open(w.cx, w.path)
		w.run_for(300)
		t.truthy(w.toast_titled(title), "the user is told: " .. title)
		t.eq(crowded(calls), {})
		local listed, files = pcall(w.tern.fs.list, "/data/editor")
		for _, file in if listed then files else {} do
			t.truthy(not file:match("^launch%-"), "no launch file left behind")
		end
		if extra then
			extra(t, w)
		end
	end
end

refusing_step("a_node_that_cannot_be_checked_is_told_in_a_callback_of_its_own", function(w)
	local run = w.tern.process.run
	w.tern.process.run = function(argv: { string }, opts: any, cb: any)
		if argv[2] == "--version" then
			w.tern.timer(0, function(fresh: any)
				cb({ status = 1, stdout = "", stderr = "", timed_out = false }, fresh)
			end)
		else
			run(argv, opts, cb)
		end
	end
end, "needs Node")

refusing_step("an_owner_that_cannot_be_spawned_removes_the_launch_file_and_tells_in_other_callbacks", function(w)
	w.owner_run_error = "No such file or directory (os error 2)"
end, "could not be started", function(t: T, w: any)
	t.eq(w.launches, 0)
	t.eq(w.kv.editor_sessions, nil, "no session was left behind for a process that never ran")
end)

refusing_step("a_launch_file_that_cannot_be_written_is_told_in_a_callback_of_its_own", function(w)
	local write = w.tern.fs.write
	w.tern.fs.write = function(path: string, text: string)
		if path:match("launch%-") then
			error("disk full")
		end
		write(path, text)
	end
end, "launch file")

tests.the_label_flow_makes_at_most_one_slow_native_call_in_each_timer_callback = function(t)
	local w = world()
	lede_selected(w)
	local calls = w.watch_natives()
	target(w, "t1").text = "A new lede"
	w.selection = {}
	poll(w)
	lede_applied_as(w, "A new lede")
	rebuilt(w)
	poll(w)
	t.truthy(#calls > 3, "the flow made calls")
	t.eq(crowded(calls, true), {})
	local frame = world()
	built(frame, text_rows())
	select_target(frame, "t2")
	poll(frame)
	local more = frame.watch_natives()
	target(frame, "t2").text = "oops"
	frame.selection = {}
	poll(frame)
	poll(frame)
	t.truthy(frame.toast_titled("Only text elements"))
	t.eq(crowded(more, true), {}, "a label discarded with a notice")
	t.truthy(not together(more, "whiteboard.edit", "toast"), "the notice is not in the callback of the edit")
end

tests.the_label_a_selection_reads_and_the_text_written_from_that_read_share_one_callback = function(t)
	local w = world()
	built(w, text_rows())
	local calls = w.watch_natives()
	select_target(w, "t1")
	poll(w)
	t.eq(target(w, "t1").text, LEDE, "the target carries the node's text")
	t.truthy(together(calls, "whiteboard.read", "whiteboard.edit"), "what the user types between a read and its write would be lost")
end

tests.losing_the_owner_makes_at_most_one_slow_native_call_in_each_timer_callback = function(t)
	local w = world()
	w.start()
	local calls = w.watch_natives()
	w.lose("attach_view")
	w.run_for(2000)
	t.eq(w.count("close_editor"), 0)
	t.truthy(w.toast_titled("disconnected"), "the user is told")
	t.truthy(#calls >= 3, "the teardown made calls")
	t.eq(crowded(calls), {})
end

tests.losing_the_owner_with_targets_on_the_board_reads_and_deletes_them_in_separate_callbacks = function(t)
	local w = world()
	built(w, text_rows())
	local drawn = #w.shapes
	t.truthy(drawn > 3, "the board has its images and targets")
	local calls = w.watch_natives()
	w.owner_exits(1)
	w.run_for(5000)
	t.truthy(#w.deleted > 0, "the targets are taken off the board")
	t.eq(crowded(calls), {})
end

tests.discarding_at_close_makes_at_most_one_slow_native_call_in_each_timer_callback = function(t)
	local w = world()
	w.start()
	local calls = w.watch_natives()
	w.close_board()
	w.answer("get_document", document({ dirty = true, revision = 7 }))
	w.choose(by("answer", "discard"))
	w.answer("discard_unsaved", { discarded = true, revision = 8 })
	w.run_for(500)
	t.eq(w.count("close_editor"), 1)
	t.truthy(#calls >= 3, "the close made calls")
	t.eq(crowded(calls), {})
end

tests.discarding_asks_the_owner_to_end_in_the_same_callback_even_if_no_later_callback_ever_runs = function(t)
	local w = world()
	w.start()
	w.close_board()
	w.answer("get_document", document({ dirty = true, revision = 7 }))
	w.choose(by("answer", "discard"))
	local remove = w.tern.fs.remove
	w.tern.fs.remove = function(path: string)
		-- The timer hook dies the moment anything is removed: whatever was to follow in a later callback is lost.
		w.timers_off = true
		remove(path)
	end
	w.answer("discard_unsaved", { discarded = true, revision = 8 })
	t.eq(w.count("close_editor"), 1, "the end is asked for first, before anything that could be lost with the hook")
end

tests.an_owner_that_answered_has_already_deleted_the_launch_file_so_ending_it_removes_nothing = function(t)
	local w = world()
	w.start()
	local calls = w.watch_natives()
	w.close_board()
	w.answer("get_document", document({ dirty = true, revision = 7 }))
	w.choose(by("answer", "discard"))
	w.answer("discard_unsaved", { discarded = true, revision = 8 })
	w.run_for(500)
	t.eq(w.count("close_editor"), 1)
	for _, entry in calls do
		t.truthy(entry.call ~= "fs.remove", "no launch file to remove: the owner read it and deleted it")
	end
end

-- The ledger above counts the callbacks of the tests that open and close; this one adds the end of the owner.
tests.asking_the_owner_to_end_is_a_request_of_its_own_with_nothing_else_in_it = function(t)
	local w = world()
	w.start()
	w.close_board()
	w.answer("get_document", document({ dirty = false }))
	local ask = w.pending("close_editor")
	t.truthy(ask, "the clean close asks the owner to end")
	t.eq(ask.args, {}, "no document, no token, no secret travels in it")
	t.eq(w.pane_calls, 0)
	t.eq(w.kv.editor_sessions, nil)
end

tests.an_owner_that_ends_after_it_was_asked_is_not_reported_as_lost = function(t)
	local w = world()
	w.start()
	w.close_board()
	w.answer("get_document", document({ dirty = false }))
	w.owner_exits(0)
	w.run_for(60000)
	for _, toast in w.toasts do
		t.eq(toast.title, "Opening the editor", "nothing but the opening toast: the user asked for this end")
	end
end

tests.an_owner_that_dies_while_the_window_is_watching_is_told_once_without_waiting_for_a_request_to_fail = function(t)
	local w = world()
	w.start()
	drawn(w)
	w.owner_exits(1)
	w.run_for(60000)
	t.eq(w.count("close_editor"), 0)
	t.eq(w.kv.editor_sessions, nil)
	local told = 0
	for _, toast in w.toasts do
		told += if toast.title:find("disconnected") then 1 else 0
	end
	t.eq(told, 1)
end

tests.closing_the_board_before_the_owner_published_leaves_it_to_end_on_its_own = function(t)
	local w = world()
	editor_board.open(w.cx, w.path)
	w.run_for(100)
	w.board_pane = 30
	w.panes[w.board_pane] = { cwd = "/work", kind = "canvas" }
	w.boards_requested[1].awaiting:resolve(w.board_pane)
	w.run_for(500)
	w.panes[w.board_pane] = nil
	w.run_for(2000)
	t.eq(w.count("close_editor"), 0, "no record, so no endpoint to ask")
	t.eq(w.kv.editor_sessions, nil)
	for _, name in w.tern.fs.list("/data/editor") do
		t.truthy(not name:match("^launch%-"), "its launch file goes, so an owner that has not read it never starts")
	end
	t.eq(w.pane_calls, 0)
end

-- A window that knows nothing of an owner that is still alive (a Tern that was closed and opened again, another
-- window) opens the file: the second owner stops with ALREADY_OPEN, and the window follows the first by its record.
local function second_launch(w: any, reason: string)
	w.reload()
	w.kv.editor_sessions = nil
	w.harness = true
	for _, name in w.tern.fs.list("/data/editor") do
		if name:match("^launch%-") then
			w.tern.fs.remove("/data/editor/" .. name)
		end
	end
	w.harness = false
	editor_board.open(w.cx, w.path)
	w.run_for(100)
	w.harness = true
	for _, name in w.tern.fs.list("/data/editor") do
		if name:match("^launch%-.*%.json$") then
			w.second_id = w.tern.json.decode(w.tern.fs.read("/data/editor/" .. name)).launch_id
			w.tern.fs.write("/data/editor/" .. name:gsub("%.json$", ".failed"), w.tern.json.encode({ code = reason }))
		end
	end
	w.harness = false
	w.board_pane = 31
	w.panes[w.board_pane] = { cwd = "/work", kind = "canvas" }
	w.boards_requested[1].awaiting:resolve(w.board_pane)
	w.owner_exits(1)
end

tests.opening_a_file_whose_owner_is_still_alive_reconnects_to_it_instead_of_failing = function(t)
	local w = world()
	w.start()
	drawn(w)
	second_launch(w, "ALREADY_OPEN")
	t.eq(w.launches, 2, "the second owner ran and stopped")
	for _, toast in w.toasts do
		t.truthy(toast.level ~= "error", "no failure for a file the window can reach")
	end
	local attach = w.pending("attach_view")
	t.truthy(attach, "the window asks the first owner's endpoint for the lease")
	t.eq(w.kv.editor_sessions[w.second_id].path, w.path, "and keeps the session under the launch that found it")
	t.eq(w.count("close_editor"), 0)
	w.answer("attach_view", attach_reply({ state = "ready", phase = "ready", revision = 3 }))
	w.run_for(500)
	t.truthy(w.pending("list_frames"), "the board is built from it")
	t.eq(w.board_opens(), 1)
	for _, name in w.tern.fs.list("/data/editor") do
		t.truthy(not name:match("%.failed$"), "the reason is read once")
	end
end

tests.a_second_launch_that_finds_no_live_owner_to_follow_says_the_file_is_open_after_a_few_seconds = function(t)
	local w = world()
	w.start()
	drawn(w)
	w.tern.fs.remove("/data/editor/sessions/record.json")
	second_launch(w, "ALREADY_OPEN")
	local projection: any = require("../lib/editor_projection")
	local title = projection.start_failure("ALREADY_OPEN", 1)
	t.eq(w.toast_titled(title), nil, "an owner that is still starting holds the lock before it publishes: the lookup goes on for a while")
	w.run_for(8000)
	t.truthy(w.toast_titled(title), "told which editor holds it, as before")
	t.eq(w.count("attach_view"), 1)
end

tests.an_owner_that_publishes_its_record_within_a_few_seconds_of_the_reopen_is_followed = function(t)
	local w = world()
	w.start()
	drawn(w)
	local record = w.tern.fs.read("/data/editor/sessions/record.json")
	w.tern.fs.remove("/data/editor/sessions/record.json")
	second_launch(w, "ALREADY_OPEN")
	w.harness = true
	w.tern.fs.write("/data/editor/sessions/record.json", record)
	w.harness = false
	w.run_for(2000)
	t.truthy(w.pending("attach_view"), "the owner that published again is followed")
	for _, toast in w.toasts do
		t.truthy(toast.level ~= "error")
	end
end

tests.a_reconnecting_window_does_nothing_to_the_owner_until_it_holds_the_lease = function(t)
	local w = world()
	w.start()
	drawn(w)
	second_launch(w, "ALREADY_OPEN")
	refuse_the_lease(w)
	local before = { w.count("get_document"), w.count("discard_unsaved"), w.count("save_document"), w.count("close_editor") }
	w.close_board()
	w.run_for(5000)
	t.eq(#w.picks, 0, "nobody is asked about a document another window is editing")
	t.eq({ w.count("get_document"), w.count("discard_unsaved"), w.count("save_document"), w.count("close_editor") }, before, "and nothing reaches its owner")
end

tests.a_reconnected_window_is_picked_up_again_by_a_reload_and_follows_the_same_owner = function(t)
	local w = world()
	w.start()
	drawn(w)
	second_launch(w, "ALREADY_OPEN")
	w.answer("attach_view", attach_reply({ state = "ready", phase = "ready", revision = 3 }))
	w.run_for(500)
	t.eq(w.kv.editor_sessions[w.second_id].follow, true, "the registry says it follows an owner it did not launch")
	w.reload()
	adopt(w)
	local attach = w.pending("attach_view")
	t.truthy(attach, "the lease is asked of the owner that is followed")
	t.eq(attach.url, "http://127.0.0.1:43123")
	t.eq(w.launches, 2, "no third owner")
end

tests.a_follower_that_gave_up_the_lease_is_forgotten_and_not_told_again_after_a_reload = function(t)
	local w = world()
	w.start()
	drawn(w)
	second_launch(w, "ALREADY_OPEN")
	for _ = 1, 12 do
		if w.pending("attach_view") then
			refuse_the_lease(w)
		end
		w.run_for(2000)
	end
	local told = 0
	for _, toast in w.toasts do
		told += if toast.title:find("another window") then 1 else 0
	end
	t.eq(told, 1, "the window that was refused says so")
	t.eq(w.kv.editor_sessions, nil, "and nothing of it is kept: the other window's session is the one that holds the editor")
	w.reload()
	adopt(w)
	local attaches = w.count("attach_view")
	w.run_for(60000)
	t.eq(w.count("attach_view"), attaches, "nobody asks the other window's owner again")
	t.eq(w.toasts, {}, "and nobody says it twice")
end

tests.a_followed_owner_that_is_gone_after_a_reload_is_forgotten_without_a_word = function(t)
	local w = world()
	w.start()
	drawn(w)
	second_launch(w, "ALREADY_OPEN")
	w.answer("attach_view", attach_reply({ state = "ready", phase = "ready", revision = 3 }))
	w.run_for(500)
	w.reload()
	w.tern.fs.remove("/data/editor/sessions/record.json")
	adopt(w)
	w.run_for(10000)
	t.eq(w.kv.editor_sessions, nil)
	t.eq(w.toasts, {}, "an owner that ended cleanly is no news")
	t.truthy(table.find(w.deleted, "shape-activity-text"), "what the session drew on the board does not stay behind")
end

tests.a_launch_that_left_no_record_is_forgotten_with_the_shapes_it_drew_swept = function(t)
	local w = world()
	w.start()
	drawn(w)
	age_the_launch(w)
	w.reload()
	w.tern.fs.remove("/data/editor/sessions/record.json")
	adopt(w)
	w.run_for(5000)
	t.eq(w.kv.editor_sessions, nil)
	t.truthy(table.find(w.deleted, "shape-activity-text"), "swept before the entry that names it goes")
	t.eq(w.board_opens(), 0, "and no board is opened for a session that is being forgotten")
end

tests.closing_again_before_the_keep_alive_fires_does_not_start_a_second_one = function(t)
	local w = world()
	w.start()
	w.close_board()
	w.answer("get_document", document({ dirty = true }))
	w.choose(by("answer", "reopen"))
	w.panes[31] = { cwd = "/work", kind = "canvas" }
	w.boards_requested[2].awaiting:resolve(31)
	w.board_pane = 31
	w.run_for(1500)
	w.close_board()
	w.answer("get_document", document({ dirty = true }))
	t.eq(#w.picks, 2)
	local before = requests_of(w, "poll_document")
	w.run_for(200000)
	local sent = requests_of(w, "poll_document") - before
	t.truthy(sent >= 8 and sent <= 11, "one request every 20 s, not two: " .. sent)
end

tests.a_window_with_a_board_closed_and_the_question_open_keeps_its_owner_asking_for_as_long_as_it_waits = function(t)
	local w = world()
	w.start()
	w.close_board()
	w.answer("get_document", document({ dirty = true }))
	t.eq(#w.picks, 1)
	local before = requests_of(w, "poll_document")
	w.run_for(300000)
	t.truthy(requests_of(w, "poll_document") - before >= 10, "a request that renews the owner's lease goes out every few seconds")
	w.choose(by("answer", "reopen"))
	local after = requests_of(w, "poll_document")
	w.run_for(60000)
	t.eq(requests_of(w, "poll_document"), after, "and stops once the question is answered")
end

tests.a_window_whose_board_could_not_open_keeps_its_owner_asking = function(t)
	local w = world()
	w.start()
	w.close_board()
	w.answer("get_document", document({ dirty = true }))
	w.choose(by("answer", "reopen"))
	w.boards_requested[2].awaiting:resolve(nil)
	w.run_for(1000)
	local before = requests_of(w, "poll_document")
	for _ = 1, 40 do
		w.run_for(1500)
		if w.pending("poll_document") then
			w.answer("poll_document", document({}))
		end
	end
	t.truthy(requests_of(w, "poll_document") - before >= 20, "the boardless poll is the window's own")
	t.eq(w.count("get_document"), 1, "and it is not the read an agent makes (only the close question)")
end

tests.a_record_of_another_document_is_never_followed_for_this_one = function(t)
	local w = world()
	w.start()
	drawn(w)
	w.tern.fs.write("/data/editor/sessions/record.json", w.tern.json.encode({
		version = 1, launch_id = w.launch_id, original_path = "/work/other.pen", endpoint = "http://127.0.0.1:43123", token = string.rep("t", 43), session_id = "S",
	}))
	second_launch(w, "ALREADY_OPEN")
	t.eq(w.count("attach_view"), 1, "nothing was followed")
end

-- A foreign record the owner left (another launch's), so the wait for ours has files to read.
local function foreign_records(w: any, count: number)
	w.harness = true
	w.tern.fs.mkdir("/data/editor")
	w.tern.fs.mkdir("/data/editor/sessions")
	for index = 1, count do
		w.tern.fs.write("/data/editor/sessions/other" .. index .. ".json", w.tern.json.encode({
			version = 1, launch_id = string.rep("e", 32), endpoint = "http://127.0.0.1:43123", token = string.rep("t", 43), session_id = "X",
		}))
	end
	w.harness = false
end

tests.an_owner_that_never_answers_is_waited_for_one_native_call_at_a_time_then_its_launch_file_goes_and_the_user_is_told = function(t)
	local w = world()
	foreign_records(w, 2)
	local calls = w.watch_natives()
	w.tick_no += 1
	editor_board.open(w.cx, w.path)
	w.run_for(100)
	w.board_pane = 30
	w.panes[w.board_pane] = { cwd = "/work", kind = "canvas" }
	w.tick_no += 1
	w.boards_requested[1].awaiting:resolve(w.board_pane)
	w.run_for(130000)
	t.eq(w.count("close_editor"), 0, "there is no record to ask: a starting owner cannot be told anything")
	t.truthy(w.toast_titled("did not start"), "and the user is told")
	local reads, removes = 0, 0
	for _, entry in calls do
		if entry.call == "fs.read" then
			reads += 1
		elseif entry.call == "fs.remove" then
			removes += 1
		end
	end
	t.truthy(reads >= 2 * 100, "every look read the two records, one per callback")
	t.eq(removes, 1, "the launch file nobody read goes")
	t.eq(w.pane_calls, 0)
	t.eq(crowded(calls), {})
end

-- Opens the editor and lets its owner exit with status 1 before it publishes a session; `reason` is the error code the
-- owner left beside its launch file, if any. Returns the world and the natives it made.
local function owner_that_exits(reason: string?, foreign: string?): (any, any)
	local w = world()
	local calls = w.watch_natives()
	w.tick_no += 1
	editor_board.open(w.cx, w.path)
	w.run_for(100)
	w.board_pane = 30
	w.panes[w.board_pane] = { cwd = "/work", kind = "canvas" }
	w.tick_no += 1
	w.boards_requested[1].awaiting:resolve(w.board_pane)
	w.harness = true
	for _, name in w.tern.fs.list("/data/editor") do
		if name:match("^launch%-.*%.json$") then
			w.launch_id = w.tern.json.decode(w.tern.fs.read("/data/editor/" .. name)).launch_id
			w.failure = "/data/editor/" .. name:gsub("%.json$", ".failed")
		end
	end
	if reason then
		w.tern.fs.write(w.failure, w.tern.json.encode({ code = reason }))
	end
	if foreign then
		w.foreign = "/data/editor/launch-" .. tostring(os.time()) .. "-" .. string.rep("a", 32) .. ".failed"
		w.tern.fs.write(w.foreign, w.tern.json.encode({ code = foreign }))
	end
	w.harness = false
	w.run_for(500)
	w.owner_exits(1)
	return w, calls
end

local function errors_told(w: any): number
	local errors = 0
	for _, toast in w.toasts do
		errors += if toast.level == "error" then 1 else 0
	end
	return errors
end

tests.an_owner_that_exits_before_its_session_is_closed_and_the_user_is_told_why_without_waiting_for_the_timeout = function(t)
	local w, calls = owner_that_exits("ALREADY_OPEN")
	w.run_for(8000)
	local projection: any = require("../lib/editor_projection")
	local title, detail = projection.start_failure("ALREADY_OPEN", 1)
	local generic = projection.start_failure(nil, 1)
	t.truthy(title ~= generic, "the reason the owner left is not the generic one")
	local toast = w.toast_titled(title)
	t.truthy(toast, "the user is told that reason")
	t.eq(toast.sub, detail)
	t.eq(toast.level, "error")
	t.eq(w.count("close_editor"), 0, "a program that exited has nobody to ask")
	t.eq(crowded(calls), {})
	t.eq(w.tern.fs.exists(w.failure), false, "the reason is read once")
	w.run_for(130000)
	t.eq(errors_told(w), 1, "told once, and nothing more when the timeout would have fired")
end

tests.an_owner_that_exits_without_a_reason_is_told_by_its_exit_status = function(t)
	local w, calls = owner_that_exits(nil)
	local projection: any = require("../lib/editor_projection")
	local title, detail = projection.start_failure(nil, 1)
	local toast = w.toast_titled(title)
	t.truthy(toast, "an editor that was never able to say why")
	t.eq(toast.sub, detail)
	t.eq(toast.level, "error")
	t.eq(w.count("close_editor"), 0)
	t.eq(crowded(calls), {})
end

tests.an_owner_still_running_without_its_session_is_waited_for_whatever_failure_files_are_around = function(t)
	local w = world()
	w.tick_no += 1
	editor_board.open(w.cx, w.path)
	w.run_for(100)
	w.harness = true
	w.tern.fs.write("/data/editor/launch-" .. tostring(os.time()) .. "-" .. string.rep("a", 32) .. ".failed", w.tern.json.encode({ code = "ALREADY_OPEN" }))
	w.harness = false
	w.run_for(20000)
	t.eq(errors_told(w), 0, "another launch's reason is not ours")
	t.eq(w.count("close_editor"), 0)
end

tests.another_launchs_fresh_reason_is_never_taken_for_the_reason_of_an_owner_that_left_none = function(t)
	local w, calls = owner_that_exits(nil, "ALREADY_OPEN")
	local projection: any = require("../lib/editor_projection")
	local title, detail = projection.start_failure(nil, 1)
	local toast = w.toast_titled(title)
	t.truthy(toast, "told that it stopped, not why the other launch did")
	t.eq(toast.sub, detail)
	t.eq(errors_told(w), 1)
	t.eq(w.tern.fs.exists(w.foreign), true, "and the other launch's file is left for its own window")
	t.eq(crowded(calls), {})
end

tests.failure_files_no_window_read_are_swept_with_the_stale_manifests_and_fresh_ones_stay = function(t)
	local w = world()
	w.harness = true
	w.tern.fs.mkdir("/data/editor")
	local old = "/data/editor/launch-1-" .. string.rep("1", 32) .. ".failed"
	local fresh = "/data/editor/launch-" .. tostring(os.time()) .. "-" .. string.rep("2", 32) .. ".failed"
	w.tern.fs.write(old, '{"code":"ALREADY_OPEN"}')
	w.tern.fs.write(fresh, '{"code":"ALREADY_OPEN"}')
	w.harness = false
	local calls = w.watch_natives()
	w.tick_no += 1
	editor_board.open(w.cx, w.path)
	w.run_for(300)
	t.eq(w.tern.fs.exists(old), false, "an old reason is gone")
	t.eq(w.tern.fs.exists(fresh), true, "a reason a window may still read stays")
	t.eq(crowded(calls), {})
end

tests.stale_launch_files_are_removed_one_per_callback_before_the_node_check = function(t)
	local w = world()
	w.harness = true
	w.tern.fs.mkdir("/data/editor")
	local stale = {}
	for index = 1, 3 do
		local name = "/data/editor/launch-1-" .. string.rep(tostring(index), 32) .. ".json"
		w.tern.fs.write(name, "{}")
		table.insert(stale, name)
	end
	w.harness = false
	local calls = w.watch_natives()
	w.tick_no += 1
	editor_board.open(w.cx, w.path)
	w.run_for(300)
	for _, name in stale do
		t.eq(w.tern.fs.exists(name), false, "a stale launch file is gone")
	end
	t.eq(w.launches, 1, "and the editor still opened")
	local removed = 0
	for _, entry in calls do
		if entry.call == "fs.remove" then
			removed += 1
		end
	end
	t.eq(removed, 3)
	t.eq(crowded(calls), {})
end

tests.a_whiteboard_edit_that_fails_is_told_in_a_callback_of_its_own = function(t)
	local w = world()
	w.rows, w.revision = text_rows(), 3
	w.start()
	local calls = w.watch_natives()
	w.answer("attach_view", attach_reply({ state = "ready", phase = "ready", revision = 3 }))
	w.run_for(500)
	w.edit_fails = true
	w.answer("list_frames", function(args: any): any
		return owner_reply(w, args, 3, FRAMES)
	end)
	w.run_for(2000)
	t.truthy(w.toast_titled("could not be updated"), "the user is told")
	t.truthy(not together(calls, "whiteboard.edit", "toast"), "not in the callback of the failed edit")
	t.eq(crowded(calls), {})
end

tests.the_open_path_takes_a_fixed_number_of_timer_callbacks = function(t)
	local w = world()
	w.tick_no += 1
	local before = w.tick_no
	editor_board.open(w.cx, w.path)
	w.run_for(100)
	-- Every callback is a hop of the window's timer: the marks are the price of a status write that shares no callback
	-- with the work it names. Measured live at about 7 ms a hop when idle (10 callbacks before the marks, 25 with the pane and its one-shot, 19 now that the owner is one process run).
	t.eq(w.tick_no - before, 19)
end

tests.a_click_while_the_owner_holds_its_answer_reads_the_board_and_restyles_it_in_separate_callbacks = function(t)
	local w = world()
	built(w, TWO())
	for _ = 1, 14 do
		w.run_for(600)
		local asked = w.pending("list_frames")
		if asked and asked.args.wait_ms then
			break
		end
		poll(w)
	end
	local held = w.pending("list_frames")
	t.truthy(held and held.args.wait_ms, "the owner holds its answer")
	local calls = w.watch_natives()
	w.selection = { target(w, "t2").id }
	w.run_for(1500)
	t.truthy(w.pending("select_node"), "the click reached the owner")
	t.truthy(#calls > 1, "the board was read and restyled")
	t.truthy(not together(calls, "whiteboard.read", "whiteboard.edit"), "the read and the restyle it leads to are not one callback")
	t.eq(crowded(calls), {})
end

tests.a_question_the_look_already_marked_as_asked_survives_a_bump_of_the_generation_before_it_is_put = function(t)
	local w = world()
	asked(w)
	w.choose(nil)
	t.eq(#w.picks, 1)
	local read = w.cx.whiteboard.read
	local bumped = false
	w.cx.whiteboard.read = function(self: any, pane: number, query: any): any
		local result = read(self, pane, query)
		if not bumped and query and query.ids and #query.ids == 2 and table.find(query.ids, target(w, "t3").id) then
			-- A revision or focus drift moves the generation between the look and its notice.
			bumped = true
			w.tern.timer(0, function()
				local core: any = require("../editor_core")
				local lifecycle: any = require("../editor_lifecycle")
				lifecycle.bump(w.cx, core.sessions[w.launch_id], 0)
			end)
		end
		return result
	end
	select_target(w, "t3")
	w.run_for(1500)
	t.truthy(bumped, "the generation moved after a look")
	w.cx.whiteboard.read = read
	t.truthy(w.pending("attach_view"), "the window starts over")
	rebuilt(w)
	for _ = 1, 6 do
		poll(w)
	end
	t.eq(#w.picks, 2, "the new selection is asked about all the same: the question was marked as asked")
end

tests.more_targets_than_the_board_shows_say_so_in_a_callback_after_the_restyle = function(t)
	local w = world()
	local rows: { any } = {}
	for index = 1, 305 do
		table.insert(rows, element("frame-a/e" .. index, index * 3, 20, 2, 2))
	end
	local calls = w.watch_natives()
	w.rows, w.revision = rows, 3
	-- The panel has an element selected, so the build ends with a restyle of its target.
	w.owner_selected = "frame-a/e1"
	w.start()
	w.answer("attach_view", attach_reply({ state = "ready", phase = "ready", revision = 3 }))
	w.run_for(500)
	w.answer("list_frames", function(args: any): any
		return owner_reply(w, args, 3, FRAMES)
	end)
	w.run_for(500)
	for _ = 1, 10 do
		if w.pending("poll_view") then
			-- The owner's pages hold at most 64 nodes each: the window follows the cursor.
			w.answer("poll_view", function(args: any): any
				local from = (args.cursor or 0) + 1
				local reply = owner_reply(w, args, 3, table.move(rows, from, math.min(from + 63, #rows), 1, {}))
				reply.page.cursor = args.cursor or 0
				reply.page.next_cursor = if from + 63 < #rows then from + 63 else nil
				return reply
			end)
			w.run_for(300)
		end
	end
	w.run_for(3000)
	t.truthy(w.toast_titled("Only the first click targets"), "the user is told")
	t.truthy(not together(calls, "whiteboard.edit", "toast"), "not in the callback of the last edit")
end

tests.a_tick_killed_on_its_one_native_call_is_named_in_the_status_file = function(t)
	local w = world()
	local run = w.tern.process.run
	w.tern.process.run = function(argv: { string }, opts: any, cb: any)
		run(argv, opts, cb)
		if argv[3] == "--launch" then
			-- Tern found the call over budget when it returned: no timer runs after it.
			w.timers_off = true
		end
	end
	editor_board.open(w.cx, w.path)
	w.run_for(300)
	local status = w.tern.json.decode(w.tern.fs.read("/data/editor/projection-status.json"))
	t.eq(status.entering, "owner_run")
end

-- An open that the plugin's timers stopped in the middle of (the timer hook dies right after the tick `name` ran, or right
-- after its mark when `before`): the watch notices, says so, and carries the open on from the await hook.
local OPEN_CUTS = {
	{ "launch_sweep", false }, { "node_start", false }, { "node_checked", false }, { "manifest_dir", false }, { "manifest_write", false },
	{ "remember_path", false }, { "open_toast", false }, { "owner_run", true }, { "owner_run", false }, { "session_start", false },
}

local function cut_open(name: string, before: boolean): any
	local w = world()
	w.cut_at = { name = name, before = before }
	editor_board.open(w.cx, w.path)
	w.run_for(20000)
	return w
end

-- The owners Tern ran: the first is alive and publishes its session; one that ran after it stops, because the document is
-- already open in the first.
local function owners_serve(w: any)
	w.harness = true
	local id = w.tern.json.decode(w.tern.fs.read(w.owner_runs[1].argv[4])).launch_id
	w.tern.fs.mkdir("/data/editor/sessions")
	w.tern.fs.write("/data/editor/sessions/record.json", w.tern.json.encode({
		version = 1, launch_id = id, original_path = w.path, endpoint = "http://127.0.0.1:43123", token = string.rep("t", 43), session_id = "S",
	}))
	local second = w.owner_runs[2]
	if second then
		w.tern.fs.write((second.argv[4]:gsub("%.json$", ".failed")), w.tern.json.encode({ code = "ALREADY_OPEN" }))
	end
	w.harness = false
	if second then
		w.owner_exits(1)
	end
	w.run_for(2000)
end

local function launch_files(w: any): { string }
	local names: { string } = {}
	for _, name in w.tern.fs.list("/data/editor") do
		if name:match("^launch%-.*%.json$") then
			table.insert(names, name)
		end
	end
	return names
end

local function sessions_kept(w: any): number
	local n = 0
	for _ in w.kv.editor_sessions or {} do
		n += 1
	end
	return n
end

for _, cut in OPEN_CUTS do
	local name, before = cut[1] :: string, cut[2] :: boolean
	tests["an_open_cut_" .. (if before then "before_" else "after_") .. name .. "_still_shows_its_board_with_one_owner"] = function(t)
		local w = cut_open(name, before)
		t.truthy(w.timers_off, "the timer hook died at the cut")
		t.truthy(w.toast_titled("stopped"), "the user is told, as before")
		owners_serve(w)
		-- Only a cut after the owner ran can leave a second one, which stops by itself (ALREADY_OPEN).
		t.eq(w.launches, if name == "owner_run" and not before then 2 else 1, "owners that ran")
		t.eq(#w.boards_requested, 1, "one board")
		t.eq(sessions_kept(w), 1, "one session for the file")
		t.eq(errors_told(w), 1, "only the notice about the timers: no failure of the open")
		w.board_pane = 31
		w.panes[w.board_pane] = { cwd = "/work", kind = "canvas" }
		w.boards_requested[1].awaiting:resolve(w.board_pane)
		w.run_for(500)
		w.answer("attach_view", attach_reply({ state = "ready", phase = "ready", revision = 3 }))
		w.run_for(500)
		t.truthy(w.pending("list_frames"), "the board is built from the owner")
		t.truthy(w.tern.fs.exists(w.owner_runs[1].argv[4]), "the launch file of the owner that ran is still there")
		editor_board.open(w.cx, w.path)
		w.run_for(200)
		t.truthy(w.toast_titled("already has a board"), "opening it again shows the board: the open is no longer pending")
		t.eq(w.launches, if name == "owner_run" and not before then 2 else 1, "and starts nothing")
	end
end

-- The board's own request is the one thing the owner's run leaves in flight on the await hook, and its answer is carried on by
-- a timer tick: the timers die when the request is made (a slow `whiteboard:open` is the likely kill), and the answer comes
-- either before the watch notices (that tick is lost with the dead hook) or after it.
for _, answered_first in { true, false } do
	tests["an_open_cut_when_the_board_is_asked_still_shows_its_board_when_the_answer_comes_" .. (if answered_first then "before" else "after") .. "_the_watch_notices"] = function(t)
		local w = world()
		local calls = w.watch_natives()
		local open = w.cx.whiteboard.open
		w.cx.whiteboard.open = function(self: any, opts: any): any
			local asked = open(self, opts)
			w.timers_off = true
			return asked
		end
		editor_board.open(w.cx, w.path)
		w.run_for(300)
		t.eq(#w.boards_requested, 1, "the board was asked for")
		w.board_pane = 31
		w.panes[w.board_pane] = { cwd = "/work", kind = "canvas" }
		if answered_first then
			w.boards_requested[1].awaiting:resolve(w.board_pane)
		end
		w.run_for(20000)
		if not answered_first then
			w.boards_requested[1].awaiting:resolve(w.board_pane)
		end
		owners_serve(w)
		t.truthy(w.toast_titled("stopped"), "the user is told, as before")
		t.eq(w.launches, 1, "one owner")
		t.eq(#w.boards_requested, 1, "one board")
		t.eq(sessions_kept(w), 1, "one session for the file")
		t.eq(errors_told(w), 1, "only the notice about the timers")
		t.truthy(#calls > 6, "the calls were seen")
		t.eq(crowded(calls), {}, "no timer callback made more than one slow native call")
		w.answer("attach_view", attach_reply({ state = "ready", phase = "ready", revision = 3 }))
		w.run_for(500)
		t.truthy(w.pending("list_frames"), "the board is installed and built from the owner")
	end
end

tests.the_same_file_asked_with_another_case_or_slashes_shows_the_board_it_has = function(t)
	local w = world()
	w.path = "C:/Work/Design.pen"
	w.harness = true
	w.tern.fs.mkdir("C:/Work")
	w.tern.fs.write(w.path, "x")
	w.harness = false
	w.start()
	editor_board.open(w.cx, "c:\\work\\DESIGN.pen")
	w.run_for(300)
	t.truthy(w.toast_titled("already has a board"), "the board it has is shown")
	t.eq(w.launches, 1, "no second owner")
end

-- The worst cut with a slow first owner: it holds the file's lock from its start but publishes its session only once its
-- engine is up, which can be long after the second owner (the restarted open's) has stopped with ALREADY_OPEN.
tests.a_restarted_open_whose_second_owner_stops_keeps_looking_for_a_first_owner_that_is_slow_to_publish = function(t)
	local w = cut_open("owner_run", false)
	t.eq(w.launches, 2, "the restarted open ran a second owner")
	w.board_pane = 31
	w.panes[w.board_pane] = { cwd = "/work", kind = "canvas" }
	w.boards_requested[1].awaiting:resolve(w.board_pane)
	w.run_for(500)
	w.harness = true
	local first = w.tern.json.decode(w.tern.fs.read(w.owner_runs[1].argv[4])).launch_id
	w.tern.fs.write((w.owner_runs[2].argv[4]:gsub("%.json$", ".failed")), w.tern.json.encode({ code = "ALREADY_OPEN" }))
	w.harness = false
	w.owner_exits(1)
	w.run_for(30000)
	local projection: any = require("../lib/editor_projection")
	t.eq(w.toast_titled((projection.start_failure("ALREADY_OPEN", 1))), nil, "the first owner is still starting: no failure yet")
	w.harness = true
	w.tern.fs.mkdir("/data/editor/sessions")
	w.tern.fs.write("/data/editor/sessions/record.json", w.tern.json.encode({
		version = 1, launch_id = first, original_path = w.path, endpoint = "http://127.0.0.1:43123", token = string.rep("t", 43), session_id = "S",
	}))
	w.harness = false
	w.run_for(2000)
	t.truthy(w.pending("attach_view"), "the session follows the first owner once it publishes")
	t.eq(w.toast_titled((projection.start_failure("ALREADY_OPEN", 1))), nil, "and the file was never reported open elsewhere")
end

tests.an_open_whose_tick_raised_is_not_pending_and_a_new_ask_starts_it_again = function(t)
	local w = world()
	local toast = w.cx.toast
	local broken = true
	w.cx.toast = function(self: any, level: string, title: string, sub: string?)
		if broken and title == "Opening the editor" then
			error("the toast failed")
		end
		toast(self, level, title, sub)
	end
	editor_board.open(w.cx, w.path)
	pcall(w.run_for, 300)
	broken = false
	editor_board.open(w.cx, w.path)
	w.run_for(300)
	t.eq(w.toast_titled("already opening"), nil, "an open that raised is over")
	t.eq(w.launches, 1, "and the next ask opened the editor")
end

tests.a_restarted_open_still_says_the_file_is_open_when_no_owner_ever_publishes = function(t)
	local w = cut_open("owner_run", false)
	w.board_pane = 31
	w.panes[w.board_pane] = { cwd = "/work", kind = "canvas" }
	w.boards_requested[1].awaiting:resolve(w.board_pane)
	w.run_for(500)
	w.harness = true
	w.tern.fs.write((w.owner_runs[2].argv[4]:gsub("%.json$", ".failed")), w.tern.json.encode({ code = "ALREADY_OPEN" }))
	w.harness = false
	w.owner_exits(1)
	w.run_for(130000)
	local projection: any = require("../lib/editor_projection")
	t.truthy(w.toast_titled((projection.start_failure("ALREADY_OPEN", 1))), "told, as before, once the wait is over")
end

tests.an_open_asked_again_while_it_is_pending_does_not_start_a_second_one = function(t)
	local w = world()
	editor_board.open(w.cx, w.path)
	editor_board.open(w.cx, w.path)
	w.run_for(300)
	t.truthy(w.toast_titled("already opening"))
	t.eq(w.launches, 1)
	local w2 = world()
	w2.cut_at = { name = "node_start", before = false }
	editor_board.open(w2.cx, w2.path)
	w2.run_for(300)
	t.truthy(w2.timers_off)
	editor_board.open(w2.cx, w2.path)
	w2.run_for(20000)
	t.truthy(w2.toast_titled("already opening"), "also while its timers are dead")
	t.eq(w2.launches, 1, "one owner for the two asks")
	t.eq(#launch_files(w2), 1)
end

tests.a_failing_open_cut_by_the_timers_still_shows_its_error_and_is_no_longer_pending = function(t)
	local w = world()
	local run = w.tern.process.run
	w.tern.process.run = function(argv: { string }, opts: any, cb: any)
		if argv[2] == "--version" then
			w.arrive(function(fresh: any)
				cb({ status = 1, stdout = "", stderr = "", timed_out = false }, fresh)
			end)
		else
			run(argv, opts, cb)
		end
	end
	w.cut_at = { name = "launch_sweep", before = false }
	editor_board.open(w.cx, w.path)
	w.run_for(20000)
	t.truthy(w.toast_titled("needs Node"), "the open's own error")
	t.eq(w.launches, 0)
	t.eq(w.kv.editor_sessions, nil)
	editor_board.open(w.cx, w.path)
	w.run_for(2000)
	t.eq(w.toast_titled("already opening"), nil, "a failed open is not pending")
	local told = 0
	for _, toast in w.toasts do
		told += if toast.title:find("needs Node") then 1 else 0
	end
	t.eq(told, 2, "and asking again tries again")
end

tests.the_answer_of_a_run_the_open_was_taken_over_from_starts_nothing = function(t)
	local w = world()
	w.hold_versions = 1
	w.cut_at = { name = "node_start", before = false }
	editor_board.open(w.cx, w.path)
	w.run_for(20000)
	t.eq(#w.held_versions, 1, "the node check of the interrupted run is still out")
	t.eq(w.launches, 1, "the resumed run went on")
	w.held_versions[1]({ status = 0, stdout = "v22.1.0\n", stderr = "", timed_out = false }, w.cx)
	w.run_for(5000)
	t.eq(w.launches, 1, "the late answer started no second owner")
	t.eq(#launch_files(w), 1, "nor wrote a second launch file")
end

tests.a_resumed_open_sweeps_stale_launch_files_and_keeps_fresh_ones = function(t)
	local w = world()
	local stale = "launch-1-" .. string.rep("a", 32) .. ".json"
	local fresh = "launch-" .. tostring(os.time()) .. "-" .. string.rep("b", 32) .. ".json"
	w.tern.fs.mkdir("/data/editor")
	w.tern.fs.write("/data/editor/" .. stale, "{}")
	w.tern.fs.write("/data/editor/" .. fresh, "{}")
	w.cut_at = { name = "launch_sweep", before = true }
	editor_board.open(w.cx, w.path)
	w.run_for(20000)
	t.eq(w.launches, 1)
	t.eq(w.tern.fs.exists("/data/editor/" .. stale), false, "a leftover nobody uses is swept, as it is without a cut")
	t.truthy(w.tern.fs.exists("/data/editor/" .. fresh), "a launch file that is still in use is kept")
end

tests.a_resumed_open_makes_at_most_one_slow_native_call_in_each_timer_callback = function(t)
	for _, cut in OPEN_CUTS do
		local w = world()
		local calls = w.watch_natives()
		w.cut_at = { name = cut[1], before = cut[2] }
		editor_board.open(w.cx, w.path)
		w.run_for(20000)
		t.truthy(w.timers_off, "the timers died")
		t.truthy(#calls > 6, "the calls were seen")
		t.eq(crowded(calls), {}, "cut at " .. cut[1])
	end
end

-- Going in and out of containers. At rest the targets are the frame's direct children, so a click picks the outer element;
-- a double click (the board's label editor opening) on a container goes in, and Esc or a click outside comes back out.
-- "frame-a/hero" is a container with a text and a card in it, "frame-a/side" an element with nothing in it.
local function frame_row(): any
	return {
		path = "frame-a", type = "frame", layout = "none", frame_id = "frame-a",
		geometry = { x = 0, y = 0, width = 800, height = 600, visible = true, captures = true, ambiguous = false, opacity = 1 },
	}
end

local function nested_rows(): { any }
	return {
		frame_row(),
		element("frame-a/hero", 10, 20, 400, 300, { type = "frame" }),
		element("frame-a/hero/title", 20, 30, 100, 40, { type = "text", text = "Title", font_size = 16, parent_path = "frame-a/hero" }),
		element("frame-a/hero/card", 20, 100, 200, 100, { type = "frame", parent_path = "frame-a/hero" }),
		element("frame-a/hero/card/icon", 30, 110, 10, 10, { parent_path = "frame-a/hero/card" }),
		element("frame-a/side", 500, 20, 100, 100),
	}
end

-- The element the user would hit at a point: the target on top there (what a click on the board lands on).
local function path_at(w: any, x: number, y: number): string?
	local sess = Core.sessions[w.launch_id]
	local found: string? = nil
	for _, shape in w.shapes do
		if shape.type == "rect" and x >= shape.x and x <= shape.x + shape.w and y >= shape.y and y <= shape.y + shape.h then
			if sess.targets.by_id[shape.id] then
				found = sess.targets.by_id[shape.id]
			elseif shape.id == sess.targets.up then
				found = "<outside>"
			end
		end
	end
	return found
end

local function target_paths(w: any): { string }
	local sess = Core.sessions[w.launch_id]
	local paths: { string } = {}
	for _, shape in w.shapes do
		if sess.targets.by_id[shape.id] then
			table.insert(paths, sess.targets.by_id[shape.id])
		end
	end
	table.sort(paths)
	return paths
end

local function by_path_id(w: any, path: string): any
	local sess = Core.sessions[w.launch_id]
	return shape_of(w, sess.targets.by_path[path])
end

-- The user selects the hero, the click reaches the owner, and a double click opens the board's editor on it.
local function hero_entered(w: any)
	built(w, nested_rows())
	w.selection = { by_path_id(w, "frame-a/hero").id }
	poll(w)
	w.editor_open = true
	poll(w)
	w.editor_open = false
	rebuilt(w)
end

tests.at_rest_the_targets_are_the_direct_children_of_the_frame_and_the_design_shows_through = function(t)
	local w = world()
	built(w, nested_rows())
	t.eq(target_paths(w), { "frame-a/hero", "frame-a/side" })
	for _, shape in w.shapes do
		if shape.type == "rect" then
			t.truthy(shape.opacity <= 0.02, "a target is there to be clicked, not seen")
		end
	end
end

tests.a_click_in_the_middle_of_a_block_picks_the_block_and_not_what_is_inside_it = function(t)
	local w = world()
	built(w, nested_rows())
	t.eq(path_at(w, 30, 40), "frame-a/hero", "where the title is")
	t.eq(path_at(w, 35, 115), "frame-a/hero", "where the card is")
	t.eq(path_at(w, 510, 30), "frame-a/side")
end

tests.a_double_click_on_a_container_goes_in_and_its_children_are_the_targets = function(t)
	local w = world()
	hero_entered(w)
	t.eq(target_paths(w), { "frame-a/hero", "frame-a/hero/card", "frame-a/hero/title" }, "the container itself and its children, and nothing inside them")
	t.eq(path_at(w, 30, 40), "frame-a/hero/title", "the title can be picked now")
	t.eq(path_at(w, 35, 115), "frame-a/hero/card")
	t.eq(path_at(w, 300, 250), "frame-a/hero", "a gap inside the container is the container, not a way out")
	t.eq(path_at(w, 600, 400), "<outside>", "and outside it is the way out")
	t.eq(path_at(w, 510, 30), "<outside>", "the elements next to the container are not targets while the user is in it")
end

tests.the_level_is_told_on_the_activity_line = function(t)
	local w = world()
	hero_entered(w)
	local found = false
	for _, shape in w.shapes do
		if shape.type == "text" and shape.text and shape.text:find("inside a container", 1, true) then
			found = true
			t.truthy(not shape.text:find("frame-a/", 1, true), "and not by an internal path")
		end
	end
	t.truthy(found, "the user can see where they are")
end

tests.a_selected_container_without_the_editor_open_stays_where_it_is = function(t)
	local w = world()
	built(w, nested_rows())
	w.selection = { by_path_id(w, "frame-a/hero").id }
	for _ = 1, 6 do
		poll(w)
	end
	t.eq(w.pending("attach_view"), nil, "a single click never goes in")
	t.eq(target_paths(w), { "frame-a/hero", "frame-a/side" })
end

tests.an_editor_opened_on_an_element_with_nothing_inside_goes_nowhere = function(t)
	local w = world()
	built(w, nested_rows())
	w.selection = { by_path_id(w, "frame-a/side").id }
	poll(w)
	w.editor_open = true
	poll(w)
	poll(w)
	t.eq(w.pending("attach_view"), nil)
	t.eq(target_paths(w), { "frame-a/hero", "frame-a/side" })
end

tests.a_double_click_on_a_text_still_edits_the_text_and_goes_nowhere = function(t)
	local w = world()
	hero_entered(w)
	w.selection = { by_path_id(w, "frame-a/hero/title").id }
	poll(w)
	w.editor_open = true
	poll(w)
	poll(w)
	t.eq(w.pending("attach_view"), nil)
	t.eq(by_path_id(w, "frame-a/hero/title").text, "Title", "the editor opens with the text the node has")
end

tests.escape_in_a_container_goes_one_level_out = function(t)
	local w = world()
	hero_entered(w)
	w.selection = { by_path_id(w, "frame-a/hero/card").id }
	poll(w)
	poll(w)
	t.eq(w.pending("attach_view"), nil, "selecting inside stays inside")
	w.selection = {}
	poll(w)
	rebuilt(w)
	t.eq(target_paths(w), { "frame-a/hero", "frame-a/side" })
end

tests.a_click_outside_the_container_goes_one_level_out = function(t)
	local w = world()
	hero_entered(w)
	w.selection = { Core.sessions[w.launch_id].targets.up }
	poll(w)
	rebuilt(w)
	t.eq(target_paths(w), { "frame-a/hero", "frame-a/side" })
	t.eq(path_at(w, 510, 30), "frame-a/side")
end

tests.going_in_twice_and_out_once_lands_in_the_first_container = function(t)
	local w = world()
	hero_entered(w)
	w.selection = { by_path_id(w, "frame-a/hero/card").id }
	poll(w)
	w.editor_open = true
	poll(w)
	w.editor_open = false
	rebuilt(w)
	t.eq(target_paths(w), { "frame-a/hero/card", "frame-a/hero/card/icon" }, "the card and what is in it")
	t.eq(path_at(w, 300, 250), "<outside>", "the hero is the way out now")
	w.selection = { Core.sessions[w.launch_id].targets.up }
	poll(w)
	rebuilt(w)
	t.eq(target_paths(w), { "frame-a/hero", "frame-a/hero/card", "frame-a/hero/title" })
end

tests.the_level_survives_a_new_revision_of_the_document = function(t)
	local w = world()
	hero_entered(w)
	w.revision = 4
	w.run_for(600)
	w.answer("list_frames", function(args: any): any
		return owner_reply(w, args, 4, w.frames or FRAMES)
	end)
	w.run_for(600)
	rebuilt(w)
	t.eq(target_paths(w), { "frame-a/hero", "frame-a/hero/card", "frame-a/hero/title" }, "still inside")
end

tests.a_level_the_document_no_longer_has_is_left_for_the_frame = function(t)
	local w = world()
	hero_entered(w)
	w.revision = 4
	w.rows = { frame_row(), element("frame-a/side", 500, 20, 100, 100) }
	w.run_for(600)
	w.answer("list_frames", function(args: any): any
		return owner_reply(w, args, 4, w.frames or FRAMES)
	end)
	w.run_for(600)
	rebuilt(w)
	t.eq(target_paths(w), { "frame-a/side" })
end

-- Nothing the user selects, deselects or has selected through the panel ever restyles a target: the board's own selection
-- box marks the selection, and no target is left looking selected when it is not.
local function all_plain(t: T, w: any, message: string)
	for _, shape in w.shapes do
		if shape.type == "rect" then
			t.eq(shape.fill, projection.TARGET_COLOR, message)
			t.truthy(shape.opacity <= 0.02, message)
		end
	end
end

tests.selecting_deselecting_and_a_rebuild_never_make_a_target_look_selected = function(t)
	local w = world()
	w.owner_selected = "frame-a/hero"
	built(w, nested_rows())
	all_plain(t, w, "what the panel has selected when the board is drawn")
	local hero = by_path_id(w, "frame-a/hero")
	w.selection = { hero.id }
	poll(w)
	poll(w)
	all_plain(t, w, "selected on the board")
	w.selection = {}
	poll(w)
	poll(w)
	all_plain(t, w, "deselected")
	w.run_for(600)
	w.revision = 4
	w.answer("list_frames", function(args: any): any
		return owner_reply(w, args, 4, w.frames or FRAMES)
	end)
	w.run_for(600)
	rebuilt(w)
	all_plain(t, w, "after another revision")
end

tests.several_elements_selected_leave_every_target_plain = function(t)
	local w = world()
	built(w, nested_rows())
	w.selection = { by_path_id(w, "frame-a/hero").id, by_path_id(w, "frame-a/side").id }
	poll(w)
	poll(w)
	all_plain(t, w, "")
end

tests.going_in_and_out_makes_at_most_one_slow_native_call_in_each_timer_callback = function(t)
	local w = world()
	built(w, nested_rows())
	local calls = w.watch_natives()
	w.selection = { by_path_id(w, "frame-a/hero").id }
	poll(w)
	w.editor_open = true
	poll(w)
	w.editor_open = false
	rebuilt(w)
	w.selection = { by_path_id(w, "frame-a/hero/title").id }
	poll(w)
	poll(w)
	w.selection = {}
	poll(w)
	rebuilt(w)
	t.truthy(#calls > 6, "the flow made calls")
	t.eq(crowded(calls, true), {})
end

-- The window's load chain (lib/editor_load, what window.luau runs before the editor opens) with the timer hook cut in the
-- middle of the load named `kill` (the tick is killed: it raises as Tern's budget trip does, and the timer hook is dead
-- from then on). The loads stand in for the editor's modules, which are already loaded here.
local LOAD_NAMES = { "load_a", "load_b", "load_c", "load_d", "load_e", "load_f", "load_g", "load_h" }

local function chain_loaders(w: any, kill: string?): ({ { name: string, load: () -> () } }, { [string]: number })
	local runs: { [string]: number } = {}
	local loaders: { { name: string, load: () -> () } } = {}
	for _, name in LOAD_NAMES do
		table.insert(loaders, {
			name = name,
			load = function()
				runs[name] = (runs[name] or 0) + 1
				if name == kill and runs[name] == 1 and w.hook == "timer" then
					error("tern: timer exceeded 50 ms", 0)
				end
			end,
		})
	end
	return loaders, runs
end

local Load: any = (require :: any)("../lib/editor_load")

local function toasts_titled(w: any, pattern: string): number
	local n = 0
	for _, toast in w.toasts do
		n += if toast.title:find(pattern) then 1 else 0
	end
	return n
end

local CHAIN_TRIGGERS = {
	-- The route of a `.pen` open.
	route = function(w: any)
		Load.load(w.cx, (chain_loaders(w, w.kill)), function(c: any, loads: any)
			editor_board.open(c, w.path, loads)
		end)
	end,
	-- The command that asks for the path.
	palette = function(w: any)
		local answer: ((text: string?, err: string?, fresh: any) -> ())? = nil
		w.cx.prompt = function(): any
			return {
				next = function(_self: any, fn: any)
					answer = fn
				end,
			}
		end
		Load.load(w.cx, (chain_loaders(w, w.kill)), function(c: any, loads: any)
			editor_board.run(c, loads)
		end)
		w.run_for(1000)
		if answer == nil then
			error("the prompt never came up")
		end
		(answer :: any)(w.path, nil, w.cx)
	end,
}

for trigger_name, trigger in CHAIN_TRIGGERS do
	for _, kill in LOAD_NAMES do
		tests["a_timer_cut_in_" .. kill .. "_of_the_load_chain_still_opens_the_board_from_the_" .. trigger_name] = function(t)
			local w = world()
			w.kill = kill
			trigger(w)
			-- Well inside the time the plugin's own watch needs to notice dead timers: the chain itself carries it on.
			w.run_for(1000)
			t.truthy(w.timers_off, "the timer hook was cut")
			owners_serve(w)
			t.eq(w.launches, 1, "one owner")
			t.eq(#w.boards_requested, 1, "one board, with no reload of the plugins")
			t.eq(sessions_kept(w), 1, "one session")
			t.eq(toasts_titled(w, "timers stopped"), 1, "the notice about the timers, once")
			t.eq(toasts_titled(w, "interrupted"), 1, "and one that the load was interrupted and retried")
			t.eq(toasts_titled(w, "could not be opened"), 0)
			t.eq(errors_told(w), 1, "nothing else went wrong")
		end
	end
	tests["a_load_chain_that_is_not_cut_opens_the_board_from_the_" .. trigger_name .. "_and_tells_nothing"] = function(t)
		local w = world()
		trigger(w)
		w.run_for(1000)
		owners_serve(w)
		t.eq(#w.boards_requested, 1)
		t.eq(sessions_kept(w), 1)
		t.eq(#w.toasts, 1, "only the opening toast")
		t.eq(errors_told(w), 0)
	end
end

-- "Open Pencil board (live mirror)": its poll and update run on the timer hook, which is gone, so the mirror cannot
-- follow the file: the chain still finishes (the prompt and the board come up) and the user is told, once, to reload.
tests.a_timer_cut_in_the_load_chain_of_the_board_command_tells_the_user_once_that_the_mirror_cannot_update = function(t)
	for _, kill in LOAD_NAMES do
		local w = world()
		local opened = 0
		Load.loadMirror(w.cx, (chain_loaders(w, kill)), function(_c: any, _loads: any)
			opened += 1
		end)
		w.run_for(3000)
		t.truthy(w.timers_off, "the timer hook was cut in " .. kill)
		t.eq(opened, 1, "the prompt still comes up after a cut in " .. kill)
		t.eq(toasts_titled(w, "live mirror"), 1, "and the user is told once to reload, after a cut in " .. kill)
	end
end

tests.a_board_command_load_chain_that_is_not_cut_tells_nothing = function(t)
	local w = world()
	local opened = 0
	Load.loadMirror(w.cx, (chain_loaders(w, nil)), function(_c: any, _loads: any)
		opened += 1
	end)
	w.run_for(3000)
	t.eq(opened, 1)
	t.eq(#w.toasts, 0)
end

-- Every later open in the VM of a cut plugin starts from a timer hook that is known to be gone: its steps must not each
-- wait a resume interval for a timer that never fires.
tests.an_open_after_a_cut_load_chain_does_not_wait_for_timers_that_are_gone = function(t)
	local w = world()
	w.kill = "load_c"
	CHAIN_TRIGGERS.route(w)
	w.run_for(3000)
	t.truthy(w.timers_off, "the timer hook was cut")
	local opened = 0
	Load.load(w.cx, (chain_loaders(w, nil)), function(_c: any, _loads: any)
		opened += 1
	end)
	-- The require of the chain module itself waits one resume interval for the dead timer hook (250 ms); without the carry
	-- the first load step waits another before the await hook takes the rest.
	w.run_for(400)
	t.eq(opened, 1, "the second open finished before two resume intervals")
	t.eq(toasts_titled(w, "timers stopped"), 1, "and the notice is still told once")
end

-- The timer hook dies in the first tick of a load chain, the one that requires the chain module itself (the budget trip is
-- raised at the second clock read of that tick, just before the require).
local function kill_in_chain_require(w: any)
	local calls = 0
	w.tern.now = function(): number
		if w.hook == "timer" then
			calls += 1
			if calls == 2 then
				error("tern: timer exceeded 50 ms", 0)
			end
		end
		return w.now
	end
end

tests.a_timer_cut_in_the_require_of_the_chain_still_opens_the_board_and_tells_the_user_once = function(t)
	local w = world()
	kill_in_chain_require(w)
	CHAIN_TRIGGERS.route(w)
	w.run_for(1000)
	t.truthy(w.timers_off, "the timer hook was cut")
	owners_serve(w)
	t.eq(w.launches, 1, "one owner")
	t.eq(#w.boards_requested, 1, "one board")
	t.eq(toasts_titled(w, "timers stopped"), 1, "the notice about the timers, once")
end

tests.a_timer_cut_in_the_require_of_the_chain_tells_the_mirror_user_once = function(t)
	local w = world()
	kill_in_chain_require(w)
	local opened = 0
	Load.loadMirror(w.cx, (chain_loaders(w, nil)), function(_c: any, _loads: any)
		opened += 1
	end)
	w.run_for(3000)
	t.truthy(w.timers_off, "the timer hook was cut")
	t.eq(opened, 1, "the prompt still comes up")
	t.eq(toasts_titled(w, "live mirror"), 1, "and the user is told once")
end

tests.a_mirror_opened_after_the_timers_are_known_dead_tells_the_user_once = function(t)
	local w = world()
	w.kill = "load_c"
	CHAIN_TRIGGERS.route(w)
	w.run_for(3000)
	t.truthy(w.timers_off, "the timer hook was cut by the first open")
	t.eq(toasts_titled(w, "live mirror"), 0)
	local opened = 0
	Load.loadMirror(w.cx, (chain_loaders(w, nil)), function(_c: any, _loads: any)
		opened += 1
	end)
	w.run_for(3000)
	t.eq(opened, 1, "the prompt comes up")
	t.eq(toasts_titled(w, "live mirror"), 1, "and the user is told once")
end

tests.a_load_chain_cut_by_the_timers_makes_at_most_one_slow_native_call_in_each_timer_callback = function(t)
	for _, kill in LOAD_NAMES do
		local w = world()
		w.kill = kill
		local calls = w.watch_natives()
		CHAIN_TRIGGERS.route(w)
		w.run_for(6000)
		t.truthy(w.timers_off, "the timers died")
		t.truthy(#calls > 6, "the calls were seen")
		t.eq(crowded(calls), {}, "cut in " .. kill)
	end
end

tests.the_notice_about_the_timers_is_told_once_when_a_second_open_follows_a_cut_load_chain = function(t)
	local w = world()
	w.kill = "load_c"
	CHAIN_TRIGGERS.route(w)
	w.run_for(20000)
	CHAIN_TRIGGERS.route(w)
	w.run_for(20000)
	t.eq(toasts_titled(w, "timers stopped"), 1)
end

return tests
