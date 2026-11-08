// Port of PhpMyAdmin\Table for reading table details; the copy, move, rename and ALTER helpers stay with the families that need them.
import { escapeString, getTableIndexesSql } from '../../../lib/pma/dbi-sql.ts';
import { Message } from '../../../lib/pma/message.ts';
import { sprintf } from '../../../lib/pma/sprintf.ts';
import { backquote } from '../../../lib/twig/sanitize.ts';

import type { PmaContext } from './context.ts';
import type { DatabaseInterface, DbiRow, DbiValue } from './dbi.ts';
import type { FieldMetadata } from '../../../lib/pma/field-metadata.ts';

/** Table::PROP_*: the UI preferences kept per table. */
export const PROP_SORTED_COLUMN = 'sorted_col';
export const PROP_COLUMN_ORDER = 'col_order';
export const PROP_COLUMN_VISIB = 'col_visib';

// PHP's empty() for a database or table name.
const isEmptyName = (value: string): boolean => value === '' || value === '0';

// PHP's "$value != null" on a cached string: only null and '' count as missing.
const isPresent = (value: DbiValue | undefined): value is string => value !== undefined && value !== null && value !== '';

export class Table {
	/** Table::get() / DatabaseInterface::getTable(). */
	static get(context: PmaContext, table: string, db: string): Table {
		return new Table(context, table, db);
	}

	/** Table::isValidName(). */
	static isValidName(tableName: string, isBackquoted = false): boolean {
		if (tableName !== tableName.trimEnd() || tableName === '') {
			return false;
		}
		if (!isBackquoted && tableName !== tableName.trim()) {
			return false;
		}
		if (!isBackquoted && /^[\w$]+$/.test(tableName)) {
			return true;
		}
		return isBackquoted;
	}

	private readonly dbi: DatabaseInterface;

	constructor(private readonly context: PmaContext, readonly name: string, readonly dbName: string) {
		this.dbi = context.dbi;
	}

	private viewsQuery(): string {
		return `SELECT TABLE_NAME FROM information_schema.VIEWS WHERE TABLE_SCHEMA = '${escapeString(this.dbName)}' AND TABLE_NAME = '${escapeString(this.name)}'`;
	}

	// The status value, with a missing key (false) as ''; a NULL column stays null upstream but prints as ''.
	private async statusString(info: string): Promise<string> {
		const value = await this.getStatusInfo(info);
		if (value === false || value === null) {
			return '';
		}
		return value;
	}

	private hasCachedRows(): boolean {
		return isPresent(this.dbi.getCachedTableContent(this.dbName, this.name)?.Rows);
	}

	private formatColumns(columns: Iterable<string>, backquoted: boolean, fullName: boolean): string[] {
		const prefix = fullName ? `${this.getFullName(backquoted)}.` : '';
		return [...columns].map(column => prefix + (backquoted ? backquote(column) : column));
	}

	// $_SESSION['tmpval']['table_uiprefs'][server][db][table], read without creating it.
	private storedUiPrefs(): Record<string, unknown> | undefined {
		return this.context.session.data.tmpval?.table_uiprefs?.[this.context.server]?.[this.dbName]?.[this.name];
	}

	private uiPrefs(): Record<string, unknown> {
		const { session, server } = this.context;
		const byServer = session.tmpval.table_uiprefs ?? {};
		session.tmpval.table_uiprefs = byServer;
		byServer[server] ??= {};
		byServer[server][this.dbName] ??= {};
		byServer[server][this.dbName][this.name] ??= {};
		return byServer[server][this.dbName][this.name];
	}

	getName(backquoted = false): string {
		return backquoted ? backquote(this.name) : this.name;
	}

	getDbName(backquoted = false): string {
		return backquoted ? backquote(this.dbName) : this.dbName;
	}

	getFullName(backquoted = false): string {
		return `${this.getDbName(backquoted)}.${this.getName(backquoted)}`;
	}

	/** Table::isEngine(). */
	async isEngine(engine: string | string[]): Promise<boolean> {
		const current = await this.getStorageEngine();
		return (Array.isArray(engine) ? engine : [engine]).includes(current);
	}

	/** Table::isView(): from the cached status when present, else information_schema.VIEWS. */
	async isView(): Promise<boolean> {
		if (isEmptyName(this.dbName) || isEmptyName(this.name)) {
			return false;
		}
		if (this.dbi.getCachedTableContent(this.dbName, this.name) !== undefined || this.context.config.Server.DisableIS) {
			const type = await this.getStatusInfo('TABLE_TYPE');
			return type === 'VIEW' || type === 'SYSTEM VIEW';
		}
		if (this.dbName === 'information_schema') {
			return true;
		}
		const views = await this.dbi.fetchResult(this.viewsQuery());
		return views.length > 0;
	}

	/** Table::isUpdatableView(). */
	async isUpdatableView(): Promise<boolean> {
		if (isEmptyName(this.dbName) || isEmptyName(this.name)) {
			return false;
		}
		const views = await this.dbi.fetchResult(`${this.viewsQuery()} AND IS_UPDATABLE = 'YES'`);
		return views.length > 0;
	}

	/** Table::isMerge(). */
	async isMerge(): Promise<boolean> {
		return this.isEngine(['MERGE', 'MRG_MYISAM']);
	}

	/** Table::getStatusInfo() for one key: '' when the table has no status, false when the key is unknown. */
	async getStatusInfo(info: string, forceRead = false): Promise<DbiValue | false> {
		const row = await this.getStatus(forceRead);
		if (row === null) {
			return '';
		}
		if (!Object.hasOwn(row, info)) {
			return false;
		}
		return row[info];
	}

	/** Table::getStatusInfo(null): the whole SHOW TABLE STATUS-like row, or null without one. */
	async getStatus(forceRead = false): Promise<DbiRow | null> {
		let cached = this.dbi.getCachedTableContent(this.dbName, this.name);
		// A lone ExactRows entry means the details were never loaded.
		if (cached === undefined || forceRead || Object.keys(cached).length === 1) {
			await this.dbi.getTablesFull(this.dbName, this.name);
			cached = this.dbi.getCachedTableContent(this.dbName, this.name);
		}
		return cached ?? null;
	}

	/** Table::getStorageEngine(). */
	async getStorageEngine(): Promise<string> {
		const engine = await this.getStatusInfo('ENGINE');
		if (engine === false) {
			return '';
		}
		return (engine ?? '').toUpperCase();
	}

	/** Table::getComment(). */
	async getComment(): Promise<string> {
		return this.statusString('TABLE_COMMENT');
	}

	/** Table::getCollation(). */
	async getCollation(): Promise<string> {
		return this.statusString('TABLE_COLLATION');
	}

	/** Table::getRowFormat(). */
	async getRowFormat(): Promise<string> {
		return this.statusString('ROW_FORMAT');
	}

	/** Table::getNumRows(): TABLE_ROWS, or 0. */
	async getNumRows(): Promise<number> {
		const rows = await this.getStatusInfo('TABLE_ROWS');
		if (rows === false) {
			const counted = await this.countRecords(true);
			return counted === false ? 0 : counted;
		}
		return Number(rows ?? 0);
	}

	/** Table::getAutoIncrement(). */
	async getAutoIncrement(): Promise<string> {
		const value = await this.getStatusInfo('AUTO_INCREMENT');
		if (value === false || value === null) {
			return '';
		}
		return value;
	}

	/** Table::getCreateOptions(): name => value pairs, with pack_keys always present. */
	async getCreateOptions(): Promise<Record<string, string>> {
		const options = await this.getStatusInfo('CREATE_OPTIONS');
		const result: Record<string, string> = {};
		if (typeof options === 'string' && options !== '' && options !== '0') {
			for (const option of options.split(' ')) {
				const [name, ...value] = option.split('=');
				if (value.length > 0) {
					result[name] = value[0];
				}
			}
		}
		if (result.pack_keys === undefined || result.pack_keys === '') {
			result.pack_keys = 'DEFAULT';
		}
		return result;
	}

	/** Table::checkIfMinRecordsExist(). */
	async checkIfMinRecordsExist(minRecords = 0): Promise<boolean> {
		let columns = await this.getUniqueColumns(true, false);
		if (columns.length === 0) {
			columns = await this.getIndexedColumns(true, false);
		}
		let fields = columns.join(', ');
		if (fields === '') {
			fields = '*';
		}
		const result = await this.dbi.tryQuery(`SELECT ${fields} FROM ${this.getFullName(true)} LIMIT ${minRecords}`);
		return result !== false && result.numRows() >= minRecords;
	}

	/**
	 * Table::countRecords(): the cached or estimated row count when it reaches $cfg['MaxExactCount'], else an exact
	 * COUNT(*); views are only sampled up to MaxExactCountViews and give false when that is 0.
	 */
	async countRecords(forceExact = false): Promise<number | false> {
		const isView = await this.isView();
		const { dbName: db, name: table, dbi } = this;
		const { config } = this.context;
		const exact = dbi.getCachedTableContent(db, table)?.ExactRows;
		if (isPresent(exact)) {
			return Number(exact);
		}
		let rowCount: number | false = false;
		if (!forceExact) {
			if (!this.hasCachedRows() && !isView) {
				await dbi.getTablesFull(db, table);
			}
			if (this.hasCachedRows()) {
				rowCount = Number(dbi.getCachedTableContent(db, table)?.Rows);
			}
		}
		if (rowCount !== false && rowCount >= config.MaxExactCount) {
			return rowCount;
		}
		if (isView) {
			rowCount = false;
			if (config.MaxExactCountViews !== 0) {
				const result = await dbi.tryQuery(`SELECT 1 FROM ${backquote(db)}.${backquote(table)} LIMIT ${config.MaxExactCountViews}`);
				if (result !== false) {
					rowCount = result.numRows();
				}
			}
		} else {
			const value = await dbi.fetchValue(`SELECT COUNT(*) FROM ${backquote(db)}.${backquote(table)}`);
			rowCount = value === false || value === null ? false : Number(value);
		}
		if (rowCount !== false && rowCount !== 0) {
			dbi.cacheTableValue(db, table, 'ExactRows', String(rowCount));
		}
		return rowCount;
	}

	/** Table::getUniqueColumns(): columns that alone make up a unique index. */
	async getUniqueColumns(backquoted = true, fullName = true): Promise<string[]> {
		const sql = getTableIndexesSql(this.dbName, this.name, 'Non_unique = 0');
		const uniques = await this.dbi.fetchResult(sql, ['Key_name', null], 'Column_name') as Map<string, DbiValue[]>;
		const result: string[] = [];
		for (const columns of uniques.values()) {
			if (columns.length > 1) {
				continue;
			}
			const [column] = this.formatColumns([columns[0] ?? ''], backquoted, fullName);
			// A column may have both a primary and a unique index.
			if (!result.includes(column)) {
				result.push(column);
			}
		}
		return result;
	}

	/** Table::getIndexedColumns(). */
	async getIndexedColumns(backquoted = true, fullName = true): Promise<string[]> {
		const indexed = await this.dbi.fetchResult<string>(getTableIndexesSql(this.dbName, this.name, ''), 'Column_name', 'Column_name');
		return this.formatColumns(indexed.keys(), backquoted, fullName);
	}

	/** Table::getColumns(). */
	async getColumns(backquoted = true, fullName = true): Promise<string[]> {
		const columns = await this.dbi.fetchResult<string>(`SHOW COLUMNS FROM ${this.getFullName(true)}`, 'Field', 'Field');
		return this.formatColumns(columns.keys(), backquoted, fullName);
	}

	/** Table::getColumnsMeta(): field metadata of a one-row SELECT. */
	async getColumnsMeta(): Promise<FieldMetadata[]> {
		const result = await this.dbi.tryQuery(`SELECT * FROM ${backquote(this.dbName)}.${backquote(this.name)} LIMIT 1`);
		return result === false ? [] : result.getFieldsMeta();
	}

	/** Table::getNonGeneratedColumns(). */
	async getNonGeneratedColumns(backquoted = true): Promise<string[]> {
		const rows = await this.dbi.fetchResult(`SHOW COLUMNS FROM ${this.getFullName(true)}`);
		const result: string[] = [];
		for (const row of rows) {
			const extra = row.Extra ?? '';
			if ((extra.includes('GENERATED') || extra.includes('VIRTUAL')) && !extra.includes('DEFAULT_GENERATED')) {
				continue;
			}
			const field = row.Field ?? '';
			result.push(backquoted ? backquote(field) : field);
		}
		return result;
	}

	/** Table::showCreate(). */
	async showCreate(): Promise<string> {
		const value = await this.dbi.fetchValue(`SHOW CREATE TABLE ${backquote(this.dbName)}.${backquote(this.name)}`, 1);
		return value === false || value === null ? '' : value;
	}

	/** Table::getRealRowCountTable(). */
	async getRealRowCountTable(): Promise<number | null> {
		const row = await this.dbi.fetchSingleRow(`SELECT COUNT(*) AS ${backquote('row_count')} FROM ${backquote(this.dbName)}.${backquote(this.name)}`) as DbiRow | null;
		return row === null ? null : Number(row.row_count);
	}

	/** Table::getUiProp(): a remembered sort, column order or visibility that still fits the table, else false. */
	async getUiProp(property: string): Promise<unknown> {
		const prefs = this.storedUiPrefs() ?? {};
		if (property === PROP_SORTED_COLUMN) {
			if (prefs[property] === undefined) {
				return false;
			}
			if (this.context.request.post.discard_remembered_sort === undefined) {
				const column = String(prefs[property]).split(' ', 1)[0].replaceAll('`', '');
				for (const available of await this.getColumns(false)) {
					if (available.endsWith(column)) {
						return prefs[property];
					}
				}
			}
			// The column no longer exists.
			this.removeUiProp(property);
			return false;
		}
		if (property === PROP_COLUMN_ORDER || property === PROP_COLUMN_VISIB) {
			if (await this.isView() || prefs[property] === undefined) {
				return false;
			}
			// Upstream compares Create_time with the stored CREATE_TIME; both keys hold the same value.
			if (await this.getStatusInfo('Create_time') === prefs.CREATE_TIME) {
				// array_map('intval', ...) on stored column numbers.
				return (prefs[property] as unknown[]).map(value => Math.trunc(Number(value)) || 0);
			}
			// The table changed since the order was saved.
			this.removeUiProp(property);
			return false;
		}
		return prefs[property] ?? false;
	}

	/** Table::setUiProp(); without pmadb the value only lives in the session. */
	async setUiProp(property: string, value: unknown, tableCreateTime: string | null = null): Promise<true | Message> {
		if (!await this.isView() && (property === PROP_COLUMN_ORDER || property === PROP_COLUMN_VISIB)) {
			const createTime = await this.getStatusInfo('CREATE_TIME');
			if (tableCreateTime === null || tableCreateTime !== createTime) {
				return Message.error(sprintf('Cannot save UI property "%s". The changes made will not be persistent after you refresh this page. Please check if the table structure has been changed.', property));
			}
			this.uiPrefs().CREATE_TIME = createTime;
		}
		this.uiPrefs()[property] = value;
		return true;
	}

	/** Table::removeUiProp(). */
	removeUiProp(property: string): void {
		const prefs = this.storedUiPrefs();
		if (prefs !== undefined) {
			delete prefs[property];
		}
	}
}
