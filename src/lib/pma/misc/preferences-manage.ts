// Preferences\ManageController's pure parts: the settings export formats, the import through the user forms and the return URL.
import {
	type FormErrors,
	type UserConfigFile,
	fixErrors,
	saveForms,
	validateForms,
} from './user-config.ts';
import { phpString } from '../../twig/php.ts';
import {
	type ConfigForm,
	fieldInfo,
	itemPath,
	userForms,
} from '../config-forms.ts';
import { phpJsonEncode } from '../json.ts';

/** UserFormList::$forms, in the order BaseFormList::process() walks them. */
export const USER_FORM_GROUPS = ['Features', 'Sql', 'Navi', 'Main', 'Export', 'Import'];

const groupForms = (group: string): ConfigForm[] => userForms(group) as ConfigForm[];

/** UserFormList::getFields(): every field the user preference forms can set. */
export function userFormFields(): Set<string> {
	const fields = new Set<string>();
	for (const group of USER_FORM_GROUPS) {
		for (const form of groupForms(group)) {
			for (const item of form.fields) {
				const path = itemPath(item);
				if (path !== null) {
					fields.add(path);
				}
			}
		}
	}
	return fields;
}

// An empty PHP array is a list, so json_encode() writes [] for an empty settings map.
const asPhpArray = (configData: Record<string, unknown>): unknown => (Object.keys(configData).length === 0 ? [] : configData);

/** json_encode($config_data, JSON_PRETTY_PRINT), the "Save as JSON file" download. */
export function settingsAsJson(configData: Record<string, unknown>): string {
	return phpJsonEncode(asPhpArray(configData), true);
}

/** json_encode($config_data), what submit_get_json sends to the browser's local storage. */
export function settingsAsJsonString(configData: Record<string, unknown>): string {
	return phpJsonEncode(asPhpArray(configData));
}

/** PHP's var_export() of a decoded settings value. */
export function varExport(value: unknown, level = 1): string {
	if (value === null || value === undefined) {
		return 'NULL';
	}
	if (typeof value === 'boolean') {
		return value ? 'true' : 'false';
	}
	if (typeof value === 'number') {
		return String(value);
	}
	if (typeof value !== 'object') {
		return `'${phpString(value).replaceAll(/['\\]/g, String.raw`\$&`)}'`;
	}
	let text = '';
	if (level > 1) {
		text += `\n${' '.repeat(level - 1)}`;
	}
	text += 'array (\n';
	const entries = Array.isArray(value) ? value.map((item: unknown, index): [string, unknown] => [String(index), item]) : Object.entries(value);
	for (const [key, item] of entries) {
		const exportedKey = /^(?:0|-?[1-9]\d*)$/.test(key) ? key : varExport(key);
		text += `${' '.repeat(level + 1)}${exportedKey} => ${varExport(item, level + 2)},\n`;
	}
	if (level > 1) {
		text += ' '.repeat(level - 1);
	}
	return `${text})`;
}

/** The "Save as PHP file" download: one $cfg line per stored setting. */
export function settingsAsPhp(configData: Record<string, unknown>): string {
	let text = '/* phpMyAdmin configuration snippet */\n\n/* Paste it to your config.inc.php */\n\n';
	for (const [key, value] of Object.entries(configData)) {
		text += `$cfg['${key.replaceAll('/', '\'][\'')}'] = ${varExport(value)};\n`;
	}
	return text;
}

export interface ImportOutcome {
	ok: boolean;
	/** FormDisplay::displayErrors() input for each user form page, in order. */
	errors: { forms: ConfigForm[]; errors: FormErrors; }[];
}

/**
 * The submit_import branch: the imported settings are posted through every user form as if submitted, on top of the
 * flattened defaults (and the current settings when merging). `cf` must have been set up by pageInit.
 */
export function importConfiguration(cf: UserConfigFile, configuration: Record<string, unknown>, merge: boolean, fixAll: boolean): ImportOutcome {
	const post = new Map<string, unknown>();
	for (const path of userFormFields()) {
		const defaultValue = fieldInfo(path).default;
		// ConfigFile::getFlatDefaultConfig() splits arrays without a first item into sub-keys no form reads.
		const first = typeof defaultValue === 'object' && defaultValue !== null ? (defaultValue as Record<string, unknown>)[0] : '';
		if (first !== null && first !== undefined) {
			post.set(path.replaceAll('/', '-'), defaultValue);
		}
	}
	const sources = merge ? [cf.getConfigArray(), configuration] : [configuration];
	for (const source of sources) {
		for (const [key, value] of Object.entries(source)) {
			post.set(key.replaceAll('/', '-'), value);
		}
	}
	cf.resetConfigData();
	// BaseFormList::process() stops at the first page that fails, leaving the rest unprocessed.
	let processed = true;
	const pages: { forms: ConfigForm[]; errors: FormErrors | null; }[] = [];
	let hasErrors = false;
	for (const group of USER_FORM_GROUPS) {
		const forms = groupForms(group);
		if (!processed) {
			pages.push({ forms, errors: null });
			continue;
		}
		const saved = saveForms(cf, forms, key => post.get(key), true);
		processed = saved.result;
		hasErrors ||= saved.errors.size > 0;
		pages.push({ forms, errors: saved.errors });
	}
	if (processed && !hasErrors) {
		return { ok: true, errors: [] };
	}
	// Unprocessed pages are only validated when their errors are asked for.
	const errorsOf = (page: typeof pages[number]): FormErrors => page.errors ?? validateForms(cf, page.forms);
	if (fixAll) {
		for (const page of pages) {
			fixErrors(cf, page.forms, errorsOf(page));
		}
		return { ok: true, errors: [] };
	}
	return {
		ok: false,
		errors: pages.map((page) => {
			return { forms: page.forms, errors: errorsOf(page) };
		}),
	};
}

/** Util::splitURLQuery() and parse_url() of the import's return_url: its path and raw (still encoded) query values, without the token. */
export function splitReturnUrl(returnUrl: string): { path: string; params: Record<string, string>; } {
	// parse_url() drops the scheme and host from the path of an absolute URL.
	const url = returnUrl.replaceAll('&amp;', '&').replace(/^[a-z][a-z\d+.-]*:\/\/[^/?#]*/i, '');
	const hashAt = url.indexOf('#');
	const withoutHash = hashAt === -1 ? url : url.slice(0, hashAt);
	const queryAt = withoutHash.indexOf('?');
	const path = queryAt === -1 ? withoutHash : withoutHash.slice(0, queryAt);
	const params: Record<string, string> = {};
	if (queryAt !== -1) {
		for (const part of withoutHash.slice(queryAt + 1).split('&')) {
			const equals = part.indexOf('=');
			// Without "=", mb_strpos() returns false: the key is empty and the value starts at the second character.
			let key = '';
			let value = part.slice(1);
			if (equals !== -1) {
				key = part.slice(0, equals);
				value = part.slice(equals + 1);
			}
			if (key !== 'token') {
				params[key] = value;
			}
		}
	}
	return { path, params };
}
