// Port of PhpMyAdmin\Properties (plugin option trees) and the Plugins::getOptions() family that renders them.
import { htmlspecialchars, phpString } from '../../twig/php.ts';
import { phpEmpty } from '../server/php.ts';

export type ItemKind = 'bool' | 'doc' | 'hidden' | 'message' | 'number' | 'radio' | 'select' | 'text';
export type GroupKind = 'root' | 'main' | 'subgroup';
export type OptionKey = number | string;

/** OptionsPropertyOneItem and its Items\* subclasses. */
export class OptionsItem {
	name: string | null = null;
	text: string | null = null;
	force: string | null = null;
	values: [OptionKey, string][] = [];
	size: number | null = null;
	len: number | null = null;

	// OptionsPropertyItem::__construct() only keeps truthy arguments, so a lone message text becomes the name.
	constructor(readonly kind: ItemKind, name: string | null = null, text: string | null = null) {
		if (name) {
			this.name = name;
		}
		if (text) {
			this.text = text;
		}
	}

	setValues(values: [OptionKey, string][]): this {
		this.values = values;
		return this;
	}

	setForce(force: string): this {
		this.force = force;
		return this;
	}
}

/** OptionsPropertyRootGroup, OptionsPropertyMainGroup and OptionsPropertySubgroup. */
export class OptionsGroup {
	name: string | null = null;
	text: string | null = null;
	force: string | null = null;
	readonly properties: (OptionsGroup | OptionsItem)[] = [];
	subgroupHeader: OptionsItem | null = null;

	constructor(readonly kind: GroupKind, name: string | null = null, text: string | null = null) {
		if (name) {
			this.name = name;
		}
		if (text) {
			this.text = text;
		}
	}

	add(property: OptionsGroup | OptionsItem): this {
		this.properties.push(property);
		return this;
	}

	setForce(force: string): this {
		this.force = force;
		return this;
	}

	setHeader(header: OptionsItem): this {
		this.subgroupHeader = header;
		return this;
	}
}

/** ExportPluginProperties / ImportPluginProperties. */
export interface PluginProperties {
	text: string;
	extension: string;
	mimeType: string;
	forceFile: boolean;
	options: OptionsGroup | null;
}

export interface PluginInfo {
	name: string;
	properties: PluginProperties;
}

/** The request state Plugins::getDefault() and checkboxCheck() read. */
export interface OptionRequest {
	/** $_GET. */
	get: Record<string, unknown>;
	/** $_REQUEST. */
	request: Record<string, unknown>;
	/** $GLOBALS['timeout_passed']. */
	timeoutPassed: boolean;
	/** $cfg['Export'] or $cfg['Import']. */
	section: Record<string, unknown>;
}

// The default captions ExportLatex::init() publishes as globals for getDefault()'s str* replacement.
const LOCALISED_STRINGS: Record<string, string> = {
	strLatexContent: 'Content of table @TABLE@',
	strLatexContinued: '(continued)',
	strLatexStructure: 'Structure of table @TABLE@',
};

/** PHP 8's loose == between an array key and a request string. */
export function looseKeyEquals(key: OptionKey, value: string): boolean {
	const numeric = /^\s*[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?\s*$/i;
	if ((typeof key === 'number' || numeric.test(key)) && numeric.test(value)) {
		return Number(key) === Number(value);
	}
	return String(key) === value;
}

/** Plugins::checkboxCheck(). */
export function checkboxCheck(request: OptionRequest, option: string): string {
	if (request.get[option] !== undefined || (request.get.repopulate === undefined && ((request.timeoutPassed && request.request[option] !== undefined) || !phpEmpty(request.section[option])))) {
		return ' checked="checked"';
	}
	return '';
}

/** Plugins::getDefault(). */
export function getDefault(request: OptionRequest, option: string): string {
	if (request.get[option] !== undefined) {
		return htmlspecialchars(request.get[option]);
	}
	if (request.timeoutPassed && request.request[option] !== undefined) {
		return htmlspecialchars(request.request[option]);
	}
	const value = request.section[option];
	if (value === undefined || value === null) {
		return '';
	}
	const text = phpString(value);
	return htmlspecialchars(text.replaceAll(/str[A-Z][A-Za-z0-9]*/g, match => LOCALISED_STRINGS[match] ?? match));
}

/** Plugins::getChoice(). */
export function getChoice(list: PluginInfo[], defaultName: string): { name: string; text: string; is_selected: boolean; force_file: boolean; }[] {
	return list.map((plugin) => {
		return {
			name: plugin.name,
			text: plugin.properties.text,
			is_selected: plugin.name === defaultName,
			force_file: plugin.properties.forceFile,
		};
	});
}

// Plugins::getOneOption() closes the list element after these items, even when it was already closed.
const CLOSED_AFTER: Set<ItemKind> = new Set(['bool', 'message', 'select', 'text']);

/** Plugins::getHtmlForProperty(). */
export function getHtmlForProperty(request: OptionRequest, pluginName: string, item: OptionsItem): string {
	const id = `${pluginName}_${item.name ?? ''}`;
	const text = item.text ?? '';
	switch (item.kind) {
		case 'bool': {
			let html = '<li class="list-group-item">\n<div class="form-check form-switch">\n';
			html += `<input class="form-check-input" type="checkbox" role="switch" name="${id}" value="something" id="checkbox_${id}" ${checkboxCheck(request, id)}`;
			if (item.force) {
				const forced = `checkbox_${pluginName}_${item.force}`;
				html += ` onclick="if (!this.checked &amp;&amp; (!document.getElementById('${forced}') || !document.getElementById('${forced}').checked)) return false; else return true;"`;
			}
			return `${html}><label class="form-check-label" for="checkbox_${id}">${text}</label></div>`;
		}
		case 'hidden': {
			return `<li class="list-group-item"><input type="hidden" name="${id}" value="${getDefault(request, id)}"></li>`;
		}
		case 'message': {
			return `<li class="list-group-item">\n${text}`;
		}
		case 'radio': {
			const current = getDefault(request, id);
			let html = '<li class="list-group-item">';
			for (const [key, label] of item.values) {
				html += `<div class="form-check"><input type="radio" name="${id}" class="form-check-input" value="${key}" id="radio_${id}_${key}"`;
				if (looseKeyEquals(key, current)) {
					html += ' checked';
				}
				html += `><label class="form-check-label" for="radio_${id}_${key}">${label}</label></div>`;
			}
			return `${html}</li>`;
		}
		case 'select': {
			let html = `<li class="list-group-item">\n<label for="select_${id}" class="form-label">${text}</label>`;
			html += `<select class="form-select" name="${id}" id="select_${id}">`;
			const current = getDefault(request, id);
			for (const [key, label] of item.values) {
				html += `<option value="${key}"${looseKeyEquals(key, current) ? ' selected' : ''}>${label}</option>`;
			}
			return `${html}</select>`;
		}
		case 'text': {
			let html = `<li class="list-group-item">\n<label for="text_${id}" class="form-label">${text}</label>`;
			html += `<input class="form-control" type="text" name="${id}" value="${getDefault(request, id)}" id="text_${id}"`;
			if ((item.size ?? 0) > 0) {
				html += ` size="${item.size}"`;
			}
			if (item.len) {
				html += ` maxlength="${item.len}"`;
			}
			return `${html}>`;
		}
		case 'number': {
			return `<li class="list-group-item">\n<label for="number_${id}" class="form-label">${text}</label><input class="form-control" type="number" name="${id}" value="${getDefault(request, id)}" id="number_${id}" min="0">`;
		}
		default: {
			// DocPropertyItem echoes its class name instead of returning markup; no plugin uses it.
			return '';
		}
	}
}

/** Plugins::getOneOption(), including its quirk of leaving list items open inside groups. */
export function getOneOption(request: OptionRequest, pluginName: string, property: OptionsGroup | OptionsItem, isSubgroup = false): string {
	let html = '\n';
	let properties: (OptionsGroup | OptionsItem)[];
	let notSubgroupHeader = false;
	if (property instanceof OptionsItem) {
		properties = [property];
	} else {
		if (!isSubgroup) {
			html += `<div id="${pluginName}_${String(property.name)}">`;
			if (property.text) {
				html += `<h5 class="card-title mt-4 mb-2">${property.text}</h5>`;
			}
			html += '<ul class="list-group">';
		}
		notSubgroupHeader = true;
		properties = property.properties;
	}
	let lastKind: ItemKind | GroupKind | null = null;
	for (const item of properties) {
		lastKind = item.kind;
		if (item instanceof OptionsGroup) {
			const header = item.subgroupHeader;
			if (header !== null) {
				html += getOneOption(request, pluginName, header);
			}
			html += '<li class="list-group-item"><ul class="list-group"';
			html += header === null ? '>' : ` id="ul_${header.name ?? ''}">`;
			html += getOneOption(request, pluginName, item, true);
			continue;
		}
		html += getHtmlForProperty(request, pluginName, item);
	}
	if (isSubgroup) {
		html += '</ul></li>';
	} else if (notSubgroupHeader) {
		html += '</ul></div>';
	}
	if (lastKind !== null && CLOSED_AFTER.has(lastKind as ItemKind)) {
		html += '</li>';
	}
	return `${html}\n`;
}

/** Plugins::getOptions(): one format_specific_options block per plugin. */
export function getOptions(request: OptionRequest, list: PluginInfo[]): string {
	let html = '';
	for (const plugin of list) {
		const { text, options } = plugin.properties;
		html += `<div id="${plugin.name}_options" class="format_specific_options">`;
		html += `<h3>${text}</h3>`;
		let noOptions = true;
		if (options !== null && options.properties.length > 0) {
			for (const mainGroup of options.properties as OptionsGroup[]) {
				noOptions = !mainGroup.properties.some(item => item.kind !== 'hidden');
				html += getOneOption(request, plugin.name, mainGroup);
			}
		}
		if (noOptions) {
			html += '<p class="card-text">This format has no options</p>';
		}
		html += '</div>';
	}
	return html;
}
