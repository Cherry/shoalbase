// Renders phpMyAdmin templates from ASTs precompiled by scripts/precompile-templates.mjs; nothing is parsed at runtime.

import { createPmaEnvironment } from './environment.ts';
import { phpScopedNodeExecutor } from './php-loop-scope.ts';
import { type TemplateStateInput, createTemplateState } from './state.ts';
import generated from '../../generated/twig-templates.js';
import { toTwigContext } from '../../lib/twig/values.ts';

import type { TwingCache, TwingTemplateNode } from 'twing';

const parsedTemplates = new Map<string, TwingTemplateNode>();

// Parsing the JSON lazily keeps Worker startup from paying for all 270 templates.
const astCache: TwingCache = {
	write: async () => {},
	load: async (key) => {
		let ast = parsedTemplates.get(key);
		if (ast === undefined && Object.hasOwn(generated.templates, key)) {
			ast = JSON.parse(generated.templates[key]) as TwingTemplateNode;
			parsedTemplates.set(key, ast);
		}
		return ast ?? null;
	},
	// A timestamp newer than any source keeps the array loader's isFresh() true, so sources are never read.
	getTimestamp: async () => Number.MAX_SAFE_INTEGER,
};

const templateNames = Object.fromEntries(Object.keys(generated.templates).map(name => [name, '']));
const themeImageSets = new Map(Object.entries(generated.themeImages).map(([theme, files]) => [theme, new Set(files)]));
const themeImages = themeImageSets.get('pmahomme') ?? new Set<string>();

/** The files under a theme's img/ directory, for Theme::getImgPath()'s is_readable() check. */
export function themeImageSet(theme: string): ReadonlySet<string> {
	return themeImageSets.get(theme) ?? new Set();
}

/**
 * Renders a template by its phpMyAdmin name, with or without the ".twig" suffix (e.g. "login/form").
 * `state` carries the request globals (token, server, lang, $cfg) that helper functions read.
 */
export async function renderTemplate(name: string, context: Record<string, unknown>, state: TemplateStateInput = {}): Promise<string> {
	const templateName = name.endsWith('.twig') ? name : `${name}.twig`;
	if (!Object.hasOwn(generated.templates, templateName)) {
		throw new Error(`Unknown template "${templateName}"`);
	}
	const env = createPmaEnvironment({
		templates: templateNames,
		state: createTemplateState({ themeImages, ...state }),
		cache: astCache,
	});
	// env.render() would do the same, but its options type leaves out the node executor that template.render() forwards to includes.
	const template = await env.loadTemplate(templateName);
	return template.render(env, toTwigContext(context), { nodeExecutor: phpScopedNodeExecutor });
}
