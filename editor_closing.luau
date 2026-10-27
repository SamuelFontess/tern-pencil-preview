--!strict
-- Closing and recovery: the board is the editor's only window, so closing it asks what to do with the document; a recovery
-- the owner offers is asked once, on the board. Also opening the board again in the same session.
local gesture = require("./lib/editor_gesture")
local editor_close = require("./lib/editor_close")
local label = require("./lib/editor_label")
local projection = require("./lib/editor_projection")
local util = require("./lib/util")
local Core = require("./editor_core")
local Lifecycle = require("./editor_lifecycle")
local POLL_MS, QUICK_FETCH_MS, RETRY_MS = Core.POLL_MS, Core.QUICK_FETCH_MS, Core.RETRY_MS
local SAVE_TIMEOUT_MS, remember = Core.SAVE_TIMEOUT_MS, Core.remember
local tick, timed = Core.tick, Core.timed
local after, bump, call = Lifecycle.after, Lifecycle.bump, Lifecycle.call
local closeOwner, ownerGone = Lifecycle.closeOwner, Lifecycle.ownerGone
local schedule = Lifecycle.schedule
type Session = Core.Session

local reopenBoard: (c: WindowCx, sess: Session) -> ()
local finishBoard: (sess: Session) -> ()

-- The user keeps the editor: its board opens again in the same session.
local function putBoardBack(c: WindowCx, sess: Session)
	sess.closing = false
	reopenBoard(c, sess)
end

-- What `editor_close` needs from the window. `cx` follows the newest tick, so every toast and pane call has a live one.
local function closePorts(c: WindowCx, sess: Session, stale: () -> boolean, offered: boolean?): editor_close.Ports
	local cx = c
	return {
		call = function(method, args, done)
			call(sess, method, args, if method == "get_document" then QUICK_FETCH_MS else SAVE_TIMEOUT_MS, function(reply, code, remote, c1, _request_id)
				cx = c1
				done(reply, code, remote)
			end, offered)
		end,
		pick = function(title, items, done)
			cx:pick({ items = items, placeholder = title, action = "choose" }):next(timed("close_pick", function(picked: PickItem?, _err: string?, fresh: WindowCx?)
				tick("close_choice", (fresh or cx) :: WindowCx, function(c1)
					cx = c1
					if not stale() then
						done(picked)
					end
				end)
			end))
		end,
		toast = function(level, title, detail)
			cx:toast(level, title, detail)
		end,
		close_owner = function()
			closeOwner(cx, sess)
		end,
		board_back = function()
			putBoardBack(cx, sess)
		end,
		owner_gone = function()
			ownerGone(cx, sess)
		end,
	}
end

-- The board is gone. A starting owner has nothing to save; otherwise the owner says what the document needs.
local function boardClosed(c: WindowCx, sess: Session)
	if sess.record == nil then
		closeOwner(c, sess)
		return
	end
	if sess.recovery_pick then
		-- A recovery is being decided (asked, picked or applied): its outcome settles this close, no second picker.
		sess.close_waits = true
		return
	end
	editor_close.begin(closePorts(c, sess, function(): boolean
		return not sess.alive or sess.retiring
	end), util.basename(sess.path))
end

-- A document that opens (or is picked up again) waiting for a recovery choice has it offered on its board, once. A
-- dismissed picker is asked again when the board closes.
local function offerRecovery(c: WindowCx, sess: Session)
	sess.recovery_asked = true
	sess.recovery_pick = true
	local ports = closePorts(c, sess, function(): boolean
		return not sess.alive or sess.retiring
	end, true)
	editor_close.offer(ports, util.basename(sess.path), function(how)
		sess.recovery_pick = false
		after(sess, "recovery_done", 0, function(c1: WindowCx)
			if sess.close_waits then
				-- The board was closed while the picker was open: the answer also settles the close.
				sess.close_waits = false
				if how == "resolved" then
					putBoardBack(c1, sess)
				elseif how == nil then
					boardClosed(c1, sess)
				else
					closeOwner(c1, sess)
				end
			elseif sess.closing then
				return
			elseif how == "resolved" then
				bump(c1, sess, 0)
			elseif how == "dismissed" then
				c1:toast("info", "This document is waiting for a recovery choice", "Close the board to choose")
			end
		end)
	end)
end

-- Installs the board the owner's request was answered with, in a tick of its own. Once: the tick, or the resume that finds it
-- lost, whichever comes first.
finishBoard = function(sess: Session)
	local ask = sess.board_ask
	if ask == nil then
		return
	end
	local gen, board = ask.gen, ask.board
	after(sess, "board_install", 0, function(c2: WindowCx)
		if sess.board_ask ~= ask then
			return
		end
		sess.opening_board, sess.board_ask = false, nil
		if board == nil or c2.session:pane(board) == nil then
			c2:toast("error", "The board could not be opened", "The editor stays open; run Reopen Pencil editor board")
			schedule(sess, RETRY_MS)
			return
		end
		sess.board = board
		remember(sess)
		sess.attached, sess.scene, sess.built_focus, sess.selected = nil, nil, nil, nil
		sess.chosen, sess.level, sess.tree = nil, nil, nil
		sess.framed, sess.activity_key, sess.activity_text = false, nil, nil
		sess.shown, sess.frame_rows = {}, {}
		sess.targets = { by_path = {}, by_id = {}, box = {} }
		sess.gesture, sess.label, sess.armed, sess.applied, sess.marks = gesture.new(), label.new(), nil, nil, nil
		local record = sess.record
		if record then
			sess.proj = projection.begin(record.session_id, board, gen)
			sess.frames_state = projection.begin(record.session_id, board, 0)
			sess.halos = projection.begin(record.session_id, board, gen)
		end
		schedule(sess, 0)
	end)
end

reopenBoard = function(c: WindowCx, sess: Session)
	if sess.opening_board or sess.closing or not sess.alive or sess.retiring then
		return
	end
	if sess.board ~= 0 and c.session:pane(sess.board) then
		c:toast("info", "This editor already has a board")
		return
	end
	sess.generation += 1
	local gen = sess.generation
	sess.busy, sess.holding, sess.opening_board, sess.board_ask = false, false, true, nil
	schedule(sess, POLL_MS)
	after(sess, "board_start", 0, function(c1: WindowCx)
		local ask = { gen = gen, answered = false, board = nil :: number? }
		sess.board_ask = ask
		c1.whiteboard:open({ how = "beside", focus = false }):next(timed("board_open", function(board: number?, _err: string?, _fresh: WindowCx?)
			if not sess.alive or sess.retiring or sess.board_ask ~= ask or gen ~= sess.generation then
				return
			end
			ask.answered, ask.board = true, board
			finishBoard(sess)
		end))
	end)
end

return {
	boardClosed = boardClosed,
	finishBoard = finishBoard,
	offerRecovery = offerRecovery,
	reopenBoard = reopenBoard,
}
