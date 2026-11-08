import { describe, expect, it } from 'vitest';

import { FlashMessages } from './flash-messages.ts';

import type { SessionData } from './session.ts';

describe('FlashMessages', () => {
	it('shows messages added on one request on the next request only', () => {
		const session = {} as SessionData;
		const first = new FlashMessages(session);
		first.addMessage('success', 'Table t has been dropped.');
		first.addMessage('success', 'Table u has been dropped.');
		expect(first.getMessages()).toEqual({});

		const second = new FlashMessages(session);
		expect(second.getMessage('success')).toEqual(['Table t has been dropped.', 'Table u has been dropped.']);
		expect(second.getMessage('error')).toBeNull();

		expect(new FlashMessages(session).getMessages()).toEqual({});
	});

	it('leaves a session without messages untouched and ignores a malformed store', () => {
		const empty = {} as SessionData;
		new FlashMessages(empty).getMessages();
		expect(empty).toEqual({});

		const malformed = { flashMessages: ['x'] } as unknown as SessionData;
		const flash = new FlashMessages(malformed);
		expect(flash.getMessages()).toEqual({});
		flash.addMessage('error', 'Oops');
		expect(new FlashMessages(malformed).getMessage('error')).toEqual(['Oops']);
	});
});
