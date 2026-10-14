--!strict
local stub = require("./stub")
local doc = stub.attach(require("../lib/doc"))

type T = {
	eq: (actual: any, expected: any, msg: string?) -> (),
	match: (s: string, pattern: string, msg: string?) -> (),
	truthy: (v: any, msg: string?) -> (),
	raises: (fn: () -> (), pattern: string?, msg: string?) -> (),
}

local LINE = [==[{"v":1,"layers":[{"id":"FSXkK","name":"Login","type":"frame","d":0,"p":null,"w":390,"h":844,"x":0,"y":0,"fill":"#0F172A"},{"id":"LvEbe","name":"Title","type":"text","d":1,"p":"FSXkK","w":243,"h":44,"x":24,"y":24,"content":"Welcome \"back\"","fill":"#FFFFFF"},{"id":"ButZP","name":"Card","type":"frame","d":1,"p":"FSXkK","w":342,"h":200,"x":24,"y":84,"fill":"#1E293B"},{"id":"C3I9OB","name":"Avatar","type":"rectangle","d":2,"p":"ButZP","w":48,"h":48,"x":0,"y":0,"fill":"#7C3AED"},{"id":"mQuDf","name":"Auto","type":"frame","d":0,"p":null,"w":60,"h":67,"x":500,"y":0,"fill":"#FFFFFF"},{"id":"yg1Vx","name":"Label","type":"text","d":1,"p":"mQuDf","w":20,"h":27,"x":20,"y":20,"content":"fit","fill":"#000000"}],"exported":"FSXkK","scale":2}]==]

-- verbatim shape of tests/fixtures/sample.stdout.txt, ANSI escapes included
local STDOUT = "\n\n[INFO] Starting pen.dev (headless)...\n[INFO] Ready.\n\n"
	.. "\27[1mpen.dev Interactive Shell\27[22m\n\27[2mFile: <PATH>\27[22m\n"
	.. '\27[2mType tool calls like: read_skill({ path: "pen-schema.md" })\27[22m\n'
	.. "\27[2mType save() to save, exit() to quit.\27[22m\n\n"
	.. "\27[36mpen\27[39m \27[2m>\27[22m OK\n\nGlobal variables (e.g. root) carry over to subsequent calls!\n\n"
	.. "## Print output\nExported /<EXPORT_DIR>/FSXkK.png  \n"
	.. LINE
	.. "\n\n\n\27[2mGoodbye.\27[22m\n"

local EXPECTED = {
	frames = {
		{
			id = "FSXkK",
			name = "Login",
			type = "frame",
			w = 390,
			h = 844,
			layers = {
				{
					id = "LvEbe",
					name = "Title",
					type = "text",
					depth = 1,
					parent = "FSXkK",
					x = 24,
					y = 24,
					w = 243,
					h = 44,
					content = 'Welcome "back"',
					fill = "#FFFFFF",
				},
				{
					id = "ButZP",
					name = "Card",
					type = "frame",
					depth = 1,
					parent = "FSXkK",
					x = 24,
					y = 84,
					w = 342,
					h = 200,
					fill = "#1E293B",
				},
				{
					id = "C3I9OB",
					name = "Avatar",
					type = "rectangle",
					depth = 2,
					parent = "ButZP",
					x = 0,
					y = 0,
					w = 48,
					h = 48,
					fill = "#7C3AED",
				},
			},
		},
		{
			id = "mQuDf",
			name = "Auto",
			type = "frame",
			w = 60,
			h = 67,
			layers = {
				{
					id = "yg1Vx",
					name = "Label",
					type = "text",
					depth = 1,
					parent = "mQuDf",
					x = 20,
					y = 20,
					w = 20,
					h = 27,
					content = "fit",
					fill = "#000000",
				},
			},
		},
	},
	exported = "FSXkK",
	scale = 2,
}

local tests: { [string]: (t: T) -> () } = {}

tests.headless_stdout_with_ansi = function(t)
	stub.install({})
	local found = doc.find_summary(STDOUT)
	t.eq(found, LINE)
	t.eq(doc.parse(found :: string), EXPECTED)
end

tests.app_mode_message = function(t)
	local tern = stub.install({})
	local text = "[INFO] connected\n" .. tern.json.encode({ message = "OK\n\n## Print output\n" .. LINE .. "\n" }, true) .. "\n"
	t.truthy(not text:find('{"v":', 1, true), "summary must only appear escaped")
	local found = doc.find_summary(text)
	t.eq(found, LINE)
	t.eq(doc.parse(found :: string), EXPECTED)
end

tests.app_mode_skips_unrelated_braces = function(t)
	local tern = stub.install({})
	local text = 'x({ path: "a" })\n'
		.. tern.json.encode({ message = "OK" }, true)
		.. "\n"
		.. tern.json.encode({ message = "## Print output\n" .. LINE }, true)
	t.eq(doc.find_summary(text), LINE)
end

tests.no_summary = function(t)
	stub.install({})
	t.eq(doc.find_summary("[INFO] Ready.\nGoodbye.\n"), nil)
	t.eq(doc.find_summary(""), nil)
	t.eq(doc.find_summary('{"message":"OK"}'), nil)
end

tests.invalid_json_is_parse_error = function(t)
	stub.install({})
	local found = doc.find_summary('noise {"v":nope} more')
	t.eq(found, '{"v":nope}')
	local summary, err = doc.parse(found :: string)
	t.eq(summary, nil)
	t.match(err :: string, "^invalid summary: ")
end

tests.empty_layers = function(t)
	stub.install({})
	t.eq(doc.parse('{"v":1,"layers":[],"exported":null,"scale":null}'), { frames = {} })
	t.eq(doc.parse('{"v":1}'), { frames = {} })
end

tests.unsupported_version = function(t)
	stub.install({})
	local summary, err = doc.parse('{"v":2}')
	t.eq(summary, nil)
	t.eq(err, "unsupported summary version")
	local s2, e2 = doc.parse("[1,2]")
	t.eq(s2, nil)
	t.eq(e2, "unsupported summary version")
end

tests.braces_inside_strings_do_not_break_scan = function(t)
	stub.install({})
	local line = '{"v":1,"layers":[{"id":"a","name":"x}{ \\"}\\\\","type":"frame","d":0,"p":null}],"exported":null,"scale":null}'
	local found = doc.find_summary("pre " .. line .. " post }")
	t.eq(found, line)
	local summary = doc.parse(found :: string) :: any
	t.eq(summary.frames[1].name, 'x}{ "}\\')
end

tests.layers_missing_id_or_type_ignored_and_orphans_dropped = function(t)
	stub.install({})
	local summary = doc.parse(
		'{"v":1,"layers":[{"id":"o","type":"text","d":1},{"type":"frame","d":0},{"id":"f","type":"frame","d":0},'
			.. '{"id":"n","d":1},{"id":"c","type":"ref","d":1,"p":"f","ref":"r","reusable":true}]}'
	) :: any
	t.eq(#summary.frames, 1)
	t.eq(summary.frames[1].name, "")
	t.eq(#summary.frames[1].layers, 1)
	t.eq(summary.frames[1].layers[1].ref, "r")
	t.eq(summary.frames[1].layers[1].reusable, true)
end

local PEN = [[{"version":"2.19","children":[
{"type":"frame","id":"A","width":3040,"height":420,"fill":"#fff","stroke":"#e5e5e5","strokeWidth":1},
{"type":"rectangle","id":"R","width":10,"height":10},
{"type":"frame","id":"B","width":1440,"height":900},
{"type":"frame","id":"C","width":"fill_container","height":10,"fill":"#000"},
{"type":"frame","id":"D","width":100,"height":50,"fill":[],"strokeWidth":{"top":2,"left":4}}
]}]]

tests.top_frames_reads_frames_in_order = function(t)
	stub.install({})
	t.eq(doc.top_frames(PEN), {
		{ id = "A", w = 3040, h = 420, stroke = 1, fill = true },
		{ id = "B", w = 1440, h = 900, stroke = 0, fill = false },
		{ id = "D", w = 100, h = 50, stroke = 4, fill = false },
	})
end

tests.top_frames_of_other_text_is_empty = function(t)
	stub.install({})
	t.eq(doc.top_frames("not json"), {})
	t.eq(doc.top_frames('{"version":"2.19"}'), {})
	t.eq(doc.top_frames("[1,2]"), {})
end

return tests
