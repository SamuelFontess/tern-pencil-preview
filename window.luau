--!strict
-- The window half: `.pen` files opened from the Files pane, the palette or
-- `tern open` go to the Pencil Preview block instead of the editor, unless
-- the command "Toggle Pencil Preview for .pen opens" turned that off.

-- The kv key of the switch; absent means on.
local ROUTE_KEY = "route_pen"

-- Read on every open: `tern.kv` is one store for every window, so a toggle
-- in one window applies in the others at once.
local function enabled(): boolean
	return tern.kv.get(ROUTE_KEY) ~= false
end

tern.command({
	id = "toggle_route",
	title = "Toggle Pencil Preview for .pen opens",
	icon = "pen",
	run = function(cx: WindowCx)
		local on = not enabled()
		tern.kv.set(ROUTE_KEY, on)
		if on then
			cx:toast("success", ".pen files open in Pencil Preview", "Open with › Pencil Preview still works")
		else
			cx:toast("info", ".pen files open in the editor", "Open with › Pencil Preview still works")
		end
	end,
})

tern.route.open(function(req: OpenRequest, _cx: WindowCx): RouteDecision?
	if not enabled() then
		return nil
	end
	-- Only a plain open: a placement or a line to reveal asks for the editor.
	if req.how ~= "default" or req.line ~= nil then
		return nil
	end
	if req.origin ~= "files" and req.origin ~= "palette" and req.origin ~= "cli" then
		return nil
	end
	if string.lower(string.sub(req.path, -4)) ~= ".pen" then
		return nil
	end
	return { block = "pencil-preview.preview", args = { req.path } }
end)
