--!strict
-- The `preview` block of 0.4.x, kept only to say it was replaced: a pane restored from a saved 0.4 workspace
-- (or still open during the update) shows this notice instead of Tern's "no block type" error. It never reads the
-- `.pen` and starts nothing; the file name comes from the launch argument.
local old = {}

type State = { name: string? }

local function notice(name: string?): string
	local text = "## Pencil Preview was replaced\n\n"
	if name then
		text ..= "`" .. name .. "` was open in the static preview of 0.4.x, which version 0.5.0 removed.\n\n"
	else
		text ..= "The static preview of 0.4.x was removed in version 0.5.0.\n\n"
	end
	return text .. "The editor on the board took its place. Run **Open Pencil editor** from the command palette, "
		.. "or open the `.pen` file from the Files pane. You can close this pane."
end

old.block = {
	init = function(_cx: BlockCx, args: { string }, _saved: any): State
		local arg = args[1]
		return { name = if arg then arg:match("[^/\\]+$") else nil }
	end,
	view = function(state: State, _cx: BlockCx): BlockView
		return { main = tern.ui.col({ tern.ui.md(notice(state.name)) }) }
	end,
	title = function(state: State): string?
		return state.name
	end,
} :: BlockDef<State>

return old
