// Config\ConfigFile and FormDisplay::save() as UserPreferences::pageInit() sets them up for the preference pages and the settings import.
import { phpString, phpTrim } from '../../twig/php.ts';
import {
	type ConfigForm,
	type FieldInfo,
	arrayRead,
	fieldInfo,
	itemPath,
	strictEquals,
	validateValues,
} from '../config-forms.ts';
import { isNumericString } from '../php-compare.ts';
import { sprintf } from '../sprintf.ts';

type PhpArray = unknown[] | Record<string, unknown>;
type Tree = Map<string, unknown>;
export type FormErrors = Map<string, string[]>;

// The cfgUpdateReadMapping of UserPreferences::pageInit(): $cfg keeps the server's settings under Server.
const READ_MAPPING: [string, string][] = [
	['Server/hide_db', 'Servers/1/hide_db'],
	['Server/only_db', 'Servers/1/only_db'],
];

const isPhpArray = (value: unknown): value is PhpArray => typeof value === 'object' && value !== null && !(value instanceof Map);

function entriesOf(value: PhpArray): [string, unknown][] {
	if (Array.isArray(value)) {
		return value.map((item, index) => [String(index), item]);
	}
	return Object.entries(value);
}

// isset($value[0]): only lists with a non-null first item are kept whole.
function hasFirstItem(value: PhpArray): boolean {
	const first = Array.isArray(value) ? value[0] : value['0'];
	return first !== undefined && first !== null;
}

/** ConfigFile::getFlatArray(): path => value pairs; lists stay whole and empty arrays vanish. */
export function flattenConfig(source: PhpArray | Tree, prefix = '', result = new Map<string, unknown>()): Map<string, unknown> {
	const entries = source instanceof Map ? source.entries().toArray() : entriesOf(source);
	for (const [key, value] of entries) {
		if (value instanceof Map || (isPhpArray(value) && !hasFirstItem(value))) {
			flattenConfig(value, `${prefix}${key}/`, result);
		} else if (!result.has(prefix + key)) {
			result.set(prefix + key, value);
		}
	}
	return result;
}

/** Core::arrayWrite() on the nested session data. */
function writePath(tree: Tree, path: string, value: unknown): void {
	const keys = path.split('/');
	const last = keys.pop() as string;
	let node = tree;
	for (const key of keys) {
		let child = node.get(key);
		if (!(child instanceof Map)) {
			child = new Map();
			node.set(key, child);
		}
		node = child as Tree;
	}
	node.set(last, value);
}

/** Core::arrayRemove(): removes the value, then any containers it left empty. */
function removePath(tree: Tree, path: string): void {
	const keys = path.split('/');
	const last = keys.pop() as string;
	const nodes: Tree[] = [tree];
	for (const key of keys) {
		const child = nodes.at(-1)?.get(key);
		if (!(child instanceof Map)) {
			return;
		}
		nodes.push(child);
	}
	nodes.at(-1)?.delete(last);
	for (let depth = keys.length - 1; depth >= 0 && nodes[depth + 1].size === 0; depth--) {
		nodes[depth].delete(keys[depth]);
	}
}

/** Config\ConfigFile limited to the user preference keys; data keeps PHP's insertion order, which the saved preferences follow. */
export class UserConfigFile {
	private data: Tree = new Map();

	/** `base` is Config::$baseSettings ($cfg before preferences); `allowed` the user preference fields. */
	constructor(private readonly base: Record<string, unknown>, private readonly allowed: ReadonlySet<string>) {}

	resetConfigData(): void {
		this.data = new Map();
	}

	/** ConfigFile::updateWithGlobalConfig(). */
	updateWithGlobalConfig(config: Record<string, unknown>): void {
		for (const [flatPath, value] of flattenConfig(config)) {
			const mapped = READ_MAPPING.find(([from]) => from === flatPath)?.[1] ?? flatPath;
			this.set(mapped, value);
		}
	}

	/** ConfigFile::set(): a value is dropped when both it and the base config equal the default. */
	set(path: string, value: unknown): void {
		if (!this.allowed.has(path)) {
			return;
		}
		const defaultValue = fieldInfo(path).default;
		if (strictEquals(value, defaultValue) && strictEquals(arrayRead(path, this.base, null), defaultValue)) {
			removePath(this.data, path);
			return;
		}
		writePath(this.data, path, value);
	}

	/** ConfigFile::get(): null when not stored. */
	get(path: string): unknown {
		let node: unknown = this.data;
		for (const key of path.split('/')) {
			if (!(node instanceof Map) || !node.has(key)) {
				return null;
			}
			node = node.get(key);
		}
		return node ?? null;
	}

	/** ConfigFile::getValue(): the stored value or the default. */
	getValue(path: string): unknown {
		return this.get(path) ?? fieldInfo(path).default;
	}

	/** ConfigFile::getConfigArray(): flat path => value pairs, with Servers/1/ paths moved to the end as Server/. */
	getConfigArray(): Record<string, unknown> {
		const flat = flattenConfig(this.data);
		for (const [mapTo, mapFrom] of READ_MAPPING) {
			const value = flat.get(mapFrom);
			if (value === undefined || value === null) {
				continue;
			}
			flat.delete(mapFrom);
			flat.set(mapTo, value);
		}
		return Object.fromEntries(flat);
	}
}

/** Util::requestString(): the first scalar of an array, trimmed. */
function requestString(value: unknown): string {
	let current = value;
	while (isPhpArray(current)) {
		const entries = entriesOf(current);
		current = entries.length > 0 ? entries[0][1] : false;
	}
	return phpTrim(phpString(current));
}

/** (int) of a string: its leading number, or 0. */
function phpIntval(value: string): number {
	const match = /^[\t\n\v\f\r ]*[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?/i.exec(value);
	return match ? Math.trunc(Number(match[0].trim())) : 0;
}

const isNumeric = (value: unknown): boolean => (typeof value === 'number' && !Number.isNaN(value)) || (typeof value === 'string' && isNumericString(value));

/** PHP 8's == between an option key and a submitted scalar. */
function looseEquals(key: string | number, value: unknown): boolean {
	if (typeof value === 'boolean') {
		const keyTruth = typeof key === 'number' ? key !== 0 : key !== '' && key !== '0';
		return keyTruth === value;
	}
	if (value === null) {
		return key === 0 || key === '';
	}
	if (typeof value !== 'number' && typeof value !== 'string') {
		return false;
	}
	if (isNumeric(key) && isNumeric(value)) {
		return Number(key) === Number(value);
	}
	return phpString(key) === phpString(value);
}

/** FormDisplay::validateSelect(): finds the option and casts the value to the option key's type. */
function validateSelect(value: unknown, keys: (string | number)[]): { ok: boolean; value: unknown; } {
	const compared = typeof value === 'boolean' ? Number(value) : value;
	for (const key of keys) {
		if (!((looseEquals(key, value) && isNumeric(compared) === isNumeric(key)) || key === value)) {
			continue;
		}
		if (typeof value === 'boolean') {
			return { ok: true, value };
		}
		if (typeof key === 'number') {
			return { ok: true, value: typeof value === 'number' ? Math.trunc(value) : phpIntval(phpString(value)) };
		}
		return { ok: true, value: phpString(value) };
	}
	return { ok: false, value };
}

/** The type casts of FormDisplay::save() for one submitted value, which may come from a form (strings) or an imported file (JSON). */
export function castFieldValue(info: FieldInfo, raw: unknown): { ok: boolean; value: unknown; } {
	if (info.type === 'checkbox' || info.type === 'number_text') {
		if (raw === '') {
			return { ok: true, value: '' };
		}
		const text = requestString(raw);
		if (info.type === 'checkbox') {
			return { ok: true, value: text !== '' && text !== '0' };
		}
		return { ok: true, value: phpIntval(text) };
	}
	if (info.type === 'select') {
		return validateSelect(raw, (info.values ?? []).map(([key]) => key));
	}
	if (info.type === 'list') {
		const items = isPhpArray(raw) ? entriesOf(raw).map(([, item]) => item) : phpString(raw).split('\n');
		return { ok: true, value: items.map(item => requestString(item)).filter(item => item !== '') };
	}
	return { ok: true, value: requestString(raw) };
}

function addError(errors: FormErrors, key: string, message: string): void {
	errors.set(key, [...errors.get(key) ?? [], message]);
}

const formPaths = (forms: ConfigForm[]): string[] => forms.flatMap(form => form.fields.map(item => itemPath(item)).filter(path => path !== null));

/** FormDisplay::validate(): validators run on the stored (or default) values of every field. */
export function validateForms(cf: UserConfigFile, forms: ConfigForm[]): FormErrors {
	return validateValues(new Map(formPaths(forms).map(path => [path, cf.getValue(path)])));
}

export interface SaveResult {
	/** FormDisplay::save()'s return value: false after missing data or an invalid choice. */
	result: boolean;
	/** FormDisplay::$errors, keyed by form name or field path; validation errors replace the others. */
	errors: FormErrors;
}

/**
 * FormDisplay::save() for one user preferences page. `post` returns the submitted value of a field by its form key
 * (Servers-1-hide_db), undefined or null when it was not sent.
 */
export function saveForms(cf: UserConfigFile, forms: ConfigForm[], post: (key: string) => unknown, allowPartialSave: boolean): SaveResult {
	let errors: FormErrors = new Map();
	let result = true;
	const toSave: [string, unknown][] = [];
	for (const form of forms) {
		for (const path of formPaths([form])) {
			const info = fieldInfo(path);
			let raw = post(path.replaceAll('/', '-'));
			if (raw === undefined || raw === null) {
				// Browsers leave unchecked checkboxes out.
				if (info.type !== 'checkbox') {
					addError(errors, form.name, sprintf('Missing data for %s', `<i>${info.name}</i>`));
					result = false;
					continue;
				}
				raw = false;
			}
			const cast = castFieldValue(info, raw);
			if (!cast.ok) {
				addError(errors, path, 'Incorrect value!');
				result = false;
				continue;
			}
			toSave.push([path, cast.value]);
		}
	}
	if (allowPartialSave || errors.size === 0) {
		for (const [path, value] of toSave) {
			cf.set(path, value);
		}
	}
	const validation = validateForms(cf, forms);
	if (validation.size > 0) {
		errors = validation;
	}
	return { result, errors };
}

/** FormDisplay::fixErrors(): fields with errors go back to their defaults; form-level errors are left alone. */
export function fixErrors(cf: UserConfigFile, forms: ConfigForm[], errors: FormErrors): void {
	const paths = new Set(formPaths(forms));
	for (const key of errors.keys()) {
		if (paths.has(key)) {
			cf.set(key, fieldInfo(key).default);
		}
	}
}
