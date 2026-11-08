export interface RoutePattern {
	methods: string[];
	path: string;
}

export type RouteMatch<T extends RoutePattern> =
	| { status: 'found'; route: T; params: Record<string, string>; }
	| { status: 'method-not-allowed'; allowed: string[]; }
	| { status: 'not-found'; };

const escapeRegExp = (text: string): string => text.replaceAll(/[$()*+.?[\\\]^{|}]/g, String.raw`\$&`);

/** Compiles a FastRoute pattern ({name}, {name:regex}, [optional suffix]) into an anchored regular expression. */
export const compileRoutePattern = (pattern: string): RegExp => {
	let source = '';
	for (let index = 0; index < pattern.length;) {
		const character = pattern[index] as string;
		if (character === '[') {
			source += '(?:';
			index += 1;
		} else if (character === ']') {
			source += ')?';
			index += 1;
		} else if (character === '{') {
			const end = pattern.indexOf('}', index);
			const [name, expression = '[^/]+'] = pattern.slice(index + 1, end).split(/:(.*)/s, 2);
			source += `(?<${name}>${expression})`;
			index = end + 1;
		} else {
			const literalEnd = pattern.slice(index).search(/[[\]{]/);
			const literal = literalEnd === -1 ? pattern.slice(index) : pattern.slice(index, index + literalEnd);
			source += escapeRegExp(literal);
			index += literal.length;
		}
	}
	return new RegExp(`^${source}$`);
};

/** Matches like FastRoute: a known path with the wrong method is a 405, not a 404. */
export const matchRoute = <T extends RoutePattern>(routes: T[], method: string, path: string): RouteMatch<T> => {
	const allowed: string[] = [];
	for (const route of routes) {
		const match = compileRoutePattern(route.path).exec(path);
		if (!match) {
			continue;
		}
		if (route.methods.includes(method)) {
			return { status: 'found', route, params: { ...match.groups } };
		}
		allowed.push(...route.methods);
	}
	if (allowed.length > 0) {
		return { status: 'method-not-allowed', allowed };
	}
	return { status: 'not-found' };
};
