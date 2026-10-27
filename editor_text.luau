--!strict
-- The text the user types on the board (lib/editor_label): the target of a text node is filled with the node's text while
-- it is selected, and what the user changed is sent to the owner as the node's content. The owner stays the source of
-- truth (it checks the revision and the node), the board is drawn again from the document afterwards, and only the window
-- that holds the owner's lease ever sends anything. Every step runs in a tick of its own.
local editor_launch = require("./lib/editor_launch")
local label = require("./lib/editor_label")
local Core = require("./editor_core")
local Lifecycle = require("./editor_lifecycle")
local Build = require("./editor_build")
local QUICK_FETCH_MS, announce, tick, timed = Core.QUICK_FETCH_MS, Core.announce, Core.tick, Core.timed
local after, bump, call, fail = Lifecycle.after, Lifecycle.bump, Lifecycle.call, Lifecycle.fail
local present = Lifecycle.present
local showActivity = Build.showActivity
type Session = Core.Session

-- The node changed while the user was typing on it: their label stays on the board and they decide, on the board itself.
-- Dismissing keeps the label; it is asked again only when the label changes (it is then sent, and refused, again).
local function askConflict(c: WindowCx, sess: Session)
	local state = sess.label
	if state.picking then
		return
	end
	state.picking = true
	c:pick({
		items = {
			{ label = "Keep my text", detail = "Send what you typed over the text the element has now", answer = "mine" },
			{ label = "Keep the document's text", detail = "Drop what you typed here and show the element's text", answer = "document" },
		},
		placeholder = "This text changed while you were editing it",
		action = "choose",
	}):next(timed("label_pick", function(picked: PickItem?, _err: string?, fresh: WindowCx?)
		tick("label_choice", (fresh or c) :: WindowCx, function(c1: WindowCx)
			state.picking = false
			if not sess.alive or sess.retiring or picked == nil then
				return
			end
			local edits = label.decide(state, (picked :: any).answer == "mine")
			if #edits > 0 and c1.session:pane(sess.board) ~= nil then
				pcall(function()
					return c1.whiteboard:edit(sess.board, edits)
				end)
			end
		end)
	end))
end

-- Sends the text the user typed to the owner as a capture of its own (no panel in between). `proceed` runs only when the
-- owner was too busy to answer (the same text is offered again at a later look); otherwise the board is drawn again from
-- the document, whatever the owner said.
local function applyText(c: WindowCx, sess: Session, change: label.Change, proceed: (c: WindowCx) -> ())
	local state, gen = sess.label, sess.generation
	sess.gestures += 1
	local capture_id = sess.launch_id .. "-g" .. tostring(sess.gestures)
	showActivity(c, sess, { state = "working", phase = "applying", revision = sess.scene }, function(c0: WindowCx)
		local args = {
			capture_id = capture_id, direct = true, scene_revision = sess.scene or 0,
			changes = tern.json.array(), texts = { { path = change.path, content = change.content, base = change.base } },
		}
		call(sess, "submit_capture", args, QUICK_FETCH_MS, function(reply, code, remote, c1, request_id)
			state.watching = nil
			if reply == nil then
				if remote == "GEOMETRY_CAPTURE_STALE" then
					proceed(c1)
				else
					fail(c1, sess, code or "BAD_REPLY", remote)
				end
				return
			end
			if not editor_launch.captured(reply, request_id, gen, capture_id) then
				fail(c1, sess, "BAD_REPLY")
				return
			end
			if reply.outcome == "refused" and reply.code == "GEOMETRY_TEXT_CONFLICT" then
				label.settled(state, change, "text_conflict", if typeof(reply.current) == "string" then reply.current else nil)
				askConflict(c1, sess)
			else
				if reply.outcome == "refused" and typeof(reply.code) == "string" then
					announce(c1, sess, reply.code)
				end
				label.settled(state, change, reply.outcome)
			end
			bump(c1, sess, 0)
		end)
	end)
end

-- The one target the board has selected, if it is exactly one and it is a click target.
local function selectedTarget(sess: Session, board: WhiteboardState): string?
	local selection = board.selection
	if #selection == 1 and sess.targets.by_id[selection[1]] ~= nil then
		return selection[1]
	end
	return nil
end

-- Looks at the target the user has selected (and the one being edited, if that is another): fills it, clears it, or sends
-- what was typed. `board` is the board as read at the start of the step. `proceed` runs when there is nothing to do or the
-- owner was busy; otherwise this has taken over the step. A look costs one small read, and none while nothing is selected.
local function watchText(c: WindowCx, sess: Session, board: WhiteboardState?, proceed: (c: WindowCx) -> ())
	local state = sess.label
	if board == nil or sess.armed ~= sess.generation or state.watching == sess.generation then
		proceed(c)
		return
	end
	local selected = selectedTarget(sess, board)
	if selected == nil and state.active == nil then
		proceed(c)
		return
	end
	local gen = sess.generation
	state.watching = gen
	after(sess, "label_look", 0, function(c1: WindowCx)
		local ids: { string } = {}
		if state.active then
			table.insert(ids, state.active.id)
		end
		if selected and selected ~= (if state.active then state.active.id else nil) then
			table.insert(ids, selected)
		end
		local there, shapes = present(c1, sess, ids)
		local labels: { [string]: string } = {}
		for id in there do
			local shape = shapes[id]
			if shape == nil then
				-- A shape the board would not read for now is not a shape that is gone: look again later.
				state.watching = nil
				proceed(c1)
				return
			end
			labels[id] = shape.text or ""
		end
		-- The read and the text write its answer decides share this tick, as they always did: apart, what the user types in
		-- between would be overwritten. The notices (a toast, the conflict pick, the owner request) follow in a tick of their own.
		local plan = label.look(state, { now = tern.now(), selected = selected, undo = board.undo, labels = labels, paths = sess.targets.by_id })
		if #plan.edits > 0 then
			local ok = pcall(function()
				return c1.whiteboard:edit(sess.board, plan.edits)
			end)
			if not ok then
				-- What the board was meant to show was not drawn: forget the edit, and the next look starts it again.
				state.active = nil
			end
		end
		-- Ungated: a bump of the generation between the read and this tick must not drop a question the read already
		-- marked as asked (`active.asked`); what follows the notices (the owner request, the next step) is the view's, and
		-- stops with it.
		after(sess, "label_notice", 0, function(c2: WindowCx)
			if plan.discarded then
				announce(c2, sess, "LABEL_DISCARDED")
			end
			if plan.ask then
				askConflict(c2, sess)
			end
			if gen ~= sess.generation then
				return
			end
			if plan.apply then
				applyText(c2, sess, plan.apply, proceed)
				return
			end
			state.watching = nil
			proceed(c2)
		end, true)
	end)
end

return {
	watchText = watchText,
}
