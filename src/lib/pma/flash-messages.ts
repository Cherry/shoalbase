// Port of PhpMyAdmin\FlashMessages: messages kept in $_SESSION['flashMessages'] for the next page that shows them.
import type { SessionData } from './session.ts';

const STORAGE_KEY = 'flashMessages';

function isMessageList(value: unknown): value is Record<string, string[]> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class FlashMessages {
	private readonly previousMessages: Record<string, string[]> = {};

	/** Like the upstream constructor, this takes the stored messages and empties the store for new ones. */
	constructor(private readonly storage: SessionData) {
		const stored = storage[STORAGE_KEY];
		if (isMessageList(stored)) {
			this.previousMessages = stored;
		}
		// An absent store stays absent, so pages that show no messages leave the session cookie alone.
		if (stored !== undefined) {
			delete storage[STORAGE_KEY];
		}
	}

	addMessage(key: string, message: string): void {
		const stored = this.storage[STORAGE_KEY];
		let messages: Record<string, string[]>;
		if (isMessageList(stored)) {
			messages = stored;
		} else {
			messages = {};
			this.storage[STORAGE_KEY] = messages;
		}
		messages[key] ??= [];
		messages[key].push(message);
	}

	getMessage(key: string): string[] | null {
		return this.previousMessages[key] ?? null;
	}

	getMessages(): Record<string, string[]> {
		return this.previousMessages;
	}
}
