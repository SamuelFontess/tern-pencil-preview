--!strict
-- The palette's Save, Undo and Redo: which session a command acts on, and what the user is told of the owner's answer.
-- Pure: the window supplies the sessions and the reply.

local editor_palette = {}

export type Action = "save" | "undo" | "redo"
export type Candidate = { id: string, board: number, tab: number? }
export type Choice = { kind: "one", id: string } | { kind: "none" } | { kind: "ask" }
export type Verdict = { level: ToastLevel, title: string, detail: string?, lost: boolean }

editor_palette.METHOD = { save = "save_document", undo = "undo_document", redo = "redo_document" }

-- The session whose board is focused; else, with the focus elsewhere (the terminal, say), the one whose board is in the
-- focused pane's tab; else the only one. With none there is nothing to act on, and with several and nothing to tell them
-- apart the user has to say which (focus its board: a picker for a menu command is more than it is worth).
function editor_palette.choose(candidates: { Candidate }, focused: number?, focused_tab: number?): Choice
	if focused ~= nil then
		for _, candidate in candidates do
			if candidate.board ~= 0 and candidate.board == focused then
				return { kind = "one", id = candidate.id }
			end
		end
	end
	if focused_tab ~= nil then
		local here: { Candidate } = {}
		for _, candidate in candidates do
			if candidate.board ~= 0 and candidate.tab == focused_tab then
				table.insert(here, candidate)
			end
		end
		if #here == 1 then
			return { kind = "one", id = here[1].id }
		end
	end
	if #candidates == 0 then
		return { kind = "none" }
	elseif #candidates == 1 then
		return { kind = "one", id = candidates[1].id }
	end
	return { kind = "ask" }
end

local FAILED: { [Action]: string } = {
	save = "The changes were not saved",
	undo = "Nothing was undone",
	redo = "Nothing was redone",
}
local DONE: { [Action]: string } = { save = "Saved", undo = "Undid the last step", redo = "Redid the next step" }

-- What the owner's answer to `action` means for the user. A lost owner is not told here: the window ends the session.
function editor_palette.verdict(action: Action, name: string, reply: any?, code: string?, remote: string?): Verdict
	if reply ~= nil then
		if action == "save" and reply.saved ~= true then
			return { level = "info", title = "Nothing to save", detail = name .. " has no unsaved changes", lost = false }
		end
		return { level = "success", title = DONE[action], detail = name, lost = false }
	end
	if code == "TRANSPORT" or code == "OWNER_ABSENT" then
		return { level = "error", title = FAILED[action], lost = true }
	elseif remote == "SOURCE_CHANGED" then
		return {
			level = "error", title = "The file changed outside Tern, so it was not saved",
			detail = "Close the board to save a recovery copy or discard", lost = false,
		}
	elseif remote == "HISTORY_UNAVAILABLE" then
		return { level = "info", title = "Nothing to " .. action, detail = name, lost = false }
	elseif remote == "REVISION_STALE" then
		return { level = "info", title = "The document changed meanwhile", detail = "Run the command again", lost = false }
	end
	return { level = "error", title = FAILED[action], detail = remote or code, lost = false }
end

-- The text to paste into an MCP client for the owner's `get_mcp_config` answer: the owner is the one place that knows the
-- command, so this only wraps it in the client's `mcpServers` shape. Nil for an answer that is not a command and arguments.
function editor_palette.mcp_text(reply: any?): string?
	local mcp = if typeof(reply) == "table" then reply.mcp else nil
	if typeof(mcp) ~= "table" or typeof(mcp.command) ~= "string" or typeof(mcp.args) ~= "table" then
		return nil
	end
	local args: { string } = {}
	for _, arg in mcp.args do
		if typeof(arg) ~= "string" then
			return nil
		end
		table.insert(args, arg)
	end
	return tern.json.encode({ mcpServers = { ["pencil-editor"] = { command = mcp.command, args = args } } }, true)
end

return editor_palette
