--!strict
-- JavaScript snippets for pen's `execute` tool and the `pen interactive` session text around them.

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

-- Layer listing plus PNG export of one top-level frame, as a single-line IIFE so repeated calls in
-- one interactive session never redeclare globals.
function script.refresh(want_id: string?, dir: string, max_side: number): string
	local want = if want_id then script.js_string(want_id) else "null"
	return table.concat({
		"(()=>{const want=",
		want,
		";const dir=",
		script.js_string(dir),
		";const maxSide=",
		formatNumber(max_side),
		";const L=[];const top=[];",
		"Get((n,c)=>{if(c.depth>6){c.skipChildren();return}const b=c.bounds||{};",
		'const e={id:n.id,name:n.name||"",type:n.type,d:c.depth,p:c.parentCtx?c.parentCtx.node.id:null,w:b.width,h:b.height,x:b.x,y:b.y};',
		'if(typeof n.content==="string")e.content=n.content;if(typeof n.fill==="string")e.fill=n.fill;',
		'if(n.reusable)e.reusable=true;if(typeof n.ref==="string")e.ref=n.ref;',
		"L.push(e);if(c.depth===0)top.push(e)});",
		"const pick=top.find(e=>e.id===want)||top[0]||null;let scale=null;",
		"if(pick){scale=Math.floor(Math.min(2,maxSide/Math.max(pick.w||1,pick.h||1,1))*1000)/1000;",
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
