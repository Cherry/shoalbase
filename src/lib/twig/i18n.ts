/*
 * Translated from phpmyadmin/twig-i18n-extension.
 *
 * Copyright (c) 2010-2019 Fabien Potencier
 * Copyright (c) 2019-2021 phpMyAdmin contributors
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
 * documentation files (the "Software"), to deal in the Software without restriction, including without limitation the
 * rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit
 * persons to whom the Software is furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all copies or substantial portions of the
 * Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE
 * WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
 * COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
 * OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 */

// The {% trans %} semantics of phpmyadmin/twig-i18n-extension (TransTokenParser + TransNode).
import { phpString, phpTrim } from './php.ts';

/** PHP's strtr() with an array: longest keys win and replaced text is never rescanned. */
export function strtr(subject: string, replacements: Map<string, string>): string {
	const keys = replacements.keys()
		.filter(key => key !== '')
		.toArray()
		.toSorted((left, right) => right.length - left.length);
	if (keys.length === 0) {
		return subject;
	}
	const pattern = new RegExp(keys.map(key => key.replaceAll(/[$()*+.?[\\\]^{|}]/g, String.raw`\$&`)).join('|'), 'g');
	return subject.replace(pattern, match => replacements.get(match) as string);
}

export interface TranslationCatalog {
	gettext(message: string, context: string | null): string;
	ngettext(singular: string, plural: string, count: number, context: string | null): string;
}

/**
 * Identity catalog for English. A real catalog must evaluate the .mo Plural-Forms expression with a
 * small interpreter, since workerd forbids eval/new Function that most gettext libraries use for it.
 */
export const englishCatalog: TranslationCatalog = {
	gettext: message => message,
	ngettext: (singular, plural, count) => (count === 1 ? singular : plural),
};

export type TransSegment = { text: string; } | { variable: string; };

/** Builds the msgid the way TransNode::compileString() does: `{{ name }}` becomes `%name%` and the result is trimmed. */
export function buildTransMessage(segments: TransSegment[]): { message: string; variables: string[]; } {
	let message = '';
	const variables: string[] = [];
	for (const segment of segments) {
		if ('text' in segment) {
			message += segment.text;
		} else {
			message += `%${segment.variable}%`;
			variables.push(segment.variable);
		}
	}
	return { message: phpTrim(message), variables };
}

export interface TransCall {
	message: string;
	plural: string | null;
	count: unknown;
	context: string | null;
	/** Keyed by placeholder, e.g. "%name%". */
	variables: Record<string, unknown>;
}

/** Runtime half of TransNode: translate, then strtr() the placeholders without escaping. */
export function translate(call: TransCall, catalog: TranslationCatalog): string {
	const count = Math.abs(Number(call.count));
	let translated: string;
	if (call.plural === null) {
		translated = catalog.gettext(call.message, call.context);
	} else {
		translated = catalog.ngettext(call.message, call.plural, count, call.context);
	}
	const replacements = new Map<string, string>();
	for (const [placeholder, value] of Object.entries(call.variables)) {
		// TransNode always binds %count% to abs() of the {% plural %} expression.
		if (placeholder === '%count%' && call.plural !== null) {
			replacements.set(placeholder, phpString(count));
		} else {
			replacements.set(placeholder, phpString(value));
		}
	}
	return strtr(translated, replacements);
}

