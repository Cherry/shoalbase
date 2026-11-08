import { describe, expect, it } from 'vitest';

import { createConfig } from './config.ts';
import { CONTAINER, NavNode, createNodeFactory } from './navigation-node.ts';
import {
	cssClasses,
	expandIcon,
	findTreeMatch,
	groupNode,
	groupTree,
	nodeTemplateVars,
	nodeView,
	paginationParams,
	setVisibility,
	siblingClasses,
	sortNode,
	sortedChildren,
} from './navigation-tree.ts';

const config = createConfig({ host: 'db' });
const factory = createNodeFactory(config, false);
const childAt = (node: NavNode, index: number): NavNode => node.children.at(index) as NavNode;
const treeConfig = { NavigationTreeEnableExpansion: true, NaturalOrder: true, ShowDatabasesNavigationAsTree: true };

/** The root as NavigationTree::__construct() prepares it, holding the given databases. */
function databaseRoot(names: string[]): NavNode {
	const root = factory.create('NodeDatabaseContainer', 'root');
	root.separator = '_';
	root.separatorDepth = 10000;
	for (const name of names) {
		root.addChild(factory.create('NodeDatabase', name));
	}
	return root;
}

function tablesOf(names: string[]) {
	const root = databaseRoot(['customer_db']);
	const db = childAt(root, 0);
	const tables = factory.create('NodeTableContainer', '');
	db.addChild(tables);
	for (const name of names) {
		tables.addChild(factory.create('NodeTable', name));
	}
	return { root, db, tables };
}

const names = (node: NavNode): string[] => node.children.map(child => child.name);

describe('sortNode', () => {
	it('puts "New" items first and sorts the rest naturally or by strcasecmp', () => {
		const { tables } = tablesOf(['t10', 'T9', 'a']);
		expect(names({ children: sortedChildren(treeConfig, tables) } as NavNode)).toEqual(['New', 'a', 'T9', 't10']);
		const plain = { ...treeConfig, NaturalOrder: false };
		expect(names({ children: sortedChildren(plain, tables) } as NavNode)).toEqual(['New', 'a', 't10', 'T9']);
		const [newItem, t10] = tables.children;
		expect(sortNode(treeConfig, t10, newItem)).toBe(1);
		expect(sortNode(treeConfig, newItem, t10)).toBe(-1);
	});
});

describe('groupNode', () => {
	it('groups tables sharing a "__" prefix one level deep, linking the group to a filtered list', () => {
		const { tables } = tablesOf(['nav__a', 'nav__b', 'nav__c__d', 'players', 'zz_one']);
		groupTree(treeConfig, factory, tables);
		expect(names(tables)).toEqual(['New', 'players', 'zz_one', 'nav']);
		const group = childAt(tables, 3);
		expect(group).toMatchObject({ isGroup: true, type: CONTAINER, classes: 'navGroup', separatorDepth: 0, icon: { image: 'b_group', title: 'Groups' } });
		expect(group.links.text).toEqual({ route: '/database/structure', params: { tbl_type: 'table', db: null, tbl_group: 'nav' } });
		expect(names(group)).toEqual(['a', 'b', 'c__d']);
		expect(group.children.map(child => child.realName)).toEqual(['nav__a', 'nav__b', 'nav__c__d']);
		expect(childAt(group, 0).kind).toBe('NodeTable');
	});

	it('nests database groups and lets a group absorb a prefix all its items share', () => {
		const root = databaseRoot(['a_b_c', 'a_b_d', 'x', 'y']);
		groupTree(treeConfig, factory, root);
		expect(names(root)).toEqual(['x', 'y', 'a_b']);
		const group = childAt(root, 2);
		expect(group.realName).toBe('a_b');
		expect(names(group)).toEqual(['c', 'd']);
		expect(childAt(group, 0).realName).toBe('a_b_c');
	});

	it('does not group when one group would hold every item but one (rfe #1634)', () => {
		const root = databaseRoot(['a_b', 'a_c', 'x']);
		groupNode(treeConfig, factory, root);
		expect(names(root)).toEqual(['a_b', 'a_c', 'x']);
	});

	it('counts a database named like the prefix into the group (bug #4375)', () => {
		const root = databaseRoot(['a', 'a_b']);
		groupNode(treeConfig, factory, root);
		expect(names(root)).toEqual(['a']);
		const group = childAt(root, 0);
		expect(names(group)).toEqual(['', 'b']);
		expect(group.children.map(child => child.realName)).toEqual(['a', 'a_b']);
	});

	it('keeps children of grouped items', () => {
		const root = databaseRoot(['customer_db', 'other', 'shop_live', 'shop_test']);
		const live = childAt(root, 2);
		const views = factory.create('NodeViewContainer', '');
		live.addChild(views);
		groupNode(treeConfig, factory, root);
		const group = root.children.find(child => child.isGroup) as NavNode;
		expect(childAt(group, 0).children).toEqual([views]);
		expect(views.parent).toBe(childAt(group, 0));
		expect(group.links.text.route).toBe('');
	});

	it('leaves objects, unseparated containers and disabled expansion alone', () => {
		const table = factory.create('NodeTable', 'a__b');
		groupNode(treeConfig, factory, table);
		const columns = factory.create('NodeColumnContainer', '');
		columns.addChild(factory.create('NodeColumn', 'a__b'));
		columns.addChild(factory.create('NodeColumn', 'a__c'));
		groupNode(treeConfig, factory, columns);
		expect(names(columns)).toEqual(['New', 'a__b', 'a__c']);
		const root = databaseRoot(['a_b', 'a_c', 'b_a', 'b_b']);
		groupNode({ ...treeConfig, NavigationTreeEnableExpansion: false }, factory, root);
		expect(root.children).toHaveLength(4);
		root.separatorDepth = 0;
		groupNode(treeConfig, factory, root);
		expect(root.children).toHaveLength(4);
	});

	it('skips containers among the candidates', () => {
		const root = databaseRoot(['a_b', 'a_c', 'q', 'z']);
		root.addChild(new NavNode('Node', 'a_d', CONTAINER));
		groupNode(treeConfig, factory, root);
		expect(names(root)).toEqual(['q', 'z', 'a_d', 'a']);

		const onlyContainers = databaseRoot(['q', 'z', 'w']);
		onlyContainers.addChild(new NavNode('Node', 'a_x', CONTAINER));
		onlyContainers.addChild(new NavNode('Node', 'a_y', CONTAINER));
		groupNode(treeConfig, factory, onlyContainers);
		expect(names(onlyContainers)).toEqual(['q', 'z', 'w', 'a_x', 'a_y']);
	});
});

describe('setVisibility and findTreeMatch', () => {
	it('marks each existing step of an expanded path visible, skipping missing ones', () => {
		const { root, db, tables } = tablesOf(['players']);
		setVisibility(root, [['root', 'customer_db', 'missing', 'Tables', 'players']]);
		expect(db.visible).toBe(true);
		expect(tables.visible).toBe(true);
		expect(childAt(tables, 1).visible).toBe(true);
	});

	it('matches when an expanded path starts with the node path, comparing loosely', () => {
		expect(findTreeMatch([['root', 'db', 'Tables']], ['root', 'db'])).toBe(true);
		expect(findTreeMatch([['root', '01']], ['root', '1'])).toBe(true);
		expect(findTreeMatch([['root']], ['root', 'db'])).toBe(false);
		expect(findTreeMatch([], ['root'])).toBe(false);
	});
});

describe('node helpers', () => {
	it('reports the page position of second and third level lists', () => {
		const { db, tables } = tablesOf(['players']);
		const table = childAt(tables, 1);
		table.pos2 = 50;
		const columns = factory.create('NodeColumnContainer', '');
		table.addChild(columns);
		columns.pos3 = 25;
		expect(paginationParams(db)).toEqual({});
		expect(paginationParams(table)).toEqual({ position: 'pos2_nav', data_name: 'tables', data_value: '50' });
		expect(paginationParams(columns)).toEqual({ position: 'pos3_nav', data_name: 'columns', data_value: '25' });
	});

	it('builds expander classes and icons, opening matched branches', () => {
		const group = new NavNode('Node', 'g', CONTAINER, true);
		expect(cssClasses(treeConfig, group, false)).toBe('expander loaded container');
		expect(cssClasses(treeConfig, new NavNode('NodeTable', 't'), false)).toBe('expander');
		expect(cssClasses({ ...treeConfig, NavigationTreeEnableExpansion: false }, group, true)).toBe('');
		const table = new NavNode('NodeTable', 't');
		expect(expandIcon(treeConfig, table, false)).toBe('<img src="themes/dot.gif" title="Expand/Collapse" alt="Expand/Collapse" class="icon ic_b_plus">');
		expect(table.visible).toBe(false);
		expect(expandIcon(treeConfig, table, true)).toBe('<img src="themes/dot.gif" title="" alt="" class="icon ic_b_minus">');
		expect(table.visible).toBe(true);
		expect(expandIcon({ ...treeConfig, NavigationTreeEnableExpansion: false }, table, true)).toBe('');
	});

	it('gives the first and last siblings their classes', () => {
		expect(siblingClasses(1, true)).toEqual(['first']);
		expect(siblingClasses(3, false)).toEqual(['', '', 'last']);
		expect(siblingClasses(3, true)).toEqual(['first', '', 'last']);
	});

	it('exposes the node properties node.twig reads', () => {
		const column = factory.column({ name: 'id', key: 'PRI', type: 'int', default: null, nullable: '' });
		expect(nodeView(column)).toEqual({ isGroup: false, icon: { image: 'b_primary', title: 'Column' }, name: 'id', displayName: 'id (PRI, int)', realName: 'id', classes: '' });
	});
});

describe('nodeTemplateVars', () => {
	const options = { config: treeConfig, vPaths: [['root', 'customer_db', 'Tables', 'players']], pos: 0, isAjax: true };

	it('fills a table link from its ancestors and opens an expanded branch', () => {
		const { tables } = tablesOf(['players']);
		const table = childAt(tables, 1);
		const vars = nodeTemplateVars(options, table, 'last');
		expect(vars).toMatchObject({
			show_node: true,
			has_siblings: true,
			li_classes: 'last nav_node_table',
			node_is_group: true,
			link_classes: 'expander loaded',
			has_second_icon: false,
			pagination_params: { position: 'pos2_nav', data_name: 'tables', data_value: '0' },
			paths: { a_path: 'cm9vdA==.Y3VzdG9tZXJfZGI=.dGFibGVz.cGxheWVycw==', v_path: 'cm9vdA==.Y3VzdG9tZXJfZGI=.VGFibGVz.cGxheWVycw==', pos: 0 },
			wrap: true,
		});
		expect(vars?.node_icon).toContain('ic_b_minus');
		expect(vars?.icon_links).toEqual([{ route: '/table/structure', params: { db: 'customer_db', table: 'players' }, is_ajax: false, image: 'b_props', title: 'Structure' }]);
		expect(vars?.text_link).toEqual({ route: '/sql', params: { pos: 0, db: 'customer_db', table: 'players' }, is_ajax: false, title: 'Browse' });
	});

	it('hides a lone tables container but keeps its children visible', () => {
		const { tables } = tablesOf(['players']);
		const vars = nodeTemplateVars(options, tables, '');
		expect(vars).toMatchObject({ show_node: false, wrap: false, has_siblings: false, li_classes: '' });
		expect(tables.visible).toBe(true);
	});

	it('drops empty containers from full pages only', () => {
		const { db } = tablesOf([]);
		const views = factory.create('NodeViewContainer', '');
		views.children = [];
		db.addChild(views);
		childAt(db, 0).addChild(factory.create('NodeTable', 't'));
		expect(nodeTemplateVars({ ...options, isAjax: false }, views, '')).toBeNull();
		expect(nodeTemplateVars(options, views, '')).toMatchObject({ show_node: true, node_is_group: true, link_classes: 'expander container' });
	});

	it('uses AJAX links inside routine, event, trigger and index lists, and for new views', () => {
		const { tables } = tablesOf(['players']);
		const table = childAt(tables, 1);
		const indexes = factory.create('NodeIndexContainer', '');
		table.addChild(indexes);
		const index = factory.create('NodeIndex', 'PRIMARY');
		indexes.addChild(index);
		const vars = nodeTemplateVars(options, index, '');
		expect(vars?.node_is_group).toBe(false);
		expect(vars?.text_link).toMatchObject({ is_ajax: true, params: { db: 'customer_db', table: 'players', index: 'PRIMARY' } });

		const views = factory.create('NodeViewContainer', '');
		tables.parent?.addChild(views);
		expect(nodeTemplateVars(options, childAt(views, 0), 'new_view italics')?.icon_links[0].is_ajax).toBe(true);
	});

	it('lets an item named like a list expand inside a list only when it has children', () => {
		const { tables } = tablesOf(['players']);
		const indexes = factory.create('NodeIndexContainer', '');
		childAt(tables, 1).addChild(indexes);
		const odd = factory.create('NodeIndex', 'columns');
		indexes.addChild(odd);
		expect(nodeTemplateVars(options, odd, '')?.node_is_group).toBe(false);
		odd.addChild(factory.create('NodeIndex', 'x'));
		expect(nodeTemplateVars(options, odd, '')?.node_is_group).toBe(true);
	});

	it('skips links for groups and adds the second table icon when configured', () => {
		const { tables } = tablesOf(['a']);
		const group = new NavNode('Node', 'grp', CONTAINER, true);
		tables.addChild(group);
		const second = createNodeFactory({ ...config, NavigationTreeDefaultTabTable2: 'sql' }, false).create('NodeTable', 'grp__x');
		group.addChild(second);
		expect(nodeTemplateVars(options, group, '')).toMatchObject({ icon_links: [], text_link: {}, link_classes: 'expander loaded container' });
		const vars = nodeTemplateVars(options, second, '');
		expect(vars?.has_second_icon).toBe(true);
		expect(vars?.icon_links[1]).toEqual({ route: '/table/sql', params: { db: 'customer_db', table: 'grp__x' }, is_ajax: false, image: 'b_sql', title: 'SQL' });
	});

	it('leaves top-level icons out of the legacy database selector', () => {
		const root = databaseRoot(['a', 'b']);
		const vars = nodeTemplateVars({ ...options, config: { ...treeConfig, ShowDatabasesNavigationAsTree: false } }, childAt(root, 0), 'first');
		expect(vars).toMatchObject({ node_is_group: true, node_icon: '', link_classes: 'expander' });
	});

	it('falls back to the node title, then an empty one, for the text link', () => {
		const { tables } = tablesOf([]);
		const newTable = childAt(tables, 0);
		expect(nodeTemplateVars(options, newTable, '')?.text_link).toMatchObject({ title: 'New' });
		newTable.title = null;
		expect(nodeTemplateVars(options, newTable, '')?.text_link).toMatchObject({ title: '' });
	});
});
