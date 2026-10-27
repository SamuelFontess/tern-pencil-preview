/**
 * The one place that says how a node is laid out. The engine leaves out a layout equal to its default, and a frame
 * without one lays its children out horizontally; every other node has none. Readers of engine rows (the model, the
 * render metadata) report the raw value, and everything downstream asks here.
 * @param {{type?:string,layout?:string|null}|null|undefined} node
 * @returns {string}
 */
export function layoutOf(node) {
	if (typeof node?.layout==='string') return node.layout;
	return node?.type==='frame' ? 'horizontal' : 'none';
}

/** The row as the rest of the editor reads it: with its layout named. */
export function normalizeRow(row) {
	return {...row,layout:layoutOf(row)};
}

/**
 * Whether `parent`'s auto-layout decides where `row` sits: the parent lays out its children and the child has not
 * detached itself with `layoutPosition: "absolute"` (such a child is free: x/y apply and it is never reordered).
 * @param {object|null|undefined} parent
 * @param {{layout_position?:string}} row
 */
export function placedByLayout(parent,row) {
	return parent!==null&&parent!==undefined&&layoutOf(parent)!=='none'&&row.layout_position!=='absolute';
}
