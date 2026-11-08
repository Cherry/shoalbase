// Port of PhpMyAdmin\SqlParser\Utils\Tokens: token pattern matching and replacement.
import { Lexer } from '../Lexer.ts';
import { equalsIgnoreCase, member, phpStr } from '../php.ts';
import { Token, type TokenValue } from '../Token.ts';
import { TokensList } from '../TokensList.ts';

export interface TokenPattern {
	token?: string | null;
	value?: TokenValue;
	value_str?: string | null;
	type?: number | null;
	flags?: number | null;
}

const isSet = (value: unknown): boolean => value !== undefined && value !== null;

export const Tokens = {
	match(token: Token, pattern: TokenPattern): boolean {
		if (isSet(pattern.token) && pattern.token !== token.token) {
			return false;
		}

		if (isSet(pattern.value) && pattern.value !== token.value) {
			return false;
		}

		if (isSet(pattern.value_str) && !equalsIgnoreCase(phpStr(pattern.value_str), phpStr(token.value))) {
			return false;
		}

		if (isSet(pattern.type) && pattern.type !== token.type) {
			return false;
		}

		return !isSet(pattern.flags) || ((pattern.flags ?? 0) & token.flags) !== 0;
	},

	/** Replaces every sequence of tokens matching $find by the $replace tokens; strings are lexed and rebuilt. */
	replaceTokens(list: TokensList | string, find: TokenPattern[], replace: Token[]): TokensList | string {
		const isList = list instanceof TokensList;

		const tokens = isList ? list : Lexer.getTokens(list);

		const newList: Token[] = [];

		const findCount = find.length;

		let start = 0;
		while (start < tokens.count) {
			// A sequence may not start with a comment.
			if (tokens.tokens[start].type === Token.TYPE_COMMENT) {
				newList.push(tokens.tokens[start]);
				++start;
				continue;
			}

			let cursor = start;
			let matched = 0;

			// Checking if the next tokens match the pattern.
			while (cursor < tokens.count && matched < findCount) {
				// Comments are skipped.
				if (tokens.tokens[cursor].type === Token.TYPE_COMMENT) {
					++cursor;
				}

				// PHP passes the missing token on and fails on its Token type.
				if (!Tokens.match(member(tokens.tokens[cursor] as Token | undefined), find[matched])) {
					break;
				}

				++cursor;
				++matched;
			}

			if (matched === findCount) {
				newList.push(...replace);
				// Skipping the matched tokens.
				start = cursor;
			} else {
				newList.push(tokens.tokens[start]);
				++start;
			}
		}

		return isList ? new TokensList(newList) : TokensList.build(newList);
	},
};
