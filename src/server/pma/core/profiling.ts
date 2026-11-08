// Port of PhpMyAdmin\Profiling: the "Profiling" checkbox choice is remembered in $_SESSION['profiling'].
import type { PmaContext } from './context.ts';
import type { DbiRow } from './dbi.ts';

/**
 * Profiling::isSupported(); PHP treats both "YES" and "NO" as true, so only a missing value turns it off. The
 * answer is kept in SessionCache, so no probe runs between the user's query and SHOW PROFILE.
 */
export async function isProfilingSupported(context: PmaContext): Promise<boolean> {
	const cache = (context.session.data.cache ?? {}) as Record<string, Record<string, unknown>>;
	const key = `server_${context.server}`;
	const cached = cache[key]?.profiling_supported;
	if (cached !== undefined) {
		return Boolean(cached);
	}
	const value = await context.dbi.fetchValue('SELECT @@have_profiling');
	const supported = value !== false && value !== null && value !== '' && value !== '0';
	cache[key] = { ...cache[key], profiling_supported: supported };
	context.session.data.cache = cache;
	return supported;
}

/** Profiling::check(), which Common::run() calls for every request before the controller. */
export async function checkProfiling(context: PmaContext): Promise<void> {
	const { params } = context.request;
	const { session } = context;
	if (params.profiling !== undefined && await isProfilingSupported(context)) {
		session.data.profiling = true;
	} else if (params.profiling_form !== undefined) {
		// The checkbox was unchecked.
		delete session.data.profiling;
	}
	if (session.data.profiling === undefined) {
		return;
	}
	context.response.addScriptFiles([
		'chart.js',
		'vendor/jqplot/jquery.jqplot.js',
		'vendor/jqplot/plugins/jqplot.pieRenderer.js',
		'vendor/jqplot/plugins/jqplot.highlighter.js',
		'vendor/jquery/jquery.tablesorter.js',
	]);
}

/** Whether isset($_SESSION['profiling']). */
export function isProfilingEnabled(context: PmaContext): boolean {
	return context.session.data.profiling !== undefined;
}

/** Profiling::enable(): turns on SET PROFILING before the user's query runs. */
export async function enableProfiling(context: PmaContext): Promise<void> {
	if (!isProfilingEnabled(context) || !await isProfilingSupported(context)) {
		return;
	}
	await context.dbi.query('SET PROFILING=1;');
}

/** Profiling::getInformation(): SHOW PROFILE rows, or null when profiling is off. */
export async function getProfilingInformation(context: PmaContext): Promise<DbiRow[] | null> {
	if (!isProfilingEnabled(context) || !await isProfilingSupported(context)) {
		return null;
	}
	return context.dbi.fetchResult('SHOW PROFILE;');
}
