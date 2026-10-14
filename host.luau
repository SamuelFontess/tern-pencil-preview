--!strict
-- The `preview` block: a `.pen` file rendered by the headless `pen interactive` CLI. One batch per file
-- version exports every top-level frame into the render cache (lib/store.luau); switching frames and
-- reopening read the cache. The path is the block's first launch argument ("Open with › Pencil Preview" or
-- the window's route).
local cache = require("./lib/cache")
local doc = require("./lib/doc")
local launch = require("./lib/launch")
local script = require("./lib/script")
local store = require("./lib/store")
local util = require("./lib/util")
local view = require("./lib/view")

type State = view.State
type Item = script.Item

local EVERY_MS = 2000
local MAX_PEN = 16 * 1024 * 1024
-- Larger files skip the host-side read of top-level frames, whose time counts against the 2 s budget.
local MAX_DECODE = 8 * 1024 * 1024
local MAX_SIDE = 4096
local BATCH_TIMEOUT_MS = 120000
local RENDER_TIMEOUT_MS = 60000
local OPEN_TIMEOUT_MS = 10000
local TAIL = 400
-- Rounds of exporting again frames that came out over MAX_SIDE.
local MAX_SHRINKS = 3
local KEEP_VERSIONS = 2
local MAX_CACHE_BYTES = 200 * 1024 * 1024

-- Batches running, by `<file dir>/<version>`: another block on the same version waits for it.
local inflight: { [string]: boolean } = {}

-- Reserve renders running, by `<cache dir>/<frame id>`: a second block does not start the same one.
local reserving: { [string]: boolean } = {}

-- Process callbacks re-check after a forced render; defined last.
local check: (state: State) -> boolean

-- Drops the export folder of the layout before the render cache.
pcall(function()
	local old = tern.plugin.data .. "/exports"
	if tern.fs.exists(old) then
		tern.fs.remove(old)
	end
end)

local function livePanes(): { [number]: boolean }
	local live: { [number]: boolean } = {}
	for _, p in tern.pane.list() do
		live[p.pane] = true
	end
	return live
end

-- Whether pane `pane` still runs; a block that ended is gone from the list.
local function running(pane: number): boolean
	return livePanes()[pane] == true
end

-- Records an error: a problem card when no image is shown, else a notice in the dock over the image (with a
-- toast when the notice first appears).
local function report(state: State, kind: string, title: string, text: string, detail: string?)
	local problem: view.Problem = { kind = kind, title = title, text = text, detail = detail }
	if state.blob then
		if state.notice == nil then
			-- ToastLevel has no "warning"; the notice reports a failure.
			state.cx:toast("error", problem.title, problem.detail or problem.text)
		end
		state.notice = problem
	else
		state.problem = problem
	end
end

-- Ends background work for a block whose pane is gone. A running batch still finishes the cache; otherwise
-- the block's unfinished cache folders go too.
local function stop(state: State)
	state.stopped = true
	local scratch, fileDir = state.scratch, state.file_dir
	if scratch then
		pcall(tern.fs.remove, scratch)
	end
	if fileDir and not state.busy then
		pcall(function()
			local own: { cache.Entry } = {}
			for _, e in store.list(fileDir) do
				if not e.complete and e.pane == state.cx.pane then
					table.insert(own, e)
				end
			end
			store.remove(own)
		end)
	end
end

-- After a failure, the same content is not tried again until it changes (or `r`).
local function settle(state: State, content: string)
	state.disk, state.pending = content, nil
end

local function failRender(state: State, content: string, why: string, r: ProcessResult)
	local out = util.tail(r.stdout .. "\n" .. r.stderr, TAIL)
	local text = why .. ". If the pen CLI is not signed in, run pen login once."
	report(state, "render", "Could not render " .. state.name, text, if out ~= "" then out else nil)
	settle(state, content)
end

local function noCli(state: State, content: string)
	report(
		state,
		"nocli",
		"pen CLI not found",
		"Install it with `npm i -g @pen.dev/cli`, or point `TERN_PENCIL_CLI` at `pen`, `pen.cmd`, `pen.exe` or its `index.mjs`."
	)
	settle(state, content)
end

local function penArgv(base: { string }, path: string, scratch: string): { string }
	local argv = table.clone(base)
	for _, a in { "interactive", "-i", path, "-o", scratch } do
		table.insert(argv, a)
	end
	return argv
end

local function summaryOf(r: ProcessResult): (string?, doc.Summary?, string?)
	local line = doc.find_summary(r.stdout)
	if line == nil then
		return nil, nil, "pen printed no summary"
	end
	local summary, why = doc.parse(line)
	return line, summary, why
end

-- Shows the chosen frame from `state.dir`, creating its blob once. False when that folder has no image of it.
local function show(state: State): boolean
	local id, dir = state.frame_id, state.dir
	if id == nil or dir == nil or not util.safe_id(id) then
		return false
	end
	local blob = state.blobs[id]
	if blob == nil then
		-- A reserve render of this frame may still be writing the file.
		if reserving[dir .. "/" .. id] then
			return false
		end
		local bytes, mime = store.image(dir, id)
		if bytes == nil or mime == nil then
			return false
		end
		local created = state.cx:blob(bytes, mime)
		state.blobs[id] = created
		blob = created
	end
	state.blob, state.shown = blob, id
	return true
end

-- Makes `summary` of `version` what the block shows, with images from `dir`. A complete folder that lacks the
-- image of a frame falls back to the reserve path for it.
local function adopt(state: State, content: string, version: string, dir: string, summary: doc.Summary, fallback: boolean)
	if dir ~= state.dir then
		state.blobs, state.shown = {}, nil
	end
	if not fallback then
		for _, f in summary.frames do
			if util.safe_id(f.id) and not store.has_image(dir, f.id) then
				fallback = true
				break
			end
		end
	end
	state.frames, state.disk, state.pending = summary.frames, content, nil
	state.version, state.dir, state.fallback = version, dir, fallback
	state.updated_at = os.date("%H:%M:%S")
	if util.frame(state.frames, state.frame_id) == nil then
		state.frame_id = if #state.frames > 0 then state.frames[1].id else nil
	end
	if state.frame_id == nil then
		state.blob, state.shown, state.layer, state.notice = nil, nil, nil, nil
		state.problem = {
			kind = "noframes",
			title = "No top-level frames",
			text = state.name .. " has no top-level frame to preview.",
		}
		return
	end
	state.problem, state.notice = nil, nil
	show(state)
	if not util.has_layer(util.frame(state.frames, state.frame_id), state.layer) then
		state.layer = nil
	end
end

-- Checks the images exported into `dir`: the bytes of those that fit, the items to export again at a lower
-- scale (their oversize files removed, their caps recorded), and whether any image is missing, unreadable or
-- too large with no lower scale left.
local function verify(state: State, dir: string, items: { Item }): (number, { Item }, boolean)
	local bytes, again, missing = 0, {} :: { Item }, false
	for _, item in items do
		local image = store.image(dir, item.id)
		local w: number?, h: number? = nil, nil
		if image then
			w, h = util.image_size(image)
		end
		if image == nil or w == nil or h == nil then
			missing = true
			continue
		end
		local side = math.max(w, h)
		if side <= MAX_SIDE then
			bytes += #image
			continue
		end
		pcall(tern.fs.remove, dir .. "/" .. item.id .. "." .. item.format)
		local cap = util.shrink(item.scale, side, MAX_SIDE)
		if cap then
			state.caps[item.id] = cap
			table.insert(again, { id = item.id, scale = cap, format = item.format })
		else
			missing = true
		end
	end
	return bytes, again, missing
end

-- Marks `dir` complete, shows it when the block still runs and trims the cache. Ends the batch's inflight mark.
local function complete(state: State, content: string, version: string, dir: string, line: string, summary: doc.Summary, bytes: number)
	inflight[(state.file_dir :: string) .. "/" .. version] = nil
	local alive = running(state.cx.pane)
	local ok, err = pcall(function()
		store.finish(dir, line, bytes)
	end)
	if not ok then
		if alive then
			adopt(state, content, version, dir, summary, true)
			report(state, "render", "Could not write the render cache", tostring(err))
		end
		return
	end
	if alive then
		adopt(state, content, version, dir, summary, false)
	end
	local protect = { [util.key(state.path :: string) .. "/" .. cache.attempt(version, state.cx.pane)] = true }
	pcall(function()
		store.remove(cache.prune(store.list_all(), livePanes(), protect, KEEP_VERSIONS, MAX_CACHE_BYTES))
	end)
end

-- Exports `items` again at their lower scales, up to MAX_SHRINKS rounds; frames still too large keep no image.
local function shrinkBatch(
	state: State,
	content: string,
	version: string,
	dir: string,
	line: string,
	summary: doc.Summary,
	bytes: number,
	items: { Item },
	round: number
)
	local cli = launch.pen_cli()
	if round > MAX_SHRINKS or cli == nil then
		complete(state, content, version, dir, line, summary, bytes)
		return
	end
	local cx = state.cx
	local argv = penArgv(cli.argv, state.path :: string, state.scratch :: string)
	state.busy = true
	-- Another block on this version keeps waiting until `complete`.
	inflight[(state.file_dir :: string) .. "/" .. version] = true
	local started = pcall(function()
		tern.process.run(argv, {
			stdin = script.session({ script.exports(items, dir) }),
			timeout_ms = RENDER_TIMEOUT_MS,
		}, function(r: ProcessResult, _: WindowCx?)
			state.busy = false
			local alive = running(cx.pane)
			local more, again = verify(state, dir, items)
			if r.timed_out or #again == 0 then
				complete(state, content, version, dir, line, summary, bytes + more)
			else
				shrinkBatch(state, content, version, dir, line, summary, bytes + more, again, round + 1)
			end
			if not alive then
				stop(state)
				return
			end
			if state.force and not state.busy then
				check(state)
			end
			cx:render()
		end)
	end)
	if not started then
		state.busy = false
		complete(state, content, version, dir, line, summary, bytes)
	end
end

-- After a reserve run: show its frame, or record why it has no image.
local function oneDone(state: State, content: string, version: string, dir: string, want: string?, r: ProcessResult)
	if r.timed_out then
		state.failed = want
		report(state, "timeout", "Render timed out", "pen took longer than 60 s; press r to try again.")
		settle(state, content)
		return
	end
	local _, summary, why = summaryOf(r)
	if summary == nil then
		state.failed = want
		failRender(state, content, why or "invalid summary", r)
		return
	end
	local exported = summary.exported
	if exported and not util.safe_id(exported) then
		state.failed = exported
		failRender(state, content, "unexpected frame id", r)
		return
	end
	local missing, over = false, false
	if exported then
		local _, again, gone = verify(state, dir, { { id = exported, scale = summary.scale or 2, format = "png" } })
		missing, over = gone, #again > 0
	end
	adopt(state, content, version, dir, summary, true)
	if missing then
		state.failed = exported
		failRender(state, content, "pen exported no image", r)
	elseif over then
		state.shrinks += 1
		if state.shrinks > MAX_SHRINKS then
			state.failed = exported
			report(state, "render", "Could not render " .. state.name, "pen exports this frame larger than 4096 px a side.")
		end
	else
		state.shrinks = 0
	end
end

-- The reserve path: one frame per run (the chosen one, or the first when it is gone), as PNG into `dir`,
-- with the layers. Used when the .pen cannot be read here or a batch export failed.
local function renderOne(state: State, content: string, version: string, dir: string): boolean
	local cli = launch.pen_cli()
	if cli == nil then
		noCli(state, content)
		return true
	end
	local cx = state.cx
	local want = state.frame_id
	local cap = if want then state.caps[want] else nil
	local argv = penArgv(cli.argv, state.path :: string, state.scratch :: string)
	local rkey = dir .. "/" .. tostring(want)
	if reserving[rkey] then
		return false
	end
	reserving[rkey] = true
	state.busy = true
	local started, err = pcall(function()
		tern.process.run(argv, {
			stdin = script.session({ script.refresh(want, dir, MAX_SIDE, cap, true) }),
			timeout_ms = RENDER_TIMEOUT_MS,
		}, function(r: ProcessResult, _: WindowCx?)
			reserving[rkey] = nil
			state.busy = false
			if not running(cx.pane) then
				stop(state)
				return
			end
			oneDone(state, content, version, dir, want, r)
			if state.force then
				check(state)
			end
			cx:render()
		end)
	end)
	if not started then
		reserving[rkey] = nil
		state.busy = false
		report(state, "spawn", "Could not start " .. cli.label, tostring(err))
		settle(state, content)
	end
	return true
end

-- After a batch: complete the cache, export oversize frames again, or fall back to the reserve path. When the
-- block is gone (`alive` false), a good batch still finishes the cache and nothing else happens.
local function batchDone(state: State, content: string, version: string, dir: string, items: { Item }, r: ProcessResult, alive: boolean)
	if r.timed_out then
		if alive then
			report(state, "timeout", "Render timed out", "pen took longer than 120 s; the preview tries again when the file changes, or press r.")
			settle(state, content)
		end
		return
	end
	local line, summary, why = summaryOf(r)
	if line == nil or summary == nil then
		if alive then
			failRender(state, content, why or "invalid summary", r)
		end
		return
	end
	local bytes, again, missing = verify(state, dir, items)
	if missing then
		if not alive then
			return
		end
		-- pen undoes a failed `execute` as a whole: render one frame per run instead.
		adopt(state, content, version, dir, summary, true)
		if state.shown ~= state.frame_id then
			renderOne(state, content, version, dir)
		end
	elseif #again > 0 then
		shrinkBatch(state, content, version, dir, line, summary, bytes, again, 1)
	else
		complete(state, content, version, dir, line, summary, bytes)
	end
end

-- Exports every top-level frame of `content` in one run (the chosen frame first), then reads the layers.
local function startBatch(state: State, content: string, version: string): boolean
	local cli = launch.pen_cli()
	if cli == nil then
		noCli(state, content)
		return true
	end
	local cx = state.cx
	local fileDir, scratch = state.file_dir :: string, state.scratch :: string
	local dir = fileDir .. "/" .. cache.attempt(version, cx.pane)
	-- Prepare removes this folder; the shown blob stays until the batch lands.
	local ownDir = state.dir == dir
	local prepared, perr = pcall(function()
		tern.fs.mkdir(fileDir)
		store.remove(cache.stale_own(store.list(fileDir), cx.pane, version))
		if tern.fs.exists(dir) then
			tern.fs.remove(dir)
		end
		tern.fs.mkdir(dir)
		tern.fs.mkdir((scratch:match("^(.*)[/\\]") or scratch))
	end)
	if not prepared then
		report(state, "spawn", "Could not prepare the cache folder", tostring(perr))
		settle(state, content)
		return true
	end
	if ownDir then
		state.dir = nil
	end
	-- stale_own just removed the reserve folder of an older version.
	if state.fallback and state.version ~= version then
		state.fallback, state.dir = false, nil
	end
	state.failed, state.shrinks = nil, 0
	local tops: { doc.Top } = if #content <= MAX_DECODE then doc.top_frames(content) else {}
	if #tops == 0 then
		if ownDir then
			state.dir, state.blobs = dir, {}
		end
		return renderOne(state, content, version, dir)
	end
	local items = script.plan_batch(tops, state.frame_id, state.caps, MAX_SIDE)
	local key = fileDir .. "/" .. version
	local argv = penArgv(cli.argv, state.path :: string, scratch)
	state.busy = true
	inflight[key] = true
	local started, err = pcall(function()
		tern.process.run(argv, {
			stdin = script.session({ script.exports(items, dir), script.refresh(nil, dir, MAX_SIDE, nil, false) }),
			timeout_ms = BATCH_TIMEOUT_MS,
		}, function(r: ProcessResult, _: WindowCx?)
			state.busy = false
			inflight[key] = nil
			local alive = running(cx.pane)
			batchDone(state, content, version, dir, items, r, alive)
			if not alive then
				stop(state)
				return
			end
			if state.force and not state.busy then
				check(state)
			end
			cx:render()
		end)
	end)
	if not started then
		state.busy = false
		inflight[key] = nil
		report(state, "spawn", "Could not start " .. cli.label, tostring(err))
		settle(state, content)
	end
	return true
end

-- Reads the file; a new version shows from the cache or starts a batch. Returns whether the state changed.
function check(state: State): boolean
	local path, fileDir = state.path, state.file_dir
	if path == nil or fileDir == nil or state.busy or state.stopped then
		return false
	end
	local read, content = pcall(tern.fs.read, path, MAX_PEN)
	if not read then
		report(state, "read", "Could not read " .. state.name, tostring(content))
		return true
	end
	local changed = false
	local problem, notice = state.problem, state.notice
	if problem and problem.kind == "read" then
		-- With no image, take the file again so the real outcome replaces the cleared card.
		state.problem, state.disk, changed = nil, nil, true
	end
	if notice and notice.kind == "read" then
		state.notice, changed = nil, true
	end
	if not state.force and content == state.disk then
		state.pending = nil
		local id, version, dir = state.frame_id, state.version, state.dir
		-- The reserve path renders the chosen frame when it has no image yet.
		if state.fallback and id and version and dir and util.safe_id(id) and state.shown ~= id and state.failed ~= id then
			return show(state) or renderOne(state, content, version, dir)
		end
		return changed
	end
	-- Saves come in bursts: a new version waits until the file holds still for one tick. The first load does not.
	if not state.force and state.disk ~= nil and content ~= state.pending then
		state.pending = content
		return changed
	end
	local version = cache.version(content)
	if inflight[fileDir .. "/" .. version] then
		return changed
	end
	if not state.force then
		local hit = cache.pick(store.list(fileDir), version)
		if hit then
			local dir = store.dir(hit)
			local summary = store.load(dir)
			if summary then
				adopt(state, content, version, dir, summary, false)
				pcall(store.touch, dir, hit.bytes)
				return true
			end
			store.remove({ hit })
		end
	end
	state.force = false
	return startBatch(state, content, version)
end

local function schedule(state: State)
	if state.paused or state.stopped or state.timer then
		return
	end
	local cx = state.cx
	if not running(cx.pane) then
		stop(state)
		return
	end
	local handle: TimerHandle? = nil
	handle = tern.timer(EVERY_MS, function()
		-- A timer cancelled by a pause may still fire; only the current one ticks.
		if state.timer ~= handle then
			return
		end
		state.timer = nil
		if not running(cx.pane) then
			stop(state)
			return
		end
		if state.paused then
			return
		end
		if check(state) then
			cx:render()
		end
		schedule(state)
	end)
	state.timer = handle
end

local function forceRender(state: State)
	-- Kept until a render starts, so `r` during a busy render runs after it.
	state.force, state.failed, state.shrinks = true, nil, 0
	check(state)
end

local function openInApp(state: State, cx: BlockCx)
	local path = state.path
	if path == nil then
		return
	end
	local opener = launch.opener(path)
	local ok, err = pcall(function()
		tern.process.run(opener.argv, { timeout_ms = OPEN_TIMEOUT_MS }, function(_: ProcessResult, _: WindowCx?) end)
	end)
	if not ok then
		cx:toast("error", "Could not start " .. opener.label, tostring(err))
	end
end

local function chooseFrame(state: State, id: string)
	state.frame_id = id
	if not util.has_layer(util.frame(state.frames, id), state.layer) then
		state.layer = nil
	end
	if show(state) then
		return
	end
	local dir = state.dir
	if dir and not tern.fs.exists(dir) then
		-- The cache folder was trimmed to make room: render this version again.
		state.disk = nil
		check(state)
	elseif state.fallback then
		check(state)
	elseif not state.busy then
		local frame = util.frame(state.frames, id)
		report(state, "render", "Could not render " .. (if frame then frame.name else id), "pen exported no image of this frame.")
	end
end

local function currentLayers(state: State): { doc.Layer }
	local frame = util.frame(state.frames, state.frame_id)
	return if frame then frame.layers else {}
end

local preview: BlockDef<State> = {
	init = function(cx: BlockCx, args: { string }, saved: any): State
		local arg: string? = args[1]
		local path = if arg and arg ~= "" then util.resolve(arg, cx.cwd) else nil
		local state: State = {
			cx = cx,
			path = path,
			name = if path then util.basename(path) else "Pencil Preview",
			file_dir = nil,
			scratch = nil,
			frames = {},
			frame_id = nil,
			layer = nil,
			panel = false,
			version = nil,
			dir = nil,
			blobs = {},
			fallback = false,
			failed = nil,
			blob = nil,
			shown = nil,
			busy = false,
			paused = false,
			stopped = false,
			force = false,
			disk = nil,
			pending = nil,
			caps = {},
			shrinks = 0,
			problem = nil,
			notice = nil,
			updated_at = nil,
			timer = nil,
		}
		if type(saved) == "table" then
			if type(saved.frame_id) == "string" then
				state.frame_id = saved.frame_id
			end
			if type(saved.layer) == "string" then
				state.layer = saved.layer
			end
			if type(saved.panel) == "boolean" then
				state.panel = saved.panel
			end
			if type(saved.paused) == "boolean" then
				state.paused = saved.paused
			end
		end
		if path == nil then
			state.problem = {
				kind = "nofile",
				title = "No file to preview",
				text = "Open a `.pen` file from the Files pane, or choose **Open with › Pencil Preview** in its menu.",
			}
			return state
		end
		state.file_dir = store.file_dir(path)
		state.scratch = tern.plugin.data .. "/scratch/" .. util.key(path) .. "-" .. tostring(cx.pane) .. ".pen"
		-- The first render runs even when paused, so a restored block shows its design.
		check(state)
		schedule(state)
		return state
	end,

	title = function(state: State): string?
		return state.name
	end,

	view = function(state: State, cx: BlockCx): BlockView
		return view.render(state, cx)
	end,

	key = function(state: State, key: Key, cx: BlockCx): boolean?
		if key.ctrl or key.alt or key.meta then
			return false
		end
		local name = key.name
		local k = key.text or name
		if name == "left" or k == "[" or name == "right" or k == "]" then
			local step = if name == "left" or k == "[" then -1 else 1
			local to = util.neighbour(state.frames, state.frame_id, step)
			if to == nil then
				return false
			end
			chooseFrame(state, to)
		elseif k == "l" then
			state.panel = not state.panel
		elseif name == "up" or k == "k" or name == "down" or k == "j" then
			if not state.panel then
				return false
			end
			local step = if name == "up" or k == "k" then -1 else 1
			local to = util.step_layer(currentLayers(state), state.layer, step)
			if to == nil then
				return false
			end
			state.layer = to
		elseif k == "r" then
			if state.path == nil then
				return false
			end
			forceRender(state)
		elseif name == "space" then
			if state.path == nil then
				return false
			end
			state.paused = not state.paused
			if state.paused then
				local timer = state.timer
				if timer then
					timer:cancel()
					state.timer = nil
				end
			else
				schedule(state)
			end
		elseif k == "p" then
			if state.path == nil then
				return false
			end
			openInApp(state, cx)
		elseif k == "o" then
			local path = state.path
			if path == nil then
				return false
			end
			-- A block's open has origin `link`, which the window's route leaves to the editor.
			cx:open(path)
		elseif k == "y" then
			local layer = state.layer
			if layer == nil then
				return false
			end
			cx:copy(layer)
			cx:toast("success", "Copied layer id", layer)
		else
			return false
		end
		return true
	end,

	event = function(state: State, ev: UiEvent, cx: BlockCx)
		if ev.ev == "action" and ev.act == "render" then
			forceRender(state)
		elseif ev.ev == "action" and ev.act == "open" then
			openInApp(state, cx)
		elseif (ev.ev == "select" or ev.ev == "activate") and type(ev.item) == "string" then
			local item: string = ev.item
			if item:sub(1, #view.LIST_ID) == view.LIST_ID then
				local id = item:sub(#view.LIST_ID + 1)
				if util.has_layer(util.frame(state.frames, state.frame_id), id) then
					state.layer = id
				end
			end
		end
	end,

	save = function(state: State): any
		return { frame_id = state.frame_id, layer = state.layer, panel = state.panel, paused = state.paused }
	end,
}

tern.block.define("preview", preview)