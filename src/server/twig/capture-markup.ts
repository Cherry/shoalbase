// Twig stores `{% set x %}...{% endset %}` as Markup, so printing it is not escaped again; Twing stores a plain string.
// This pass follows every capturing set with `x = _capture_markup(x)`, which restores Twig's Markup value.
import {
	createArrayNode,
	createFunctionNode,
	createNameNode,
	createNode,
	createSetNode,
} from 'twing';

import type { TwingBaseNode } from 'twing';

export const CAPTURE_MARKUP_FUNCTION = '_capture_markup';

const patched = new WeakSet<TwingBaseNode>();

function markupAssignment(set: TwingBaseNode): TwingBaseNode {
	const { line, column } = set;
	const names = Object.values(set.children.names.children);
	const values: Record<string, TwingBaseNode> = {};
	for (const [index, assignment] of names.entries()) {
		const name = (assignment.attributes as { name: string; }).name;
		const argument = createArrayNode([{ value: createNameNode(name, line, column) }], line, column);
		values[index] = createFunctionNode(CAPTURE_MARKUP_FUNCTION, argument, line, column);
	}
	return createSetNode(false, set.children.names, createNode(values, line, column), line, column, 'set') as TwingBaseNode;
}

function patchNode(node: TwingBaseNode): void {
	for (const [key, child] of Object.entries(node.children)) {
		patchNode(child);
		if (child.type === 'set' && (child.attributes as { captures?: boolean; }).captures === true) {
			node.children[key] = createNode({ 0: child, 1: markupAssignment(child) }, child.line, child.column) as TwingBaseNode;
		}
	}
}

/** Mutates a loaded template AST once so captured set values print unescaped, as in Twig. */
export function markCapturedSets(template: TwingBaseNode): void {
	if (patched.has(template)) {
		return;
	}
	patched.add(template);
	patchNode(template);
}
