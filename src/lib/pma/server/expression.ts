// Port of the parts of Symfony ExpressionLanguage 5.4 that phpMyAdmin's Advisor rules use, evaluated with PHP 8 semantics.
import { phpString } from '../../twig/php.ts';
import { isNumericString, strcmp } from '../php-compare.ts';

export type ExpressionValue = string | number | boolean | null | ExpressionValue[];
export type ExpressionFunction = (...args: ExpressionValue[]) => ExpressionValue;

/** Symfony's SyntaxError and PHP's TypeError/DivisionByZeroError carry the message the Advisor shows. */
export class ExpressionError extends Error {}

interface Token {
	type: 'number' | 'string' | 'operator' | 'punctuation' | 'name' | 'end of expression';
	value: ExpressionValue;
	cursor: number;
}

type Node =
	| { kind: 'constant'; value: ExpressionValue; }
	| { kind: 'name'; name: string; }
	| { kind: 'unary'; operator: string; node: Node; }
	| { kind: 'binary'; operator: string; left: Node; right: Node; }
	| { kind: 'conditional'; test: Node; whenTrue: Node; whenFalse: Node; }
	| { kind: 'function'; name: string; args: Node[]; }
	| { kind: 'array'; elements: Node[]; };

const UNARY: Record<string, number> = { 'not': 50, '!': 50, '-': 500, '+': 500 };
const BINARY: Record<string, [number, 'left' | 'right']> = {
	'or': [10, 'left'],
	'||': [10, 'left'],
	'and': [15, 'left'],
	'&&': [15, 'left'],
	'|': [16, 'left'],
	'^': [17, 'left'],
	'&': [18, 'left'],
	'==': [20, 'left'],
	'===': [20, 'left'],
	'!=': [20, 'left'],
	'!==': [20, 'left'],
	'<': [20, 'left'],
	'>': [20, 'left'],
	'>=': [20, 'left'],
	'<=': [20, 'left'],
	'not in': [20, 'left'],
	'in': [20, 'left'],
	'matches': [20, 'left'],
	'..': [25, 'left'],
	'+': [30, 'left'],
	'-': [30, 'left'],
	'~': [40, 'left'],
	'*': [60, 'left'],
	'/': [60, 'left'],
	'%': [60, 'left'],
	'**': [200, 'right'],
};

const OPERATOR = /(?<=^|[\s(])not in(?=[\s(])|!==|(?<=^|[\s(])not(?=[\s(])|(?<=^|[\s(])and(?=[\s(])|===|>=|(?<=^|[\s(])or(?=[\s(])|<=|\*\*|\.\.|(?<=^|[\s(])in(?=[\s(])|&&|\|\||(?<=^|[\s(])matches|==|!=|[-*~%/>|!^&+<]/y;
const NUMBER = /\d+(?:\.\d+)?(E[+-]\d+)?/iy;
const STRING = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'/y;
const NAME = /[a-z_\u{7F}-\u{FFFF}][\w\u{7F}-\u{FFFF}]*/iuy;

/** PHP's levenshtein() with unit costs. */
export function levenshtein(left: string, right: string): number {
	let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
	for (let row = 1; row <= left.length; row++) {
		const current = [row];
		for (let column = 1; column <= right.length; column++) {
			const cost = left[row - 1] === right[column - 1] ? 0 : 1;
			current[column] = Math.min((previous[column] as number) + 1, (current[column - 1] as number) + 1, (previous[column - 1] as number) + cost);
		}
		previous = current;
	}
	return previous[right.length] as number;
}

function syntaxError(message: string, cursor: number, expression: string, subject?: string, proposals?: string[]): ExpressionError {
	let text = `${message.replace(/\.+$/, '')} around position ${cursor}`;
	if (expression !== '') {
		text += ` for expression \`${expression}\``;
	}
	text += '.';
	if (subject !== undefined && proposals !== undefined) {
		let guess: string | undefined;
		let minScore = Infinity;
		for (const proposal of proposals) {
			const distance = levenshtein(subject, proposal);
			if (distance < minScore) {
				guess = proposal;
				minScore = distance;
			}
		}
		if (guess !== undefined && minScore < 3) {
			text += ` Did you mean "${guess}"?`;
		}
	}
	return new ExpressionError(text);
}

/** PHP's stripcslashes() for the escapes rule strings can contain. */
function stripCSlashes(value: string): string {
	const escapes: Record<string, string> = { n: '\n', t: '\t', r: '\r', v: '\v', f: '\f', a: '\u{7}', b: '\b' };
	return value.replaceAll(/\\(.)/gs, (_, character: string) => escapes[character] ?? character);
}

function tokenize(expression: string): Token[] {
	const tokens: Token[] = [];
	const brackets: [string, number][] = [];
	const match = (pattern: RegExp, cursor: number): RegExpExecArray | null => {
		pattern.lastIndex = cursor;
		return pattern.exec(expression);
	};
	let cursor = 0;
	while (cursor < expression.length) {
		const character = expression[cursor] as string;
		if (character === ' ') {
			cursor++;
			continue;
		}
		const number = match(NUMBER, cursor);
		const string = number === null ? match(STRING, cursor) : null;
		if (number !== null) {
			tokens.push({ type: 'number', value: Number(number[0]), cursor: cursor + 1 });
			cursor += number[0].length;
		} else if ('([{'.includes(character)) {
			brackets.push([character, cursor]);
			tokens.push({ type: 'punctuation', value: character, cursor: cursor + 1 });
			cursor++;
		} else if (')]}'.includes(character)) {
			const open = brackets.pop();
			if (open === undefined) {
				throw syntaxError(`Unexpected "${character}".`, cursor, expression);
			}
			if (')]}'['([{'.indexOf(open[0])] !== character) {
				throw syntaxError(`Unclosed "${open[0]}".`, open[1], expression);
			}
			tokens.push({ type: 'punctuation', value: character, cursor: cursor + 1 });
			cursor++;
		} else if (string !== null) {
			tokens.push({ type: 'string', value: stripCSlashes(string[0].slice(1, -1)), cursor: cursor + 1 });
			cursor += string[0].length;
		} else if (match(OPERATOR, cursor) !== null) {
			const operator = (match(OPERATOR, cursor) as RegExpExecArray)[0];
			tokens.push({ type: 'operator', value: operator, cursor: cursor + 1 });
			cursor += operator.length;
		} else if ('.,?:'.includes(character)) {
			tokens.push({ type: 'punctuation', value: character, cursor: cursor + 1 });
			cursor++;
		} else if (match(NAME, cursor) !== null) {
			const name = (match(NAME, cursor) as RegExpExecArray)[0];
			tokens.push({ type: 'name', value: name, cursor: cursor + 1 });
			cursor += name.length;
		} else {
			throw syntaxError(`Unexpected character "${character}".`, cursor, expression);
		}
	}
	tokens.push({ type: 'end of expression', value: null, cursor: cursor + 1 });
	const open = brackets.pop();
	if (open !== undefined) {
		throw syntaxError(`Unclosed "${open[0]}".`, open[1], expression);
	}
	return tokens;
}

class Parser {
	private position = 0;

	constructor(private readonly tokens: Token[], private readonly expression: string, private readonly names: string[], private readonly functions: Set<string>) {}

	private get current(): Token {
		return this.tokens[this.position] as Token;
	}

	private is(type: Token['type'], value?: string): boolean {
		return this.current.type === type && (value === undefined || this.current.value === value);
	}

	private expect(type: Token['type'], value: string, message: string): void {
		if (!this.is(type, value)) {
			const token = this.current;
			throw syntaxError(`${message}. Unexpected token "${token.type}" of value "${phpString(token.value)}" ("${type}" expected with value "${value}").`, token.cursor, this.expression);
		}
		this.position++;
	}


	private parseExpression(precedence = 0): Node {
		let expression = this.getPrimary();
		let token = this.current;
		while (token.type === 'operator' && Object.hasOwn(BINARY, token.value as string) && (BINARY[token.value as string] as [number, string])[0] >= precedence) {
			const [operatorPrecedence, associativity] = BINARY[token.value as string] as [number, string];
			this.position++;
			const right = this.parseExpression(associativity === 'left' ? operatorPrecedence + 1 : operatorPrecedence);
			expression = { kind: 'binary', operator: token.value as string, left: expression, right };
			token = this.current;
		}
		if (precedence === 0) {
			return this.parseConditional(expression);
		}
		return expression;
	}

	private parseConditional(expression: Node): Node {
		let result = expression;
		while (this.is('punctuation', '?')) {
			this.position++;
			let whenTrue: Node;
			let whenFalse: Node;
			if (this.is('punctuation', ':')) {
				this.position++;
				whenTrue = result;
				whenFalse = this.parseExpression();
			} else {
				whenTrue = this.parseExpression();
				whenFalse = { kind: 'constant', value: null };
				if (this.is('punctuation', ':')) {
					this.position++;
					whenFalse = this.parseExpression();
				}
			}
			result = { kind: 'conditional', test: result, whenTrue, whenFalse };
		}
		return result;
	}

	private getPrimary(): Node {
		const token = this.current;
		if (token.type === 'operator' && Object.hasOwn(UNARY, token.value as string)) {
			this.position++;
			return { kind: 'unary', operator: token.value as string, node: this.parseExpression(UNARY[token.value as string]) };
		}
		if (this.is('punctuation', '(')) {
			this.position++;
			const expression = this.parseExpression();
			this.expect('punctuation', ')', 'An opened parenthesis is not properly closed');
			return expression;
		}
		return this.parsePrimaryExpression();
	}

	private parsePrimaryExpression(): Node {
		const token = this.current;
		if (token.type === 'name') {
			this.position++;
			const name = token.value as string;
			const constants: Record<string, ExpressionValue> = { true: true, TRUE: true, false: false, FALSE: false, null: null, NULL: null };
			if (Object.hasOwn(constants, name)) {
				return { kind: 'constant', value: constants[name] as ExpressionValue };
			}
			if (this.current.value === '(') {
				if (!this.functions.has(name)) {
					throw syntaxError(`The function "${name}" does not exist.`, token.cursor, this.expression, name, [...this.functions]);
				}
				return { kind: 'function', name, args: this.parseArguments() };
			}
			if (!this.names.includes(name)) {
				throw syntaxError(`Variable "${name}" is not valid.`, token.cursor, this.expression, name, this.names);
			}
			return { kind: 'name', name };
		}
		if (token.type === 'number' || token.type === 'string') {
			this.position++;
			return { kind: 'constant', value: token.value };
		}
		if (this.is('punctuation', '[')) {
			return this.parseArray();
		}
		throw syntaxError(`Unexpected token "${token.type}" of value "${phpString(token.value)}".`, token.cursor, this.expression);
	}

	private parseArray(): Node {
		this.expect('punctuation', '[', 'An array element was expected');
		const elements: Node[] = [];
		while (!this.is('punctuation', ']')) {
			if (elements.length > 0) {
				this.expect('punctuation', ',', 'An array element must be followed by a comma');
				if (this.is('punctuation', ']')) {
					break;
				}
			}
			elements.push(this.parseExpression());
		}
		this.expect('punctuation', ']', 'An opened array is not properly closed');
		return { kind: 'array', elements };
	}

	private parseArguments(): Node[] {
		const args: Node[] = [];
		this.expect('punctuation', '(', 'A list of arguments must begin with an opening parenthesis');
		while (!this.is('punctuation', ')')) {
			if (args.length > 0) {
				this.expect('punctuation', ',', 'Arguments must be separated by a comma');
			}
			args.push(this.parseExpression());
		}
		this.expect('punctuation', ')', 'A list of arguments must be closed by a parenthesis');
		return args;
	}

	parse(): Node {
		// eslint-disable-next-line unicorn/no-declarations-before-early-exit -- parsing must consume the tokens before the end can be checked.
		const node = this.parseExpression();
		if (!this.is('end of expression')) {
			throw syntaxError(`Unexpected token "${this.current.type}" of value "${phpString(this.current.value)}".`, this.current.cursor, this.expression);
		}
		return node;
	}
}

/** PHP's get_debug_type() names as TypeError messages use them. */
export function typeName(value: ExpressionValue): string {
	if (value === null) {
		return 'null';
	}
	if (typeof value === 'boolean') {
		return 'bool';
	}
	if (typeof value === 'number') {
		return Number.isSafeInteger(value) ? 'int' : 'float';
	}
	if (Array.isArray(value)) {
		return 'array';
	}
	return 'string';
}

/** PHP's truthiness. */
export function phpBool(value: ExpressionValue): boolean {
	if (Array.isArray(value)) {
		return value.length > 0;
	}
	return value !== null && value !== false && value !== 0 && value !== '' && value !== '0';
}

const LEADING_NUMBER = /^[\t\n\v\f\r ]*[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?/i;

/** An arithmetic operand: numeric and leading-numeric strings convert, other strings are a TypeError as in PHP 8. */
function operand(value: ExpressionValue, left: ExpressionValue, right: ExpressionValue, operator: string): number {
	if (typeof value === 'number') {
		return value;
	}
	if (value === null || typeof value === 'boolean') {
		return Number(value);
	}
	const match = typeof value === 'string' ? LEADING_NUMBER.exec(value) : null;
	if (match === null) {
		throw new ExpressionError(`Unsupported operand types: ${typeName(left)} ${operator} ${typeName(right)}`);
	}
	return Number(match[0]);
}

/** PHP 8's loose comparison ($a <=> $b) of scalars. */
export function phpSpaceship(left: ExpressionValue, right: ExpressionValue): number {
	if (typeof left === 'boolean' || typeof right === 'boolean' || left === null || right === null) {
		if (typeof left === 'string' && right === null) {
			return left === '' ? 0 : 1;
		}
		if (left === null && typeof right === 'string') {
			return right === '' ? 0 : -1;
		}
		return Math.sign(Number(phpBool(left)) - Number(phpBool(right)));
	}
	if (typeof left === 'number' && typeof right === 'number') {
		return Math.sign(left - right);
	}
	if (typeof left === 'string' && typeof right === 'string') {
		if (isNumericString(left) && isNumericString(right)) {
			return Math.sign(Number(left) - Number(right));
		}
		return Math.sign(strcmp(left, right));
	}
	// A number against a string compares numerically only when the string is numeric.
	const text = (typeof left === 'string' ? left : right) as string;
	if (isNumericString(text)) {
		return Math.sign(Number(left) - Number(right));
	}
	if (typeof left === 'string') {
		return Math.sign(strcmp(left, phpString(right)));
	}
	return Math.sign(strcmp(phpString(left), text));
}

function arithmetic(operator: string, left: ExpressionValue, right: ExpressionValue): number {
	const leftNumber = operand(left, left, right, operator);
	const rightNumber = operand(right, left, right, operator);
	switch (operator) {
		case '+': {
			return leftNumber + rightNumber;
		}
		case '-': {
			return leftNumber - rightNumber;
		}
		case '*': {
			return leftNumber * rightNumber;
		}
		case '**': {
			return leftNumber ** rightNumber;
		}
		case '/': {
			if (rightNumber === 0) {
				throw new ExpressionError('Division by zero.');
			}
			return leftNumber / rightNumber;
		}
		default: {
			if (Math.trunc(rightNumber) === 0) {
				throw new ExpressionError('Modulo by zero.');
			}
			return Math.trunc(leftNumber) % Math.trunc(rightNumber);
		}
	}
}

function binary(operator: string, left: ExpressionValue, right: ExpressionValue): ExpressionValue {
	switch (operator) {
		case '==': {
			return phpSpaceship(left, right) === 0;
		}
		case '!=': {
			return phpSpaceship(left, right) !== 0;
		}
		case '===': {
			return left === right;
		}
		case '!==': {
			return left !== right;
		}
		case '<': {
			return phpSpaceship(left, right) < 0;
		}
		case '>': {
			return phpSpaceship(left, right) > 0;
		}
		case '<=': {
			return phpSpaceship(left, right) <= 0;
		}
		case '>=': {
			return phpSpaceship(left, right) >= 0;
		}
		case '~': {
			return phpString(left) + phpString(right);
		}
		case '+':
		case '-':
		case '*':
		case '/':
		case '%':
		case '**': {
			return arithmetic(operator, left, right);
		}
		default: {
			throw new ExpressionError(`The "${operator}" operator is not supported.`);
		}
	}
}

function evaluateNode(node: Node, functions: Record<string, ExpressionFunction>, values: Record<string, ExpressionValue>): ExpressionValue {
	switch (node.kind) {
		case 'constant': {
			return node.value;
		}
		case 'name': {
			return values[node.name] as ExpressionValue;
		}
		case 'array': {
			return node.elements.map(element => evaluateNode(element, functions, values));
		}
		case 'function': {
			const args = node.args.map(arg => evaluateNode(arg, functions, values));
			return (functions[node.name] as ExpressionFunction)(...args);
		}
		case 'conditional': {
			let branch = node.whenFalse;
			if (phpBool(evaluateNode(node.test, functions, values))) {
				branch = node.whenTrue;
			}
			// eslint-disable-next-line unicorn/no-useless-recursion -- evaluating the chosen subtree is a tree walk, not a loop.
			return evaluateNode(branch, functions, values);
		}
		case 'unary': {
			const value = evaluateNode(node.node, functions, values);
			if (node.operator === '!' || node.operator === 'not') {
				return !phpBool(value);
			}
			if (node.operator === '-') {
				return -operand(value, value, value, '*');
			}
			return value;
		}
		default: {
			const left = evaluateNode(node.left, functions, values);
			if (node.operator === 'or' || node.operator === '||') {
				return phpBool(left) || phpBool(evaluateNode(node.right, functions, values));
			}
			if (node.operator === 'and' || node.operator === '&&') {
				return phpBool(left) && phpBool(evaluateNode(node.right, functions, values));
			}
			return binary(node.operator, left, evaluateNode(node.right, functions, values));
		}
	}
}

/** ExpressionLanguage::evaluate(): names are checked against the sorted variable names, as asort() leaves them. */
export function evaluateExpression(expression: string, values: Record<string, ExpressionValue>, functions: Record<string, ExpressionFunction>): ExpressionValue {
	const names = Object.keys(values).toSorted(strcmp);
	const node = new Parser(tokenize(expression), expression, names, new Set(Object.keys(functions))).parse();
	return evaluateNode(node, functions, values);
}
