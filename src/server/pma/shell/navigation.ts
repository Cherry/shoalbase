// Port of PhpMyAdmin\Navigation\Navigation and NavigationTree for production's config: no pmadb, information_schema, grouped database tree.
import { renderNaviSettings } from './navigation-settings.ts';
import {
	type LogoSettings,
	logoSettings,
	pageFromPosition,
	pageSelector,
	recentFavoriteHtml,
	resultsFound,
	serverOptions,
	treeControls,
} from '../../../lib/pma/navigation-html.ts';
import {
	CONTAINER,
	type ColumnItem,
	type NavNode,
	type NodeFactory,
	createNodeFactory,
	parsePath,
} from '../../../lib/pma/navigation-node.ts';
import {
	type DatabaseChildType,
	type TableChildType,
	databaseChildCountQuery,
	databaseChildListQuery,
	databaseCountQuery,
	databaseListQuery,
	databasePositionQuery,
	indexListQuery,
	pageIndexNames,
	tableChildCountQuery,
	tableChildListQuery,
} from '../../../lib/pma/navigation-sql.ts';
import {
	type TreeConfig,
	groupTree,
	nodeTemplateVars,
	nodeView,
	setVisibility,
	siblingClasses,
	sortedChildren,
} from '../../../lib/pma/navigation-tree.ts';
import { strnatcasecmp } from '../../../lib/pma/php-compare.ts';
import { phpToInt } from '../../../lib/pma/sprintf.ts';
import { getCommon, getFromRoute } from '../../../lib/twig/url.ts';
import { configuredServers } from '../../auth-runtime.ts';
import { renderTemplate, themeImageSet } from '../../twig/render.ts';
import { getHtmlList } from '../core/recent-favorite-table.ts';
import { ResponseExit } from '../core/response.ts';

import type { RequestValue } from '../../../lib/pma-request.ts';
import type { TemplateStateInput } from '../../twig/state.ts';
import type { PmaContext } from '../core/context.ts';

const DATABASE_CHILD_TYPES = new Set<string>(['tables', 'views', 'procedures', 'functions', 'events']);
const SPECIAL_NODE_NAMES = DATABASE_CHILD_TYPES;

const postString = (context: PmaContext, key: string): string | undefined => {
	const value = context.request.post[key];
	return typeof value === 'string' ? value : undefined;
};

const toInt = (value: unknown): number => phpToInt(value);

/** PHP's !empty() for a request value. */
const notEmpty = (value: RequestValue | undefined): boolean => {
	if (Array.isArray(value)) {
		return value.length > 0;
	}
	return value !== undefined && value !== '' && value !== '0';
};

/** array_slice(), whose negative offset counts from the end. */
const arraySlice = <T>(list: T[], offset: number, length: number): T[] => {
	const start = offset < 0 ? Math.max(list.length + offset, 0) : offset;
	return list.slice(start, start + length);
};

class NavigationTree {
	/** NavigationTree::__construct(), whose privilege check and database position need queries. */
	static async create(context: PmaContext, state: TemplateStateInput): Promise<NavigationTree> {
		const { dbi, request } = context;
		const isCreateDbPriv = await dbi.isCreateDatabaseUser();
		const factory = createNodeFactory(context.config, isCreateDbPriv);
		let pos: number;
		if (request.post.pos !== undefined) {
			pos = toInt(request.post.pos);
		} else if (request.query.pos === undefined) {
			pos = await this.databasePosition(context);
		} else {
			pos = toInt(request.query.pos);
		}
		const tree = factory.create('NodeDatabaseContainer', 'root');
		return new NavigationTree(context, state, factory, tree, pos);
	}

	/** NavigationTree::getNavigationDbPos(). */
	private static async databasePosition(context: PmaContext): Promise<number> {
		if (context.db === '') {
			return 0;
		}
		const { config } = context;
		return toInt(await context.dbi.fetchValue(databasePositionQuery(config.NavigationTreeDbSeparator, toInt(config.FirstLevelNavigationItems), context.db)));
	}

	private readonly aPath: string[][] = [];
	private readonly vPath: string[][] = [];
	private readonly pos2Name: string[] = [];
	private readonly pos2Value: number[] = [];
	private readonly pos3Name: string[] = [];
	private readonly pos3Value: number[] = [];
	private readonly searchClause: string;
	private readonly searchClause2: string;
	private readonly treeConfig: TreeConfig;
	private collate: string | null = null;

	private constructor(
		private readonly context: PmaContext,
		private readonly state: TemplateStateInput,
		private readonly factory: NodeFactory,
		private readonly tree: NavNode,
		private readonly pos: number,
	) {
		const { config } = context;
		this.treeConfig = config;
		this.readPaths();
		this.searchClause = postString(context, 'searchClause') ?? '';
		this.searchClause2 = postString(context, 'searchClause2') ?? '';
		if (config.NavigationTreeEnableGrouping && config.ShowDatabasesNavigationAsTree) {
			tree.separator = config.NavigationTreeDbSeparator;
			tree.separatorDepth = 10000;
		}
	}

	private readPaths(): void {
		const post = (key: string) => postString(this.context, key);
		const aPath = post('aPath');
		if (aPath === undefined) {
			for (let count = 0; post(`n${count}_aPath`) !== undefined; count++) {
				this.aPath[count] = parsePath(post(`n${count}_aPath`) as string);
				if (post(`n${count}_pos2_name`) !== undefined) {
					this.pos2Name[count] = post(`n${count}_pos2_name`) as string;
					this.pos2Value[count] = toInt(post(`n${count}_pos2_value`));
				}
				if (post(`n${count}_pos3_name`) === undefined) {
					continue;
				}

				this.pos3Name[count] = post(`n${count}_pos3_name`) as string;
				this.pos3Value[count] = toInt(post(`n${count}_pos3_value`));
			}
		} else {
			this.aPath[0] = parsePath(aPath);
			this.pos2Name[0] = post('pos2_name') ?? '';
			this.pos2Value[0] = toInt(post('pos2_value') ?? 0);
			if (post('pos3_name') !== undefined) {
				this.pos3Name[0] = post('pos3_name') as string;
				this.pos3Value[0] = toInt(post('pos3_value'));
			}
		}
		const vPath = post('vPath');
		if (vPath === undefined) {
			for (let count = 0; post(`n${count}_vPath`) !== undefined; count++) {
				this.vPath[count] = parsePath(post(`n${count}_vPath`) as string);
			}
		} else {
			this.vPath[0] = parsePath(vPath);
		}
	}

	private async collateForIS(): Promise<string> {
		this.collate ??= await this.context.dbi.getCollateForIS();
		return this.collate;
	}

	/** getPresence() of the root (database groups), a database or a table. */
	private async presence(node: NavNode, type = '', searchClause = '', singleItem = false): Promise<number> {
		const { dbi, config } = this.context;
		if (node.kind === 'NodeDatabase') {
			if (!DATABASE_CHILD_TYPES.has(type)) {
				return 0;
			}
			return toInt(await dbi.fetchValue(databaseChildCountQuery(type as DatabaseChildType, node.realName, await this.collateForIS(), searchClause, singleItem)));
		}
		if (node.kind === 'NodeTable') {
			return this.tablePresence(node, type);
		}
		return toInt(await dbi.fetchValue(databaseCountQuery(config.NavigationTreeDbSeparator, searchClause)));
	}

	private async tablePresence(table: NavNode, type: string): Promise<number> {
		const { dbi } = this.context;
		const database = (table.realParent() as NavNode).realName;
		if (type === 'indexes') {
			const result = await dbi.tryQuery(indexListQuery(database, table.realName));
			return result === false ? 0 : result.numRows();
		}
		if (type !== 'columns' && type !== 'triggers') {
			return 0;
		}
		return toInt(await dbi.fetchValue(tableChildCountQuery(type, database, table.realName, await this.collateForIS())));
	}

	/** NodeDatabase::getData(): naturally sorted names, paged in PHP. */
	private async databaseData(database: NavNode, type: DatabaseChildType, pos: number, searchClause: string): Promise<string[]> {
		const { dbi, config } = this.context;
		const rows = await dbi.fetchResult<string | null>(databaseChildListQuery(type, database.realName, await this.collateForIS(), searchClause));
		let names = rows.map(name => name ?? '');
		if (config.NaturalOrder) {
			names = names.toSorted(strnatcasecmp);
		}
		return arraySlice(names, pos, toInt(config.MaxNavigationItems));
	}

	/** NodeTable::getData(). */
	private async tableData(table: NavNode, type: TableChildType, pos: number): Promise<(string | ColumnItem)[]> {
		const { dbi, config } = this.context;
		const database = (table.realParent() as NavNode).realName;
		const maxItems = toInt(config.MaxNavigationItems);
		if (type === 'indexes') {
			const result = await dbi.tryQuery(indexListQuery(database, table.realName));
			if (result === false) {
				return [];
			}
			return pageIndexNames(result.fetchAllAssoc().map(row => row.Key_name ?? ''), pos, maxItems);
		}
		const sql = tableChildListQuery(type, database, table.realName, await this.collateForIS(), pos, maxItems);
		if (type === 'columns') {
			return dbi.fetchResult<ColumnItem>(sql);
		}
		const names = await dbi.fetchResult<string | null>(sql);
		return names.map(name => name ?? '');
	}

	/** NavigationTree::buildPath(): all databases of the page, then each requested branch. */
	private async buildPath(): Promise<NavNode | boolean> {
		const { dbi, config } = this.context;
		let result: NavNode | boolean = this.tree;
		const sql = databaseListQuery(config.NavigationTreeDbSeparator, this.searchClause, this.pos, toInt(config.FirstLevelNavigationItems));
		for (const database of await dbi.fetchResult<string | null>(sql)) {
			this.tree.addChild(this.factory.create('NodeDatabase', database ?? ''));
		}
		for (const [key, path] of this.aPath.entries()) {
			result = await this.buildPathPart(path, this.pos2Name[key] ?? '', this.pos2Value[key] ?? 0, this.pos3Name[key] ?? '', this.pos3Value[key] ?? 0);
		}
		return result;
	}

	private createDatabaseChild(containerName: string, item: string): NavNode | null {
		const kinds: Record<string, Parameters<NodeFactory['create']>[0]> = {
			events: 'NodeEvent',
			functions: 'NodeFunction',
			procedures: 'NodeProcedure',
			tables: 'NodeTable',
			views: 'NodeView',
		};
		const kind = kinds[containerName];
		return kind === undefined ? null : this.factory.create(kind, item);
	}

	/** NavigationTree::buildPathPart(). */
	private async buildPathPart(fullPath: string[], type2: string, pos2: number, type3: string, pos3: number): Promise<NavNode | boolean> {
		if (fullPath.length <= 1) {
			return true;
		}
		const path = fullPath.slice(1);
		const db = this.tree.getChild(path[0]);
		if (db === null) {
			return false;
		}
		const containers = await this.addDbContainers(db, type2, pos2);
		path.shift();
		if ((path.length === 0 || !containers.has(path[0])) && containers.size !== 1) {
			return db;
		}
		let container: NavNode;
		if (containers.size === 1) {
			[container] = containers.values();
		} else {
			const found = db.getChild(path[0], true);
			if (found === null) {
				return false;
			}
			container = found;
		}
		if (container.children.length <= 1) {
			const type = container.realName as DatabaseChildType;
			for (const item of await this.databaseData(db, type, pos2, this.searchClause2)) {
				const node = this.createDatabaseChild(container.realName, item);
				if (node === null) {
					continue;
				}
				if (type2 === container.realName) {
					node.pos2 = pos2;
				}
				container.addChild(node);
			}
		}
		if (path.length > 1 && path[0] !== 'tables') {
			return false;
		}
		path.shift();
		if (path.length === 0) {
			return container;
		}
		let table = container.getChild(path[0], true);
		if (table === null) {
			if (await this.presence(db, 'tables', path[0]) === 0) {
				return false;
			}
			const node = this.factory.create('NodeTable', path[0]);
			if (type2 === container.realName) {
				node.pos2 = pos2;
			}
			container.addChild(node);
			table = node;
		}
		const tableContainers = await this.addTableContainers(table, pos2, type3, pos3);
		path.shift();
		const tableContainer = path.length === 0 ? undefined : tableContainers.get(path[0]);
		if (tableContainer === undefined) {
			return table;
		}
		for (const item of await this.tableData(table, tableContainer.realName as TableChildType, pos3)) {
			let node: NavNode;
			if (typeof item === 'string') {
				node = this.factory.create(tableContainer.realName === 'indexes' ? 'NodeIndex' : 'NodeTrigger', item);
			} else {
				node = this.factory.column(item);
			}
			node.pos2 = (tableContainer.parent as NavNode).pos2;
			if (type3 === tableContainer.realName) {
				node.pos3 = pos3;
			}
			tableContainer.addChild(node);
		}
		return tableContainer;
	}

	/** NavigationTree::addTableContainers(). */
	private async addTableContainers(table: NavNode, pos2: number, type3: string, pos3: number): Promise<Map<string, NavNode>> {
		const containers = new Map<string, NavNode>();
		if (table.hasChildren(true)) {
			for (const node of table.children) {
				if (type3 === node.realName) {
					node.pos3 = pos3;
				}
				containers.set(node.realName, node);
			}
			return containers;
		}
		const kinds = [['columns', 'NodeColumnContainer'], ['indexes', 'NodeIndexContainer'], ['triggers', 'NodeTriggerContainer']] as const;
		for (const [type, kind] of kinds) {
			if (await this.presence(table, type) > 0) {
				containers.set(type, this.factory.create(kind, ''));
			}
		}
		for (const node of containers.values()) {
			node.pos2 = pos2;
			if (type3 === node.realName) {
				node.pos3 = pos3;
			}
			table.addChild(node);
		}
		return containers;
	}

	/** NavigationTree::addDbContainers(); hidden groups need pmadb, so only the NavigationTreeShow* switches apply. */
	private async addDbContainers(db: NavNode, type: string, pos2: number): Promise<Map<string, NavNode>> {
		const { config } = this.context;
		const containers = new Map<string, NavNode>();
		if (db.hasChildren(true)) {
			for (const node of db.children) {
				if (type === node.realName) {
					node.pos2 = pos2;
				}
				containers.set(node.realName, node);
			}
			return containers;
		}
		const kinds = [
			['tables', 'NodeTableContainer', config.NavigationTreeShowTables],
			['views', 'NodeViewContainer', config.NavigationTreeShowViews],
			['functions', 'NodeFunctionContainer', config.NavigationTreeShowFunctions],
			['procedures', 'NodeProcedureContainer', config.NavigationTreeShowProcedures],
			['events', 'NodeEventContainer', config.NavigationTreeShowEvents],
		] as const;
		for (const [name, kind, shown] of kinds) {
			if (shown && await this.presence(db, name) > 0) {
				containers.set(name, this.factory.create(kind, ''));
			}
		}
		for (const node of containers.values()) {
			if (type === node.realName) {
				node.pos2 = pos2;
			}
			db.addChild(node);
		}
		return containers;
	}

	private render(name: string, vars: Record<string, unknown>): Promise<string> {
		return renderTemplate(name, vars, this.state);
	}

	private async renderNodes(children: NavNode[], hasFirstClass = true): Promise<string> {
		const classes = siblingClasses(children.length, hasFirstClass);
		let html = '';
		for (const [index, child] of children.entries()) {
			html += await this.renderNode(child, classes[index]);
		}
		return html;
	}

	/** NavigationTree::renderNode(): a node and, recursively, its children. */
	private async renderNode(node: NavNode, cls = ''): Promise<string> {
		const vars = nodeTemplateVars({ config: this.treeConfig, vPaths: this.vPath, pos: this.pos, isAjax: this.context.response.isAjax }, node, cls);
		if (vars === null) {
			return '';
		}
		const children = sortedChildren(this.treeConfig, node);
		let buffer = '';
		for (const [index, child] of children.entries()) {
			const extraClass = index + 1 === children.length ? ' last' : '';
			buffer += await this.renderNode(child, child.classes + extraClass);
		}
		let recursiveHtml = '';
		if (buffer !== '') {
			recursiveHtml = await this.fastFilterHtml(node) + await this.getPageSelector(node) + buffer;
		}
		const { wrap, ...templateVars } = vars;
		return this.render('navigation/tree/node', {
			...templateVars,
			node: nodeView(node),
			recursive: { html: recursiveHtml, has_wrapper: wrap, is_hidden: !node.visible },
		});
	}

	/** NavigationTree::fastFilterHtml(): a filter box above long lists. */
	private async fastFilterHtml(node: NavNode): Promise<string> {
		const { config } = this.context;
		let urlParams: Record<string, unknown> = {};
		const isRootNode = node === this.tree && await this.presence(this.tree) >= toInt(config.NavigationTreeDisplayDbFilterMinimum);
		if (isRootNode) {
			urlParams = { pos: 0 };
		} else {
			const realParent = node.realParent();
			if (node.type === CONTAINER && SPECIAL_NODE_NAMES.has(node.realName) && realParent !== false && await this.presence(realParent, node.realName) >= toInt(config.NavigationTreeDisplayItemFilterMinimum)) {
				const paths = node.getPaths();
				urlParams = { pos: this.pos, aPath: paths.aPath, vPath: paths.vPath, pos2_name: node.realName, pos2_value: 0 };
			}
		}
		if (Object.keys(urlParams).length === 0) {
			return '';
		}
		return this.render('navigation/tree/fast_filter', { url_params: urlParams, is_root_node: isRootNode });
	}

	/** NavigationTree::getPageSelector(). */
	private async getPageSelector(node: NavNode): Promise<string> {
		const { config, server } = this.context;
		const script = getFromRoute(this.context.urlState(), '/navigation');
		if (node === this.tree) {
			const count = await this.presence(this.tree, 'databases', this.searchClause);
			return this.listNavigator(count, this.pos, { server }, script, toInt(config.FirstLevelNavigationItems), 'pos', ['dbselector']);
		}
		if (node.type !== CONTAINER || node.isGroup) {
			return '';
		}
		const paths = node.getPaths();
		const level = paths.aPath_clean.length > 4 ? 3 : 2;
		const urlParams: Record<string, unknown> = { aPath: paths.aPath, vPath: paths.vPath, pos: this.pos, server, pos2_name: paths.aPath_clean[2] };
		let pos = node.pos2;
		if (level === 3) {
			pos = node.pos3;
			urlParams.pos2_value = node.pos2;
			urlParams.pos3_name = paths.aPath_clean[4];
		}
		const count = await this.presence(node.realParent() as NavNode, node.realName, this.searchClause2);
		return this.listNavigator(count, pos, urlParams, script, toInt(config.MaxNavigationItems), `pos${level}_value`, []);
	}

	/** Generator::getListNavigator() for the navigation frame; nothing shows while everything fits on one page. */
	private async listNavigator(count: number, pos: number, urlParams: Record<string, unknown>, script: string, maxItems: number, name: string, classes: string[]): Promise<string> {
		const maxCount = maxItems > 0 ? maxItems : 250;
		if (maxCount >= count) {
			return '';
		}
		return this.render('list_navigator', {
			count,
			max_count: maxCount,
			classes: [...classes, 'pageselector'],
			frame: 'frame_navigation',
			position: pos,
			script,
			url_params: urlParams,
			param_name: name,
			page_selector: pageSelector(name, maxCount, pageFromPosition(pos, maxCount), Math.ceil(count / maxCount)),
		});
	}

	/** NavigationTree::quickWarp(): recent and favorite tables, which live in the session without pmadb. */
	private async quickWarp(): Promise<string> {
		const { config } = this.context;
		const details: Record<string, string> = {};
		if (toInt(config.NumRecentTables) > 0) {
			details.recent = recentFavoriteHtml('recent', await getHtmlList(this.context, 'recent'));
		}
		if (toInt(config.NumFavoriteTables) > 0) {
			details.favorite = recentFavoriteHtml('favorite', await getHtmlList(this.context, 'favorite'));
		}
		return this.render('navigation/tree/quick_warp', details);
	}

	/** NavigationTree::renderState(): the whole tree for a page load or a navigation reload. */
	async renderState(): Promise<string> {
		const { config } = this.context;
		await this.buildPath();
		const quickWarp = await this.quickWarp();
		const fastFilter = await this.fastFilterHtml(this.tree);
		let controls = '';
		if (config.NavigationTreeEnableExpansion) {
			const links = treeControls(config.NavigationLinkWithMainPanel);
			controls = await this.render('navigation/tree/controls', { collapse_all: links.collapseAll, unlink: links.unlink });
		}
		const pageSelectorHtml = await this.getPageSelector(this.tree);
		groupTree(this.treeConfig, this.factory, this.tree);
		const children = sortedChildren(this.treeConfig, this.tree);
		setVisibility(this.tree, this.vPath);
		const nodes = await this.renderNodes(children);
		return this.render('navigation/tree/state', { quick_warp: quickWarp, fast_filter: fastFilter, controls, page_selector: pageSelectorHtml, nodes });
	}

	/** NavigationTree::renderPath(): one expanded branch, or the database list for a filter. */
	async renderPath(): Promise<string | false> {
		const node = await this.buildPath();
		let listContent = '';
		if (typeof node !== 'boolean') {
			groupTree(this.treeConfig, this.factory, this.tree);
			listContent = await this.fastFilterHtml(node);
			listContent += await this.getPageSelector(node);
			listContent += await this.renderNodes(sortedChildren(this.treeConfig, node), false);
		}
		const hasSearchClause = this.searchClause !== '' || this.searchClause2 !== '';
		if (hasSearchClause && typeof node !== 'boolean') {
			let results = 0;
			if (this.searchClause2 === '') {
				results = await this.presence(this.tree, 'databases', this.searchClause);
			} else {
				const realParent = node.realParent();
				if (realParent !== false) {
					results = await this.presence(realParent, node.realName, this.searchClause2);
				}
			}
			this.context.response.addJSON('results', resultsFound(results));
		}
		if (node === false) {
			return false;
		}
		return this.render('navigation/tree/path', {
			has_search_results: hasSearchClause,
			list_content: listContent,
			is_tree: this.context.config.ShowDatabasesNavigationAsTree,
			parent_name: '',
		});
	}
}

/** Navigation::getLogoSource(): the active theme's logo, if it ships one. */
function logoSource(theme: string): string {
	const images = themeImageSet(theme);
	for (const file of ['logo_left.png', 'pma_logo2.png']) {
		if (images.has(file)) {
			return `./themes/${theme}/img/${file}`;
		}
	}
	return '';
}

/** Server\Select::render(true, true) as a drop-down. */
export async function renderServerSelect(context: PmaContext, state: TemplateStateInput): Promise<string> {
	const hosts = configuredServers().map(server => server.host);
	return renderTemplate('server/select/index', {
		not_only_options: true,
		omit_fieldset: true,
		servers: { select: serverOptions(hosts, context.server) },
		form_action: getFromRoute(context.urlState(), '/'),
	}, state);
}

/** Navigation::getDisplay(): the full panel on a page, or a tree fragment for the AJAX navigation route. */
export async function getNavigationDisplay(context: PmaContext): Promise<string> {
	const { config, response } = context;
	const state = await context.templateState();
	const isAjax = response.isAjax;
	let logo: LogoSettings = { is_displayed: config.NavigationDisplayLogo, has_link: false, link: '#', attributes: ' target="_blank" rel="noopener noreferrer"', source: '' };
	let serverSelect = '';
	let navigationSettings = '';
	if (!isAjax) {
		logo = logoSettings(config.NavigationDisplayLogo, String(config.NavigationLogoLink), config.NavigationLogoLinkWindow, logoSource(context.theme), divider => getCommon(context.urlState(), {}, divider));
		if (config.NavigationDisplayServers && configuredServers().length > 1) {
			serverSelect = await renderServerSelect(context, state);
		}
		if (!response.naviSettingsDisabled) {
			const pageSettings = await renderNaviSettings(context);
			// A saved form exits here upstream, inside Header::getDisplay(), so only the headers go out.
			if (pageSettings.saved) {
				throw new ResponseExit();
			}
			response.addHTML(pageSettings.errorHtml);
			navigationSettings = pageSettings.html;
		}
	}
	const tree = await NavigationTree.create(context, state);
	let navRender: string | false;
	const { post } = context.request;
	if (!isAjax || notEmpty(post.full) || notEmpty(post.reload)) {
		navRender = await tree.renderState();
	} else {
		navRender = await tree.renderPath();
	}
	return renderTemplate('navigation/main', {
		is_ajax: isAjax,
		logo,
		config_navigation_width: config.NavigationWidth,
		is_synced: config.NavigationLinkWithMainPanel,
		is_highlighted: config.NavigationTreePointerEnable,
		is_autoexpanded: config.NavigationTreeAutoexpandSingleDb,
		server: context.server,
		auth_type: config.Server.auth_type,
		is_servers_displayed: config.NavigationDisplayServers,
		servers: configuredServers().map(server => server.host),
		server_select: serverSelect,
		navigation_tree: navRender,
		is_navigation_settings_enabled: !response.naviSettingsDisabled,
		navigation_settings: navigationSettings,
		is_drag_drop_import_enabled: config.enable_drag_drop_import === true,
		is_mariadb: context.dbi.isMariaDB(),
	}, state);
}

/** Shell provider: the #pma_navigation panel of a full page. */
export async function renderNavigation(context: PmaContext): Promise<string> {
	return getNavigationDisplay(context);
}
