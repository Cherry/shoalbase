// Config\FormDisplay without its templates: the user preference and page settings forms, their POST parsing and validators.
import formsData from './config-forms.json' with { type: 'json' };
import { sprintf } from './sprintf.ts';
import { escapeJsString } from '../twig/sanitize.ts';

export type FieldType = 'checkbox' | 'text' | 'short_text' | 'number_text' | 'select' | 'list';
type SelectKey = string | number;
type Validator = (string | number)[];

/** Everything FormDisplay::displayFieldInput() reads about a field besides its value, in English. */
export interface FieldInfo {
	type: FieldType;
	/** Descriptions::get(), already sanitized to HTML. */
	name: string;
	desc: string;
	cmt: string;
	/** FormDisplay::getDocLink(). */
	doc: string;
	/** ConfigFile::getDefault(). */
	default: unknown;
	/** Form::getOptionValueList() as ordered key/label pairs, after FormDisplay::setComments(). */
	values?: [SelectKey, string | boolean][];
	/** Validator::getValidators() entries: the name and its extra arguments. */
	validators?: Validator[];
}

export type FormItem = string | { path: string; setvalue: string; } | { group: 'header'; text: string; } | { group: 'end'; };

export interface ConfigForm {
	name: string;
	/** Descriptions::get('Form_' . name), and its description. */
	title: string;
	desc: string;
	fields: FormItem[];
}

interface FormsData {
	page: Record<string, ConfigForm[]>;
	user: Record<string, ConfigForm[]>;
	userFields: string[];
	fields: Record<string, FieldInfo>;
}

const data = formsData as unknown as FormsData;

/** PageFormList: the forms behind each page's settings dialog (Browse, DbStructure, Edit, Export, Import, Navi, Sql, TableStructure). */
export function pageForms(group: string): ConfigForm[] | null {
	return data.page[group] ?? null;
}

/** UserFormList: the user preferences tabs (Features, Sql, Navi, Main, Export, Import). */
export function userForms(group: string): ConfigForm[] | null {
	return data.user[group] ?? null;
}

export function fieldInfo(path: string): FieldInfo {
	return data.fields[path];
}

/** The path of a form item, or null for group markers. */
export function itemPath(item: FormItem): string | null {
	if (typeof item === 'string') {
		return item;
	}
	if ('path' in item) {
		return item.path;
	}
	return null;
}

// UserPreferences::apply() also accepts these custom-handled keys.
const EXTRA_ALLOWED = ['ThemeDefault', 'lang', 'Server/hide_db', 'Server/only_db', '2fa'];
const allowedPaths = new Set([...data.userFields, ...EXTRA_ALLOWED]);

/** Core::arrayRead(). */
export function arrayRead(path: string, source: Record<string, unknown>, fallback: unknown = null): unknown {
	let current: unknown = source;
	for (const key of path.split('/')) {
		if (typeof current !== 'object' || current === null || !Object.hasOwn(current, key)) {
			return fallback;
		}
		current = (current as Record<string, unknown>)[key];
	}
	return current;
}

/** Core::arrayWrite(). */
export function arrayWrite(path: string, target: Record<string, unknown>, value: unknown): void {
	const keys = path.split('/');
	const last = keys.pop() as string;
	let current = target;
	for (const key of keys) {
		if (typeof current[key] !== 'object' || current[key] === null) {
			current[key] = {};
		}
		current = current[key] as Record<string, unknown>;
	}
	current[last] = value;
}

/** UserPreferences::apply(): the stored path => value pairs a user may set, as a nested $cfg overlay. */
export function applyUserPreferences(configData: Record<string, unknown>, disallow: string[] = []): Record<string, unknown> {
	const overlay: Record<string, unknown> = {};
	for (const [path, value] of Object.entries(configData)) {
		if (allowedPaths.has(path) && !disallow.includes(path)) {
			arrayWrite(path, overlay, value);
		}
	}
	return overlay;
}

const isPlainRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** array_replace_recursive() of an overlay onto $cfg. */
export function replaceRecursive(target: Record<string, unknown>, overlay: Record<string, unknown>): void {
	for (const [key, value] of Object.entries(overlay)) {
		const current = target[key];
		if (isPlainRecord(value) && isPlainRecord(current)) {
			replaceRecursive(current, value);
		} else {
			target[key] = value;
		}
	}
}

/** PHP's === for config values, which compares arrays by keys, order and types. */
export function strictEquals(left: unknown, right: unknown): boolean {
	if (typeof left !== 'object' || left === null || typeof right !== 'object' || right === null) {
		return left === right;
	}
	const leftEntries = Object.entries(left);
	const rightEntries = Object.entries(right);
	if (leftEntries.length !== rightEntries.length) {
		return false;
	}
	return leftEntries.every(([key, value], index) => key === rightEntries[index][0] && strictEquals(value, rightEntries[index][1]));
}

// implode() turns null into '' and booleans into '1' or ''.
function phpImplodeValue(value: unknown): string {
	if (value === null || value === false) {
		return '';
	}
	if (value === true) {
		return '1';
	}
	return String(value);
}

/** The line FormDisplay::displayFieldInput() adds to the form's defaultValues script. */
export function jsDefaultLine(path: string, info: FieldInfo): string {
	const defaultValue = info.default;
	let value: string;
	if (info.type === 'checkbox') {
		value = defaultValue ? 'true' : 'false';
	} else if (info.type === 'select') {
		value = `['${escapeJsString(typeof defaultValue === 'boolean' ? Number(defaultValue) : defaultValue)}']`;
	} else if (info.type === 'list') {
		const items = Object.entries(defaultValue as Record<string, unknown>).filter(([key]) => key !== 'wrapper_params').map(([, item]) => item);
		value = `'${escapeJsString(items.map(item => phpImplodeValue(item)).join('\n'))}'`;
	} else {
		value = `'${escapeJsString(defaultValue)}'`;
	}
	return `'${path.replaceAll('/', '-')}': ${value}`;
}

/** FormDisplayTemplate::addJsValidate(). */
export function jsValidateLines(path: string, validators: Validator[]): string[] {
	return validators.map(([name, ...args]) => {
		let argList = '';
		if (args.length > 0) {
			argList = `, ['${args.map(arg => escapeJsString(arg)).join('\', \'')}']`;
		}
		return `registerFieldValidator('${path.replaceAll('/', '-')}', '${name}', true${argList})`;
	});
}

/** PHP's intval() of a request string, which reads leading digits and ignores the rest. */
function phpIntval(value: string): number {
	const match = /^\s*[+-]?\d+/.exec(value);
	return match ? Number.parseInt(match[0], 10) : 0;
}

// PHP's is_numeric().
const isNumeric = (value: unknown): boolean => typeof value === 'number' || (typeof value === 'string' && /^\s*[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?\s*$/i.test(value));

/** FormDisplay::validateSelect() for a posted string: finds the option it means and returns it with the option key's type. */
function validateSelect(value: string, allowed: SelectKey[]): { ok: boolean; value: unknown; } {
	for (const key of allowed) {
		// PHP 8's loose == between a number and a numeric string compares numerically; otherwise as strings.
		const bothNumeric = isNumeric(value) && isNumeric(key);
		const loose = bothNumeric ? Number(value) === Number(key) : value === String(key);
		if (loose && isNumeric(value) === isNumeric(key)) {
			return { ok: true, value: typeof key === 'number' ? phpIntval(value) : value };
		}
	}
	return { ok: false, value };
}

export interface ProcessedForms {
	/** path => typed value for every field that was posted correctly. */
	values: Map<string, unknown>;
	/** FormDisplay::$errors: keyed by form name for missing data, by field path otherwise. */
	errors: Map<string, string[]>;
}

type PostValue = string | string[] | undefined;

function addError(errors: Map<string, string[]>, key: string, message: string): void {
	const list = errors.get(key) ?? [];
	list.push(message);
	errors.set(key, list);
}

/** FormDisplay::save()'s POST reading for the given forms, with the type casts upstream applies. */
export function readPostedForms(forms: ConfigForm[], post: Record<string, PostValue>): ProcessedForms {
	const values = new Map<string, unknown>();
	const errors = new Map<string, string[]>();
	for (const form of forms) {
		for (const item of form.fields) {
			const path = itemPath(item);
			if (path === null) {
				continue;
			}
			const info = fieldInfo(path);
			const raw = post[path.replaceAll('/', '-')];
			if (raw === undefined) {
				// Browsers leave unchecked checkboxes out.
				if (info.type !== 'checkbox') {
					addError(errors, form.name, sprintf('Missing data for %s', `<i>${info.name}</i>`));
					continue;
				}
				values.set(path, false);
				continue;
			}
			const text = Array.isArray(raw) ? '' : raw;
			if (info.type === 'checkbox') {
				// settype($value, 'boolean'): '' stays as it is, and '0' is false.
				values.set(path, text === '' ? '' : text !== '0');
			} else if (info.type === 'number_text') {
				// settype() to integer only runs when something was entered; no page form has a float option.
				values.set(path, text === '' ? '' : phpIntval(text));
			} else if (info.type === 'select') {
				const options = info.values as [SelectKey, string | boolean][];
				const selected = validateSelect(text, options.map(([key]) => key));
				if (!selected.ok) {
					addError(errors, path, 'Incorrect value!');
					continue;
				}
				values.set(path, selected.value);
			} else if (info.type === 'list') {
				const lines = Array.isArray(raw) ? raw : raw.split('\n');
				values.set(path, lines.filter(line => line !== ''));
			} else {
				values.set(path, text);
			}
		}
	}
	return { values, errors };
}

/** Validator::validateNumber() on a posted integer: empty() lets 0 and '' pass, so only negatives fail. */
function validateNumber(value: unknown, message: string): string {
	if (typeof value === 'number' && value < 0) {
		return message;
	}
	return '';
}

/** Runs one Validator method; '' means valid, as upstream returns. */
function runValidator(name: string, args: (string | number)[], value: unknown): string {
	if (name === 'validatePositiveNumber') {
		return validateNumber(value, 'Not a positive number!');
	}
	if (name === 'validateNonNegativeNumber') {
		return validateNumber(value, 'Not a non-negative number!');
	}
	if (name === 'validateUpperBound') {
		return Number(value) <= Number(args[0]) ? '' : sprintf('Value must be less than or equal to %s!', args[0]);
	}
	if (name === 'validateByRegex') {
		if (value === null || value === undefined) {
			return '';
		}
		const pattern = String(args[0]);
		const regex = new RegExp(pattern.slice(1, pattern.lastIndexOf('/')));
		return regex.test(String(value)) ? '' : 'Incorrect value!';
	}
	// validateRegex checks hide_db, which no page settings form shows.
	return '';
}

/** Validator::validate() for the given path => value pairs: the error list of each failing path. */
export function validateValues(values: Map<string, unknown>): Map<string, string[]> {
	const errors = new Map<string, string[]>();
	for (const [path, value] of values) {
		for (const [name, ...args] of fieldInfo(path).validators ?? []) {
			const error = runValidator(String(name), args, value);
			if (error !== '') {
				addError(errors, path, error);
			}
		}
	}
	return errors;
}

/** ConfigFile::getConfigArray() for user preferences: allowed keys whose value differs from the default or the server config. */
export function userPreferencesToSave(config: Record<string, unknown>, baseConfig: Record<string, unknown>): Record<string, unknown> {
	const missing = Symbol('missing');
	const saved: Record<string, unknown> = {};
	for (const field of data.userFields) {
		const info = data.fields[field];
		// $cfg keeps the server's settings under Server rather than Servers/1.
		const path = field.replace(/^Servers\/1\//, 'Server/');
		const value = arrayRead(path, config, missing);
		// ConfigFile::getFlatArray() walks an empty array as a map with no keys, so an emptied list is never stored.
		if (info === undefined || value === missing || (Array.isArray(value) && value.length === 0)) {
			continue;
		}
		if (!strictEquals(value, info.default) || !strictEquals(arrayRead(path, baseConfig, missing), info.default)) {
			saved[path] = value;
		}
	}
	return saved;
}
