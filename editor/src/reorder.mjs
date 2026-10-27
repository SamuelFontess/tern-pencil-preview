/**
 * Where a child of an auto-layout parent lands when the user drops it on the board: the index it takes among its
 * siblings (the position it will have once it is moved, as the `move` operation counts), or null when the drop changes
 * nothing (the centre is outside the parent, or the child would keep its place). Boxes are in board coordinates and the
 * siblings in document order; only centres along the layout axis are compared, so the gap between siblings needs no
 * handling. A sibling that is disabled (`enabled:false`: it takes no space) or detached from the layout
 * (`absolute:true`) takes no part in the layout: it never decides the landing spot, but it still counts in the index.
 * One that is laid out but not drawn (opacity 0, clipped away) still occupies its slot like any other.
 * Passing only such siblings is no move at all.
 * @param {{layout:string,parent:object,siblings:object[],path:string,dropped:object}} options
 * @returns {number|null}
 */
export function reorderIndex({layout,parent,siblings,path,dropped}) {
	const x=dropped.x+dropped.width/2;
	const y=dropped.y+dropped.height/2;
	if (x<parent.x||x>parent.x+parent.width||y<parent.y||y>parent.y+parent.height) return null;
	const horizontal=layout==='horizontal';
	const at=horizontal ? x : y;
	const centre=box=>horizontal ? box.x+box.width/2 : box.y+box.height/2;
	const landing=sibling=>sibling.enabled!==false&&sibling.absolute!==true;
	const others=siblings.filter(sibling=>sibling.path!==path);
	const before=others.findIndex(sibling=>landing(sibling)&&centre(sibling)>=at);
	const index=before===-1 ? others.length : before;
	const current=siblings.findIndex(sibling=>sibling.path===path);
	if (index===current) return null;
	// Moving forward passes others[current..index-1]; moving backward lands before a landing spot by construction.
	if (index>current&&!others.slice(current,index).some(landing)) return null;
	return index;
}
