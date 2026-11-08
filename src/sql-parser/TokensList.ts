// Port of PhpMyAdmin\SqlParser\TokensList: the token array plus the cursor every parser advances.
import { Token } from './Token.ts';

export class TokensList {
	/** Concatenates the raw text of the tokens; strings are returned as they are. */
	static build(list: TokensList | Token[] | string | null | undefined): string {
		if (typeof list === 'string') {
			return list;
		}
		const tokens = list instanceof this ? list.tokens : list;
		let ret = '';
		if (Array.isArray(tokens)) {
			for (const token of tokens) {
				ret += token.token ?? '';
			}
		}
		return ret;
	}

	tokens: Token[] = [];

	count = 0;

	idx = 0;

	constructor(tokens: Token[] = [], count = -1) {
		if (tokens.length === 0) {
			return;
		}
		this.tokens = tokens;
		this.count = count === -1 ? tokens.length : count;
	}

	add(token: Token): void {
		this.tokens[this.count++] = token;
	}

	/** The next token that is not a whitespace or a comment. */
	getNext(): Token | null {
		for (; this.idx < this.count; ++this.idx) {
			const token = this.tokens[this.idx];
			if (token.type !== Token.TYPE_WHITESPACE && token.type !== Token.TYPE_COMMENT) {
				return this.tokens[this.idx++];
			}
		}
		return null;
	}

	/** The previous token that is not a whitespace or a comment. */
	getPrevious(): Token | null {
		for (; this.idx >= 0; --this.idx) {
			const token = this.tokens[this.idx];
			// PHP reads past the end as null, which is neither a whitespace nor a comment.
			if (token === undefined) {
				return this.tokens[this.idx--] ?? null;
			}
			if (token.type !== Token.TYPE_WHITESPACE && token.type !== Token.TYPE_COMMENT) {
				return this.tokens[this.idx--];
			}
		}
		return null;
	}

	getPreviousOfType(type: number | number[]): Token | null {
		const types = Array.isArray(type) ? type : [type];
		for (; this.idx >= 0; --this.idx) {
			const token = this.tokens[this.idx];
			if (token !== undefined && types.includes(token.type)) {
				return this.tokens[this.idx--];
			}
		}
		return null;
	}

	getNextOfType(type: number | number[]): Token | null {
		const types = Array.isArray(type) ? type : [type];
		for (; this.idx < this.count; ++this.idx) {
			if (types.includes(this.tokens[this.idx].type)) {
				return this.tokens[this.idx++];
			}
		}
		return null;
	}

	getNextOfTypeAndValue(type: number, value: unknown): Token | null {
		for (; this.idx < this.count; ++this.idx) {
			const token = this.tokens[this.idx];
			if (token.type === type && token.value === value) {
				return this.tokens[this.idx++];
			}
		}
		return null;
	}

	getNextOfTypeAndFlag(type: number, flag: number): Token | null {
		for (; this.idx < this.count; ++this.idx) {
			const token = this.tokens[this.idx];
			if (token.type === type && token.flags === flag) {
				return this.tokens[this.idx++];
			}
		}
		return null;
	}

	offsetSet(offset: number | null, value: Token): void {
		if (offset === null || offset >= this.count) {
			this.tokens[this.count++] = value;
		} else if (offset >= 0) {
			this.tokens[offset] = value;
		}
	}

	offsetGet(offset: number): Token | null {
		return this.offsetExists(offset) ? this.tokens[offset] : null;
	}

	offsetExists(offset: number): boolean {
		return offset >= 0 && offset < this.count;
	}

	offsetUnset(offset: number): void {
		if (!this.offsetExists(offset)) {
			return;
		}
		this.tokens.splice(offset, 1);
		--this.count;
	}
}
