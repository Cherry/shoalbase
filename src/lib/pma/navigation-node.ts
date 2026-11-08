// Port of PhpMyAdmin\Navigation\Nodes\* and NodeFactory: the building blocks of the navigation tree.
import { isNumericString } from './php-compare.ts';

import type { PmaConfig } from './config.ts';

export const CONTAINER = 0;
export const OBJECT = 1;
export type NodeType = typeof CONTAINER | typeof OBJECT;

/** The upstream class each node was created from; grouping recreates nodes by class. */
export type NodeKind =
	| 'Node'
	| 'NodeDatabase'
	| 'NodeTable'
	| 'NodeView'
	| 'NodeFunction'
	| 'NodeProcedure'
	| 'NodeEvent'
	| 'NodeColumn'
	| 'NodeIndex'
	| 'NodeTrigger'
	| 'NodeDatabaseContainer'
	| 'NodeTableContainer'
	| 'NodeViewContainer'
	| 'NodeFunctionContainer'
	| 'NodeProcedureContainer'
	| 'NodeEventContainer'
	| 'NodeColumnContainer'
	| 'NodeIndexContainer'
	| 'NodeTriggerContainer';

export interface NodeIcon {
	image: string;
	title: string;
}

export interface NodeLink {
	route: string;
	params: Record<string, unknown>;
}

export interface NodeLinks {
	text: NodeLink;
	icon: NodeLink;
	second_icon?: NodeLink;
	title?: string;
}

export interface NodePaths {
	aPath: string;
	aPath_clean: string[];
	vPath: string;
	vPath_clean: string[];
}

/** A row of the column query in NodeTable::getData(), in its column order. */
export type ColumnItem = Record<string, string | null> & { name: string; };

/** The $cfg keys node constructors read. */
export type NodeConfig = Pick<PmaConfig, 'DefaultTabDatabase' | 'DefaultTabTable' | 'NavigationTreeDefaultTabTable' | 'NavigationTreeDefaultTabTable2' | 'NavigationTreeEnableGrouping' | 'NavigationTreeTableSeparator' | 'NavigationTreeTableLevel' | 'ShowCreateDb' | 'NavigationTreeEnableExpansion'>;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** PHP's == between two strings: numeric strings compare as numbers. */
export function looseEquals(left: string, right: string): boolean {
	if (isNumericString(left) && isNumericString(right)) {
		return Number(left) === Number(right);
	}
	return left === right;
}

/** mb_strlen(). */
export function mbStrlen(value: string): number {
	return [...value].length;
}

/** mb_substr() for non-negative arguments. */
export function mbSubstr(value: string, start: number, length?: number): string {
	const characters = [...value];
	const end = length === undefined ? characters.length : start + length;
	return characters.slice(start, end).join('');
}

/** mb_strpos(), or false when the needle is absent. */
export function mbStrpos(haystack: string, needle: string): number | false {
	const index = haystack.indexOf(needle);
	if (index === -1) {
		return false;
	}
	return mbStrlen(haystack.slice(0, index));
}

/** strlen(): the UTF-8 byte length. */
export function byteLength(value: string): number {
	return encoder.encode(value).length;
}

/** base64_encode() of the UTF-8 bytes. */
export function base64Encode(value: string): string {
	let binary = '';
	for (const byte of encoder.encode(value)) {
		binary += String.fromCodePoint(byte);
	}
	return btoa(binary);
}

/** base64_decode() in its lenient mode: characters outside the alphabet are skipped. */
export function base64Decode(value: string): string {
	let clean = value.replaceAll(/[^A-Z0-9+/]/gi, '');
	// A lone trailing character carries fewer than 8 bits, so PHP drops it.
	if (clean.length % 4 === 1) {
		clean = clean.slice(0, -1);
	}
	const binary = atob(clean.padEnd(Math.ceil(clean.length / 4) * 4, '='));
	return decoder.decode(Uint8Array.from(binary, character => character.codePointAt(0) as number));
}

/** NavigationTree::parsePath(): a dot-separated list of base64 names. */
export function parsePath(value: string): string[] {
	return value.split('.').map(part => base64Decode(part));
}

/** Util::getUrlForOption() for the 'database' and 'table' locations. */
export function getUrlForOption(target: string, location: 'database' | 'table'): string {
	const routes: Record<string, Record<string, string>> = {
		database: {
			'structure': '/database/structure',
			'db_structure.php': '/database/structure',
			'sql': '/database/sql',
			'db_sql.php': '/database/sql',
			'search': '/database/search',
			'db_search.php': '/database/search',
			'operations': '/database/operations',
			'db_operations.php': '/database/operations',
		},
		table: {
			'structure': '/table/structure',
			'tbl_structure.php': '/table/structure',
			'sql': '/table/sql',
			'tbl_sql.php': '/table/sql',
			'search': '/table/search',
			'tbl_select.php': '/table/search',
			'insert': '/table/change',
			'tbl_change.php': '/table/change',
			'browse': '/sql',
			'sql.php': '/sql',
		},
	};
	return routes[location][target] ?? '/';
}

const TARGET_TITLES: Record<string, string> = {
	structure: 'Structure',
	sql: 'SQL',
	search: 'Search',
	insert: 'Insert',
	browse: 'Browse',
	operations: 'Operations',
};

/** (string) Util::getTitleForTarget(): unknown targets give false, which casts to ''. */
export function getTitleForTarget(target: string): string {
	return TARGET_TITLES[target] ?? '';
}

const TABLE_ICONS: Record<string, NodeIcon> = {
	'/table/structure': { image: 'b_props', title: 'Structure' },
	'/table/search': { image: 'b_search', title: 'Search' },
	'/table/change': { image: 'b_insrow', title: 'Insert' },
	'/table/sql': { image: 'b_sql', title: 'SQL' },
	'/sql': { image: 'b_browse', title: 'Browse' },
};

/** NodeTable::addIcon(), comparing routes instead of the equivalent script URLs. */
function tableIcon(target: string): NodeIcon | null {
	return TABLE_ICONS[getUrlForOption(target, 'table')] ?? null;
}

export class NavNode {
	name = '';
	realName = '';
	type: NodeType = OBJECT;
	visible = false;
	parent: NavNode | null = null;
	children: NavNode[] = [];
	separator = '';
	separatorDepth = 1;
	icon: NodeIcon = { image: '', title: '' };
	links: NodeLinks = { text: { route: '', params: {} }, icon: { route: '', params: {} } };
	title: string | null = null;
	classes = '';
	isNew = false;
	pos2 = 0;
	pos3 = 0;
	displayName: string | null = null;
	urlParamName: string | null = null;
	secondIcon: NodeIcon | null = null;

	constructor(readonly kind: NodeKind, name: string, type: NodeType = OBJECT, public isGroup = false) {
		if (name.length > 0) {
			this.name = name;
			this.realName = name;
		}
		this.type = type;
	}

	addChild(child: NavNode): void {
		this.children.push(child);
		child.parent = this;
	}

	/** Node::getChild(): by name skipping "New" nodes, or by real name. */
	getChild(name: string, realName = false): NavNode | null {
		if (realName) {
			return this.children.find(child => child.realName === name) ?? null;
		}
		return this.children.find(child => child.name === name && !child.isNew) ?? null;
	}

	/** Node::removeChild(), which compares names loosely. */
	removeChildByName(name: string): void {
		const index = this.children.findIndex(child => looseEquals(child.name, name));
		if (index !== -1) {
			this.children.splice(index, 1);
		}
	}

	parents(self = false, containers = false, groups = false): NavNode[] {
		const parents: NavNode[] = [];
		const include = (node: NavNode): boolean => (node.type !== CONTAINER || containers) && (!node.isGroup || groups);
		if (self && include(this)) {
			parents.push(this);
		}
		let parent = this.parent;
		while (parent !== null) {
			if (include(parent)) {
				parents.push(parent);
			}
			parent = parent.parent;
		}
		return parents;
	}

	/** Node::realParent(): the closest object ancestor, whose name SQL queries use. */
	realParent(): NavNode | false {
		return this.parents()[0] ?? false;
	}

	hasChildren(countEmptyContainers = true): boolean {
		if (countEmptyContainers) {
			return this.children.length > 0;
		}
		return this.children.some(child => child.type === OBJECT || child.hasChildren(false));
	}

	/** Columns and indexes always count as having siblings so that their containers are rendered. */
	hasSiblings(): boolean {
		if (this.getPaths().aPath_clean.length > 3) {
			return true;
		}
		return (this.parent as NavNode).children.some(child => child !== this && (child.type === OBJECT || child.hasChildren(false)));
	}

	getPaths(): NodePaths {
		const actual = this.parents(true, true, false).toReversed();
		const virtual = this.parents(true, true, true).toReversed();
		return {
			aPath: actual.map(node => base64Encode(node.realName)).join('.'),
			aPath_clean: actual.map(node => node.realName),
			vPath: virtual.map(node => base64Encode(node.name)).join('.'),
			vPath_clean: virtual.map(node => node.name),
		};
	}
}

/** NodeColumn::getDisplayName(): the non-empty attributes in brackets, with long defaults cut. */
export function columnDisplayName(item: ColumnItem): string {
	let result = item.name;
	let first = true;
	for (const [key, value] of Object.entries(item)) {
		// PHP's empty() also skips "0".
		if (key === 'name' || value === null || value === '' || value === '0') {
			continue;
		}
		result += first ? ' (' : ', ';
		first = false;
		if (key === 'default' && value.length > 6) {
			result += `${value.slice(0, 6)}...`;
		} else {
			result += value;
		}
	}
	return `${result})`;
}

function columnIcon(key: string | null): string {
	if (key === 'PRI') {
		return 'b_primary';
	}
	if (key === 'UNI') {
		return 'bd_primary';
	}
	return 'pause';
}

const sameLinks = (route: string, params: Record<string, unknown>): NodeLinks => {
	return { text: { route, params }, icon: { route, params: { ...params } } };
};

/** NodeFunction and NodeProcedure, which differ only in the routine type. */
function routine(kind: NodeKind, itemType: string, title: string, classes: string, name: string, type: NodeType, isGroup: boolean): NavNode {
	const node = new NavNode(kind, name, type, isGroup);
	node.icon = { image: 'b_routines', title };
	node.links = {
		text: { route: '/database/routines', params: { item_type: itemType, edit_item: 1, db: null, item_name: null } },
		icon: { route: '/database/routines', params: { item_type: itemType, execute_dialog: 1, db: null, item_name: null } },
	};
	node.classes = classes;
	node.urlParamName = 'item_name';
	return node;
}

export interface NodeFactory {
	/** NodeFactory::getInstance() for a class that takes a name. */
	create(kind: NodeKind, name: string, type?: NodeType, isGroup?: boolean): NavNode;
	column(item: ColumnItem): NavNode;
	/** NodeFactory::getInstanceForNewNode(). */
	newNode(name: string, classes: string): NavNode;
}

/** NodeFactory bound to the request's $cfg; isCreateDbPriv is $GLOBALS['is_create_db_priv']. */
export function createNodeFactory(config: NodeConfig, isCreateDbPriv: boolean): NodeFactory {
	const newNode = (name: string, classes: string): NavNode => {
		const node = new NavNode('Node', name);
		node.title = name;
		node.isNew = true;
		node.classes = classes;
		return node;
	};

	const childContainer = (kind: NodeKind, name: string): NavNode => {
		const node = new NavNode(kind, name, CONTAINER);
		if (config.NavigationTreeEnableGrouping) {
			node.separator = config.NavigationTreeTableSeparator as string;
			node.separatorDepth = Math.trunc(Number(config.NavigationTreeTableLevel));
		}
		return node;
	};

	const addNew = (container: NavNode, classes: string, image: string, links: NodeLinks): void => {
		const node = newNode('New', classes);
		node.icon = { image, title: 'New' };
		node.links = links;
		container.addChild(node);
	};

	const builders: Partial<Record<NodeKind, (name: string, type: NodeType, isGroup: boolean) => NavNode>> = {
		NodeDatabase: (name, type, isGroup) => {
			const node = new NavNode('NodeDatabase', name, type, isGroup);
			node.icon = { image: 's_db', title: 'Database operations' };
			node.links = {
				text: { route: getUrlForOption(config.DefaultTabDatabase, 'database'), params: { db: null } },
				icon: { route: '/database/operations', params: { db: null } },
				title: 'Structure',
			};
			node.classes = 'database';
			node.urlParamName = 'db';
			return node;
		},
		NodeTable: (name, type, isGroup) => {
			const node = new NavNode('NodeTable', name, type, isGroup);
			node.icon = tableIcon(config.NavigationTreeDefaultTabTable) ?? node.icon;
			node.secondIcon = tableIcon(config.NavigationTreeDefaultTabTable2);
			node.title = getTitleForTarget(config.DefaultTabTable);
			node.links = {
				text: { route: getUrlForOption(config.DefaultTabTable, 'table'), params: { pos: 0, db: null, table: null } },
				icon: { route: getUrlForOption(config.NavigationTreeDefaultTabTable, 'table'), params: { db: null, table: null } },
				second_icon: { route: getUrlForOption(config.NavigationTreeDefaultTabTable2, 'table'), params: { db: null, table: null } },
				title: node.title,
			};
			node.classes = 'nav_node_table';
			node.urlParamName = 'table';
			return node;
		},
		NodeView: (name, type, isGroup) => {
			const node = new NavNode('NodeView', name, type, isGroup);
			node.icon = { image: 'b_props', title: 'View' };
			node.links = {
				text: { route: '/sql', params: { pos: 0, db: null, table: null } },
				icon: { route: '/table/structure', params: { db: null, table: null } },
			};
			node.classes = 'view';
			node.urlParamName = 'table';
			return node;
		},
		NodeFunction: (name, type, isGroup) => routine('NodeFunction', 'FUNCTION', 'Function', 'function', name, type, isGroup),
		NodeProcedure: (name, type, isGroup) => routine('NodeProcedure', 'PROCEDURE', 'Procedure', 'procedure', name, type, isGroup),
		NodeEvent: (name, type, isGroup) => {
			const node = new NavNode('NodeEvent', name, type, isGroup);
			node.icon = { image: 'b_events', title: 'Event' };
			node.links = {
				text: { route: '/database/events', params: { edit_item: 1, db: null, item_name: null } },
				icon: { route: '/database/events', params: { export_item: 1, db: null, item_name: null } },
			};
			node.classes = 'event';
			node.urlParamName = 'item_name';
			return node;
		},
		NodeIndex: (name, type, isGroup) => {
			const node = new NavNode('NodeIndex', name, type, isGroup);
			node.icon = { image: 'b_index', title: 'Index' };
			node.links = sameLinks('/table/indexes', { db: null, table: null, index: null });
			node.classes = 'index';
			node.urlParamName = 'index';
			return node;
		},
		NodeTrigger: (name, type, isGroup) => {
			const node = new NavNode('NodeTrigger', name, type, isGroup);
			node.icon = { image: 'b_triggers', title: 'Trigger' };
			node.links = {
				text: { route: '/database/triggers', params: { edit_item: 1, db: null, item_name: null } },
				icon: { route: '/database/triggers', params: { export_item: 1, db: null, item_name: null } },
			};
			node.classes = 'trigger';
			node.urlParamName = 'item_name';
			return node;
		},
		NodeDatabaseContainer: (name) => {
			const node = new NavNode('NodeDatabaseContainer', name, CONTAINER);
			if (isCreateDbPriv && config.ShowCreateDb !== false) {
				addNew(node, 'new_database italics', 'b_newdb', sameLinks('/server/databases', {}));
			}
			return node;
		},
		NodeTableContainer: () => {
			const node = childContainer('NodeTableContainer', 'Tables');
			node.icon = { image: 'b_browse', title: 'Tables' };
			node.links = sameLinks('/database/structure', { tbl_type: 'table', db: null });
			node.realName = 'tables';
			node.classes = 'tableContainer subContainer';
			addNew(node, 'new_table italics', 'b_table_add', sameLinks('/table/create', { db: null }));
			return node;
		},
		NodeViewContainer: () => {
			const node = childContainer('NodeViewContainer', 'Views');
			node.icon = { image: 'b_views', title: 'Views' };
			node.links = sameLinks('/database/structure', { tbl_type: 'view', db: null });
			node.classes = 'viewContainer subContainer';
			node.realName = 'views';
			addNew(node, 'new_view italics', 'b_view_add', sameLinks('/view/create', { db: null }));
			return node;
		},
		NodeFunctionContainer: () => {
			const node = childContainer('NodeFunctionContainer', 'Functions');
			node.icon = { image: 'b_routines', title: 'Functions' };
			node.links = sameLinks('/database/routines', { type: 'FUNCTION', db: null });
			node.realName = 'functions';
			addNew(node, 'new_function italics', 'b_routine_add', sameLinks('/database/routines', { item_type: 'FUNCTION', add_item: 1, db: null }));
			return node;
		},
		NodeProcedureContainer: () => {
			const node = childContainer('NodeProcedureContainer', 'Procedures');
			node.icon = { image: 'b_routines', title: 'Procedures' };
			node.links = sameLinks('/database/routines', { type: 'PROCEDURE', db: null });
			node.realName = 'procedures';
			addNew(node, 'new_procedure italics', 'b_routine_add', sameLinks('/database/routines', { add_item: 1, db: null }));
			return node;
		},
		NodeEventContainer: () => {
			const node = childContainer('NodeEventContainer', 'Events');
			node.icon = { image: 'b_events', title: 'Events' };
			node.links = sameLinks('/database/events', { db: null });
			node.realName = 'events';
			addNew(node, 'new_event italics', 'b_event_add', sameLinks('/database/events', { add_item: 1, db: null }));
			return node;
		},
		NodeColumnContainer: () => {
			const node = new NavNode('NodeColumnContainer', 'Columns', CONTAINER);
			node.icon = { image: 'pause', title: 'Columns' };
			node.links = sameLinks('/table/structure', { db: null, table: null });
			node.realName = 'columns';
			addNew(node, 'new_column italics', 'b_column_add', sameLinks('/table/add-field', { field_where: 'last', after_field: '', db: null, table: null }));
			return node;
		},
		NodeIndexContainer: () => {
			const node = new NavNode('NodeIndexContainer', 'Indexes', CONTAINER);
			node.icon = { image: 'b_index', title: 'Indexes' };
			node.links = sameLinks('/table/structure', { db: null, table: null });
			node.realName = 'indexes';
			addNew(node, 'new_index italics', 'b_index_add', sameLinks('/table/indexes', { create_index: 1, added_fields: 2, db: null, table: null }));
			return node;
		},
		NodeTriggerContainer: () => {
			const node = new NavNode('NodeTriggerContainer', 'Triggers', CONTAINER);
			node.icon = { image: 'b_triggers', title: 'Triggers' };
			node.links = sameLinks('/database/triggers', { db: null, table: null });
			node.realName = 'triggers';
			addNew(node, 'new_trigger italics', 'b_trigger_add', sameLinks('/database/triggers', { add_item: 1, db: null }));
			return node;
		},
	};

	return {
		create: (kind, name, type = OBJECT, isGroup = false) => {
			const builder = builders[kind];
			if (builder) {
				return builder(name, type, isGroup);
			}
			return new NavNode(kind, name, type, isGroup);
		},
		column: (item) => {
			const node = new NavNode('NodeColumn', item.name);
			node.displayName = columnDisplayName(item);
			node.icon = { image: columnIcon(item.key), title: 'Column' };
			node.links = sameLinks('/table/structure/change', { change_column: 1, db: null, table: null, field: null });
			node.links.title = 'Structure';
			node.urlParamName = 'field';
			return node;
		},
		newNode,
	};
}
