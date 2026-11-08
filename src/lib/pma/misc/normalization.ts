// Normalization's HTML and SQL builders: the 1NF, 2NF and 3NF wizard steps, without the database reads.
import { htmlspecialchars } from '../../twig/php.ts';
import { backquote } from '../../twig/sanitize.ts';
import { phpJsonEncode } from '../json.ts';
import { phpCompareStrings } from '../php-compare.ts';
import { sprintf } from '../sprintf.ts';
import { extractColumnSpec } from '../table-structure/column-spec.ts';

export interface ColumnDefinition {
	name: string;
	type: string;
}

/** Normalization::getHtmlForColumnsList(): options or checkboxes for the columns whose type is in `types` (all when null). */
export function columnsListHtml(columns: ColumnDefinition[], types: string[] | null, listType: 'dropdown' | 'checkbox'): string {
	let html = '';
	for (const column of columns) {
		const type = extractColumnSpec(column.type).type;
		if (types !== null && types.length > 0 && !types.includes(type.toUpperCase())) {
			continue;
		}
		const name = htmlspecialchars(column.name);
		if (listType === 'checkbox') {
			html += `<input type="checkbox" value="${name}">${name} [ ${htmlspecialchars(column.type)} ]<br>`;
		} else {
			html += `<option value="${name}">${name} [ ${htmlspecialchars(column.type)} ]</option>`;
		}
	}
	return html;
}

/** Normalization::getHtmlFor1NFStep1(). */
export function oneNfStep1Html(normalizeTo: string, stringColumnsOptions: string): string {
	return '<h3 class=\'text-center\'>First step of normalization (1NF)</h3>'
		+ `<div id='mainContent' data-normalizeto='${normalizeTo}'><fieldset class="pma-fieldset"><legend>Step 1.1 Make all columns atomic</legend>`
		+ '<h4>Do you have any column which can be split into more than one column? For example: address can be split into street, city, country and zip.'
		+ '<br>(<a class=\'central_columns_dialog\' data-maxrows=\'25\' data-pick=false href=\'#\'> Show me the central list of columns that are not already in this table </a>)</h4>'
		+ '<p class=\'cm-em\'>Select a column which can be split into more than one (on select of \'no such column\', it\'ll move to next step).</p>'
		+ '<div id=\'extra\'><select id=\'selectNonAtomicCol\' name=\'makeAtomic\'><option selected="selected" disabled="disabled">Select one…</option>'
		+ `<option value='no_such_col'>No such column</option>${stringColumnsOptions}</select>`
		+ '<span>split into </span><input id=\'numField\' type=\'number\' value=\'2\'><input type="submit" class="btn btn-primary" id="splitGo" value="Go"></div>'
		+ '<div id=\'newCols\'></div></fieldset><fieldset class="pma-fieldset tblFooters"></fieldset></div>';
}

/** Normalization::getHtmlContentsFor1NFStep2(); `addPrimaryIcon` is the b_index_add icon. */
export function oneNfStep2(hasPrimaryKey: boolean, addPrimaryIcon: string): Record<string, string> {
	if (hasPrimaryKey) {
		return { legendText: 'Step 1.2 Have a primary key', headText: 'Primary key already exists.', subText: 'Taking you to next step…', hasPrimaryKey: '1', extra: '' };
	}
	return {
		legendText: 'Step 1.2 Have a primary key',
		headText: 'There is no primary key; please add one.<br>Hint: A primary key is a column (or combination of columns) that uniquely identify all rows.',
		subText: `<a href="#" id="createPrimaryKey">${addPrimaryIcon}</a>`,
		hasPrimaryKey: '0',
		extra: 'If it\'s not possible to make existing column combinations as primary key<br><a href="#" id="addNewPrimary">+ Add a new primary key column</a>',
	};
}

/** Normalization::getHtmlContentsFor1NFStep3(). */
export function oneNfStep3(columnCheckboxes: string, primaryKey: string[]): Record<string, string> {
	return {
		legendText: 'Step 1.3 Move repeating groups',
		headText: 'Do you have a group of two or more columns that are closely related and are all repeating the same attribute? For example, '
			+ 'a table that holds data on books might have columns such as book_id, author1, author2, author3 and so on which form a '
			+ 'repeating group. In this case a new table (book_id, author) should be created.',
		subText: 'Check the columns which form a repeating group. If no such group, click on \'No repeating group\'',
		extra: `${columnCheckboxes}<br><input class="btn btn-secondary" type="submit" id="moveRepeatingGroup" value="Done">`
			+ '<input class="btn btn-secondary" type="submit" value="No repeating group" onclick="goToStep4();">',
		primary_key: phpJsonEncode(primaryKey),
	};
}

/** Normalization::getHtmlContentsFor1NFStep4(). */
export function oneNfStep4(columnCheckboxes: string): Record<string, string> {
	return {
		legendText: 'Step 1.4 Remove redundant columns',
		headText: 'Do you have a group of columns which on combining gives an existing column? For example, if you have first_name, last_name and '
			+ 'full_name then combining first_name and last_name gives full_name which is redundant.',
		subText: 'Check the columns which are redundant and click on remove. If no redundant column, click on \'No redundant column\'',
		extra: `${columnCheckboxes}<br><input class="btn btn-secondary" type="submit" id="removeRedundant" value="Remove selected">`
			+ '<input class="btn btn-secondary" type="submit" value="No redundant column" onclick="goToFinish1NF();">',
	};
}

/** Normalization::getHtmlFor2NFstep1(). */
export function twoNfStep1(primaryKey: string[], columns: string[]): Record<string, string> {
	const key = primaryKey.join(', ');
	const selectPkForm = primaryKey.map(name => `<input type="checkbox" name="pd" value="${htmlspecialchars(name)}">${htmlspecialchars(name)}`).join('');
	const result = { legendText: 'Step 2.1 Find partial dependencies', headText: '', subText: '', extra: '', primary_key: key };
	if (primaryKey.length <= 1) {
		result.headText = `${sprintf('No partial dependencies possible as the primary key ( %1$s ) has just one column.', htmlspecialchars(key))}<br>`;
		result.extra = '<h3>Table is already in second normal form.</h3>';
		return result;
	}
	if (primaryKey.length === columns.length) {
		result.headText = `${sprintf('No partial dependencies possible as no non-primary column exists since primary key ( %1$s ) is composed of all the columns in the table.', htmlspecialchars(key))}<br>`;
		result.extra = '<h3>Table is already in second normal form.</h3>';
		return result;
	}
	result.headText = `${sprintf('The primary key ( %1$s ) consists of more than one column so we need to find the partial dependencies.', htmlspecialchars(key))}<br>`
		+ 'Please answer the following question(s) carefully to obtain a correct normalization.'
		+ '<br><a href="#" id="showPossiblePd">+ Show me the possible partial dependencies based on data in the table</a>';
	result.subText = 'For each column below, please select the <b>minimal set</b> of columns among given set whose values combined together are sufficient to determine the value of the column.';
	let count = 0;
	for (const column of columns) {
		if (primaryKey.includes(column)) {
			continue;
		}
		count++;
		result.extra += `<b>${sprintf('\'%1$s\' depends on:', htmlspecialchars(column))}</b><br>`
			+ `<form id="pk_${count}" data-colname="${htmlspecialchars(column)}" class="smallIndent">${selectPkForm}</form><br><br>`;
	}
	return result;
}

/** Normalization::getHtmlForNewTables2NF(). */
export function newTables2NfHtml(partialDependencies: Record<string, string[]>, table: string): string {
	let html = `<p><b>${sprintf('In order to put the original table \'%1$s\' into Second normal form we need to create the following tables:', htmlspecialchars(table))}</b></p>`;
	let tableName = table;
	let index = 1;
	for (const [key, dependents] of Object.entries(partialDependencies)) {
		html += `<p><input type="text" name="${htmlspecialchars(key)}" value="${htmlspecialchars(tableName)}">( <u>${htmlspecialchars(key)}</u>`
			+ `${dependents.length > 0 ? ', ' : ''}${htmlspecialchars(dependents.join(', '))} )`;
		index++;
		tableName = `table${index}`;
	}
	return html;
}

const quoteList = (names: string[], separator: string): string => names.map(name => backquote(name)).join(separator);

// PHP's trim($query, ', ').
const trimCommaSpace = (query: string): string => query.replaceAll(/^[, ]+|[, ]+$/g, '');

/** Normalization::createNewTablesFor2NF()'s statements; empty when only one dependency group exists. */
export function newTables2NfQueries(partialDependencies: Record<string, string[]>, tablesName: Record<string, string>, table: string): string[] {
	const entries = Object.entries(partialDependencies);
	if (entries.length === 1) {
		return [];
	}
	const queries: string[] = [];
	const nonPkColumns: string[] = [];
	let dropColumns = false;
	for (const [key, dependents] of entries) {
		if (tablesName[key] === table) {
			dropColumns = true;
			continue;
		}
		const quotedKey = quoteList(key.split(', '), ', ');
		queries.push(
			`CREATE TABLE ${backquote(tablesName[key])} SELECT DISTINCT ${quotedKey}${dependents.length > 0 ? ', ' : ''}${quoteList(dependents, ',')} FROM ${backquote(table)};`,
			`ALTER TABLE ${backquote(tablesName[key])} ADD PRIMARY KEY(${quotedKey});`,
		);
		nonPkColumns.push(...dependents);
	}
	if (dropColumns) {
		queries.push(`${trimCommaSpace(`ALTER TABLE ${backquote(table)}${nonPkColumns.map(column => ` DROP ${backquote(column)},`).join('')}`)};`);
	} else {
		queries.push(`DROP TABLE ${backquote(table)}`);
	}
	return queries;
}

export interface NewTable3Nf {
	pk: string;
	nonpk: string;
}

/** Normalization::getHtmlForNewTables3NF(); `primaryKeys` holds each table's primary key columns. */
export function newTables3Nf(dependencies: Record<string, string[]>, tables: Record<string, string[]>, primaryKeys: Record<string, string[]>): { html: string; newTables: Record<string, Record<string, NewTable3Nf>>; success: true; } {
	let html = '';
	let index = 1;
	const newTables: Record<string, Record<string, NewTable3Nf>> = {};
	for (const [table, dependsOn] of Object.entries(tables)) {
		if (new Set(dependsOn).size === 1) {
			continue;
		}
		html += `<p><b>${sprintf('In order to put the original table \'%1$s\' into Third normal form we need to create the following tables:', htmlspecialchars(table))}</b></p>`;
		let tableName = table;
		const columnLists: string[][] = [];
		for (const dependOn of dependsOn) {
			const dependents = dependencies[dependOn] ?? [];
			let key = dependOn;
			if (key === table) {
				key = (primaryKeys[table] ?? []).join(', ');
			}
			const columns = [...key.split(', '), ...dependents].toSorted(phpCompareStrings);
			if (columnLists.some(list => list.length === columns.length && list.every((item, position) => item === columns[position]))) {
				continue;
			}
			columnLists.push(columns);
			html += `<p><input type="text" name="${htmlspecialchars(tableName)}" value="${htmlspecialchars(tableName)}">( <u>${htmlspecialchars(key)}</u>`
				+ `${dependents.length > 0 ? ', ' : ''}${htmlspecialchars(dependents.join(', '))} )`;
			newTables[table] ??= {};
			newTables[table][tableName] = { pk: key, nonpk: dependents.join(', ') };
			index++;
			tableName = `table${index}`;
		}
	}
	return { html, newTables, success: true };
}

/** Normalization::createNewTablesFor3NF()'s statements; `columnsOf` lists an original table's columns. */
export function newTables3NfQueries(newTables: Record<string, Record<string, NewTable3Nf>>, columnsOf: (table: string) => string[]): string[] {
	const queries: string[] = [];
	for (const [originalTable, tablesList] of Object.entries(newTables)) {
		let kept: NewTable3Nf | null = null;
		for (const [table, columns] of Object.entries(tablesList)) {
			if (table === originalTable) {
				kept = columns;
				continue;
			}
			const quotedPk = quoteList(columns.pk.split(', '), ', ');
			queries.push(
				`CREATE TABLE ${backquote(table)} SELECT DISTINCT ${quotedPk}, ${quoteList(columns.nonpk.split(', '), ', ')} FROM ${backquote(originalTable)};`,
				`ALTER TABLE ${backquote(table)} ADD PRIMARY KEY(${quotedPk});`,
			);
		}
		if (kept === null) {
			queries.push(`DROP TABLE ${backquote(originalTable)}`);
			continue;
		}
		const present = new Set([...kept.pk.split(', '), ...kept.nonpk.split(', ')]);
		const drops = columnsOf(originalTable).filter(column => !present.has(column)).map(column => ` DROP ${backquote(column)},`)
			.join('');
		queries.push(`${trimCommaSpace(`ALTER TABLE ${backquote(originalTable)}${drops}`)};`);
	}
	return queries;
}

/** Normalization::moveRepeatingGroup()'s two statements. */
export function moveRepeatingGroupQueries(repeatingColumns: string, primaryColumns: string, newTable: string, newColumn: string, table: string): [string, string] {
	const primary = quoteList(primaryColumns.split(','), ',');
	const selects: string[] = [];
	let alter = `ALTER TABLE ${backquote(table)}`;
	for (const column of repeatingColumns.split(', ')) {
		selects.push(` SELECT ${primary},${backquote(column)} as ${backquote(newColumn)} FROM ${backquote(table)}`);
		alter += ` DROP ${backquote(column)},`;
	}
	return [`CREATE TABLE ${backquote(newTable)}${selects.join(' UNION ')}`, alter.replaceAll(/^,+|,+$/g, '')];
}

export interface TableColumns {
	name: string;
	primaryKey: string[];
	columns: string[];
}

/** Normalization::getHtmlFor3NFstep1(). */
export function threeNfStep1(tables: TableColumns[]): Record<string, string> {
	let extra = '';
	let count = 0;
	for (const table of tables) {
		const nonKey = table.columns.filter(column => !table.primaryKey.includes(column));
		if (table.columns.length - table.primaryKey.length <= 1) {
			continue;
		}
		const checkboxes = nonKey.map(column => `<input type="checkbox" name="pd" value="${htmlspecialchars(column)}"><span>${htmlspecialchars(column)}</span>`).join('');
		for (const column of nonKey) {
			count++;
			extra += `<b>${sprintf('\'%1$s\' depends on:', htmlspecialchars(column))}</b><br>`
				+ `<form id="td_${count}" data-colname="${htmlspecialchars(column)}" data-tablename="${htmlspecialchars(table.name)}" class="smallIndent">${checkboxes}</form><br><br>`;
		}
	}
	if (extra === '') {
		return {
			legendText: 'Step 3.1 Find transitive dependencies',
			headText: 'No Transitive dependencies possible as the table doesn\'t have any non primary key columns',
			subText: '',
			extra: '<h3>Table is already in Third normal form!</h3>',
		};
	}
	return {
		legendText: 'Step 3.1 Find transitive dependencies',
		headText: 'Please answer the following question(s) carefully to obtain a correct normalization.',
		subText: 'For each column below, please select the <b>minimal set</b> of columns among given set whose values combined together are sufficient to determine the value of the column.<br>'
			+ 'Note: A column may have no transitive dependency, in that case you don\'t have to select any.',
		extra,
	};
}

/** Normalization::getHtmlForNormalizeTable(). */
export function normalizeTableHtml(action: string, hiddenInputs: string): string {
	return `<form method="post" action="${action}" name="normalize" id="normalizeTable" >${hiddenInputs}<input type="hidden" name="step1" value="1">`
		+ '<fieldset class="pma-fieldset"><legend>Improve table structure (Normalization):</legend><h3>Select up to what step you want to normalize</h3>'
		+ '<div><input type="radio" name="normalizeTo" id="normalizeToRadio1" value="1nf" checked> <label for="normalizeToRadio1">First step of normalization (1NF)</label></div>'
		+ '<div><input type="radio" name="normalizeTo" id="normalizeToRadio2" value="2nf"> <label for="normalizeToRadio2">Second step of normalization (1NF+2NF)</label></div>'
		+ '<div><input type="radio" name="normalizeTo" id="normalizeToRadio3" value="3nf"> <label for="normalizeToRadio3">Third step of normalization (1NF+2NF+3NF)</label></div>'
		+ '</fieldset><fieldset class="pma-fieldset tblFooters"><span class=\'float-start\'>Hint: Please follow the procedure carefully in order to obtain correct normalization</span>'
		+ '<input class="btn btn-primary" type="submit" name="submit_normalize" value="Go"></fieldset></form></div>';
}

/** Normalization::getAllCombinationPartialKeys(): every subset of the backquoted key columns except the full key, starting with ''. */
export function partialKeyCombinations(primaryKey: string[]): string[] {
	const results = [''];
	for (const element of primaryKey) {
		// PHP's foreach walks a copy, so only the combinations from before this element are extended.
		const existing = results.length;
		for (let index = 0; index < existing; index++) {
			results.push(`${element},${results[index]}`.replaceAll(/^,+|,+$/g, ''));
		}
	}
	results.pop();
	return results;
}

/** Normalization::findDistinctValuesCount()'s query over the first 500 rows. */
export function distinctValuesQuery(columns: string[], table: string): string {
	const counts = columns.filter(column => column !== '').map(column => `COUNT(DISTINCT ${column}) as '${column}_cnt'`).join(', ');
	return `SELECT ${counts} FROM (SELECT * FROM ${backquote(table)} LIMIT 500) as dt;`;
}

/** Normalization::checkPartialDependency()'s query. */
export function partialDependencyQuery(partialKey: string, column: string, table: string): string {
	return `SELECT COUNT(DISTINCT ${partialKey},${column}) as pkColCnt FROM (SELECT * FROM ${backquote(table)} LIMIT 500) as dt;`;
}

/** Normalization::checkPartialDependency()'s decision, with PHP's loose comparisons of the counts. */
export function isPartialDependency(pkCount: string | null, columnCount: string | null, pairCount: string | null, totalRows: string | null): boolean {
	const number = (value: string | null): number => Number(value ?? 0);
	if (number(pkCount) !== 0 && number(pkCount) === number(columnCount) && number(columnCount) === number(pairCount)) {
		return true;
	}
	return number(totalRows) !== 0 && number(totalRows) === number(pkCount);
}

/** Normalization::findPartialDependencies()'s HTML for the found determinant => dependents list. */
export function partialDependenciesHtml(dependencies: Map<string, string[]>): string {
	let html = 'This list is based on a subset of the table\'s data and is not necessarily accurate. <div class="dependencies_box">';
	for (const [determinant, dependents] of dependencies) {
		html += '<span class="d-block"><input type="button" class="btn btn-secondary pickPd" value="Pick">'
			+ `<span class="determinants">${htmlspecialchars(determinant.replaceAll('`', ''))}</span> -> `
			+ `<span class="dependents">${htmlspecialchars(dependents.join(', ').replaceAll('`', ''))}</span></span>`;
	}
	if (dependencies.size === 0) {
		html += '<p class="d-block m-1">No partial dependencies found!</p>';
	}
	return `${html}</div>`;
}
