// Port of Plugins\Import\ImportShp: one geometry column per shape; the image has no dBase extension, so no attribute columns.
import { GEOMETRY, type ImportTable, analyzeTable } from '../../../../lib/pma/export-import/import-analysis.ts';
import { zipContents, zipFileCount } from '../../../../lib/pma/export-import/import-file.ts';
import {
	type ShapeData,
	multiLineStringShape,
	multiPointShape,
	multiPolygonShape,
	pointShape,
	readShapeFile,
	shapeName,
} from '../../../../lib/pma/export-import/shapefile.ts';
import { Message } from '../../../../lib/pma/message.ts';

import type { ImportPlugin, ImportRun } from './engine.ts';

const SHAPES: Record<number, (data: ShapeData) => string> = {
	1: pointShape,
	3: multiLineStringShape,
	5: multiPolygonShape,
	8: multiPointShape,
};

const SHAPE_FILE_ERROR = 'There was an error importing the ESRI shape file: "%s".';

export class ImportShp implements ImportPlugin {
	async doImport(run: ImportRun): Promise<void> {
		const { context } = run;
		run.finished = false;
		if (run.source === null) {
			return;
		}
		let bytes = run.source.bytes;
		if (run.options.compression === 'application/zip' && zipFileCount(run.source.raw) > 1) {
			const entry = await zipContents(run.source.raw, { pattern: /^.*\.shp$/i, source: String.raw`/^.*\.shp$/i` });
			if (entry.error !== '') {
				run.message = Message.error(SHAPE_FILE_ERROR);
				run.message.addParam(Message.rawError(entry.error));
				return;
			}
			bytes = entry.data;
		}
		const shapes = readShapeFile(bytes);
		if (shapes.lastError !== '') {
			run.error = true;
			run.message = Message.error(SHAPE_FILE_ERROR);
			run.message.addParam(shapes.lastError);
			return;
		}
		const type = shapes.shapeType === false ? 0 : shapes.shapeType;
		if (type !== 0 && SHAPES[type] === undefined) {
			run.error = true;
			run.message = Message.error('MySQL Spatial Extension does not support ESRI type "%s".');
			run.message.addParam(shapeName(type));
			return;
		}
		const shape = SHAPES[type];
		const rows = shapes.records.map(record => [shape === undefined ? null : `GeomFromText('${shape(record)}')`]);
		if (rows.length === 0) {
			run.error = true;
			run.message = Message.error('The imported file does not contain any data!');
			return;
		}
		let name = 'TBL_NAME';
		if (context.db !== '') {
			const tables = await context.dbi.fetchResult('SHOW TABLES') as unknown[];
			name = `TABLE ${tables.length + 1}`;
		}
		const table: ImportTable = { name, columns: ['SPATIAL'], rows };
		const analysis = analyzeTable(table);
		analysis.types[0] = GEOMETRY;
		analysis.formattedSql = [true];
		if (context.db === '') {
			await run.buildSql('SHP_DB', [table], [analysis], null);
		} else {
			await run.buildSql(context.db, [table], [analysis], null, false);
		}
		run.finished = true;
		run.error = false;
		await run.runQuery('', '');
	}
}
