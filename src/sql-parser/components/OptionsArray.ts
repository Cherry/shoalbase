// Port of PhpMyAdmin\SqlParser\Components\OptionsArray: keyword options, optionally followed by a value or an expression.
import { sprintf } from '../../lib/pma/sprintf.ts';
import { Component, type ComponentOptions } from '../Component.ts';
import {
	equalsIgnoreCase,
	phpEmpty,
	phpStr,
	strtoupper,
} from '../php.ts';
import { Token, type TokenValue } from '../Token.ts';
import { Translator } from '../Translator.ts';
import { Expression } from './Expression.ts';

import type { Parser } from '../Parser.ts';
import type { TokensList } from '../TokensList.ts';

/** An option definition: its position, or [position, 'var' | 'var=' | 'expr' | 'expr=', expression options]. */
export type OptionSpec = number | boolean | readonly [number, string] | readonly [number, string, ComponentOptions];
export type OptionsSpec = Record<string, OptionSpec>;

/** An option with a value ('var') or an expression ('expr'). */
export interface OptionEntry {
	name: TokenValue;
	equals: boolean;
	expr: string | Expression | null;
	value?: string;
}

export type OptionValue = TokenValue | OptionEntry;

export function isOptionEntry(value: OptionValue | undefined): value is OptionEntry {
	return typeof value === 'object' && value !== null;
}

/** The options of a PHP array keyed by their position; Map keeps PHP's insertion order for unsorted options. */
export type OptionsMap = Map<number, OptionValue>;

function entryOf(options: OptionsArray, id: number): OptionEntry {
	let entry = options.options.get(id);
	if (!isOptionEntry(entry)) {
		// PHP auto-vivifies the array when writing into a scalar slot that is missing.
		entry = {
			name: null,
			equals: false,
			expr: '',
		};
		options.options.set(id, entry);
	}
	return entry;
}

export class OptionsArray extends Component {
	static parse(parser: Parser, list: TokensList, options: OptionsSpec = {}): OptionsArray {
		const ret = new this();

		// Conflicting options get generated ids, starting after the real ones.
		let lastAssignedId = Object.keys(options).length + 1;

		let lastOption: OptionSpec | null = null;
		let lastOptionId = 0;
		let brackets = 0;
		let state = 0;

		for (; list.idx < list.count; ++list.idx) {
			const token = list.tokens[list.idx];

			if (token.type === Token.TYPE_DELIMITER) {
				break;
			}

			if (token.type === Token.TYPE_COMMENT) {
				continue;
			}

			// Whitespaces only matter while parsing a value.
			if (token.type === Token.TYPE_WHITESPACE && brackets === 0) {
				continue;
			}

			if (lastOption === null) {
				const upper = strtoupper(token.token ?? '');
				if (!Object.hasOwn(options, upper) || options[upper] === null) {
					// There is no option to be processed.
					break;
				}

				lastOption = options[upper];
				lastOptionId = Array.isArray(lastOption) ? lastOption[0] : Number(lastOption);
				state = 0;

				// Options like ALL and DISTINCT conflict; the duplicate gets a generated id.
				const existing = ret.options.get(lastOptionId);
				if (existing !== undefined && existing !== null) {
					parser.error(
						sprintf(
							Translator.gettext('This option conflicts with "%1$s".'),
							isOptionEntry(existing) ? existing.name : existing,
						),
						token,
					);
					lastOptionId = lastAssignedId++;
				}
			}

			const spec = Array.isArray(lastOption) ? lastOption as readonly [number, string, ComponentOptions?] : null;

			if (state === 0) {
				if (spec === null) {
					// A keyword option without a value: its beginning and its end.
					ret.options.set(lastOptionId, token.value);
					lastOption = null;
					state = 0;
				} else if (spec[1] === 'var' || spec[1] === 'var=') {
					// The value is read in state 2; state 1 skips the equals sign.
					ret.options.set(lastOptionId, {
						name: token.value,
						equals: spec[1] === 'var=',
						expr: '',
						value: '',
					});
					state = 1;
				} else if (spec[1] === 'expr' || spec[1] === 'expr=') {
					// Skipping the option keyword so the expression parser starts after it.
					++list.idx;
					ret.options.set(lastOptionId, {
						name: token.value,
						equals: spec[1] === 'expr=',
						expr: '',
					});
					state = 1;
				}
			} else if (state === 1) {
				state = 2;
				if (token.token === '=') {
					entryOf(ret, lastOptionId).equals = true;
					continue;
				}
			}

			// Checked outside the chain above because state may have just changed.
			if (state !== 2) {
				continue;
			}

			if (spec !== null && (spec[1] === 'expr' || spec[1] === 'expr=')) {
				const entry = entryOf(ret, lastOptionId);
				entry.expr = Expression.parse(parser, list, phpEmpty(spec[2]) ? {} : spec[2]);
				if (entry.expr !== null) {
					entry.value = entry.expr.expr ?? '';
				}
				lastOption = null;
				state = 0;
			} else {
				if (token.token === '(') {
					++brackets;
				} else if (token.token === ')') {
					--brackets;
				}

				const entry = entryOf(ret, lastOptionId);
				entry.expr = `${phpStr(entry.expr)}${token.token ?? ''}`;

				// The outer pair of brackets is not part of the value.
				if (!((token.token === '(' && brackets === 1) || (token.token === ')' && brackets === 0))) {
					entry.value = `${entry.value ?? ''}${phpStr(token.value)}`;
				}

				if (brackets === 0) {
					lastOption = null;
				}
			}
		}

		// The statement ended without the value an option requires.
		if (state === 1 && Array.isArray(lastOption) && ['expr', 'var', 'var=', 'expr='].includes(lastOption[1])) {
			parser.error(
				sprintf('Value/Expression for the option %1$s was expected.', entryOf(ret, lastOptionId).name),
				list.tokens[list.idx - 1],
			);
		}

		if (phpEmpty(options._UNSORTED)) {
			ret.options = new Map([...ret.options].toSorted((left, right) => left[0] - right[0]));
		}

		--list.idx;
		return ret;
	}

	static build(component: OptionsArray | null | undefined): string {
		if (!component || component.options.size === 0) {
			return '';
		}
		const options: string[] = [];
		for (const option of component.options.values()) {
			if (isOptionEntry(option)) {
				const separator = option.equals ? '=' : ' ';
				const expr = phpEmpty(option.expr) ? option.value : option.expr;
				options.push(`${phpStr(option.name)}${separator}${phpStr(expr)}`);
			} else {
				options.push(phpStr(option));
			}
		}
		return options.join(' ');
	}

	options: OptionsMap;

	constructor(options: OptionsMap | OptionValue[] = new Map()) {
		super();
		this.options = Array.isArray(options) ? new Map(options.map((option, index) => [index, option])) : options;
	}

	/** The value (or expression) of an option, true for a plain keyword option, false when missing. */
	has(key: string, getExpr = false): string | Expression | boolean | null | undefined {
		for (const option of this.options.values()) {
			if (isOptionEntry(option)) {
				if (equalsIgnoreCase(key, phpStr(option.name))) {
					return getExpr ? option.expr : option.value;
				}
			} else if (equalsIgnoreCase(key, phpStr(option))) {
				return true;
			}
		}
		return false;
	}

	remove(key: string): boolean {
		for (const [idx, option] of this.options) {
			const name = isOptionEntry(option) ? option.name : option;
			if (equalsIgnoreCase(key, phpStr(name))) {
				this.options.delete(idx);
				return true;
			}
		}
		return false;
	}

	/** array_merge_recursive() renumbers the integer keys of both arrays. */
	merge(options: OptionsArray | OptionValue[] | OptionsMap): void {
		let other: OptionValue[] = [];
		if (options instanceof OptionsArray) {
			other = options.options.values().toArray();
		} else if (options instanceof Map) {
			other = options.values().toArray();
		} else if (Array.isArray(options)) {
			other = options;
		}
		const merged = [...this.options.values(), ...other];
		this.options = new Map(merged.map((option, index) => [index, option]));
	}

	isEmpty(): boolean {
		return this.options.size === 0;
	}

	/** `clone $options`: PHP copies the array, entries included. */
	clone(): OptionsArray {
		const copy = new Map<number, OptionValue>();
		for (const [key, option] of this.options) {
			copy.set(key, isOptionEntry(option) ? { ...option } : option);
		}
		return new OptionsArray(copy);
	}
}
