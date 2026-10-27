--!strict
local stub = require("./stub")
local old = stub.attach(require("../lib/old_preview"))

type T = {
	eq: (actual: any, expected: any, msg: string?) -> (),
	match: (s: string, pattern: string, msg: string?) -> (),
	truthy: (v: any, msg: string?) -> (),
	raises: (fn: () -> (), pattern: string?, msg: string?) -> (),
}

local PEN = "D:\\design\\sample.pen"

-- A tern that records every fs read and process start, with the two ui builders the notice uses.
local function setup(): { reads: { string }, runs: number }
	local seen = { reads = {}, runs = 0 }
	local tern = stub.install({ files = { [PEN] = "{}" } })
	local read = tern.fs.read
	tern.fs.read = function(path: string, max: number?): string
		table.insert(seen.reads, path)
		return read(path, max)
	end
	tern.process = {
		run = function()
			seen.runs += 1
		end,
	}
	tern.ui = {
		col = function(children: { any }): any
			return { kind = "col", c = children }
		end,
		md = function(text: string): any
			return { kind = "md", text = text }
		end,
	}
	return seen
end

local function text(view: any): string
	return view.main.c[1].text
end

local tests: { [string]: (t: T) -> () } = {}

tests.saved_0_4_pane_shows_a_notice_naming_the_file_and_touches_nothing = function(t)
	local seen = setup()
	local state = old.block.init({} :: any, { PEN }, { frame_id = "F1", panel = true, follow = true })
	local shown = text(old.block.view(state, {} :: any))
	t.truthy(shown ~= "")
	t.match(shown, "sample%.pen")
	t.eq(old.block.title and old.block.title(state), "sample.pen")
	t.eq(seen.reads, {})
	t.eq(seen.runs, 0)
end

tests.pane_without_a_file_still_shows_a_notice = function(t)
	setup()
	local state = old.block.init({} :: any, {}, nil)
	t.truthy(text(old.block.view(state, {} :: any)) ~= "")
	t.eq(old.block.title and old.block.title(state), nil)
end

tests.unix_paths_give_the_file_name = function(t)
	setup()
	local state = old.block.init({} :: any, { "/home/a/b.pen" }, nil)
	t.eq(old.block.title and old.block.title(state), "b.pen")
end

return tests
