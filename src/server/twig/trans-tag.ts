// {% trans %} for Twing, ported from phpmyadmin/twig-i18n-extension's TransTokenParser.
import {
	type TwingBaseExpressionNode,
	type TwingBaseNode,
	type TwingTagHandler,
	createArrayNode,
	createConstantNode,
	createFunctionNode,
	createHashNode,
	createNameNode,
	createPrintNode,
} from 'twing';

import { type TransSegment, buildTransMessage } from '../../lib/twig/i18n.ts';
import { phpTrim } from '../../lib/twig/php.ts';

/** Runtime function the tag compiles to; registered by the environment. */
export const TRANS_FUNCTION = '_pma_trans';

const forkTags = ['plural', 'context', 'notes', 'endtrans'];

function bodyNodes(node: TwingBaseNode): TwingBaseNode[] {
	if (node.type === null) {
		return Object.values(node.children);
	}
	return [node];
}

// Twing wraps printed names in filter/check_to_string nodes; TransNode looks through them too.
function unwrapName(expression: TwingBaseNode): TwingBaseNode {
	let node = expression;
	while (node.type === 'filter' || node.type === 'check_to_string') {
		node = node.children.operand ?? node.children.expression;
	}
	return node;
}

function toSegments(body: TwingBaseNode, line: number): TransSegment[] {
	return bodyNodes(body).map((node) => {
		if (node.type === 'text') {
			return { text: (node.attributes as { data: string; }).data };
		}
		if (node.type === 'print') {
			const name = unwrapName(node.children.expression);
			if (name.type === 'name') {
				return { variable: (name.attributes as { name: string; }).name };
			}
		}
		throw new Error(`The text to be translated with "trans" can only contain references to simple variables (line ${line}).`);
	});
}

function textOf(node: TwingBaseNode): string {
	return bodyNodes(node).map(child => (child.attributes as { data?: string; }).data ?? '').join('');
}

interface CompiledString {
	message: TwingBaseExpressionNode;
	variables: string[];
}

// Mirrors TransNode::compileString(): a bare expression is used as the msgid as-is.
function compileString(body: TwingBaseNode, line: number, column: number): CompiledString {
	if (body.type === 'name' || body.type === 'constant') {
		return { message: body as TwingBaseExpressionNode, variables: [] };
	}
	const { message, variables } = buildTransMessage(toSegments(body, line));
	return { message: createConstantNode(message, line, column), variables };
}

export function createTransTagHandler(): TwingTagHandler {
	return {
		tag: 'trans',
		initialize: parser => (token, stream) => {
			const { line, column } = token;
			const nullNode = createConstantNode(null, line, column);
			if (stream.test('NAME', 'from')) {
				throw new Error(`Translation domains are not supported (line ${line}).`);
			}
			let body: TwingBaseNode;
			let plural: TwingBaseNode | null = null;
			let count: TwingBaseExpressionNode | null = null;
			let context: TwingBaseExpressionNode | null = null;
			if (stream.test('TAG_END')) {
				stream.expect('TAG_END');
				body = parser.subparse(stream, 'trans', candidate => candidate.test('NAME', forkTags));
				let next = stream.next().value;
				if (next === 'plural') {
					count = parser.parseExpression(stream);
					stream.expect('TAG_END');
					plural = parser.subparse(stream, 'trans', candidate => candidate.test('NAME', forkTags));
					next = stream.next().value;
				}
				if (next === 'context' || next === 'notes') {
					stream.expect('TAG_END');
					const extra = parser.subparse(stream, 'trans', candidate => candidate.test('NAME', 'endtrans'));
					stream.next();
					if (next === 'context') {
						context = createConstantNode(phpTrim(textOf(extra)), line, column);
					}
				}
			} else {
				body = parser.parseExpression(stream);
			}
			stream.expect('TAG_END');

			const singular = compileString(body, line, column);
			const variables = [...singular.variables];
			let pluralMessage: TwingBaseExpressionNode = nullNode;
			if (plural !== null) {
				const compiled = compileString(plural, line, column);
				pluralMessage = compiled.message;
				variables.push(...compiled.variables);
			}
			const variableHash = createHashNode(
				[...new Set(variables)].map((name) => {
					let value: TwingBaseExpressionNode = createNameNode(name, line, column);
					// %count% is bound to the {% plural %} expression even when no "count" variable exists.
					if (name === 'count' && count !== null) {
						value = count;
					}
					return { key: createConstantNode(`%${name}%`, line, column), value };
				}),
				line,
				column,
			);
			const args = createArrayNode(
				[singular.message, pluralMessage, count ?? nullNode, context ?? nullNode, variableHash].map((value) => { return { value }; }),
				line,
				column,
			);
			// Twing cannot execute custom node types, so the tag lowers to a print of a function call.
			return createPrintNode(createFunctionNode(TRANS_FUNCTION, args, line, column), line, column);
		},
	};
}
