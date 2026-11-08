// Port of Plugins\Import\ImportSql: splits the input into statements with BufferedQuery and runs them one by one.
import { BufferedQuery } from '../../../../sql-parser/index.ts';

import type { ImportPlugin, ImportRun } from './engine.ts';

const isEmpty = (value: string | false): boolean => [false, '', '0'].includes(value);

export class ImportSql implements ImportPlugin {
	// ImportSql::setSQLMode(): the compatibility options of the form.
	private async setSqlMode(run: ImportRun): Promise<void> {
		const params = run.context.request.params;
		const modes: string[] = [];
		if (typeof params.sql_compatibility === 'string' && params.sql_compatibility !== 'NONE') {
			modes.push(params.sql_compatibility);
		}
		if (params.sql_no_auto_value_on_zero !== undefined) {
			modes.push('NO_AUTO_VALUE_ON_ZERO');
		}
		if (modes.length === 0) {
			return;
		}
		await run.dbi.tryQuery(`SET SQL_MODE="${modes.join(',')}"`);
	}

	async doImport(run: ImportRun): Promise<void> {
		const { request } = run.context;
		await this.setSqlMode(run);
		const buffer = new BufferedQuery();
		const delimiter = request.post.sql_delimiter;
		if (typeof delimiter === 'string') {
			buffer.setDelimiter(delimiter);
		}
		while (!run.error) {
			const statement = buffer.extract();
			if (isEmpty(statement)) {
				const data = run.getNextChunk();
				if (data === true) {
					break;
				}
				// A lone CR becomes LF so every statement is found on any platform.
				buffer.query += data.replaceAll(/\r($|[^\n])/g, '\n$1');
				continue;
			}
			await run.runQuery(statement as string, statement as string);
		}
		while (!run.error && buffer.query !== '' && buffer.query !== '0') {
			const statement = buffer.extract(true);
			if (isEmpty(statement)) {
				continue;
			}
			await run.runQuery(statement as string, statement as string);
		}
		if (run.error) {
			return;
		}
		await run.runQuery('', '');
	}
}
