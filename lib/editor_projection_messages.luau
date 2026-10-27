--!strict
-- The words the board shows for each state, and what a whiteboard error says.
local projection = {}

local MESSAGES: { [string]: { string } } = {
	TRANSPORT = {
		"The editor is not answering",
		"The editor session could not be reached. Its interactive targets are removed; published images stay on the board.",
	},
	METADATA_LIMIT = {
		"The editor sent too much data",
		"A page from the editor exceeded the board's limit, so the board was not updated.",
	},
	BAD_REPLY = {
		"The editor sent an unreadable answer",
		"The board ignored it and asks again. If this repeats, restart the editor.",
	},
	VIEW_STALE = {
		"The board's view of the editor was replaced",
		"The editor no longer knows this board's view. The board reattaches and rebuilds its targets.",
	},
	OWNER_ABSENT = {
		"The editor is disconnected",
		"Its images stay on the board as a picture, without interactive targets.",
	},
	OWNER_TIMEOUT = {
		"The editor did not start",
		"No editor session appeared in time. Open the file again.",
	},
	BOARD_FAILED = {
		"The board could not be updated",
		"A whiteboard edit failed, so the board starts over from the editor's state in a moment.",
	},
	TARGETS_CAPPED = {
		"Only the first click targets are shown",
		"This frame has more elements than the board shows as click targets.",
	},
	TARGETS_RESTORED = {
		"Some board shapes were missing and were restored",
		"A click target had been deleted or undone on the board. The document was not changed by that; the board shows it again.",
	},
	NOT_MOVABLE = {
		"Can't move this element on the board",
		"An auto-layout parent decides where it sits, so the board puts it back.",
	},
	NOT_RESIZABLE = {
		"Can't resize this element on the board",
		"Its size is automatic (fit, fill or a variable), so the board puts it back.",
	},
	GEOMETRY_CONTROLLED_BY_LAYOUT = {
		"Can't move this element on the board",
		"An auto-layout parent decides where it sits, so the board puts it back.",
	},
	GEOMETRY_SIZE_AMBIGUOUS = {
		"Can't resize this element on the board",
		"Its size is automatic (fit, fill or a variable), so the board puts it back.",
	},
	GEOMETRY_AMBIGUOUS = {
		"Can't apply that change from the board",
		"The element is hidden, clipped, rotated or scaled, so the board puts it back.",
	},
	GEOMETRY_TARGET_MISSING = {
		"That element is no longer in the document",
		"The board is drawn again from the document.",
	},
	GEOMETRY_TOO_MANY = {
		"Too many elements changed at once",
		"Move fewer elements together; the board puts them back.",
	},
	GEOMETRY_INVALID = {
		"The board could not read that change",
		"The board puts the elements back.",
	},
	GEOMETRY_NOT_TEXT = {
		"Can't edit that text from the board",
		"Only a text element with plain text can be edited on the board (not one bound to a variable or inside a component). The board is drawn again from the document.",
	},
	LABEL_DISCARDED = {
		"Only text elements take text on the board",
		"The text typed on this element was removed; the document was not changed.",
	},
}

-- The title and detail shown for a visible state; an unknown code is shown by its name rather than hidden. A refusal by
-- the layout names the layout (the owner's `horizontal` or `vertical`) when it is known.
function projection.message(code: string, layout: string?): (string, string)
	local known = MESSAGES[code]
	if known and code == "GEOMETRY_CONTROLLED_BY_LAYOUT" and layout ~= nil then
		return known[1], `A {layout} auto-layout parent decides where it sits. Drop it between its siblings inside that parent to reorder it; anywhere else the board puts it back.`
	elseif known then
		return known[1], known[2]
	end
	return "The editor answered with " .. code, "The board keeps what it shows and tries again."
end

local START_FAILURES: { [string]: { string } } = {
	ALREADY_OPEN = {
		"This file is already open in another Pencil editor",
		"Close that editor, then open the file again.",
	},
	SOURCE_CHANGED = {
		"The file changed while the editor was opening it",
		"Another program wrote to it. Open the file again.",
	},
	SOURCE_UNAVAILABLE = {
		"The editor could not read the file",
		"Check that it still exists and can be read, then open it again.",
	},
	LOCK_UNAVAILABLE = {
		"The editor could not lock the file",
		"Its lock in the plugin's data folder could not be written. Open the file again.",
	},
	SOURCE_LOCK_INVALID = {
		"The editor could not take over the file's old lock",
		"The lock left by an earlier editor is not one it can verify. Open the file again.",
	},
	ENGINE_EOF = {
		"The Pen engine stopped while starting",
		"Check that the Pen CLI runs from a terminal, then open the file again.",
	},
	ENGINE_START = {
		"The Pen engine did not start",
		"Check that the Pen CLI runs from a terminal, then open the file again.",
	},
	ENGINE_TIMEOUT = {
		"The Pen engine did not start in time",
		"Open the file again; if it repeats, check that the Pen CLI runs from a terminal.",
	},
}

-- Why an editor program that exited before it published its session did not start. `code` is the error code it left (nil
-- when it left none: Node missing, a crash, an owner too old to say); `status` is the exit status of its process.
function projection.start_failure(code: string?, status: number): (string, string)
	local known = if code then START_FAILURES[code] else nil
	if known then
		return known[1], known[2]
	elseif code then
		return "The editor stopped before it opened", `It reported {code} (exit status {status}). Open the file again.`
	end
	return "The editor stopped before it opened", `It exited with status {status} without saying why. Open the file again; if it repeats, check that Node and the Pen CLI run from a terminal.`
end

-- Whether a whiteboard error says a shape id is not on the board. The host's text for a read or edit naming a missing
-- shape is `runtime error: no shape <16 hex digits>` (an edit adds `Nothing changed: edit N (op): ` before it).
function projection.is_missing_shape(err: any): boolean
	local text = tostring(err)
	local id = "no shape " .. string.rep("%x", 16) .. "%f[%X]"
	return text:find("runtime error: " .. id) ~= nil or text:find("%): " .. id) ~= nil
end

-- The id a whiteboard "no shape <16 hex>" error names, or nil when the error says something else.
function projection.missing_id(err: any): string?
	local text = tostring(err)
	local id = text:match("runtime error: no shape (%x+)%f[%X]") or text:match("%): no shape (%x+)%f[%X]")
	if id ~= nil and #id == 16 then
		return id
	end
	return nil
end

return projection
