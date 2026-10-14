--!strict
-- JavaScript snippets for pen's `execute` tool and the `pen interactive` session text around them.

local doc = require("./doc")
local util = require("./util")

local script = {}

-- A JSON string is a valid JavaScript string literal.
function script.js_string(s: string): string
	return tern.json.encode(s)
end

local function formatNumber(n: number): string
	if n == math.floor(n) and math.abs(n) < 2 ^ 53 then
		return string.format("%d", n)
	end
	return string.format("%.15g", n)
end

-- The export scale for a `w` × `h` frame: at most 2, at most `max_side` px a side, 3 decimals rounded
-- down, and at most `cap` when given.
function script.fit_scale(w: number, h: number, max_side: number, cap: number?): number
	local s = math.floor(math.min(2, max_side / math.max(w, h, 1)) * 1000) / 1000
	return if cap and cap < s then cap else s
end

script.JPEG_QUALITY = 92

export type Item = { id: string, scale: number, format: string }

-- What a batch exports: `first` ahead of the other frames when it is one of `tops`, each at a scale that fits
-- its stroke inside `max_side` (at most its cap), as JPEG when the frame has a fill and PNG when it does not.
-- Tops whose id is not safe as a file name are left out.
function script.plan_batch(tops: { doc.Top }, first: string?, caps: { [string]: number }, max_side: number): { Item }
	local out: { Item } = {}
	local function add(top: doc.Top)
		local pad = 2 * top.stroke
		table.insert(out, {
			id = top.id,
			scale = script.fit_scale(top.w + pad, top.h + pad, max_side, caps[top.id]),
			format = if top.fill then "jpeg" else "png",
		})
	end
	for _, top in tops do
		if top.id == first and util.safe_id(top.id) then
			add(top)
		end
	end
	for _, top in tops do
		if top.id ~= first and util.safe_id(top.id) then
			add(top)
		end
	end
	return out
end

-- One `Export` per item into `dir` (`<dir>/<id>.<format>`), for one `execute` run before any `Get`: pen
-- exports about twice as fast then. A missing node fails the whole call; pen undoes it.
function script.exports(items: { Item }, dir: string): string
	local out: { string } = {}
	local d = script.js_string(dir)
	for _, item in items do
		local opts = "{scale:" .. formatNumber(item.scale)
		if item.format == "jpeg" then
			opts ..= ",quality:" .. formatNumber(script.JPEG_QUALITY)
		end
		table.insert(out, "Export([" .. script.js_string(item.id) .. "]," .. script.js_string(item.format) .. "," .. d .. "," .. opts .. "})")
	end
	return table.concat(out, ";")
end

-- Layer listing as a single-line IIFE so repeated calls in one interactive session never redeclare
-- globals. With `export_pick`, it also exports `want_id` (or the first top-level frame when that one
-- is gone) at a scale that fits `max_side`, at most `cap`; without it, `exported` and `scale` are null.
function script.refresh(want_id: string?, dir: string, max_side: number, cap: number?, export_pick: boolean): string
	local want = if want_id then script.js_string(want_id) else "null"
	return table.concat({
		"(()=>{const want=",
		want,
		";const dir=",
		script.js_string(dir),
		";const maxSide=",
		formatNumber(max_side),
		";const cap=",
		if cap then formatNumber(cap) else "null",
		";const L=[];const top=[];",
		"Get((n,c)=>{if(c.depth>6){c.skipChildren();return}const b=c.bounds||{};",
		'const e={id:n.id,name:n.name||"",type:n.type,d:c.depth,p:c.parentCtx?c.parentCtx.node.id:null,w:b.width,h:b.height,x:b.x,y:b.y};',
		'if(typeof n.content==="string")e.content=n.content;if(typeof n.fill==="string")e.fill=n.fill;',
		'if(n.reusable)e.reusable=true;if(typeof n.ref==="string")e.ref=n.ref;',
		"L.push(e);if(c.depth===0)top.push(e)});",
		if export_pick then "const pick=top.find(e=>e.id===want)||top[0]||null;" else "const pick=null;",
		"let scale=null;if(pick){",
		"scale=Math.floor(Math.min(2,maxSide/Math.max(pick.w||1,pick.h||1,1))*1000)/1000;",
		"if(cap!==null&&pick.id===want&&cap<scale)scale=cap;",
		'Export([pick.id],"png",dir,{scale})}',
		"Print(JSON.stringify({v:1,layers:L,exported:pick?pick.id:null,scale}))})()",
	})
end

-- Text piped to `pen interactive`: one execute call per snippet, then exit.
function script.session(snippets: { string }): string
	local out: { string } = {}
	for _, snippet in snippets do
		table.insert(out, "execute({ input: " .. script.js_string(snippet) .. " })\n")
	end
	table.insert(out, "exit()\n")
	return table.concat(out)
end

return script
