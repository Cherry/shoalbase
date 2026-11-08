// Generator::getListNavigator()'s template variables for list_navigator.twig.
import { pageFromPosition, pageSelector } from './navigation-html.ts';
import { phpToInt } from './sprintf.ts';

export interface ListNavigatorInput {
	count: number;
	pos: number;
	urlParams: Record<string, unknown>;
	script: string;
	frame: string;
	maxCount: unknown;
	name: string;
	classes: string[];
}

/** The variables Generator::getListNavigator() renders list_navigator with; a page selector only when one page is not enough. */
export function listNavigatorVariables(input: ListNavigatorInput): Record<string, unknown> {
	// MaxTableList and friends are sometimes set to an empty string, which intval() turns into 0.
	let maxCount = phpToInt(input.maxCount);
	if (maxCount <= 0) {
		maxCount = 250;
	}
	const classes = [...input.classes];
	let selector = '';
	if (maxCount < input.count) {
		classes.push('pageselector');
		selector = pageSelector(input.name, maxCount, pageFromPosition(input.pos, maxCount), Math.ceil(input.count / maxCount));
	}
	return {
		count: input.count,
		max_count: maxCount,
		classes,
		frame: input.frame,
		position: input.pos,
		script: input.script,
		url_params: input.urlParams,
		param_name: input.name,
		page_selector: selector,
	};
}
