--!strict
local stub = require("./stub")
local launch = stub.attach(require("../lib/launch"))

type T = {
	eq: (actual: any, expected: any, msg: string?) -> (),
	match: (s: string, pattern: string, msg: string?) -> (),
	truthy: (v: any, msg: string?) -> (),
	raises: (fn: () -> (), pattern: string?, msg: string?) -> (),
}

local INDEX = "\\node_modules\\@pen.dev\\cli\\dist\\index.mjs"

local tests: { [string]: (t: T) -> () } = {}

tests.windows_npm_layout_in_second_path_entry = function(t)
	stub.install({
		os = "windows",
		env = { PATH = ' "C:\\a" ;"C:\\npm\\";C:\\other' },
		files = {
			["C:\\npm\\pen.cmd"] = true,
			["C:\\npm" .. INDEX] = true,
		},
	})
	t.eq(launch.pen_cli(), { argv = { "node", "C:\\npm" .. INDEX }, label = "C:\\npm" .. INDEX })
end

tests.windows_prefers_node_exe_beside_shim = function(t)
	stub.install({
		os = "windows",
		env = { PATH = "C:\\npm\\" },
		files = {
			["C:\\npm\\pen.cmd"] = true,
			["C:\\npm" .. INDEX] = true,
			["C:\\npm\\node.exe"] = true,
		},
	})
	local l = launch.pen_cli() :: any
	t.eq(l.argv, { "C:\\npm\\node.exe", "C:\\npm" .. INDEX })
end

tests.windows_pen_exe_fallback = function(t)
	stub.install({
		os = "windows",
		env = { PATH = "C:\\a;C:\\bin" },
		files = { ["C:\\bin\\pen.exe"] = true },
	})
	t.eq(launch.pen_cli(), { argv = { "C:\\bin\\pen.exe" }, label = "C:\\bin\\pen.exe" })
end

tests.windows_first_matching_dir_wins = function(t)
	stub.install({
		os = "windows",
		env = { PATH = "C:\\one;C:\\two" },
		files = { ["C:\\one\\pen.exe"] = true, ["C:\\two\\pen.exe"] = true },
	})
	t.eq((launch.pen_cli() :: any).argv, { "C:\\one\\pen.exe" })
end

tests.windows_shim_without_cli_falls_to_exe = function(t)
	stub.install({
		os = "windows",
		env = { PATH = "C:\\one" },
		files = { ["C:\\one\\pen.cmd"] = true, ["C:\\one\\pen.exe"] = true },
	})
	t.eq((launch.pen_cli() :: any).argv, { "C:\\one\\pen.exe" })
end

tests.windows_nothing_found = function(t)
	stub.install({ os = "windows", env = { PATH = "C:\\a;;C:\\b" }, files = {} })
	t.eq(launch.pen_cli(), nil)
	stub.install({ os = "windows", env = {}, files = {} })
	t.eq(launch.pen_cli(), nil)
end

tests.windows_reads_Path_variable = function(t)
	stub.install({ os = "windows", env = { Path = "C:\\bin" }, files = { ["C:\\bin\\pen.exe"] = true } })
	t.eq((launch.pen_cli() :: any).argv, { "C:\\bin\\pen.exe" })
end

tests.override_mjs_any_case = function(t)
	stub.install({ os = "linux", env = { TERN_PENCIL_CLI = "/x/CLI.MJS" } })
	t.eq(launch.pen_cli(), { argv = { "node", "/x/CLI.MJS" }, label = "TERN_PENCIL_CLI" })
	stub.install({ os = "linux", env = { TERN_PENCIL_CLI = "/x/cli.js" } })
	t.eq((launch.pen_cli() :: any).argv, { "node", "/x/cli.js" })
end

tests.override_cmd_with_node_beside = function(t)
	stub.install({
		os = "windows",
		env = { TERN_PENCIL_CLI = "C:\\npm\\PEN.CMD" },
		files = { ["C:\\npm\\node.exe"] = true },
	})
	t.eq(launch.pen_cli(), {
		argv = { "C:\\npm\\node.exe", "C:\\npm" .. INDEX },
		label = "TERN_PENCIL_CLI",
	})
end

tests.override_cmd_without_node_forward_slashes = function(t)
	stub.install({ os = "linux", env = { TERN_PENCIL_CLI = "/opt/npm/pen.cmd" } })
	t.eq((launch.pen_cli() :: any).argv, { "node", "/opt/npm/node_modules/@pen.dev/cli/dist/index.mjs" })
	stub.install({
		os = "linux",
		env = { TERN_PENCIL_CLI = "/opt/npm/pen.cmd" },
		files = { ["/opt/npm/node.exe"] = true },
	})
	t.eq((launch.pen_cli() :: any).argv[1], "/opt/npm/node.exe")
end

tests.override_plain_exe = function(t)
	stub.install({ os = "windows", env = { TERN_PENCIL_CLI = "C:\\tools\\pen.exe" } })
	t.eq(launch.pen_cli(), { argv = { "C:\\tools\\pen.exe" }, label = "TERN_PENCIL_CLI" })
end

tests.empty_override_ignored = function(t)
	stub.install({ os = "linux", env = { TERN_PENCIL_CLI = "" } })
	t.eq(launch.pen_cli(), { argv = { "pen" }, label = "pen" })
end

tests.unix_pen_cli = function(t)
	stub.install({ os = "linux" })
	t.eq(launch.pen_cli(), { argv = { "pen" }, label = "pen" })
	stub.install({ os = "macos" })
	t.eq(launch.pen_cli(), { argv = { "pen" }, label = "pen" })
end

tests.opener_per_os = function(t)
	stub.install({ os = "windows" })
	t.eq(launch.opener("a.pen"), { argv = { "explorer.exe", "a.pen" }, label = "explorer.exe" })
	stub.install({ os = "macos" })
	t.eq(launch.opener("a.pen"), { argv = { "open", "a.pen" }, label = "open" })
	stub.install({ os = "linux" })
	t.eq(launch.opener("a.pen"), { argv = { "xdg-open", "a.pen" }, label = "xdg-open" })
end

return tests
