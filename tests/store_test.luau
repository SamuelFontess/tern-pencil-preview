--!strict
local stub = require("./stub")
stub.attach(require("../lib/doc"))
stub.attach(require("../lib/util"))
stub.attach(require("../lib/cache"))
local store = stub.attach(require("../lib/store"))

type T = {
	eq: (actual: any, expected: any, msg: string?) -> (),
	match: (s: string, pattern: string, msg: string?) -> (),
	truthy: (v: any, msg: string?) -> (),
	raises: (fn: () -> (), pattern: string?, msg: string?) -> (),
}

local tests: { [string]: (t: T) -> () } = {}

local SUMMARY = '{"v":1,"layers":[{"id":"A","name":"Home","type":"frame","d":0,"p":null,"w":10,"h":20}],"exported":null,"scale":null}'

tests.finished_attempt_lists_as_complete_and_loads = function(t)
	local tern = stub.install({ data = "/pd" })
	local fileDir = store.file_dir("C:/x/a.pen")
	t.match(fileDir, "^/pd/cache/%x+$")
	local dir = fileDir .. "/ab1r1-7"
	tern.fs.mkdir(dir)
	tern.fs.write(dir .. "/A.jpeg", "JPG")
	t.eq(store.list(fileDir)[1].complete, false, "no marker yet")
	store.finish(dir, SUMMARY, 3)
	local e = store.list(fileDir)[1]
	t.eq({ e.version, e.pane, e.complete, e.bytes }, { "ab1r1", 7, true, 3 })
	t.truthy(e.used > 0)
	t.eq(store.dir(e), dir)
	t.eq((store.load(dir) :: any).frames[1].id, "A")
	t.eq(#store.list_all(), 1)
end

tests.image_prefers_jpeg_and_reports_missing = function(t)
	local tern = stub.install({ files = { ["/d/A.png"] = "P", ["/d/A.jpeg"] = "J", ["/d/B.png"] = "Q" } })
	t.eq({ store.image("/d", "A") }, { "J", "image/jpeg" })
	t.eq({ store.image("/d", "B") }, { "Q", "image/png" })
	t.eq(store.image("/d", "C"), nil)
	t.eq(tern.fs.exists("/d"), true)
end

tests.has_image_finds_either_format = function(t)
	stub.install({ files = { ["/d/A.jpeg"] = "J", ["/d/B.png"] = "P" } })
	t.eq(store.has_image("/d", "A"), true)
	t.eq(store.has_image("/d", "B"), true)
	t.eq(store.has_image("/d", "C"), false)
end

tests.list_ignores_other_names_and_remove_deletes = function(t)
	local tern = stub.install({ files = { ["/data/cache/f/ab1r1-2/complete"] = true, ["/data/cache/f/notes.txt"] = "x" } })
	local list = store.list("/data/cache/f")
	t.eq(#list, 1)
	store.remove(list)
	t.eq(tern.fs.exists("/data/cache/f/ab1r1-2"), false)
	t.eq(store.list("/data/cache/missing"), {})
end

tests.list_skips_files_where_folders_belong = function(t)
	stub.install({ files = { ["/data/cache/stray"] = "x", ["/data/cache/f/ab1r1-2/complete"] = true } })
	t.eq(store.list("/data/cache/stray"), {})
	t.eq(#store.list_all(), 1)
end

tests.load_without_summary_fails = function(t)
	stub.install({ files = { ["/d/complete"] = true } })
	local summary, why = store.load("/d")
	t.eq(summary, nil)
	t.truthy(why)
end

return tests
