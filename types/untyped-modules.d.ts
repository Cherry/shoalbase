// Declarations for the packages the tooling imports that ship no types of their own.

declare module '@nodecraft/eslint-config' {
	import type { Linter } from 'eslint';

	const config: { configs: Record<'typescript' | 'json', Linter.Config[]>; };
	export default config;
}

// Only what scripts/pma-crawl.ts uses, rather than adding @types/jsdom for one script.
declare module 'jsdom' {
	export class JSDOM {
		readonly window: Window & typeof globalThis;
		constructor(html?: string);
	}
}

declare module '@semantic-release/commit-analyzer' {
	import type { AnalyzeCommitsContext } from 'semantic-release';

	export function analyzeCommits(pluginConfig: unknown, context: AnalyzeCommitsContext): Promise<string | null>;
}

declare module '@semantic-release/release-notes-generator' {
	import type { GenerateNotesContext } from 'semantic-release';

	export function generateNotes(pluginConfig: unknown, context: GenerateNotesContext): Promise<string>;
}
