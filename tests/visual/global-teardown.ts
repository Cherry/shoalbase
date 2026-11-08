import {
	existsSync,
	readFileSync,
	readdirSync,
	writeFileSync,
} from 'node:fs';
import path from 'node:path';

import { dropScratchTables, withDb } from './support/db.ts';
import { REPORT_DIR } from './support/diff.ts';

const escapeHtml = (text: string): string => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

/** Gathers every result.json the specs wrote into summary.json and a browsable index.html. */
function writeIndex(): void {
	const results: Record<string, unknown>[] = [];
	for (const entry of readdirSync(REPORT_DIR, { withFileTypes: true })) {
		const file = path.join(REPORT_DIR, entry.name, 'result.json');
		if (entry.isDirectory() && existsSync(file)) {
			results.push(JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>);
		}
	}
	writeFileSync(path.join(REPORT_DIR, 'summary.json'), JSON.stringify(results, null, '\t'));
	const rows = results.map((result) => {
		const name = String(result.screen ?? result.check);
		let image = '';
		if (existsSync(path.join(REPORT_DIR, name, 'side-by-side.png'))) {
			image = `<a href="${name}/side-by-side.png"><img src="${name}/side-by-side.png" loading="lazy"></a>`;
		}
		return `<section><h2>${escapeHtml(name)}</h2><pre>${escapeHtml(JSON.stringify(result, null, 2))}</pre>${image}</section>`;
	});
	const html = `<!doctype html><meta charset="utf-8"><title>Visual parity</title>
<style>body{font:14px sans-serif;margin:16px}img{max-width:100%;border:1px solid #ccc}pre{background:#f4f4f4;padding:8px;white-space:pre-wrap}</style>
<h1>Oracle | ours | diff</h1>${rows.join('\n')}`;
	writeFileSync(path.join(REPORT_DIR, 'index.html'), html);
}

export default async function globalTeardown(): Promise<void> {
	writeIndex();
	await withDb(dropScratchTables);
}
