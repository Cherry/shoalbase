// Plugins::getPlugin('export', $format) for the formats the export page offers.
import {
	ExportCodegen,
	ExportHtmlword,
	ExportLatex,
	ExportMediawiki,
	ExportOds,
	ExportOdt,
	ExportTexytext,
} from './document-formats.ts';
import { ExportSql } from './sql.ts';
import {
	ExportCsv,
	ExportExcel,
	ExportJson,
	ExportPhparray,
	ExportXml,
	ExportYaml,
} from './text-formats.ts';
import { ExportPdf } from '../../pdf/export-pdf.ts';

import type { ExportPlugin, ExportRun } from './engine.ts';

const PLUGINS: Record<string, new (run: ExportRun) => ExportPlugin> = {
	codegen: ExportCodegen,
	csv: ExportCsv,
	excel: ExportExcel,
	htmlword: ExportHtmlword,
	json: ExportJson,
	latex: ExportLatex,
	mediawiki: ExportMediawiki,
	ods: ExportOds,
	odt: ExportOdt,
	pdf: ExportPdf,
	phparray: ExportPhparray,
	sql: ExportSql,
	texytext: ExportTexytext,
	xml: ExportXml,
	yaml: ExportYaml,
};

/** The plugin instance for a format getExportPlugin() accepted, or null for one without a port. */
export function createExportPlugin(format: string, run: ExportRun): ExportPlugin | null {
	const Plugin = PLUGINS[format];
	if (Plugin === undefined) {
		return null;
	}
	return new Plugin(run);
}
