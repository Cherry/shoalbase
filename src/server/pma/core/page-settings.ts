// Port of Config\PageSettings with the FormDisplay rendering it uses: the "Page-related settings" dialogs.
import {
	type ConfigForm,
	arrayRead,
	arrayWrite,
	fieldInfo,
	itemPath,
	jsDefaultLine,
	jsValidateLines,
	pageForms,
	readPostedForms,
	strictEquals,
	userPreferencesToSave,
	validateValues,
} from '../../../lib/pma/config-forms.ts';
import { saveUserPreferences } from '../../../lib/pma/user-preferences.ts';
import { renderTemplate } from '../../twig/render.ts';

import type { PmaContext } from './context.ts';
import type { TemplateStateInput } from '../../twig/state.ts';

export interface PageSettings {
	/** PageSettings::getHTML(). */
	html: string;
	/** PageSettings::getErrorHTML(), which callers add to the page content. */
	errorHtml: string;
	/**
	 * The form was saved and a Location header back to the page was set; upstream exits there, so the controller
	 * must return context.response.response() without adding anything.
	 */
	saved: boolean;
}

export type Errors = Map<string, string[]>;

export interface FormDisplayInput {
	forms: ConfigForm[];
	groupName: string;
	errors: Errors;
	/** Values posted with a form that failed validation, shown instead of the configuration. */
	posted: Map<string, unknown>;
	/** FormDisplay::getDisplay() arguments for the user preference forms; page settings post back to the page without buttons. */
	action?: string;
	hiddenFields?: Record<string, unknown>;
	showButtons?: boolean;
}

// ConfigFile's read mapping: $cfg keeps the server's settings under Server rather than Servers/1.
const configPath = (path: string): string => path.replace(/^Servers\/1\//, 'Server/');

/** FormDisplay::displayFieldInput() for each field, plus FormDisplay::getDisplay() around them. */
export async function renderFormDisplay(context: PmaContext, input: FormDisplayInput, state: TemplateStateInput): Promise<string> {
	const config: Record<string, unknown> = context.config;
	const jsArray: string[] = [];
	const jsDefault: string[] = [];
	const tabs: Record<string, string> = {};
	const forms: Record<string, unknown>[] = [];
	for (const form of input.forms) {
		tabs[form.name] = form.title;
	}
	for (const form of input.forms) {
		let group = 0;
		let fieldsHtml = '';
		for (const item of form.fields) {
			const path = itemPath(item);
			if (path === null) {
				const marker = item as { group: string; text?: string; };
				if (marker.group === 'end') {
					group--;
					continue;
				}
				group++;
				if (marker.text !== '') {
					fieldsHtml += await renderTemplate('config/form_display/group_header', { group, colspan: 2, header_text: marker.text }, state);
				}
				continue;
			}
			const info = fieldInfo(path);
			let trClass = '';
			if (group > 0) {
				trClass = `group-field group-field-${group}`;
			}
			let setValue: string | null = null;
			if (typeof item === 'object' && 'setvalue' in item) {
				setValue = item.setvalue;
				if (setValue === ':group') {
					setValue = null;
					group++;
					trClass = `group-header-field group-header-${group}`;
				}
			}
			let value = input.posted.has(path) ? input.posted.get(path) : arrayRead(configPath(path), config, null);
			let valueIsDefault = false;
			if (value === null || strictEquals(value, info.default)) {
				value = info.default;
				valueIsDefault = true;
			}
			if (info.type === 'list') {
				// String keys, as Twing compares integer keys with 'wrapper_params' the PHP 7 way.
				value = new Map(Object.entries(typeof value === 'object' && value !== null ? value : [value]));
			}
			const errors = input.errors.get(path) ?? [];
			fieldsHtml += await renderTemplate('config/form_display/input', {
				is_setup: false,
				allows_customization: true,
				path: path.replaceAll('/', '-'),
				has_errors: errors.length > 0,
				errors,
				show_restore_default: true,
				set_value: setValue,
				tr_class: trClass,
				name: info.name,
				doc: info.doc,
				option_is_disabled: false,
				description: info.desc,
				comment: info.cmt,
				type: info.type,
				value,
				value_is_default: valueIsDefault,
				// A Map keeps integer option keys, which the template compares with "same as".
				select_values: new Map(info.values),
				select_values_disabled: [],
			}, state);
			jsDefault.push(jsDefaultLine(path, info));
			jsArray.push(...jsValidateLines(path, info.validators ?? []));
		}
		forms.push({
			name: form.name,
			descriptions: { name: form.title, desc: form.desc },
			errors: input.errors.get(form.name) ?? null,
			fields_html: fieldsHtml,
		});
	}
	return renderTemplate('config/form_display/display', {
		action: input.action ?? context.response.getSelfUrl(),
		has_check_page_refresh: true,
		hidden_fields: input.hiddenFields ?? { submit_save: input.groupName },
		tabs,
		forms,
		show_buttons: input.showButtons ?? false,
		js_array: jsArray,
		js_default: jsDefault,
	}, state);
}

/** FormDisplay::displayErrors(): field errors are titled by the field, form errors by the form. */
export async function renderErrors(forms: ConfigForm[], errors: Errors, state: TemplateStateInput): Promise<string> {
	let html = '';
	for (const [key, list] of errors) {
		const form = forms.find(item => item.name === key);
		const name = form === undefined ? fieldInfo(key).name : form.title;
		html += await renderTemplate('config/form_display/errors', { name, error_list: list }, state);
	}
	return html;
}

/** PageSettings::processPageSettings() and FormDisplay::process(false): saves only when every field is present and valid. */
function processForms(context: PmaContext, forms: ConfigForm[]): { errors: Errors; posted: Map<string, unknown>; } {
	const read = readPostedForms(forms, context.request.post);
	if (read.errors.size > 0) {
		return { errors: read.errors, posted: new Map() };
	}
	const errors = validateValues(read.values);
	if (errors.size > 0) {
		return { errors, posted: read.values };
	}
	const config: Record<string, unknown> = structuredClone(context.config);
	for (const [path, value] of read.values) {
		arrayWrite(configPath(path), config, value);
	}
	const baseConfig: Record<string, unknown> = context.baseConfig;
	saveUserPreferences(context.session, userPreferencesToSave(config, baseConfig), Math.floor(Date.now() / 1000));
	return { errors, posted: read.values };
}

/** new PageSettings($formGroupName, $elemId): processes a submitted settings form, then renders the dialog. */
export async function getPageSettings(context: PmaContext, groupName: string, elemId = 'page_settings_modal'): Promise<PageSettings> {
	const forms = pageForms(groupName);
	if (forms === null || context.request.params.printview === '1') {
		return { html: '', errorHtml: '', saved: false };
	}
	let errors: Errors = new Map();
	let posted = new Map<string, unknown>();
	if (context.request.post.submit_save === groupName) {
		({ errors, posted } = processForms(context, forms));
		if (errors.size === 0) {
			// Core::sendHeaderLocation() to Footer::getSelfUrl(), then exit.
			context.response.header('Location', context.response.getSelfUrl());
			return { html: '', errorHtml: '', saved: true };
		}
	}
	const state = await context.templateState();
	let errorHtml = '';
	if (errors.size > 0) {
		errorHtml = '<div class="alert alert-danger config-form" role="alert"><b>Cannot save settings, submitted configuration form contains errors!</b>'
			+ `${await renderErrors(forms, errors, state)}</div>`;
	}
	const display = await renderFormDisplay(context, { forms, groupName, errors, posted }, state);
	return { html: `<div id="${elemId}"><div class="page_settings">${display}</div></div>`, errorHtml, saved: false };
}
