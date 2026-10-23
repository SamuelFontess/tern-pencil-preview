--!strict
-- The window half: `.pen` files opened from the Files pane, the palette or
-- `tern open` go to the Pencil Preview block instead of the editor, unless
-- the command "Toggle Pencil Preview for .pen opens" turned that off.

-- The board's lib/ chain is large; a window hook has a 50 ms budget and requiring the whole chain
-- in one hook (here, or inside board.luau's own top level) blows it. Each module loads in its own
-- timer tick instead, and only when "Open Pencil board (live mirror)" first runs: the default
-- route above needs none of them.
type Loader = { name: string, load: () -> () }
local BOARD_LOADERS: { Loader } = {
	{ name = "load_cache", load = function() require("./lib/cache") end },
	{ name = "load_launch", load = function() require("./lib/launch") end },
	{ name = "load_mirror", load = function() require("./lib/mirror") end },
	{ name = "load_script", load = function() require("./lib/script") end },
	{ name = "load_util", load = function() require("./lib/util") end },
}

local function loadBoard(index: number, last: WindowCx)
	tern.timer(0, function(fresh: WindowCx?)
		local loader = BOARD_LOADERS[index]
		if fresh == nil then
			-- No fresh context means nothing can run the command now; say so on the last good one.
			pcall(function()
				last:toast("error", "The board could not be opened", "Run the command again")
			end)
			return
		end
		if loader then
			loader.load()
			loadBoard(index + 1, fresh)
		else
			require("./board").open(fresh)
		end
	end)
end

-- The kv key of the switch; absent means on.
local ROUTE_KEY = "route_pen"

-- Read on every open: `tern.kv` is one store for every window, so a toggle
-- in one window applies in the others at once.
local function enabled(): boolean
	return tern.kv.get(ROUTE_KEY) ~= false
end

tern.command({
	id = "board",
	title = "Open Pencil board (live mirror)",
	icon = "pen",
	run = function(cx: WindowCx)
		loadBoard(1, cx)
	end,
})

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
	-- A line to reveal asks for the editor.
	if req.line ~= nil then
		return nil
	end
	-- From the Files pane and the palette only a plain open counts (a
	-- placement asks for the editor). `tern open` is claimed whatever its
	-- placement: the CLI picks one (e.g. "beside") for every file.
	if req.origin == "cli" then
		-- any placement
	elseif req.origin == "files" or req.origin == "palette" then
		if req.how ~= "default" then
			return nil
		end
	else
		return nil
	end
	if string.lower(string.sub(req.path, -4)) ~= ".pen" then
		return nil
	end
	return { block = "pencil-preview.preview", args = { req.path } }
end)
