/**
 * Wraps the commit analyzer and release notes generator so commits that only touch `website/` are ignored.
 * The site deploys on its own, and each release tags the app the installer clones, so a site change should not cut one.
 */

import { execFileSync } from 'node:child_process';

import * as commitAnalyzer from '@semantic-release/commit-analyzer';
import * as notesGenerator from '@semantic-release/release-notes-generator';

import type { AnalyzeCommitsContext, GenerateNotesContext } from 'semantic-release';

function touchesApp(hash: string, cwd: string | undefined) {
	const files = execFileSync('git', ['diff-tree', '--no-commit-id', '--name-only', '-r', '--root', hash], { cwd, encoding: 'utf8' })
		.split('\n')
		.filter(Boolean);
	return files.some(file => !file.startsWith('website/'));
}

function withoutWebsiteOnly<Context extends AnalyzeCommitsContext>(context: Context): Context {
	const commits = context.commits.filter(commit => touchesApp(commit.hash, context.cwd));
	return { ...context, commits };
}

export function analyzeCommits(pluginConfig: unknown, context: AnalyzeCommitsContext) {
	return commitAnalyzer.analyzeCommits(pluginConfig, withoutWebsiteOnly(context));
}

export function generateNotes(pluginConfig: unknown, context: GenerateNotesContext) {
	return notesGenerator.generateNotes(pluginConfig, withoutWebsiteOnly(context));
}
