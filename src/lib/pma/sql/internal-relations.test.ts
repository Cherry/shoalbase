import { describe, expect, it } from 'vitest';

import { internalRelations } from './internal-relations.ts';

describe('internalRelations', () => {
	it('emulates foreign keys of system schema tables, matching the database case-insensitively', () => {
		expect(internalRelations('INFORMATION_SCHEMA', 'CHARACTER_SETS')).toEqual({ DEFAULT_COLLATE_NAME: ['information_schema', 'COLLATIONS', 'COLLATION_NAME'] });
		expect(Object.keys(internalRelations('mysql', 'db')).length).toBeGreaterThan(0);
	});

	it('has nothing for user databases or unknown tables', () => {
		expect(internalRelations('customer_db', 'CHARACTER_SETS')).toEqual({});
		expect(internalRelations('information_schema', 'character_sets')).toEqual({});
	});
});
