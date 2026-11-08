// Port of PhpMyAdmin\Advisor: runs the advisory rules against the server's status and variables.
import {
	ExpressionError,
	type ExpressionFunction,
	type ExpressionValue,
	evaluateExpression,
	phpBool,
	typeName,
} from './expression.ts';
import data from './server-data.json' with { type: 'json' };
import { htmlspecialchars, phpString } from '../../twig/php.ts';
import { type UrlState, getFromRoute, linkUrl } from '../../twig/url.ts';
import { sprintf } from '../sprintf.ts';
import { formatByteDown, phpRound, timespanFormat } from '../util.ts';

export interface AdvisorRule {
	id: string;
	name: string;
	precondition?: string;
	formula: string;
	test: string;
	issue: string;
	recommendation: string;
	justification: string;
	justification_formula?: string;
}

export interface AdvisorResult {
	fired: AdvisorRule[];
	notfired: AdvisorRule[];
	unchecked: AdvisorRule[];
	errors: string[];
}

export interface AdvisorInput {
	/** SHOW GLOBAL STATUS merged with SHOW GLOBAL VARIABLES and system_memory, as Advisor::setVariables() does. */
	variables: Record<string, ExpressionValue>;
	version: number;
	isMariaDB: boolean;
	url: UrlState;
}

const RULES = data.advisorRules as { generic: AdvisorRule[]; before80003: AdvisorRule[]; };



/** The Advisor closures run under strict_types, so PHP refuses non-strings for string parameters. */
function requireString(value: ExpressionValue, signature: string): string {
	if (typeof value !== 'string') {
		throw new ExpressionError(`${signature} must be of type string, ${typeName(value)} given`);
	}
	return value;
}

/** A PHP /pattern/flags regular expression as a RegExp. */
function phpRegExp(pattern: string): RegExp {
	const delimiter = pattern[0] as string;
	const end = pattern.lastIndexOf(delimiter);
	return new RegExp(pattern.slice(1, end), pattern.slice(end + 1).replaceAll(/[^imsu]/g, ''));
}

/** Advisor::byTime(): a rate per second, minute, hour or day. */
export function byTime(value: number, precision: number): string {
	let num = value;
	let per: string;
	if (num >= 1) {
		per = 'per second';
	} else if (num * 60 >= 1) {
		num *= 60;
		per = 'per minute';
	} else if (num * 60 * 60 >= 1) {
		num *= 60 * 60;
		per = 'per hour';
	} else {
		num *= 24 * 60 * 60;
		per = 'per day';
	}
	num = phpRound(num, precision);
	if (num === 0) {
		return `<${phpString(10 ** -precision)} ${per}`;
	}
	return `${phpString(num)} ${per}`;
}

export function runAdvisor(input: AdvisorInput): AdvisorResult {
	const result: AdvisorResult = { fired: [], notfired: [], unchecked: [], errors: [] };
	const variables: Record<string, ExpressionValue> = { ...input.variables };
	const globals: Record<string, ExpressionValue> = { PMA_MYSQL_INT_VERSION: input.version, IS_MARIADB: input.isMariaDB };
	const functions: Record<string, ExpressionFunction> = {
		round: num => phpRound(Number(num)),
		substr: (string, start, length) => {
			const text = requireString(string as ExpressionValue, 'substr(): Argument #1 ($string)');
			return text.slice(Number(start), Number(start) + Number(length));
		},
		preg_match: (pattern, subject) => {
			const text = requireString(subject as ExpressionValue, 'preg_match(): Argument #2 ($subject)');
			return phpRegExp(String(pattern)).test(text) ? 1 : 0;
		},
		ADVISOR_bytime: (num, precision) => byTime(Number(num), Number(precision)),
		ADVISOR_timespanFormat: seconds => timespanFormat(Math.trunc(Number(seconds))),
		ADVISOR_formatByteDown: (value, limes, comma) => (formatByteDown(value as number | string, Number(limes), Number(comma)) as string[]).join(' '),
		// A loose == between the rule ids and the argument.
		fired: value => (result.fired.some(rule => rule.id === phpString(value)) ? '1' : '0'),
	};
	const evaluate = (expression: string): ExpressionValue => {
		const values: Record<string, ExpressionValue> = { ...variables, ...globals };
		// Disabled InnoDB leaves these unset, so they default to 0.
		for (const name of ['innodb_buffer_pool_size', 'innodb_log_file_size', 'innodb_log_files_in_group']) {
			if (values[name] === undefined || values[name] === null) {
				values[name] = 0;
			}
		}
		return evaluateExpression(expression, values, functions);
	};
	const storeError = (description: string, error: unknown): void => {
		result.errors.push(`${description} ${sprintf('Error when evaluating: %s', (error as Error).message)}`);
	};
	const replaceVariables = (text: string): string => text.replaceAll(/\{(\w+)\}/g, (_, name: string) => `<a href="${getFromRoute(input.url, '/server/variables', { filter: name })}">${htmlspecialchars(name)}</a>`);
	const addRule = (type: keyof Omit<AdvisorResult, 'errors'>, source: AdvisorRule): void => {
		if (type === 'unchecked') {
			result.unchecked.push(source);
			return;
		}
		const rule = { ...source };
		if (rule.justification_formula !== undefined) {
			let params: ExpressionValue;
			try {
				params = evaluate(`[${rule.justification_formula}]`);
			} catch (error) {
				storeError(`Failed formatting string for rule '${rule.name}'.`, error);
				return;
			}
			rule.justification = sprintf(rule.justification, ...(params as ExpressionValue[]));
		}
		rule.recommendation = replaceVariables(rule.recommendation);
		rule.issue = replaceVariables(rule.issue);
		rule.recommendation = rule.recommendation.replaceAll(/href=(["'])(https?:\/\/[^"']+)\1/gi, (_, _quote: string, url: string) => `href="${linkUrl(url)}" target="_blank" rel="noopener noreferrer"`);
		result[type].push(rule);
	};

	const isMariaDB = phpString(variables.version).includes('MariaDB');
	let rules = RULES.generic;
	if (isMariaDB || input.version < 80003) {
		rules = [...RULES.generic, ...RULES.before80003];
	}
	for (const rule of rules) {
		variables.value = 0;
		let precondition: ExpressionValue = true;
		if (rule.precondition !== undefined) {
			try {
				precondition = evaluate(rule.precondition);
			} catch (error) {
				storeError(`Failed evaluating precondition for rule '${rule.name}'.`, error);
				continue;
			}
		}
		if (!phpBool(precondition)) {
			addRule('unchecked', rule);
			continue;
		}
		let value: ExpressionValue;
		try {
			value = evaluate(rule.formula);
		} catch (error) {
			storeError(`Failed calculating value for rule '${rule.name}'.`, error);
			continue;
		}
		variables.value = value;
		let fired: ExpressionValue;
		try {
			fired = evaluate(rule.test);
		} catch (error) {
			storeError(`Failed running test for rule '${rule.name}'.`, error);
			continue;
		}
		if (!phpBool(fired)) {
			addRule('notfired', rule);
		} else {
			addRule('fired', rule);
		}
	}
	return result;
}
