// Ports of PhpMyAdmin\SqlParser\Exceptions\*: errors collected by the lexer and parser (thrown only in strict mode).
import type { Token } from './Token.ts';

class PhpException extends Error {
	code: number;

	constructor(message: string, code: number) {
		super(message);
		this.code = code;
	}

	getMessage(): string {
		return this.message;
	}

	getCode(): number {
		return this.code;
	}
}

export class LexerException extends PhpException {
	ch: string;
	pos: number;

	constructor(message = '', ch = '', pos = 0, code = 0) {
		super(message, code);
		this.name = 'LexerException';
		this.ch = ch;
		this.pos = pos;
	}
}

export class ParserException extends PhpException {
	token: Token | null;

	constructor(message = '', token: Token | null = null, code = 0) {
		super(message, code);
		this.name = 'ParserException';
		this.token = token;
	}
}

export class LoaderException extends PhpException {
	// Named contextName because Error already has a `name` property.
	contextName: string;

	constructor(message = '', name = '', code = 0) {
		super(message, code);
		this.name = 'LoaderException';
		this.contextName = name;
	}
}
