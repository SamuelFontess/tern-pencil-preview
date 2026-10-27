--!strict
-- Pure rules of the board mirror: the pen snippet that exports only the frames whose content changed, how its
-- answer is read, and the whiteboard edits that bring the board in line with it.
local mirror = {}

mirror.MAX_SIDE = 4096
-- Each frame is exported at 1x PNG: sharp text and about 25 MP of textures for a 17-frame file. JPEG at 2x was
-- blurred by the compression and stuttered at ~100 MP.
mirror.CAP = 1

-- A top-level frame as pen measured it. `key` hashes its content; `exported` says this run wrote its image; `file` names
-- that image when it is not `<dir>/<id>.png` (the native editor's renderer publishes by content key).
export type Frame = { id: string, x: number, y: number, w: number, h: number, key: string, fill: boolean, exported: boolean, file: string? }
-- What the board shows for a frame: the image shape, the backing shape (frames without a fill), the key it was
-- drawn from and the folder holding the image file.
export type Shown = { shape: string, bg: string?, key: string, dir: string }
export type Plan = { edits: { WhiteboardEdit }, replaced: { string }, gone: { string }, missing: { string } }

local MARK = '{"v":1,"frames":'

-- One line of JavaScript for `pen interactive`. For every top-level frame it hashes the frame's content and exports
-- `<dir>/<id>.png` when the hash differs from `prev[id]` (or `force`), then prints `{"v":1,"frames":[…]}` with the
-- bounds pen measured. Ids that are not safe file names are skipped: pen names the file after the id.
function mirror.script(prev: { [string]: string }, force: boolean, dir: string): string
	return table.concat({
		"(()=>{const P=",
		tern.json.encode(prev),
		",F=",
		if force then "true" else "false",
		",D=",
		tern.json.encode(dir),
		",C=",
		tostring(mirror.CAP),
		",M=",
		tostring(mirror.MAX_SIDE),
		[==[;const R=[];const H=s=>{let h=2166136261;for(let i=0;i<s.length;i++){h^=s.charCodeAt(i);h=Math.imul(h,16777619)}return(h>>>0).toString(16)+'.'+s.length};]==],
		[==[const OK=id=>typeof id==='string'&&id!==''&&!/[\/\\:\u0000-\u001f]/.test(id)&&id.indexOf('..')<0;]==],
		[==[Get((n,c)=>{if(c.depth===0){if(n.type==='frame'&&OK(n.id)){const b=c.bounds||{},w=b.width||0,h=b.height||0,k=H(JSON.stringify(n)),]==],
		[==[o=Object.prototype.hasOwnProperty.call(P,n.id)?P[n.id]:null,e=F||o!==k;]==],
		[==[if(e){Export([n.id],'png',D,{scale:Math.floor(Math.min(C,M/Math.max(w,h,1))*1000)/1000})}]==],
		[==[R.push({id:n.id,x:b.x||0,y:b.y||0,w:w,h:h,k:k,f:n.fill!=null,e:e})}c.skipChildren()}});]==],
		[==[Print(JSON.stringify({v:1,frames:R}))})()]==],
	})
end

local function num(v: any): number
	return if typeof(v) == "number" then v else 0
end

-- The frames in pen's answer (document order), or nil and why.
function mirror.parse(stdout: string): ({ Frame }?, string?)
	local at = stdout:find(MARK, 1, true)
	if at == nil then
		return nil, "pen printed no frame list"
	end
	local nl = stdout:find("\n", at, true)
	local line = stdout:sub(at, if nl then nl - 1 else #stdout):gsub("\r$", "")
	local ok, decoded = pcall(tern.json.decode, line)
	if not ok or typeof(decoded) ~= "table" or typeof((decoded :: any).frames) ~= "table" then
		return nil, "invalid frame list"
	end
	local out: { Frame } = {}
	for _, e in (decoded :: any).frames :: { any } do
		if typeof(e) == "table" and typeof(e.id) == "string" and typeof(e.k) == "string" then
			table.insert(out, { id = e.id, x = num(e.x), y = num(e.y), w = num(e.w), h = num(e.h), key = e.k, fill = e.f == true, exported = e.e == true })
		end
	end
	return out, nil
end

-- The keys the board was drawn from, for the next snippet to compare against.
function mirror.prev(shown: { [string]: Shown }): { [string]: string }
	local out: { [string]: string } = {}
	for id, s in shown do
		out[id] = s.key
	end
	return out
end

-- Every frame must export when what frames share changed (`seed`, see cache.shared_seed) or nothing is shown yet.
function mirror.force(shown: { [string]: Shown }, last_seed: string?, seed: string): boolean
	return last_seed ~= seed or next(shown) == nil
end

local function drawable(f: Frame): boolean
	return f.w > 0 and f.h > 0
end

local function drop(edits: { WhiteboardEdit }, s: Shown)
	local ids = if s.bg then { s.shape, s.bg } else { s.shape }
	-- A locked shape cannot be deleted.
	table.insert(edits, { op = "unlock", ids = ids })
	table.insert(edits, { op = "delete", ids = ids })
end

-- The edits that make the board show `frames`: a frame exported this run gets a new image (its old shapes go),
-- one pen did not export keeps what it has, a frame that is gone or has no area loses its shapes. `missing` lists
-- frames pen exported whose file is not there; they keep their old image. `exists` tells whether a file is there.
function mirror.plan(shown: { [string]: Shown }, frames: { Frame }, dir: string, exists: (string) -> boolean): Plan
	local edits: { WhiteboardEdit } = {}
	local replaced: { string } = {}
	local missing: { string } = {}
	local seen: { [string]: boolean } = {}
	for _, f in frames do
		if not drawable(f) then
			continue
		end
		seen[f.id] = true
		if not f.exported then
			continue
		end
		local file = f.file or (dir .. "/" .. f.id .. ".png")
		if not exists(file) then
			table.insert(missing, f.id)
			continue
		end
		local old = shown[f.id]
		if old then
			drop(edits, old)
		end
		if not f.fill then
			-- A frame without a fill exports with a transparent background: back it with white.
			local bg = "bg:" .. f.id
			table.insert(edits, { op = "add", type = "rect", ref = bg, x = f.x, y = f.y, w = f.w, h = f.h, fill = "#ffffff" })
			table.insert(edits, { op = "order", id = bg, to = "back" })
			table.insert(edits, { op = "lock", id = bg })
		end
		local ref = "img:" .. f.id
		table.insert(edits, { op = "add", type = "image", ref = ref, path = file, x = f.x, y = f.y, w = f.w })
		table.insert(edits, { op = "order", id = ref, to = "back" })
		table.insert(edits, { op = "lock", id = ref })
		table.insert(replaced, f.id)
	end
	local gone: { string } = {}
	for id in shown do
		if not seen[id] then
			table.insert(gone, id)
		end
	end
	table.sort(gone)
	for _, id in gone do
		drop(edits, shown[id])
	end
	return { edits = edits, replaced = replaced, gone = gone, missing = missing }
end

-- Records in `shown` what an applied plan did, from the `refs` the whiteboard call answered. A frame whose image
-- shape is not in `refs` shows nothing, so the next run exports it again.
function mirror.adopt(shown: { [string]: Shown }, plan: Plan, frames: { Frame }, refs: { [string]: string }, dir: string)
	local byId: { [string]: Frame } = {}
	for _, f in frames do
		byId[f.id] = f
	end
	for _, id in plan.gone do
		shown[id] = nil
	end
	for _, id in plan.replaced do
		local shape = refs["img:" .. id]
		shown[id] = nil
		if shape and byId[id] then
			shown[id] = { shape = shape, bg = refs["bg:" .. id], key = byId[id].key, dir = dir }
		end
	end
end

-- Names of the image folders `shown` still uses (the last segment of each `dir`).
function mirror.used_dirs(shown: { [string]: Shown }): { [string]: boolean }
	local out: { [string]: boolean } = {}
	for _, s in shown do
		local name = s.dir:match("[^/]+$")
		if name then
			out[name] = true
		end
	end
	return out
end

return mirror
