--!strict
-- The palette's Save, Undo and Redo, window half: finds the session (lib/editor_palette), asks the owner for the document's
-- revision and then for the action, and tells the user how it went. The board follows by itself: the owner's answer to the
-- loop's held poll changes with the revision and the saved state, so the board is rebuilt and its status line redrawn.
local editor_palette = require("./lib/editor_palette")
local registry = require("./lib/editor_registry")
local util = require("./lib/util")
local Core = require("./editor_core")
local Lifecycle = require("./editor_lifecycle")
local Adopt = require("./editor_adopt")
local QUICK_FETCH_MS, SAVE_TIMEOUT_MS, sessions = Core.QUICK_FETCH_MS, Core.SAVE_TIMEOUT_MS, Core.sessions
local call, ownerGone = Lifecycle.call, Lifecycle.ownerGone
type Session = Core.Session

local ASKS: { [string]: string } = {
	save = "Focus the board of the one to save", undo = "Focus the board of the one to undo",
	redo = "Focus the board of the one to redo", mcp = "Focus the board of the one to copy the MCP configuration of",
}

local function run(c: WindowCx, action: editor_palette.Action | "mcp")
	Adopt.whenAdopted(c, function(c1: WindowCx)
		local scope = registry.scope(c1)
		local candidates: { editor_palette.Candidate } = {}
		for id, sess in sessions do
			if sess.alive and not sess.retiring and not sess.closing and sess.record ~= nil and sess.scope == scope then
				local pane = if sess.board ~= 0 then c1.session:pane(sess.board) else nil
				table.insert(candidates, { id = id, board = sess.board, tab = if pane then pane.tab else nil })
			end
		end
		local focused = c1.session:focused()
		local here = if focused then c1.session:pane(focused) else nil
		local choice = editor_palette.choose(candidates, focused, if here then here.tab else nil)
		if choice.kind == "none" then
			c1:toast("info", "No Pencil editor is open", "Open a .pen file first")
			return
		elseif choice.kind == "ask" then
			c1:toast("info", "Several Pencil editors are open", ASKS[action])
			return
		end
		local sess = sessions[choice.id]
		local name = util.basename(sess.path)
		if action == "mcp" then
			call(sess, "get_mcp_config", {}, QUICK_FETCH_MS, function(reply, code, remote, c2)
				local text = editor_palette.mcp_text(reply)
				if text ~= nil then
					c2:copy(text)
					c2:toast("success", "MCP configuration copied", "For " .. name .. ": paste it into your MCP client's settings")
				elseif code == "TRANSPORT" or code == "OWNER_ABSENT" then
					ownerGone(c2, sess)
				else
					c2:toast("error", "The MCP configuration was not copied", remote or code)
				end
			end, true)
			return
		end
		local verb: editor_palette.Action = action
		local function finish(reply: any?, code: string?, remote: string?, c2: WindowCx)
			local verdict = editor_palette.verdict(verb, name, reply, code, remote)
			if verdict.lost then
				ownerGone(c2, sess)
			else
				c2:toast(verdict.level, verdict.title, verdict.detail)
			end
		end
		-- `keep`: the answer matters whatever the board did meanwhile (a rebuild must not swallow the user's Save).
		call(sess, "get_document", {}, QUICK_FETCH_MS, function(doc, code, remote, c2)
			if doc == nil then
				finish(nil, code, remote, c2)
				return
			end
			call(sess, editor_palette.METHOD[verb], { session_id = doc.session_id, base_revision = doc.revision }, SAVE_TIMEOUT_MS, finish, true)
		end, true)
	end)
end

return { run = run }
