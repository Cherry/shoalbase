// Html\Generator::formatSql(): a query shown in a code block, optionally cut to $cfg['MaxCharactersInDisplayedSQL'].
import { escapeCompat } from './column-spec.ts';

export function formatSql(sqlQuery: string, truncate = false, maxCharacters = 1000): string {
	let query = sqlQuery;
	const characters = [...sqlQuery];
	if (truncate && characters.length > maxCharacters) {
		query = `${characters.slice(0, maxCharacters).join('')}[...]`;
	}
	return `<code class="sql" dir="ltr"><pre>\n${escapeCompat(query)}\n</pre></code>`;
}
