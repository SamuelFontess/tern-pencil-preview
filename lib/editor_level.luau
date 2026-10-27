--!strict
-- Which level of a frame the board's click targets show. At rest a frame's targets are its direct children, so a click
-- picks the outer element; a double click on a container goes in (its children are the targets), and Esc or a click
-- outside it comes back out one level. Pure: the window reads the board and the owner and calls these.
local level = {}

-- `parent` maps an element path to its parent's path (a frame has none), `kids` holds the paths that have children.
export type Tree = { parent: { [string]: string }, kids: { [string]: boolean } }

function level.tree(rows: { any }): Tree
	local tree: Tree = { parent = {}, kids = {} }
	for _, row in rows do
		if typeof(row) == "table" and typeof(row.path) == "string" and typeof(row.parent_path) == "string" then
			tree.parent[row.path] = row.parent_path
			tree.kids[row.parent_path] = true
		end
	end
	return tree
end

-- `path` if it is an element of this frame that has children, else nil (a level the document no longer has).
function level.valid(tree: Tree, path: string?): string?
	if path ~= nil and tree.kids[path] and tree.parent[path] ~= nil then
		return path
	end
	return nil
end

-- The level outside `inside`: its parent's, or nil (the frame's own) when the parent is the frame.
function level.out(tree: Tree, frame: string, inside: string): string?
	local parent = tree.parent[inside]
	if parent == frame then
		return nil
	end
	return parent
end

-- Whether the board's view tree shows the label editor of a shape (a text field the user types in): a double click on a
-- rectangle opens it, and it is the only signal the board gives of one.
function level.editing(view: any): boolean
	if typeof(view) ~= "table" then
		return false
	end
	if view.role == "MultilineTextInput" then
		return true
	end
	if typeof(view.children) == "table" then
		for _, child in view.children do
			if level.editing(child) then
				return true
			end
		end
	end
	return false
end

return level
