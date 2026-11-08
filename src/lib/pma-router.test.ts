import { describe, expect, it } from 'vitest';

import { compileRoutePattern, matchRoute } from '~/lib/pma-router';

const routes = [
	{ methods: ['GET', 'POST'], path: '[/]', name: 'home' },
	{ methods: ['GET'], path: '/server/engines/{engine}[/{page}]', name: 'engine' },
	{ methods: ['POST'], path: String.raw`/server/status/processes/kill/{id:\d+}`, name: 'kill' },
	{ methods: ['POST'], path: '/table.v2', name: 'literal' },
];

describe('phpMyAdmin route matching', () => {
	it('matches the home route with or without a slash', () => {
		expect(matchRoute(routes, 'GET', '')).toMatchObject({ status: 'found', route: { name: 'home' } });
		expect(matchRoute(routes, 'POST', '/')).toMatchObject({ status: 'found', route: { name: 'home' } });
	});

	it('captures placeholders and optional suffixes', () => {
		expect(matchRoute(routes, 'GET', '/server/engines/InnoDB')).toEqual({ status: 'found', route: routes[1], params: { engine: 'InnoDB', page: undefined } });
		expect(matchRoute(routes, 'GET', '/server/engines/InnoDB/Status')).toMatchObject({ params: { engine: 'InnoDB', page: 'Status' } });
		expect(matchRoute(routes, 'GET', '/server/engines/a/b/c')).toEqual({ status: 'not-found' });
	});

	it('honours placeholder expressions', () => {
		expect(matchRoute(routes, 'POST', '/server/status/processes/kill/42')).toMatchObject({ params: { id: '42' } });
		expect(matchRoute(routes, 'POST', '/server/status/processes/kill/x')).toEqual({ status: 'not-found' });
	});

	it('treats regex characters in literal segments literally', () => {
		expect(matchRoute(routes, 'POST', '/table.v2')).toMatchObject({ status: 'found' });
		expect(matchRoute(routes, 'POST', '/tableXv2')).toEqual({ status: 'not-found' });
		expect(compileRoutePattern('/a.b').test('/a.b')).toBe(true);
	});

	it('distinguishes a wrong method from an unknown path', () => {
		expect(matchRoute(routes, 'GET', '/server/status/processes/kill/42')).toEqual({ status: 'method-not-allowed', allowed: ['POST'] });
		expect(matchRoute(routes, 'GET', '/nope')).toEqual({ status: 'not-found' });
	});
});
