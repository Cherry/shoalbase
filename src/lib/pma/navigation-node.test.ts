import { describe, expect, it } from 'vitest';

import { createConfig } from './config.ts';
import {
	CONTAINER,
	NavNode,
	base64Decode,
	base64Encode,
	byteLength,
	columnDisplayName,
	createNodeFactory,
	getTitleForTarget,
	getUrlForOption,
	looseEquals,
	mbStrlen,
	mbStrpos,
	mbSubstr,
	parsePath,
} from './navigation-node.ts';

const config = createConfig({ host: 'db' });
const factory = createNodeFactory(config, false);
const childAt = (node: NavNode, index: number): NavNode => node.children.at(index) as NavNode;

/** root > customer_db > Tables > players, as buildPath() creates it. */
function tableBranch() {
	const root = factory.create('NodeDatabaseContainer', 'root');
	const db = factory.create('NodeDatabase', 'customer_db');
	root.addChild(db);
	const tables = factory.create('NodeTableContainer', '');
	db.addChild(tables);
	const table = factory.create('NodeTable', 'players');
	tables.addChild(table);
	return { root, db, tables, table };
}

describe('PHP string helpers', () => {
	it('compares numeric strings as numbers, like PHP 8 ==', () => {
		expect(looseEquals('1', '01')).toBe(true);
		expect(looseEquals('1e1', '10')).toBe(true);
		expect(looseEquals('abc', 'ABC')).toBe(false);
		expect(looseEquals('1a', '1')).toBe(false);
	});

	it('counts code points like mb_* functions, and bytes like strlen()', () => {
		expect(mbStrlen('a😀b')).toBe(3);
		expect(mbSubstr('a😀b_c', 0, 3)).toBe('a😀b');
		expect(mbSubstr('a😀b_c', 4)).toBe('c');
		expect(mbStrpos('a😀b_c', '_')).toBe(3);
		expect(mbStrpos('abc', '_')).toBe(false);
		expect(byteLength('é_')).toBe(3);
	});

	it('base64-encodes UTF-8 bytes like base64_encode()', () => {
		expect(base64Encode('é_ü')).toBe('w6lfw7w=');
		expect(base64Encode('root')).toBe('cm9vdA==');
	});

	it('decodes leniently like base64_decode(), skipping junk and missing padding', () => {
		expect(base64Decode('cm9v!dA')).toBe('root');
		expect(base64Decode('w6lfw7w=')).toBe('é_ü');
		// Values from PHP 8.3: padding inside the string is skipped and a lone trailing character is dropped.
		expect(base64Decode('cm9vdA==Z')).toBe('root\u{6}');
		expect(base64Decode('Y3V=zdA')).toBe('cust');
		expect(base64Decode('cm9vd')).toBe('roo');
	});

	it('splits a navigation path into its decoded parts', () => {
		expect(parsePath('cm9vdA==.Y3VzdG9tZXJfZGI=.dGFibGVz')).toEqual(['root', 'customer_db', 'tables']);
	});
});

describe('option helpers', () => {
	it('maps tab names and legacy script names to routes', () => {
		expect(getUrlForOption('structure', 'database')).toBe('/database/structure');
		expect(getUrlForOption('db_operations.php', 'database')).toBe('/database/operations');
		expect(getUrlForOption('browse', 'table')).toBe('/sql');
		expect(getUrlForOption('insert', 'table')).toBe('/table/change');
		expect(getUrlForOption('', 'table')).toBe('/');
	});

	it('gives an empty title for unknown targets', () => {
		expect(getTitleForTarget('browse')).toBe('Browse');
		expect(getTitleForTarget('nope')).toBe('');
	});
});

describe('NavNode', () => {
	it('keeps the default empty name when created without one', () => {
		const node = new NavNode('Node', '');
		expect(node.name).toBe('');
		expect(node.realName).toBe('');
	});

	it('finds children by name skipping "New" items, or by real name', () => {
		const { tables, table } = tableBranch();
		expect(tables.getChild('New')).toBeNull();
		expect(tables.getChild('New', true)?.isNew).toBe(true);
		expect(tables.getChild('players')).toBe(table);
		expect(tables.getChild('nope', true)).toBeNull();
	});

	it('removes the first child whose name is loosely equal', () => {
		const parent = new NavNode('Node', 'p', CONTAINER);
		parent.addChild(new NavNode('NodeTable', '01'));
		parent.addChild(new NavNode('NodeTable', '1'));
		parent.removeChildByName('1');
		expect(parent.children.map(child => child.name)).toEqual(['1']);
		parent.removeChildByName('missing');
		expect(parent.children).toHaveLength(1);
	});

	it('lists ancestors with or without containers and groups', () => {
		const { root, db, tables, table } = tableBranch();
		const group = new NavNode('Node', 'grp', CONTAINER, true);
		tables.addChild(group);
		const grouped = new NavNode('NodeTable', 'x');
		group.addChild(grouped);
		expect(grouped.parents()).toEqual([db]);
		expect(grouped.parents(true, true)).toEqual([grouped, tables, db, root]);
		expect(grouped.parents(false, true, true)).toEqual([group, tables, db, root]);
		expect(tables.parents(true)).toEqual([db]);
		expect(table.realParent()).toBe(db);
		expect(root.realParent()).toBe(false);
	});

	it('treats containers holding only empty containers as childless', () => {
		const parent = new NavNode('Node', 'p', CONTAINER);
		expect(parent.hasChildren()).toBe(false);
		parent.addChild(new NavNode('Node', 'empty', CONTAINER));
		expect(parent.hasChildren()).toBe(true);
		expect(parent.hasChildren(false)).toBe(false);
	});

	it('only counts siblings that are objects or non-empty containers, except deep in a table', () => {
		const { root, db, tables, table } = tableBranch();
		expect(db.hasSiblings()).toBe(false);
		root.addChild(factory.create('NodeDatabase', 'other'));
		expect(db.hasSiblings()).toBe(true);
		expect(tables.hasSiblings()).toBe(false);
		db.addChild(factory.create('NodeViewContainer', ''));
		expect(tables.hasSiblings()).toBe(true);
		const columns = factory.create('NodeColumnContainer', '');
		table.addChild(columns);
		expect(columns.hasSiblings()).toBe(true);
	});

	it('builds the actual and virtual paths the client posts back', () => {
		const { tables, table } = tableBranch();
		const group = new NavNode('Node', 'pl', CONTAINER, true);
		tables.addChild(group);
		const grouped = factory.create('NodeTable', 'ayers');
		grouped.realName = 'players';
		group.addChild(grouped);
		expect(table.getPaths()).toEqual({
			aPath: 'cm9vdA==.Y3VzdG9tZXJfZGI=.dGFibGVz.cGxheWVycw==',
			aPath_clean: ['root', 'customer_db', 'tables', 'players'],
			vPath: 'cm9vdA==.Y3VzdG9tZXJfZGI=.VGFibGVz.cGxheWVycw==',
			vPath_clean: ['root', 'customer_db', 'Tables', 'players'],
		});
		expect(grouped.getPaths().aPath_clean).toEqual(['root', 'customer_db', 'tables', 'players']);
		expect(grouped.getPaths().vPath_clean).toEqual(['root', 'customer_db', 'Tables', 'pl', 'ayers']);
	});
});

describe('columnDisplayName', () => {
	it('lists the non-empty attributes and shortens long defaults', () => {
		expect(columnDisplayName({ name: 'id', key: 'PRI', type: 'int', default: null, nullable: '' })).toBe('id (PRI, int)');
		expect(columnDisplayName({ name: 'label', key: '', type: 'varchar', default: 'longdefault', nullable: 'nullable' })).toBe('label (varchar, longde..., nullable)');
		expect(columnDisplayName({ name: 'n', key: '', type: 'int', default: 'abcdef', nullable: '' })).toBe('n (int, abcdef)');
	});

	it('skips "0" like empty() and keeps the stray bracket when nothing is shown', () => {
		expect(columnDisplayName({ name: 'flag', key: '', type: 'tinyint', default: '0', nullable: '' })).toBe('flag (tinyint)');
		expect(columnDisplayName({ name: 'x', key: '', type: '', default: null, nullable: '' })).toBe('x)');
	});
});

describe('createNodeFactory', () => {
	it('links databases to the default database tab and operations', () => {
		const node = factory.create('NodeDatabase', 'shop');
		expect(node.links).toEqual({
			text: { route: '/database/structure', params: { db: null } },
			icon: { route: '/database/operations', params: { db: null } },
			title: 'Structure',
		});
		expect(node.urlParamName).toBe('db');
		expect(node.classes).toBe('database');
	});

	it('follows the table tab settings for icons, links and title', () => {
		const table = factory.create('NodeTable', 't');
		expect(table.icon).toEqual({ image: 'b_props', title: 'Structure' });
		expect(table.secondIcon).toBeNull();
		expect(table.links.text).toEqual({ route: '/sql', params: { pos: 0, db: null, table: null } });
		expect(table.links.second_icon?.route).toBe('/');
		expect(table.links.title).toBe('Browse');

		const custom = createNodeFactory({ ...config, NavigationTreeDefaultTabTable: 'search', NavigationTreeDefaultTabTable2: 'insert', DefaultTabTable: 'sql' }, false).create('NodeTable', 't');
		expect(custom.icon).toEqual({ image: 'b_search', title: 'Search' });
		expect(custom.secondIcon).toEqual({ image: 'b_insrow', title: 'Insert' });
		expect(custom.links.text.route).toBe('/table/sql');
		expect(custom.title).toBe('SQL');

		const browse = createNodeFactory({ ...config, NavigationTreeDefaultTabTable: 'browse', NavigationTreeDefaultTabTable2: 'sql' }, false).create('NodeTable', 't');
		expect(browse.icon.image).toBe('b_browse');
		expect(browse.secondIcon?.image).toBe('b_sql');

		const unknown = createNodeFactory({ ...config, NavigationTreeDefaultTabTable: 'nope', DefaultTabTable: 'nope' }, false).create('NodeTable', 't');
		expect(unknown.icon).toEqual({ image: '', title: '' });
		expect(unknown.title).toBe('');
	});

	it('gives routines, events, views, indexes and triggers their links', () => {
		expect(factory.create('NodeFunction', 'f').links.icon.params).toEqual({ item_type: 'FUNCTION', execute_dialog: 1, db: null, item_name: null });
		expect(factory.create('NodeProcedure', 'p').classes).toBe('procedure');
		expect(factory.create('NodeEvent', 'e').links.icon.params).toEqual({ export_item: 1, db: null, item_name: null });
		expect(factory.create('NodeView', 'v').links.text.route).toBe('/sql');
		expect(factory.create('NodeIndex', 'PRIMARY').urlParamName).toBe('index');
		expect(factory.create('NodeTrigger', 'tr').icon).toEqual({ image: 'b_triggers', title: 'Trigger' });
	});

	it('gives each container its real name and a "New" item', () => {
		const expected: [Parameters<typeof factory.create>[0], string, string][] = [
			['NodeTableContainer', 'tables', 'new_table italics'],
			['NodeViewContainer', 'views', 'new_view italics'],
			['NodeFunctionContainer', 'functions', 'new_function italics'],
			['NodeProcedureContainer', 'procedures', 'new_procedure italics'],
			['NodeEventContainer', 'events', 'new_event italics'],
			['NodeColumnContainer', 'columns', 'new_column italics'],
			['NodeIndexContainer', 'indexes', 'new_index italics'],
			['NodeTriggerContainer', 'triggers', 'new_trigger italics'],
		];
		for (const [kind, realName, classes] of expected) {
			const container = factory.create(kind, '');
			expect(container.type).toBe(CONTAINER);
			expect(container.realName).toBe(realName);
			expect(container.children).toHaveLength(1);
			expect(childAt(container, 0)).toMatchObject({ name: 'New', title: 'New', isNew: true, classes });
		}
	});

	it('groups database children by the table separator only when grouping is on', () => {
		expect(factory.create('NodeTableContainer', '')).toMatchObject({ separator: '__', separatorDepth: 1 });
		expect(factory.create('NodeColumnContainer', '')).toMatchObject({ separator: '', separatorDepth: 1 });
		const ungrouped = createNodeFactory({ ...config, NavigationTreeEnableGrouping: false }, false);
		expect(ungrouped.create('NodeViewContainer', '')).toMatchObject({ separator: '', separatorDepth: 1 });
	});

	it('offers "New" databases only to accounts that may create them', () => {
		expect(factory.create('NodeDatabaseContainer', 'root').children).toHaveLength(0);
		const creator = createNodeFactory(config, true).create('NodeDatabaseContainer', 'root');
		expect(childAt(creator, 0)).toMatchObject({ classes: 'new_database italics', links: { text: { route: '/server/databases', params: {} } } });
		expect(createNodeFactory({ ...config, ShowCreateDb: false }, true).create('NodeDatabaseContainer', 'root').children).toHaveLength(0);
	});

	it('builds column nodes with key icons and a display name', () => {
		const primary = factory.column({ name: 'id', key: 'PRI', type: 'int', default: null, nullable: '' });
		expect(primary).toMatchObject({ name: 'id', displayName: 'id (PRI, int)', icon: { image: 'b_primary', title: 'Column' }, urlParamName: 'field' });
		expect(primary.links.title).toBe('Structure');
		expect(factory.column({ name: 'u', key: 'UNI', type: 'int', default: null, nullable: '' }).icon.image).toBe('bd_primary');
		expect(factory.column({ name: 'n', key: '', type: 'int', default: null, nullable: '' }).icon.image).toBe('pause');
	});

	it('creates plain nodes for classes without their own constructor', () => {
		const group = factory.create('Node', 'grp', CONTAINER, true);
		expect(group).toMatchObject({ kind: 'Node', name: 'grp', type: CONTAINER, isGroup: true });
	});
});
