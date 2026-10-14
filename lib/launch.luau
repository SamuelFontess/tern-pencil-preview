--!strict
-- Resolves how to start the pen CLI and the OS file opener.
local launch = {}

export type Launch = { argv: { string }, label: string }

local CLI_REL = { "node_modules", "@pen.dev", "cli", "dist", "index.mjs" }

local function sepOf(p: string): string
	if p:find("\\", 1, true) then
		return "\\"
	end
	return "/"
end

local function dirOf(p: string): string
	return p:match("^(.*)[\\/][^\\/]*$") or "."
end

local function cliIn(dir: string, sep: string): string
	return dir .. sep .. table.concat(CLI_REL, sep)
end

local function nodeIn(dir: string, sep: string): string
	local exe = dir .. sep .. "node.exe"
	if tern.fs.exists(exe) then
		return exe
	end
	return "node"
end

local function fromOverride(p: string): Launch
	local lower = p:lower()
	if lower:match("%.mjs$") or lower:match("%.js$") then
		return { argv = { "node", p }, label = "TERN_PENCIL_CLI" }
	end
	if lower:match("%.cmd$") then
		local dir, sep = dirOf(p), sepOf(p)
		return { argv = { nodeIn(dir, sep), cliIn(dir, sep) }, label = "TERN_PENCIL_CLI" }
	end
	return { argv = { p }, label = "TERN_PENCIL_CLI" }
end

local function pathDirs(): { string }
	local raw = tern.getenv("PATH") or tern.getenv("Path") or ""
	local dirs: { string } = {}
	for entry in raw:gmatch("[^;]+") do
		local d = entry:gsub("^%s+", ""):gsub("%s+$", "")
		d = d:gsub('^"(.*)"$', "%1")
		d = d:gsub("^%s+", ""):gsub("%s+$", "")
		d = d:gsub("[\\/]+$", "")
		if d ~= "" then
			table.insert(dirs, d)
		end
	end
	return dirs
end

local function fromWindowsPath(): Launch?
	for _, dir in pathDirs() do
		local index = cliIn(dir, "\\")
		if tern.fs.exists(dir .. "\\pen.cmd") and tern.fs.exists(index) then
			return { argv = { nodeIn(dir, "\\"), index }, label = index }
		end
		local exe = dir .. "\\pen.exe"
		if tern.fs.exists(exe) then
			return { argv = { exe }, label = exe }
		end
	end
	return nil
end

function launch.pen_cli(): Launch?
	local override = tern.getenv("TERN_PENCIL_CLI")
	if override and override ~= "" then
		return fromOverride(override)
	end
	if tern.runtime.os == "windows" then
		return fromWindowsPath()
	end
	return { argv = { "pen" }, label = "pen" }
end

function launch.opener(path: string): Launch
	local os = tern.runtime.os
	local cmd = "xdg-open"
	if os == "windows" then
		cmd = "explorer.exe"
	elseif os == "macos" then
		cmd = "open"
	end
	return { argv = { cmd, path }, label = cmd }
end

return launch
