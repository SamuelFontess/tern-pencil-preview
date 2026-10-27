--!strict
-- What the window does when a document needs a decision: closing the board (end the editor, ask about unsaved work, or
-- put the board back) and a document that opens waiting for a recovery choice. The flow asks the owner and the user
-- through `Ports`, so the window supplies its panes and requests and this module only decides.

local editor_close = {}

export type Ports = {
	-- One request to the owner; `done` gets its reply, or nil with the failure code (and the owner's own code).
	call: (method: string, args: { [string]: any }, done: (reply: any?, code: string?, remote: string?) -> ()) -> (),
	-- Asks the user; `done` gets the chosen row, or nil when the picker was dismissed.
	pick: (title: string, items: { PickItem }, done: (picked: PickItem?) -> ()) -> (),
	toast: (level: ToastLevel, title: string, detail: string?) -> (),
	-- Ends the editor: the owner is asked to end and closes its document.
	close_owner: () -> (),
	-- The editor stays; its board opens again.
	board_back: () -> (),
	-- The owner cannot be reached any more.
	owner_gone: () -> (),
}

-- How an offered recovery ended.
export type Recovery = "resolved" | "dismissed" | "failed"

local RECOVERY: { [string]: boolean } = { recover = true, discard = true, copy = true }
local DONE_TEXT: { [string]: string } = {
	recover = "Your unsaved edits were recovered",
	discard = "Using the file as it is on disk",
	copy = "A recovery copy was written",
}

local function lost(code: string?): boolean
	return code == "TRANSPORT" or code == "OWNER_ABSENT"
end

local function disconnected(reply: any): boolean
	return typeof(reply.activity) == "table" and reply.activity.state == "disconnected"
end

-- The picker rows for the choices the owner says the document accepts.
local function recovery_items(choices: any): { PickItem }
	local items: { PickItem } = {}
	if typeof(choices) == "table" then
		for _, entry in choices do
			if typeof(entry) == "table" and typeof(entry.choice) == "string" and RECOVERY[entry.choice] and typeof(entry.label) == "string" then
				table.insert(items, {
					label = entry.label,
					detail = if typeof(entry.detail) == "string" then entry.detail else nil,
					choice = entry.choice,
				})
			end
		end
	end
	return items
end

-- Asks which recovery to run for a `get_document` reply in the recovering phase, and runs it.
local function recover(ports: Ports, reply: any, name: string, done: (how: Recovery) -> ())
	local items = recovery_items(reply.recovery_choices)
	if #items == 0 then
		ports.toast("error", "This document needs a recovery the board cannot offer", name)
		done("failed")
		return
	end
	ports.pick("Unsaved edits from an earlier session in " .. name, items, function(picked)
		local choice = if picked then picked.choice else nil
		if typeof(choice) ~= "string" or not RECOVERY[choice] then
			done("dismissed")
			return
		end
		ports.call("resolve_recovery", { choice = choice }, function(result, code, remote)
			if result == nil then
				if lost(code) then
					ports.owner_gone()
					return
				end
				ports.toast("error", "The recovery was not applied", remote or code)
				done("failed")
				return
			end
			local copy = result.recovery_copy
			ports.toast("info", DONE_TEXT[choice] :: string, if typeof(copy) == "string" then copy else nil)
			done("resolved")
		end)
	end)
end

-- A document that opened waiting for a recovery choice: ask the owner what it accepts and offer it on the board.
function editor_close.offer(ports: Ports, name: string, done: (how: Recovery?) -> ())
	ports.call("get_document", {}, function(reply, code)
		if reply == nil or disconnected(reply) then
			if reply ~= nil or lost(code) then
				ports.owner_gone()
			else
				done(nil)
			end
			return
		end
		if reply.phase ~= "recovering" then
			done(nil)
			return
		end
		recover(ports, reply, name, done)
	end)
end

local ANSWERS: { [string]: string } = { save = "save_document", discard = "discard_unsaved", copy = "save_recovery_copy" }
local FAILED: { [string]: string } = {
	save_document = "The changes were not saved",
	discard_unsaved = "The changes were not discarded",
	save_recovery_copy = "The recovery copy was not written",
}

local ask_conflict: (ports: Ports, reply: any, name: string) -> ()

-- Runs the user's answer on the owner; the editor ends only once it was done. A Save that finds the file changed on
-- disk (the document stays ready) is offered again as a recovery copy, a discard or back.
local function act(ports: Ports, reply: any, name: string, method: string)
	ports.call(method, { session_id = reply.session_id, base_revision = reply.revision }, function(result, code, remote)
		if result ~= nil then
			if method == "save_recovery_copy" then
				ports.toast("info", "A recovery copy was written", if typeof(result.path) == "string" then result.path else nil)
			end
			ports.close_owner()
		elseif lost(code) then
			ports.owner_gone()
		elseif method == "save_document" and remote == "SOURCE_CHANGED" then
			ask_conflict(ports, reply, name)
		else
			ports.toast("error", FAILED[method] :: string, remote or code)
			ports.board_back()
		end
	end)
end

local function method_of(picked: PickItem?): string?
	return if picked and typeof(picked.answer) == "string" then ANSWERS[picked.answer :: string] else nil
end

ask_conflict = function(ports, reply, name)
	local items: { PickItem } = {
		{ label = "Save a recovery copy", detail = "Write your edits next to the original, then close the editor", answer = "copy" },
		{ label = "Discard", detail = "Close the editor without saving", answer = "discard" },
		{ label = "Back", detail = "Keep editing: bring the board back", answer = "reopen" },
	}
	ports.pick("The file changed outside Tern: " .. name, items, function(picked)
		local method = method_of(picked)
		if method == nil or method == "save_document" then
			ports.board_back()
		else
			act(ports, reply, name, method)
		end
	end)
end

local function ask_unsaved(ports: Ports, reply: any, name: string)
	local items: { PickItem } = {
		{ label = "Save", detail = "Write the changes to the .pen file, then close the editor", answer = "save" },
		{ label = "Discard", detail = "Close the editor without saving; the .pen file stays as it is", answer = "discard" },
		{ label = "Back", detail = "Keep editing: bring the board back", answer = "reopen" },
	}
	ports.pick("Unsaved changes in " .. name, items, function(picked)
		local method = method_of(picked)
		if method == nil or method == "save_recovery_copy" then
			ports.board_back()
		else
			act(ports, reply, name, method)
		end
	end)
end

-- The board was closed. A document that is not `ready` and cannot be saved or discarded (blocked, recovering) never
-- leads back to the board in a loop: the user chooses, or the editor ends and its confirmed edits stay on disk.
function editor_close.begin(ports: Ports, name: string)
	ports.call("get_document", {}, function(reply, code, remote)
		if reply == nil then
			if lost(code) then
				ports.owner_gone()
			else
				ports.toast("error", "The editor could not say whether it has unsaved changes", remote or code)
				ports.board_back()
			end
			return
		end
		if disconnected(reply) then
			ports.owner_gone()
		elseif reply.phase == "blocked" then
			ports.toast("error", "This document is blocked, so the editor was closed", "Its confirmed edits stay on disk; open the file again to recover them")
			ports.close_owner()
		elseif reply.phase == "recovering" then
			recover(ports, reply, name, function(how)
				if how == "resolved" then
					ports.board_back()
				else
					ports.close_owner()
				end
			end)
		elseif reply.dirty == true then
			ask_unsaved(ports, reply, name)
		elseif reply.dirty == false then
			ports.close_owner()
		else
			ports.toast("error", "The editor could not say whether it has unsaved changes")
			ports.board_back()
		end
	end)
end

return editor_close
