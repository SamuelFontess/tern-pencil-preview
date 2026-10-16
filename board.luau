--!strict
-- The board: a whiteboard that mirrors a .pen, one image per top-level frame, kept up to date from Pencil's backup
-- of unsaved edits (the .pen itself when there is none). Window half only, read-only: nothing here writes the user's
-- file, and edits made on the board are not sent anywhere.
--
-- Every step runs in its own timer tick: a window handler that takes 50 ms is killed and the plugin's timers are
-- switched off until it reloads. The version is told apart from the last one by comparing the text read (a hash of
-- 1.9 MB in Luau would not fit); pen hashes each frame and exports only the ones that changed.
local cache = require("./lib/cache")
local launch = require("./lib/launch")
local mirror = require("./lib/mirror")
local script = require("./lib/script")
local util = require("./lib/util")

local POLL_MS = 2000
local MAX_BYTES = 64 * 1024 * 1024
local PEN_TIMEOUT_MS = 120000
local LAST_KEY = "board_path"
local KEEP_UPDATES = 20

type Update = { [string]: number | string | boolean }

type Live = {
	path: string,
	windows: boolean,
	backups: { string },
	argv: { string },
	data: string,
	pane: number,
	-- The text of the version handled last, and the shared seed (cache.shared_seed) of the one on the board.
	last: string?,
	seed: string?,
	shown: { [string]: mirror.Shown },
	busy: boolean,
	runs: number,
	-- Reads that failed in a row, and how many failed before the version being handled.
	fails: number,
	misses: number,
	-- The longest a poll timer fired after its time since the last update, in ms.
	late: number,
	-- The last problem shown, so the same one is not announced again on every poll.
	note: string?,
	updates: { Update },
}

-- Bumped by every start: the timers of an older board stop instead of acting on the new one.
local generation = 0
-- The pane of the board this plugin opened last; the only one it ever closes.
local opened: number? = nil

-- Numbers and fixed words only, never anything of the file.
local function writeStatus(st: Live)
	pcall(tern.fs.write, st.data .. "/status.json", tern.json.encode({ runs = st.runs, updates = st.updates }, true))
end

local function announce(cx: WindowCx, st: Live, text: string?)
	if text == nil then
		st.note = nil
	elseif st.note ~= text then
		st.note = text
		cx:toast("info", text)
	end
end

-- Image folders of earlier updates go in child processes: deleting them in a timer would hold it up.
local function dropDirs(st: Live, keep: { [string]: boolean })
	local base = st.data .. "/img"
	local ok, names = pcall(tern.fs.list, base)
	if not ok then
		return
	end
	for _, name in names do
		if not keep[name] then
			local dir = base .. "/" .. name
			local argv = if st.windows then { "cmd", "/c", "rmdir", "/s", "/q", (dir:gsub("/", "\\")) } else { "rm", "-rf", dir }
			tern.process.run(argv, { timeout_ms = 60000 }, function() end)
		end
	end
end

local function record(st: Live, update: Update)
	table.insert(st.updates, update)
	if #st.updates > KEEP_UPDATES then
		table.remove(st.updates, 1)
	end
	writeStatus(st)
end

-- Puts pen's answer on the board: new images for the frames it exported, nothing for the others.
local function apply(cx: WindowCx, st: Live, gen: number, frames: { mirror.Frame }, dir: string, seed: string, detected: number, source: string, penMs: number, done: (WindowCx) -> ())
	local plan = mirror.plan(st.shown, frames, dir, tern.fs.exists)
	tern.timer(0, function(fresh: WindowCx?)
		if gen ~= generation then
			return
		end
		local c = (fresh or cx) :: WindowCx
		local t0 = tern.now()
		local ok, res = true, nil :: any
		if #plan.edits > 0 then
			ok, res = pcall(function()
				return c.whiteboard:edit(st.pane, plan.edits)
			end)
		end
		local editMs = tern.now() - t0
		if ok then
			mirror.adopt(st.shown, plan, frames, if res then res.refs else {}, dir)
			st.seed = seed
			if #plan.missing > 0 then
				announce(c, st, string.format("%d frame image(s) did not export; they update on the next change", #plan.missing))
			else
				announce(c, st, nil)
			end
		else
			announce(c, st, "The board could not be updated; it updates on the next change")
		end
		dropDirs(st, mirror.used_dirs(st.shown))
		record(st, {
			total_ms = math.floor(tern.now() - detected),
			pen_ms = math.floor(penMs),
			edit_ms = math.floor(editMs * 10) / 10,
			exported = #plan.replaced,
			removed = #plan.gone,
			frames = #frames,
			source = source,
			ok = ok,
			read_misses = st.misses,
			late_ms = math.floor(st.late),
		})
		st.late = 0
		done(c)
	end)
end

-- One update: copy the bytes for pen, decode them for the shared seed, run pen, read its answer, apply it.
local function update(cx: WindowCx, st: Live, gen: number, content: string, source: string, done: (WindowCx) -> ())
	local detected = tern.now()
	st.runs += 1
	local n = st.runs
	local function stop(c: WindowCx, text: string?)
		announce(c, st, text)
		done(c)
	end
	tern.timer(0, function(fresh: WindowCx?)
		if gen ~= generation then
			return
		end
		local c = (fresh or cx) :: WindowCx
		-- Pen reads a copy of the bytes just read: never the backup in place, never the user's file.
		local input = st.path
		if source == "backup" then
			local text = content
			if text:find('"url"', 1, true) then
				-- Relative image URLs would resolve against the copy's folder.
				text = util.rewrite_urls(text, util.dirname(st.path), st.windows)
			end
			input = st.data .. "/live-in.pen"
			tern.fs.write(input, text)
		end
		tern.timer(0, function(fresh2: WindowCx?)
			if gen ~= generation then
				return
			end
			local c2 = (fresh2 or c) :: WindowCx
			local ok, root = pcall(tern.json.decode, content)
			if not ok or typeof(root) ~= "table" or typeof((root :: any).children) ~= "table" then
				stop(c2, "Not a readable .pen document yet; waiting for the next change")
				return
			end
			tern.timer(0, function(fresh3: WindowCx?)
				if gen ~= generation then
					return
				end
				local c3 = (fresh3 or c2) :: WindowCx
				local seed = cache.shared_seed(root)
				local dir = st.data .. "/img/r" .. gen .. "_" .. n
				tern.fs.mkdir(dir)
				local snippet = mirror.script(mirror.prev(st.shown), mirror.force(st.shown, st.seed, seed), dir)
				local argv = table.clone(st.argv)
				for _, a in { "interactive", "-i", input, "-o", st.data .. "/scratch.pen" } do
					table.insert(argv, a)
				end
				local pen0 = tern.now()
				tern.process.run(argv, { stdin = script.session({ snippet }), timeout_ms = PEN_TIMEOUT_MS }, function(r: ProcessResult, fresh4: WindowCx?)
					if gen ~= generation then
						return
					end
					local c4 = (fresh4 or c3) :: WindowCx
					local penMs = tern.now() - pen0
					tern.timer(0, function(fresh5: WindowCx?)
						if gen ~= generation then
							return
						end
						local c5 = (fresh5 or c4) :: WindowCx
						if r.timed_out then
							stop(c5, "pen timed out; the board updates on the next change")
							return
						end
						local frames, why = mirror.parse(r.stdout)
						if frames == nil then
							stop(c5, (why or "pen failed") .. ". If the pen CLI is not signed in, run pen login once.")
							return
						end
						apply(c5, st, gen, frames, dir, seed, detected, source, penMs, done)
					end)
				end)
			end)
		end)
	end)
end

local function poll(cx: WindowCx, st: Live, gen: number, delay: number)
	local armed = tern.now()
	tern.timer(delay, function(fresh: WindowCx?)
		if gen ~= generation then
			return
		end
		st.late = math.max(st.late, tern.now() - armed - delay)
		local c = (fresh or cx) :: WindowCx
		if c.session:pane(st.pane) == nil then
			return
		end
		if st.busy then
			poll(c, st, gen, POLL_MS)
			return
		end
		local src, source = st.path, "file"
		for _, b in st.backups do
			if tern.fs.exists(b) then
				src, source = b, "backup"
				break
			end
		end
		local ok, content = pcall(tern.fs.read, src, MAX_BYTES)
		if not ok then
			-- Pencil replaces the backup by renaming a temporary file: a read can fail for an instant.
			st.fails += 1
			if st.fails >= 3 then
				announce(c, st, "Cannot read " .. util.basename(src))
			end
			poll(c, st, gen, POLL_MS)
			return
		end
		st.misses, st.fails = st.fails, 0
		if content == st.last then
			poll(c, st, gen, POLL_MS)
			return
		end
		st.last = content
		st.busy = true
		update(c, st, gen, content, source, function(c2: WindowCx)
			st.busy = false
			poll(c2, st, gen, POLL_MS)
		end)
	end)
end

local function start(cx: WindowCx, path: string)
	local cli = launch.pen_cli()
	if cli == nil then
		cx:toast("error", "The pen CLI was not found", "Install it with npm i -g @pen.dev/cli, or set TERN_PENCIL_CLI")
		return
	end
	if opened and cx.session:pane(opened) then
		cx.layout:close(opened)
	end
	opened = nil
	generation += 1
	local gen = generation
	local windows = tern.runtime.os == "windows"
	local home = tern.getenv(if windows then "USERPROFILE" else "HOME")
	local st: Live = {
		path = path,
		windows = windows,
		backups = util.backup_paths(home, path, windows),
		argv = cli.argv,
		data = tern.plugin.data .. "/board",
		pane = 0,
		last = nil,
		seed = nil,
		shown = {},
		busy = false,
		runs = 0,
		fails = 0,
		misses = 0,
		late = 0,
		note = nil,
		updates = {},
	}
	tern.fs.mkdir(st.data)
	dropDirs(st, {})
	tern.kv.set(LAST_KEY, path)
	cx.whiteboard:open({ how = "beside", focus = true }):next(function(pane: number?, _err: string?, fresh: WindowCx?)
		if gen ~= generation then
			return
		end
		local c = (fresh or cx) :: WindowCx
		if pane == nil then
			c:toast("error", "The board could not be opened")
			return
		end
		st.pane = pane
		opened = pane
		poll(c, st, gen, 0)
	end)
end

tern.command({
	id = "board",
	title = "Open Pencil board (live mirror)",
	icon = "pen",
	run = function(cx: WindowCx)
		local last = tern.kv.get(LAST_KEY)
		cx:prompt({
			placeholder = "Full path of a .pen file",
			value = if typeof(last) == "string" then last else nil,
			action = "open board",
		}):next(function(path: string?, _err: string?, fresh: WindowCx?)
			if path and path ~= "" then
				start((fresh or cx) :: WindowCx, (path:gsub('^"(.*)"$', "%1")))
			end
		end)
	end,
})

return {}
