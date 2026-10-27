--!strict
-- The native editor's shared ground: constants, the session type, the numbers every window callback is measured with, the status
-- file, the registry writes and the timer tick. Every other editor module builds on it; nothing here knows the board.
local drafts = require("./lib/editor_draft")
local gesture = require("./lib/editor_gesture")
local editor_launch = require("./lib/editor_launch")
local editor_level = require("./lib/editor_level")
local label = require("./lib/editor_label")
local mirror = require("./lib/mirror")
local projection = require("./lib/editor_projection")
local registry = require("./lib/editor_registry")
local hooks_live = require("./lib/editor_hooks")

local POLL_MS = 400
local READY_POLL_MS = 250
local READY_TIMEOUT_MS = 120000
local RETRY_MS = 2000
local NODE_TIMEOUT_MS = 5000
local QUICK_FETCH_MS = 30000
local SAVE_TIMEOUT_MS = 60000
local MAX_SCAN_ROWS = 4096
local READ_GROUP = 100

-- Adding an image costs most of a tick (about 7 ms each, measured), so image batches stay small.
local IMAGE_BATCH_ADDITIONS = 1
local IMAGE_BATCH_REMOVALS = 10
local PATH_KEY = "editor_path"

-- Capture reads: groups of this many ids, and at most this many reads or milliseconds in one tick.
local CAPTURE_GROUP = 25
local CAPTURE_TICK_READS = 40
local CAPTURE_TICK_MS = 8

-- Between held probes (the owner already waited), a short breather.
local HELD_GAP_MS = 100

-- The whole-page read of a sweep (reload leftovers, shapes an Undo brought back): at most this many shapes.
local SWEEP_READ = 2000
local WHOLE_PAGE = { x = -1e7, y = -1e7, w = 2e7, h = 2e7 }

export type Stats = { max_ms: number, slowest: string, callbacks: number, builds: number, build_ms: number, entering: string, by: { [string]: number } }

export type Session = {
	alive: boolean,
	busy: boolean,
	busy_since: number,
	tick: number,
	path: string,
	data_dir: string,
	launch_id: string,
	manifest: string,
	-- The exit status of the owner's process, once Tern has called back (only the VM that started it hears: after a reload
	-- the owner is followed by its session record alone).
	exited: number?,
	-- The launch's owner stopped because the document is already open in another one: this session follows that owner,
	-- found by the document's path in the session records rather than by this launch's id.
	reconnect: boolean,
	-- Picked up by a plugin reload rather than started by this VM.
	adopted: boolean,
	-- Which keep-alive (see `keepAlive`) is the one running: a newer one retires the older.
	keep: number,
	board: number,
	started: number,
	record: editor_launch.Record?,
	generation: number,
	attached: number?,
	proj: projection.State?,
	frames_state: projection.State?,
	halos: projection.State?,
	activity_key: string?,
	activity_text: string?,
	frame_rows: { any },
	retiring: boolean,
	opening_board: boolean,
	-- While `opening_board`: where the board's request stands, so that after the timers' death the open can go on from it. nil:
	-- not made yet (the tick that makes it can be lost with the timers); `answered` false: made, and its answer comes on the
	-- await hook, which that death does not touch; true: the answer is in `board`, and the tick that installs it can be lost.
	board_ask: { gen: number, answered: boolean, board: number? }?,
	-- Born of an open the watch began again (see `Opening`): the owner it ran, if any, may still be starting its engine when
	-- the second one stops with ALREADY_OPEN, so the session looks for it for as long as an owner may take to start.
	restarted: boolean,
	closing: boolean,
	recovery_asked: boolean,
	-- A recovery offered on opening is undecided (the owner is being asked, the picker is open, or the choice is being
	-- applied); a close that arrives meanwhile waits for its outcome instead of asking a second time.
	recovery_pick: boolean,
	close_waits: boolean,
	-- Picked up after a reload with a board on screen: the ids of the shapes the old VM drew on it. Only those are
	-- removed before the first build; a board holding none of them was never this session's.
	sweep_ids: { string }?,
	-- `registry.scope` of the window that owns the session.
	scope: string,
	-- The name of the view this VM keeps on the owner: one per VM, so a window that lost the lease cannot pass for the
	-- one that holds it.
	view_id: string,
	-- Picked up after a reload: the owner's lease is not won yet, so nothing is drawn, swept or opened until it is.
	claim: boolean,
	-- Since when the owner has been refusing the lease (another window holds it).
	taken_since: number?,
	-- The shape list was cut at the record's limit (said once in the log).
	shapes_cut: boolean,
	shown: { [string]: mirror.Shown },
	targets: projection.Targets,
	requests: number,
	scene: number?,
	focus: string?,
	built_focus: string?,
	-- The owner's selection as this window last sent or heard it: what the drift check compares the owner's reply with.
	selected: string?,
	-- The one target the board had selected at the last look of this build, by shape id: leaving it (Esc, a click on
	-- nothing) is what ends the level the user is in.
	chosen: string?,
	-- The container whose children the targets are (nil: the focused frame's own), and the focused frame's tree of
	-- elements as the last build read it.
	level: string?,
	tree: editor_level.Tree?,
	framed: boolean,
	note: string?,
	capped_focus: string?,
	reset_seen: number?,
	quiet: number,
	holding: boolean,
	change_seq: number?,
	-- The user's moves and resizes of the click targets (lib/editor_gesture).
	gesture: gesture.State,
	-- The text the user types on the target of a text node (lib/editor_label).
	label: label.State,
	-- The view generation whose targets are on the board: nothing is compared before they are.
	armed: number?,
	-- The view generation in which a look at the targets is under way (one at a time).
	watching: number?,
	gestures: number,
	-- What the owner applied of the user's last gestures, by element path: the shape it came from and the box applied. The
	-- rebuild that follows decides, when it redraws the targets, which of those shapes the user has moved on with.
	applied: { [string]: { id: string, change: drafts.Change } }?,
	-- The board's undo and redo step counts at the last look, to tell when the board's own Undo or Redo was used.
	marks: { undo: number, redo: number }?,
	retired_cut: boolean,
}

-- An open that has begun and has no session yet (see editor_start). `restart` begins it again from its first tick, for the
-- watch to call when the timers its ticks were queued on stopped; `run` tells the ticks of one run from another's.
export type Opening = { path: string, run: number, restart: (c: WindowCx) -> () }

-- What a plugin reload resets, and what the modules share: they never keep a copy of a value that changes.
export type Live = {
	last_state: string,
	-- A window hook that goes over its budget is disabled until the next reload, and from then on `tern.timer` quietly does
	-- nothing. `Awaitable:next` runs on the await hook, a budget of its own, so once the watch has seen the timers stop,
	-- everything is scheduled through `tern.sleep` instead.
	timers_dead: boolean,
	flush_queued: boolean,
	-- The sessions kept in `tern.kv` for a reload to find (see lib/editor_registry). Writes never share a callback with
	-- measured work: sessions to store (or false, to forget one) are collected here and written in a timer tick of their
	-- own, which also collects the ids of the board shapes each one drew by then.
	registry_ops: { [string]: Session | false },
	registry_queued: boolean,
	-- The name of this VM among the windows that may hold an owner's lease.
	holder: string?,
	-- The opens that have no session yet, by the file's key (`keyOf` in editor_start): one at a time per file, and the ones the
	-- watch carries on when the timers stop.
	opening: { [string]: Opening },
}

-- The steps that cross module boundaries upward: the session's `schedule` runs the loop's step, and a board found closed
-- by `guard` goes to the closing flow. Each module fills its own in when it loads.
export type Hooks = {
	step: (c: WindowCx, sess: Session) -> (),
	boardClosed: (c: WindowCx, sess: Session) -> (),
}

local sessions: { [string]: Session } = {}

-- How long every window callback of this module took (ms), by name; the budget is 50 ms each.
local stats: Stats = { max_ms = 0, slowest = "", callbacks = 0, builds = 0, build_ms = 0, entering = "", by = {} }
local live: Live = { last_state = "ok", timers_dead = false, flush_queued = false, registry_ops = {}, registry_queued = false, holder = nil, opening = {} }

local function unset(name: string): (c: WindowCx, sess: Session) -> ()
	return function(_c: WindowCx, _sess: Session)
		error("the editor module that provides " .. name .. " is not loaded", 2)
	end
end
local hooks: Hooks = { step = unset("step"), boardClosed = unset("boardClosed") }

-- Tests only: what a plugin reload does to the state of this module, which is to forget everything it kept in memory.
local function reset()
	for id in sessions do
		sessions[id] = nil
	end
	stats.max_ms, stats.slowest, stats.callbacks, stats.builds, stats.build_ms, stats.entering, stats.by = 0, "", 0, 0, 0, "", {}
	live.last_state, live.timers_dead, live.flush_queued = "ok", false, false
	live.registry_ops, live.registry_queued = {}, false
	live.holder, live.opening = nil, {}
end

local SLOW_MS = 25

local function later(ms: number, fn: (fresh: WindowCx?) -> ())
	if live.timers_dead then
		hooks_live.sleep(ms, fn)
	else
		hooks_live.timer(ms, fn)
	end
end

-- Numbers and fixed words only, never anything of the file or the session.
local function flush()
	pcall(
		tern.fs.write,
		tern.plugin.data .. "/editor/projection-status.json",
		tern.json.encode({
			max_ms = math.floor(stats.max_ms * 10) / 10,
			slowest = stats.slowest,
			callbacks = stats.callbacks,
			builds = stats.builds,
			build_ms = stats.build_ms,
			by = stats.by,
			entering = stats.entering,
			state = live.last_state,
		}, true)
	)
end

-- Status files and kv writes never share a callback with measured work: they run in a timer tick of their own, at
-- most one queued at a time.
local deferFlush: () -> ()

local function record(name: string, took: number)
	stats.callbacks += 1
	stats.by[name] = math.max(stats.by[name] or 0, math.floor(took * 10) / 10)
	if took > stats.max_ms then
		stats.max_ms, stats.slowest = took, name
		-- A tick close to the 50 ms budget is written out at once: past it Tern disables the plugin's timers.
		if took >= SLOW_MS then
			deferFlush()
		end
	end
end

-- Wraps a Tern callback so its run time is recorded under `name`.
local function timed(name: string, fn: (...any) -> ()): (...any) -> ()
	return function(...: any)
		local t0 = tern.now()
		fn(...)
		record(name, tern.now() - t0)
	end
end

deferFlush = function()
	if live.flush_queued then
		return
	end
	live.flush_queued = true
	local queued = pcall(function()
		later(0, timed("flush", function(_c: WindowCx?)
			live.flush_queued = false
			flush()
		end))
	end)
	if not queued then
		live.flush_queued = false
	end
end

local function ownedShapes(sess: Session): { string }
	local seen: { [string]: boolean } = {}
	local ids: { string } = {}
	local function add(id: string?)
		if id ~= nil and not seen[id] then
			seen[id] = true
			table.insert(ids, id)
		end
	end
	local function addOwned(state: projection.State?)
		if state then
			for id, owned in state.owned do
				if owned then
					add(id)
				end
			end
		end
	end
	addOwned(sess.proj)
	addOwned(sess.frames_state)
	addOwned(sess.halos)
	local pending = sess.sweep_ids
	if pending then
		for _, id in pending do
			add(id)
		end
	end
	for _, shown in sess.shown do
		add(shown.shape)
		add(shown.bg)
	end
	add(sess.activity_text)
	table.sort(ids)
	if #ids > registry.MAX_SHAPES then
		-- shortcut: a board with more shapes than this keeps the first ones by id; the rest outlive a reload as strays.
		if not sess.shapes_cut then
			sess.shapes_cut = true
			tern.log.warn(string.format("editor board has %d shapes; only %d are recorded, so the rest are not swept after a reload", #ids, registry.MAX_SHAPES))
		end
		ids = table.move(ids, 1, registry.MAX_SHAPES, 1, {})
	end
	return ids
end

local armRegistry: () -> ()

armRegistry = function()
	if live.registry_queued then
		return
	end
	live.registry_queued = true
	local queued = pcall(later, 0, timed("registry", function(_c: WindowCx?)
		live.registry_queued = false
		local ops: registry.Ops = {}
		for key, op in live.registry_ops do
			if typeof(op) == "table" then
				ops[key] = {
					launch_id = op.launch_id, path = op.path, board = op.board,
					data_dir = op.data_dir, manifest = op.manifest, scope = op.scope, shapes = ownedShapes(op), follow = op.reconnect,
				}
			else
				ops[key] = false
			end
		end
		live.registry_ops = {}
		pcall(registry.apply, ops)
	end))
	if not queued then
		live.registry_queued = false
	end
end

local function queueRegistry(id: string, sess: Session | false)
	live.registry_ops[id] = sess
	armRegistry()
end

local function holderOf(): string
	local name = live.holder or editor_launch.launch_id(tostring(tern.now()) .. "|" .. tostring(math.random()) .. "|" .. tostring(math.random()))
	live.holder = name
	return name
end

local function remember(sess: Session)
	queueRegistry(sess.launch_id, sess)
end

local function writeStatus(sess: Session)
	live.last_state = sess.note or "ok"
	deferFlush()
end

-- Notes that are news for the user rather than faults of the editor.
local function isNews(code: string): boolean
	return code == "TARGETS_CAPPED" or code == "TARGETS_RESTORED" or code == "NOT_MOVABLE" or code == "NOT_RESIZABLE" or code == "LABEL_DISCARDED" or code:find("^GEOMETRY_") ~= nil
end

local function announce(c: WindowCx, sess: Session, code: string?, layout: string?)
	if code == nil then
		-- The cap note belongs to the focused frame and is only dropped when the focus changes.
		if sess.note ~= "TARGETS_CAPPED" then
			sess.note = nil
		end
	elseif sess.note ~= code then
		sess.note = code
		local title, detail = projection.message(code, layout)
		c:toast(if isNews(code) then "info" else "error", title, detail)
	end
end

-- Continues in a timer tick of its own. A process or board callback must be short (50 ms each); what follows runs on
-- a fresh budget, measured like every other tick. For a tick that makes a slow native call, the status write is a tick of
-- its own just before (the "mark": `entering` set, the file written) and `fn` runs in the next, so `fn` keeps its budget
-- for its one call. A mark is one write (about 0.5 ms at rest: the call is what costs, not the size).
-- What `entering` in the status file can mislead about:
--   - a mark that Tern kills (its write finished, the budget check came after) leaves the name of the tick it was
--     marking, which never ran;
--   - when two `tick` chains interleave (mark A, mark B, work A), the file names B while A runs. The in-memory
--     `entering` the work tick sets again is only written by the next flush, which a killed hook never makes.
-- In both, `stats.by` (the ticks that did finish) helps tell which one is real: on a tick's first run the dead one has no entry.
local function tick(name: string, c: WindowCx, fn: (c: WindowCx) -> ())
	later(0, timed("mark", function(marked: WindowCx?)
		stats.entering = name
		flush()
		later(0, timed(name, function(fresh: WindowCx?)
			stats.entering = name
			fn((fresh or marked or c) :: WindowCx)
		end))
	end))
end

-- A tick that makes no slow native call of its own (it checks, builds, schedules): nothing to protect, so no mark and no
-- extra hop. `entering` is only set in memory.
local function quick(name: string, c: WindowCx, fn: (c: WindowCx) -> ())
	later(0, timed(name, function(fresh: WindowCx?)
		stats.entering = name
		fn((fresh or c) :: WindowCx)
	end))
end

return {
	CAPTURE_GROUP = CAPTURE_GROUP,
	CAPTURE_TICK_MS = CAPTURE_TICK_MS,
	CAPTURE_TICK_READS = CAPTURE_TICK_READS,
	HELD_GAP_MS = HELD_GAP_MS,
	IMAGE_BATCH_ADDITIONS = IMAGE_BATCH_ADDITIONS,
	IMAGE_BATCH_REMOVALS = IMAGE_BATCH_REMOVALS,
	MAX_SCAN_ROWS = MAX_SCAN_ROWS,
	NODE_TIMEOUT_MS = NODE_TIMEOUT_MS,
	PATH_KEY = PATH_KEY,
	POLL_MS = POLL_MS,
	QUICK_FETCH_MS = QUICK_FETCH_MS,
	READY_POLL_MS = READY_POLL_MS,
	READY_TIMEOUT_MS = READY_TIMEOUT_MS,
	READ_GROUP = READ_GROUP,
	RETRY_MS = RETRY_MS,
	SAVE_TIMEOUT_MS = SAVE_TIMEOUT_MS,
	SWEEP_READ = SWEEP_READ,
	WHOLE_PAGE = WHOLE_PAGE,
	announce = announce,
	armRegistry = armRegistry,
	deferFlush = deferFlush,
	holderOf = holderOf,
	hooks = hooks,
	later = later,
	live = live,
	queueRegistry = queueRegistry,
	quick = quick,
	record = record,
	remember = remember,
	reset = reset,
	sessions = sessions,
	stats = stats,
	tick = tick,
	timed = timed,
	writeStatus = writeStatus,
}
