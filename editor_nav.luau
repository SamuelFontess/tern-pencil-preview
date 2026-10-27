--!strict
-- Going in and out of containers on the board (lib/editor_level), read from what the user does to the board's selection:
-- a double click on a container opens the board's label editor on its target, which is how it is told, and goes in; Esc or
-- a click on nothing takes the selection away, and a click on the shape outside the container selects that; either goes
-- one level out (Esc leaves a selection, so it counts as one; with nothing selected the board gives no sign of it). Every
-- step runs in a tick of its own.
local level = require("./lib/editor_level")
local Core = require("./editor_core")
local Lifecycle = require("./editor_lifecycle")
local after, bump = Lifecycle.after, Lifecycle.bump
type Session = Core.Session

-- Rebuilds the board at another level.
local function moveTo(c: WindowCx, sess: Session, to: string?)
	sess.level, sess.chosen = to, nil
	bump(c, sess, 0)
end

-- Looks at the board's selection (`board`, read at the start of the step). `proceed` runs when there is nothing to do;
-- otherwise this has taken over the step.
local function watchLevel(c: WindowCx, sess: Session, board: WhiteboardState?, proceed: (c: WindowCx) -> ())
	local tree = sess.tree
	if board == nil or tree == nil or sess.armed ~= sess.generation then
		proceed(c)
		return
	end
	local frame = sess.built_focus
	local selection = board.selection
	local only = if #selection == 1 then selection[1] else nil
	local path = if only then sess.targets.by_id[only] else nil
	if only ~= nil and only == sess.targets.up and sess.level ~= nil and frame ~= nil then
		moveTo(c, sess, level.out(tree, frame, sess.level))
		return
	end
	if only ~= nil and path ~= nil then
		sess.chosen = only
		if tree.kids[path] and path ~= sess.level and sess.label.nodes[path] == nil then
			-- A container is selected: its label editor opening is a double click on it.
			after(sess, "level_look", 0, function(c1: WindowCx)
				local ok, view = pcall(function(): any
					return c1.session:view(sess.board)
				end)
				if ok and level.editing(view) then
					moveTo(c1, sess, path)
					return
				end
				proceed(c1)
			end)
			return
		end
		proceed(c)
		return
	end
	local had = sess.chosen
	sess.chosen = nil
	if had == nil then
		proceed(c)
		return
	end
	-- What was selected is not any more: inside a container that is the way out, at the top it is nothing.
	if #selection == 0 and sess.level ~= nil and frame ~= nil then
		moveTo(c, sess, level.out(tree, frame, sess.level))
		return
	end
	proceed(c)
end

return {
	watchLevel = watchLevel,
}
