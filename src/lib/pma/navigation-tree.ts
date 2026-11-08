// Pure parts of PhpMyAdmin\Navigation\NavigationTree: grouping, sorting, visibility and the node.twig variables.
import {
	CONTAINER,
	type NavNode,
	type NodeFactory,
	type NodeLink,
	OBJECT,
	byteLength,
	looseEquals,
	mbStrlen,
	mbStrpos,
	mbSubstr,
} from './navigation-node.ts';
import { strcasecmp, strnatcasecmp } from './php-compare.ts';
import { getImage } from '../twig/html.ts';
import { htmlspecialchars } from '../twig/php.ts';

/** The $cfg keys the tree algorithms read. */
export interface TreeConfig {
	NavigationTreeEnableExpansion: boolean;
	NaturalOrder: boolean;
	ShowDatabasesNavigationAsTree: boolean;
}

const STERILE = new Set(['events', 'triggers', 'functions', 'procedures', 'views', 'columns', 'indexes']);
const HAVE_AJAX = new Set(['functions', 'procedures', 'events', 'triggers', 'indexes']);

/** NavigationTree::sortNode(): "New" items first, then by name. */
export function sortNode(config: TreeConfig, left: NavNode, right: NavNode): number {
	if (left.isNew) {
		return -1;
	}
	if (right.isNew) {
		return 1;
	}
	if (config.NaturalOrder) {
		return strnatcasecmp(left.name, right.name);
	}
	return strcasecmp(left.name, right.name);
}

export function sortedChildren(config: TreeConfig, node: NavNode): NavNode[] {
	return node.children.toSorted((left, right) => sortNode(config, left, right));
}

/** The prefixes shared by more than one child, with upstream's counting quirks (bug #4375 counts are added per child). */
function groupPrefixes(node: NavNode, separator: string): Map<string, number> {
	const prefixes = new Map<string, number>();
	if (node.separatorDepth > 0) {
		for (const child of node.children) {
			// A name starting with the separator has no prefix.
			const prefixPos = mbStrpos(child.name, separator);
			if (prefixPos !== false && prefixPos > 0) {
				const prefix = mbSubstr(child.name, 0, prefixPos);
				prefixes.set(prefix, (prefixes.get(prefix) ?? 0) + 1);
			}
			for (const otherChild of node.children) {
				const count = prefixes.get(otherChild.name);
				if (count !== undefined) {
					prefixes.set(otherChild.name, count + 1);
				}
			}
		}
		for (const child of node.children) {
			const count = prefixes.get(child.name);
			if (count !== undefined) {
				prefixes.set(child.name, count + 1);
			}
		}
	}
	for (const [key, value] of prefixes) {
		if (value <= 1) {
			prefixes.delete(key);
		}
	}
	// rfe #1634: one group holding every item but one is not worth a level.
	if (prefixes.size === 1) {
		const [[key, value]] = prefixes;
		if (value === node.children.length - 1) {
			prefixes.delete(key);
		}
	}
	return prefixes;
}

interface Replacement {
	node: NavNode;
	replacesName: string;
}

function groupMembers(factory: NodeFactory, node: NavNode, key: string, separator: string): Replacement[] {
	const members: Replacement[] = [];
	// Upstream adds a character count to a byte count here.
	const keySeparatorLength = mbStrlen(key) + byteLength(separator);
	for (const child of node.children) {
		const nameSubstring = mbSubstr(child.name, 0, keySeparatorLength);
		if ((!looseEquals(nameSubstring, key + separator) && !looseEquals(child.name, key)) || child.type !== OBJECT) {
			continue;
		}
		const member = factory.create(child.kind, mbSubstr(child.name, keySeparatorLength));
		member.realName = child.realName;
		member.icon = child.icon;
		member.links = child.links;
		member.pos2 = child.pos2;
		member.pos3 = child.pos3;
		for (const element of child.children) {
			member.addChild(element);
		}
		members.push({ node: member, replacesName: child.name });
	}
	return members;
}

function groupLinks(link: NodeLink, key: string): NodeLink {
	return { route: link.route, params: { ...link.params, tbl_group: key } };
}

/** NavigationTree::groupNode(): moves items sharing a name prefix into group containers. */
export function groupNode(config: TreeConfig, factory: NodeFactory, node: NavNode): void {
	const { separator } = node;
	// Production only sets single string separators, so upstream's separator arrays are left out.
	if (node.type !== CONTAINER || !config.NavigationTreeEnableExpansion || separator === '') {
		return;
	}
	const prefixes = groupPrefixes(node, separator);
	if (prefixes.size === 0) {
		return;
	}
	const numChildren = node.children.length;
	const groups: NavNode[] = [];
	for (const key of prefixes.keys()) {
		const members = groupMembers(factory, node, key, separator);
		if (members.length === 0) {
			continue;
		}
		// A plain group whose items all share the prefix absorbs it instead of nesting another group.
		if (members.length === numChildren && node.kind === 'Node') {
			node.name += separator + htmlspecialchars(key);
			node.realName += separator + htmlspecialchars(key);
			node.separatorDepth--;
			for (const member of members) {
				node.removeChildByName(member.replacesName);
				node.addChild(member.node);
			}
			continue;
		}
		const group = factory.create('Node', key, CONTAINER, true);
		group.separator = node.separator;
		group.separatorDepth = node.separatorDepth - 1;
		group.icon = { image: 'b_group', title: 'Groups' };
		group.pos2 = node.pos2;
		group.pos3 = node.pos3;
		if (node.kind === 'NodeTableContainer' || node.kind === 'NodeViewContainer') {
			group.links = { text: groupLinks(node.links.text, key), icon: groupLinks(node.links.icon, key) };
		}
		for (const member of members) {
			node.removeChildByName(member.replacesName);
			group.addChild(member.node);
		}
		groups.push(group);
	}
	for (const group of groups) {
		node.addChild(group);
		groupNode(config, factory, group);
		group.classes = 'navGroup';
	}
}

/** NavigationTree::groupTree(). */
export function groupTree(config: TreeConfig, factory: NodeFactory, node: NavNode): void {
	groupNode(config, factory, node);
	for (const child of node.children) {
		groupTree(config, factory, child);
	}
}

/** NavigationTree::setVisibility(): shows the branches the client had expanded. */
export function setVisibility(tree: NavNode, vPaths: string[][]): void {
	for (const path of vPaths) {
		let node = tree;
		for (const value of path) {
			const child = node.getChild(value);
			if (child === null) {
				continue;
			}
			child.visible = true;
			node = child;
		}
	}
}

/** NavigationTree::findTreeMatch(): whether some expanded path starts with the given one. */
export function findTreeMatch(tree: string[][], paths: string[]): boolean {
	return tree.some(path => paths.every((part, index) => index < path.length && looseEquals(part, path[index])));
}

export interface PaginationParams {
	position?: string;
	data_name?: string;
	data_value?: string;
}

/** NavigationTree::getPaginationParamsHtml(). */
export function paginationParams(node: NavNode): PaginationParams {
	const paths = node.getPaths().aPath_clean;
	if (paths.length > 4) {
		return { position: 'pos3_nav', data_name: paths[4], data_value: String(node.pos3) };
	}
	if (paths.length > 2) {
		return { position: 'pos2_nav', data_name: paths[2], data_value: String(node.pos2) };
	}
	return {};
}

/** Node::getCssClasses(). */
export function cssClasses(config: TreeConfig, node: NavNode, match: boolean): string {
	if (!config.NavigationTreeEnableExpansion) {
		return '';
	}
	const result = ['expander'];
	if (node.isGroup || match) {
		result.push('loaded');
	}
	if (node.type === CONTAINER) {
		result.push('container');
	}
	return result.join(' ');
}

/** Node::getIcon(): an expanded branch is made visible. */
export function expandIcon(config: TreeConfig, node: NavNode, match: boolean): string {
	if (!config.NavigationTreeEnableExpansion) {
		return '';
	}
	if (match) {
		node.visible = true;
		return getImage('b_minus');
	}
	return getImage('b_plus', 'Expand/Collapse');
}

export interface IconLink {
	route: string;
	params: Record<string, unknown>;
	is_ajax: boolean;
	image: string;
	title: string;
}

export interface TextLink {
	route: string;
	params: Record<string, unknown>;
	is_ajax: boolean;
	title: string;
}

/** The node.twig variables of one node, before its children are rendered into `recursive`. */
export interface NodeTemplateVars {
	node: { isGroup: boolean; icon: { image: string; title: string; }; name: string; displayName: string | null; realName: string; classes: string; };
	class: string;
	show_node: boolean;
	has_siblings: boolean;
	li_classes: string;
	control_buttons: string;
	node_is_container: boolean;
	has_second_icon: boolean;
	icon_links: IconLink[];
	text_link: TextLink | Record<string, never>;
	pagination_params: PaginationParams;
	node_is_group: boolean;
	link_classes: string;
	paths: { a_path: string; v_path: string; pos: number; };
	node_icon: string;
	/** Whether children are wrapped in their own list_container (false for the hidden tables container). */
	wrap: boolean;
}

/** array_merge($params, array_intersect_key($args, $params)): fills a link's placeholders from the node's ancestors. */
function fillLink(link: NodeLink, args: Record<string, string>): Record<string, unknown> {
	const params = { ...link.params };
	for (const key of Object.keys(params)) {
		if (Object.hasOwn(args, key)) {
			params[key] = args[key];
		}
	}
	return params;
}

export interface NodeRenderOptions {
	config: TreeConfig;
	vPaths: string[][];
	pos: number;
	isAjax: boolean;
}

/**
 * The first half of NavigationTree::renderNode(): null when upstream returns '' for an empty container.
 * Must run before the children are rendered because it may mark the node visible.
 */
export function nodeTemplateVars(options: NodeRenderOptions, node: NavNode, cls: string): Omit<NodeTemplateVars, 'node'> | null {
	const { config } = options;
	const paths = node.getPaths();
	const nodeIsContainer = node.type === CONTAINER;
	const containerParents = node.parents(false, true);
	const hasSiblings = node.hasSiblings();
	let showNode = hasSiblings || containerParents.length > 0;
	// The tables container only shows when views, routines or events sit beside it.
	if (node.kind === 'NodeTableContainer' && !hasSiblings) {
		showNode = false;
	}
	const vars: Omit<NodeTemplateVars, 'node'> = {
		class: cls,
		show_node: showNode,
		has_siblings: hasSiblings,
		li_classes: '',
		control_buttons: '',
		node_is_container: nodeIsContainer,
		has_second_icon: node.secondIcon !== null,
		icon_links: [],
		text_link: {},
		pagination_params: paginationParams(node),
		node_is_group: false,
		link_classes: '',
		paths: { a_path: paths.aPath, v_path: paths.vPath, pos: options.pos },
		node_icon: '',
		wrap: showNode,
	};
	if (!showNode) {
		node.visible = true;
		return vars;
	}
	if (nodeIsContainer && node.children.length === 0 && !options.isAjax) {
		return null;
	}
	vars.li_classes = `${cls} ${node.classes}`.trim();
	const parent = containerParents[0];
	const parentName = parent.realName;
	vars.node_is_group = node.isGroup || (!STERILE.has(parentName) && !node.isNew) || (STERILE.has(node.realName) && node.children.length > 0);
	if (vars.node_is_group) {
		const match = findTreeMatch(options.vPaths, paths.vPath_clean);
		vars.link_classes = cssClasses(config, node, match);
		if (config.ShowDatabasesNavigationAsTree || parentName !== 'root') {
			vars.node_icon = expandIcon(config, node, match);
		}
	}
	const isNewView = parentName === 'views' && node.isNew;
	const linkHasAjaxClass = parent.type === CONTAINER && (HAVE_AJAX.has(parentName) || isNewView);
	if (!node.isGroup) {
		const args: Record<string, string> = {};
		for (const ancestor of node.parents(true)) {
			if (ancestor.urlParamName !== null) {
				args[ancestor.urlParamName] = ancestor.realName;
			}
		}
		vars.icon_links.push({
			route: node.links.icon.route,
			params: fillLink(node.links.icon, args),
			is_ajax: linkHasAjaxClass,
			image: node.icon.image,
			title: node.icon.title,
		});
		if (node.links.second_icon !== undefined && node.secondIcon !== null) {
			vars.icon_links.push({
				route: node.links.second_icon.route,
				params: fillLink(node.links.second_icon, args),
				is_ajax: linkHasAjaxClass,
				image: node.secondIcon.image,
				title: node.secondIcon.title,
			});
		}
		vars.text_link = {
			route: node.links.text.route,
			params: fillLink(node.links.text, args),
			is_ajax: linkHasAjaxClass,
			title: node.links.title ?? node.title ?? '',
		};
	}
	return vars;
}

/** The node object node.twig reads, as a plain value so Twig sees it like a PHP object's public properties. */
export function nodeView(node: NavNode): NodeTemplateVars['node'] {
	return {
		isGroup: node.isGroup,
		icon: { ...node.icon },
		name: node.name,
		displayName: node.displayName,
		realName: node.realName,
		classes: node.classes,
	};
}

/** NavigationTree::renderNodes(): the classes of a list of siblings by position. */
export function siblingClasses(count: number, hasFirstClass: boolean): string[] {
	return Array.from({ length: count }, (_, index) => {
		if (index === 0) {
			return hasFirstClass ? 'first' : '';
		}
		if (index + 1 === count) {
			return 'last';
		}
		return '';
	});
}
