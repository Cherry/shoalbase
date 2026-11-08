// Twing's escaper visitor only escapes inside the template body, while Twig applies the default "html" strategy to
// {% block %} bodies too. This pass adds the missing escape nodes to block bodies of a parsed template AST.
import { type SafeCalls, unwrapSafeCalls } from './safe-calls.ts';

import type { TwingBaseNode } from 'twing';

// Expressions Twing's own visitor treats as safe.
const SAFE_TYPES = new Set(['constant', 'block_function', 'parent_function', 'method_call']);

const patched = new WeakSet<TwingBaseNode>();

function isTwingSafe(node: TwingBaseNode): boolean {
	if (node.type === 'conditional') {
		return isTwingSafe(node.children.expr2) && isTwingSafe(node.children.expr3);
	}
	return SAFE_TYPES.has(node.type as string);
}

function escapePrints(node: TwingBaseNode): void {
	for (const child of Object.values(node.children)) {
		if (child.type === 'print') {
			const { expression } = child.children;
			// Prints that already carry an escape node come from an {% autoescape %} region or a later fixed parser.
			if (expression.type !== 'escape' && !isTwingSafe(expression)) {
				child.children.expression = { ...expression, type: 'escape', attributes: { strategy: 'html' }, children: { body: expression } } as TwingBaseNode;
			}
			continue;
		}
		escapePrints(child);
	}
}

/** Escapes the prints of every block body once, then lets is_safe helpers skip escaping again. */
export function escapeBlockBodies(template: TwingBaseNode, safe: SafeCalls): void {
	if (patched.has(template) || template.type !== 'template') {
		return;
	}
	patched.add(template);
	const { blocks } = template.children;
	if (blocks === undefined) {
		return;
	}
	escapePrints(blocks);
	unwrapSafeCalls(blocks, safe);
}
