import { describe, expect, it } from 'vitest';

import {
	groupMaintenanceRows,
	isSelectedTableList,
	nameAssertionError,
	warningMessages,
	warningToString,
} from './maintenance.ts';

describe('nameAssertionError', () => {
	it('accepts a valid name', () => {
		expect(nameAssertionError('players')).toBeNull();
	});

	it('reports Webmozart messages for each failed assertion', () => {
		expect(nameAssertionError(undefined)).toBe('Expected a string. Got: NULL');
		expect(nameAssertionError(['a'])).toBe('Expected a string. Got: array');
		expect(nameAssertionError('')).toBe('Expected a different value than "".');
		expect(nameAssertionError('a'.repeat(65))).toBe(`Expected a value to contain at most 64 characters. Got: "${'a'.repeat(65)}"`);
		expect(nameAssertionError('abc ')).toBe('Expected a value not to end with " ". Got: "abc "');
	});

	it('counts characters rather than UTF-16 units', () => {
		expect(nameAssertionError('😀'.repeat(64))).toBeNull();
	});
});

describe('isSelectedTableList', () => {
	it('requires a non-empty list of non-empty strings', () => {
		expect(isSelectedTableList(['a', 'b'])).toBe(true);
		expect(isSelectedTableList([])).toBe(false);
		expect(isSelectedTableList(['a', ''])).toBe(false);
		expect(isSelectedTableList('a')).toBe(false);
	});
});

describe('groupMaintenanceRows', () => {
	it('groups Message::fromArray() rows by table, reading missing fields as empty', () => {
		const grouped = groupMaintenanceRows([
			{ Table: 'db.a', Op: 'analyze', Msg_type: 'status', Msg_text: 'OK' },
			{ Table: 'db.b', Op: 'analyze', Msg_type: 'error', Msg_text: 'missing' },
			{ Table: 'db.a', Op: 'analyze', Msg_type: 'note' },
			{ Msg_text: 5 },
		]);
		expect(grouped.keys().toArray()).toEqual(['db.a', 'db.b', '']);
		expect(grouped.get('db.a')).toEqual([
			{ table: 'db.a', operation: 'analyze', type: 'status', text: 'OK' },
			{ table: 'db.a', operation: 'analyze', type: 'note', text: '' },
		]);
		expect(grouped.get('')).toEqual([{ table: '', operation: '', type: '', text: '' }]);
	});
});

describe('warningToString', () => {
	it(String.raw`formats like Dbal\Warning::__toString()`, () => {
		expect(warningToString({ Level: 'Warning', Code: '1265', Message: 'Data truncated' })).toBe('Warning: #1265 Data truncated');
		expect(warningToString({ Level: 'Note', Code: 1050, Message: '' })).toBe('Note: #1050');
	});

	it('normalises unknown levels and invalid codes', () => {
		expect(warningToString({ Level: 'Info', Code: 'x' })).toBe('?: #0');
		expect(warningToString({ Code: '-4' })).toBe('?: #0');
		expect(warningToString({ Level: 'Error', Code: '' })).toBe('Error: #0');
	});
});

describe('warningMessages', () => {
	it('drops only the Aria TRANSACTIONAL error when switching to MyISAM', () => {
		const rows = [
			{ Level: 'Error', Code: '1478', Message: 'TRANSACTIONAL' },
			{ Level: 'Warning', Code: '1478', Message: 'kept' },
		];
		expect(warningMessages(rows, 'MyISAM')).toEqual(['Warning: #1478 kept']);
		expect(warningMessages(rows, 'InnoDB')).toEqual(['Error: #1478 TRANSACTIONAL', 'Warning: #1478 kept']);
	});
});
