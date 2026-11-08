// Twig PHP decides at compile time that `is_safe => ['html']` helpers skip HTML escaping but are still escaped in
// js/url contexts. Twing has no is_safe, so this pass removes the matching escape nodes after Twing's escaper ran.
import type { TwingBaseNode } from 'twing';

export interface SafeCalls {
	/** Function and filter names declared `is_safe => ['html']` upstream. */
	html: Set<string>;
	/** Names whose output is never escaped, like the {% trans %} runtime function. */
	all: Set<string>;
}

function callName(node: TwingBaseNode): string | null {
	if (node.type === 'function' || node.type === 'filter') {
		return (node.attributes as { operatorName: string; }).operatorName;
	}
	return null;
}

// Mirrors SafeAnalysisNodeVisitor for the expressions phpMyAdmin templates print.
function isSafe(node: TwingBaseNode, strategy: string, safe: SafeCalls): boolean {
	if (node.type === 'constant') {
		return true;
	}
	if (node.type === 'conditional') {
		return isSafe(node.children.expr2, strategy, safe) && isSafe(node.children.expr3, strategy, safe);
	}
	const name = callName(node);
	if (name === null) {
		return false;
	}
	return safe.all.has(name) || (strategy === 'html' && safe.html.has(name));
}

// Like EscaperNodeVisitor::unwrapConditional(): `a ? safe : unsafe` escapes only the unsafe branch.
function escapeExpression(escape: TwingBaseNode, body: TwingBaseNode, safe: SafeCalls): TwingBaseNode {
	const { strategy } = escape.attributes as { strategy: string; };
	if (isSafe(body, strategy, safe)) {
		return body;
	}
	if (body.type === 'conditional') {
		const { expr1, expr2, expr3 } = body.children;
		return { ...body, children: { expr1, expr2: escapeExpression(escape, expr2, safe), expr3: escapeExpression(escape, expr3, safe) } };
	}
	return { ...escape, children: { ...escape.children, body } };
}

/** Mutates a parsed template AST in place, unwrapping escape nodes around safe helper calls. */
export function unwrapSafeCalls(node: TwingBaseNode, safe: SafeCalls): void {
	for (const [key, child] of Object.entries(node.children)) {
		if (child.type === 'escape') {
			node.children[key] = escapeExpression(child, child.children.body, safe);
		}
		unwrapSafeCalls(node.children[key], safe);
	}
}
