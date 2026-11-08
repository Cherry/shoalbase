// Ports of Server, Database and Table ImportController: the import form for each level.
import { optionRequest, render } from './common.ts';
import { CSV_COLUMNS_HINT, getImportList } from '../../../../lib/pma/export-import/import-plugins.ts';
import {
	checkboxCheck,
	getChoice,
	getDefault,
	getOptions,
} from '../../../../lib/pma/export-import/properties.ts';
import { isNumericString } from '../../../../lib/pma/php-compare.ts';
import { getFormattedMaximumUploadSize } from '../../../../lib/pma/util.ts';
import { showHint } from '../../../../lib/twig/html.ts';
import { getCharsets } from '../../core/charsets.ts';
import { generatorState } from '../../core/generator.ts';
import { getPageSettings } from '../../core/page-settings.ts';
import { getDbInfo, hasDatabase } from '../database/common.ts';
import { checkDbTableExists } from '../table-structure/common.ts';

import type { PmaContext } from '../../core/context.ts';
import type { Controller } from '../../dispatcher.ts';

/** upload_max_filesize of the official image (UPLOAD_LIMIT=2048K), which $GLOBALS['config']->get('max_upload_size') reports. */
export const MAX_UPLOAD_SIZE = 2_097_152;

/** The upload progress handler Ajax::uploadProgressSetup() picks: the image ships the uploadprogress extension. */
export const UPLOAD_HANDLER = String.raw`PhpMyAdmin\Plugins\Import\Upload\UploadProgress`;

/** Import::getCompressions() with the image's zlib, bz2 and zip extensions. */
const COMPRESSIONS = ['gzip', 'bzip2', 'zip'];

/** uniqid(''): the time in seconds and microseconds as 13 hex digits. */
function uniqid(now: number): string {
	const seconds = Math.floor(now / 1000);
	const micro = Math.floor((now % 1000) * 1000);
	return seconds.toString(16).padStart(8, '0') + micro.toString(16).padStart(5, '0');
}

/** Ajax::uploadProgressSetup(): records the handler in $_SESSION['__upload_status'] and returns a new upload id. */
function uploadProgressSetup(context: PmaContext): string {
	const status = (context.session.data.__upload_status ?? {}) as Record<string, unknown>;
	status.handler = UPLOAD_HANDLER;
	context.session.data.__upload_status = status;
	return uniqid(Date.now());
}

/** ForeignKey::isCheckEnabled(). */
async function isForeignKeyCheckEnabled(context: PmaContext): Promise<boolean> {
	const setting = context.config.DefaultForeignKeyChecks;
	if (setting === 'enable') {
		return true;
	}
	if (setting === 'disable') {
		return false;
	}
	return await context.dbi.getVariable('FOREIGN_KEY_CHECKS') === 'ON';
}

/** ImportLdi::setLdiLocalOptionConfig(): 'auto' becomes whether the server allows LOCAL INFILE. */
async function resolveLdiLocalOption(context: PmaContext): Promise<void> {
	const importConfig = context.config.Import as unknown as Record<string, unknown>;
	if (importConfig.ldi_local_option !== 'auto') {
		return;
	}
	importConfig.ldi_local_option = false;
	const result = await context.dbi.tryQuery('SELECT @@local_infile;');
	if (result === false || result.numRows() <= 0) {
		return;
	}
	const value = result.fetchValue();
	importConfig.ldi_local_option = value === 'ON' || value === '1';
}

async function importPage(context: PmaContext, importType: 'database' | 'server' | 'table', template: string, pageSettings: { html: string; errorHtml: string; }, hiddenInputs: Record<string, unknown>): Promise<Response> {
	const { request, response } = context;
	const uploadId = uploadProgressSetup(context);
	if (importType === 'table') {
		await resolveLdiLocalOption(context);
	}
	const importList = getImportList({ importType, columnsHint: showHint(generatorState(context), CSV_COLUMNS_HINT) });
	const offset = request.params.offset;
	const options = optionRequest(context, 'Import');
	const format = request.query.format;
	const charsets = await getCharsets(context);
	response.addHTML(await render(context, template, {
		page_settings_error_html: pageSettings.errorHtml,
		page_settings_html: pageSettings.html,
		upload_id: uploadId,
		handler: UPLOAD_HANDLER,
		hidden_inputs: { UPLOAD_IDENTIFIER: uploadId, import_type: importType, ...hiddenInputs },
		db: context.db,
		table: context.table,
		max_upload_size: MAX_UPLOAD_SIZE,
		formatted_maximum_upload_size: getFormattedMaximumUploadSize(MAX_UPLOAD_SIZE),
		plugins_choice: getChoice(importList, typeof format === 'string' ? format : getDefault(options, 'format')),
		options: getOptions(options, importList),
		skip_queries_default: getDefault(options, 'skip_queries'),
		is_allow_interrupt_checked: checkboxCheck(options, 'allow_interrupt'),
		local_import_file: request.params.local_import_file ?? null,
		is_upload: true,
		upload_dir: context.config.UploadDir,
		timeout_passed_global: null,
		compressions: COMPRESSIONS,
		is_encoding_supported: true,
		encodings: context.config.AvailableCharsets,
		import_charset: context.config.Import.charset,
		timeout_passed: request.params.timeout_passed ?? null,
		offset: typeof offset === 'string' && isNumericString(offset) ? Math.trunc(Number(offset)) : null,
		can_convert_kanji: false,
		charsets: charsets.values().toArray(),
		is_foreign_key_check: await isForeignKeyCheckEnabled(context),
		user_upload_dir: '/',
		local_files: '',
	}));
	return response.response();
}

/** ServerImportController. */
const serverImportController: Controller = async (context) => {
	const { dbi, response } = context;
	const pageSettings = await getPageSettings(context, 'Import');
	if (pageSettings.saved) {
		return response.response();
	}
	response.addScriptFiles(['import.js']);
	if (await dbi.isSuperUser()) {
		await dbi.selectDb('mysql');
	}
	return importPage(context, 'server', 'server/import/index', pageSettings, {});
};

/** DatabaseImportController. */
const databaseImportController: Controller = async (context) => {
	const { response } = context;
	const pageSettings = await getPageSettings(context, 'Import');
	if (pageSettings.saved) {
		return response.response();
	}
	response.addScriptFiles(['import.js']);
	if (!await hasDatabase(context)) {
		return response.response();
	}
	await getDbInfo(context, '');
	return importPage(context, 'database', 'database/import/index', pageSettings, { db: context.db });
};

/** TableImportController. */
const tableImportController: Controller = async (context) => {
	const { response } = context;
	const pageSettings = await getPageSettings(context, 'Import');
	if (pageSettings.saved) {
		return response.response();
	}
	response.addScriptFiles(['import.js']);
	const missing = await checkDbTableExists(context);
	if (missing !== null) {
		return missing;
	}
	return importPage(context, 'table', 'table/import/index', pageSettings, { db: context.db, table: context.table });
};

export const controllers: Record<string, Controller> = {
	'Server/ImportController': serverImportController,
	'Database/ImportController': databaseImportController,
	'Table/ImportController': tableImportController,
};
