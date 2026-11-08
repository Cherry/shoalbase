import { mkdirSync, rmSync } from 'node:fs';

import { createPagesTable, dropScratchTables, withDb } from './support/db.ts';
import { REPORT_DIR } from './support/diff.ts';

export default async function globalSetup(): Promise<void> {
	rmSync(REPORT_DIR, { recursive: true, force: true });
	mkdirSync(REPORT_DIR, { recursive: true });
	await withDb(async (connection) => {
		await dropScratchTables(connection);
		await createPagesTable(connection, 'vis_pages');
	});
}
