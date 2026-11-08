// Plugins::getPlugin('import', $format, $importType) for the formats the import page offers.
import { ImportCsv, ImportLdi } from './csv.ts';
import { ImportMediawiki, ImportOds, ImportXml } from './documents.ts';
import { ImportShp } from './shp.ts';
import { ImportSql } from './sql.ts';

import type { ImportPlugin } from './engine.ts';

/** The plugin for a format, or null when it is unknown or LOAD DATA is asked for outside a table. */
export function createImportPlugin(format: string, importType: string): ImportPlugin | null {
	if (format === 'sql') {
		return new ImportSql();
	}
	if (format === 'csv') {
		return new ImportCsv();
	}
	if (format === 'ods') {
		return new ImportOds();
	}
	if (format === 'xml') {
		return new ImportXml();
	}
	if (format === 'shp') {
		return new ImportShp();
	}
	if (format === 'mediawiki') {
		return new ImportMediawiki();
	}
	if (format === 'ldi' && importType === 'table') {
		return new ImportLdi();
	}
	return null;
}
