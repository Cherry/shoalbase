// Port of PhpMyAdmin\Message: success, notice and error texts with BBCode, parameters and the message.twig markup.
import { sprintf } from './sprintf.ts';
import { type GeneratorState, getImage } from '../twig/html.ts';
import { htmlspecialchars } from '../twig/php.ts';
import { sanitizeMessage } from '../twig/sanitize.ts';

export const MESSAGE_SUCCESS = 1;
export const MESSAGE_NOTICE = 2;
export const MESSAGE_ERROR = 8;

export type MessageNumber = typeof MESSAGE_SUCCESS | typeof MESSAGE_NOTICE | typeof MESSAGE_ERROR;
export type MessageLevel = 'success' | 'notice' | 'error';

/** Message::SANITIZE_* flags for the constructor. */
export const SANITIZE_NONE = 0;
export const SANITIZE_STRING = 16;
export const SANITIZE_PARAMS = 32;
export const SANITIZE_BOOTH = 48;

type MessageParam = Message | number | string;

const levels: Record<MessageNumber, MessageLevel> = {
	[MESSAGE_SUCCESS]: 'success',
	[MESSAGE_NOTICE]: 'notice',
	[MESSAGE_ERROR]: 'error',
};

/** BBCode decoding only reads the docs location and the "Documentation" string, which the English defaults cover. */
export const defaultMessageState: GeneratorState = {
	config: {},
	hasLocalDocs: true,
	mysqlVersion: 0,
	gettext: message => message,
};

// PHP's empty() on a string is also true for "0".
const isEmptyString = (value: string): boolean => value === '' || value === '0';

export class Message {
	/** Message::success(); the default text is upstream's English string. */
	static success(string = ''): Message {
		return new Message(isEmptyString(string) ? 'Your SQL query has been executed successfully.' : string, MESSAGE_SUCCESS);
	}

	static error(string = ''): Message {
		return new Message(isEmptyString(string) ? 'Error' : string, MESSAGE_ERROR);
	}

	static notice(string: string): Message {
		return new Message(string, MESSAGE_NOTICE);
	}

	/** Message::raw(): final HTML that skips BBCode decoding. */
	static raw(message: string, type: MessageNumber = MESSAGE_NOTICE): Message {
		const result = new Message('', type);
		result.setMessage(message);
		result.setBBCode(false);
		return result;
	}

	static rawError(message: string): Message {
		return this.raw(message, MESSAGE_ERROR);
	}

	static rawNotice(message: string): Message {
		return this.raw(message, MESSAGE_NOTICE);
	}

	static rawSuccess(message: string): Message {
		return this.raw(message, MESSAGE_SUCCESS);
	}

	private static counted(singular: string, plural: string, rows: number): Message {
		const message = this.success(rows === 1 ? singular : plural);
		message.addParam(rows);
		return message;
	}

	static getMessageForAffectedRows(rows: number): Message {
		return this.counted('%1$d row affected.', '%1$d rows affected.', rows);
	}

	static getMessageForDeletedRows(rows: number): Message {
		return this.counted('%1$d row deleted.', '%1$d rows deleted.', rows);
	}

	static getMessageForInsertedRows(rows: number): Message {
		return this.counted('%1$d row inserted.', '%1$d rows inserted.', rows);
	}

	/** Message::sanitize(): htmlspecialchars() on a value or each list item. */
	static sanitize(value: MessageParam): string;
	static sanitize(value: MessageParam[]): string[];
	static sanitize(value: MessageParam | MessageParam[]): string | string[] {
		if (Array.isArray(value)) {
			return value.map(item => htmlspecialchars(this.paramString(item)));
		}
		return htmlspecialchars(this.paramString(value));
	}

	private static paramString(value: MessageParam, state: GeneratorState = defaultMessageState): string | number {
		if (value instanceof this) {
			return value.getMessage(state);
		}
		return value;
	}

	private number: MessageNumber;
	private string = '';
	private message = '';
	private displayed = false;
	private useBBCode = true;
	private params: MessageParam[] = [];
	private readonly addedMessages: (Message | string)[] = [];

	constructor(string = '', number: MessageNumber = MESSAGE_NOTICE, params: MessageParam[] = [], sanitize = SANITIZE_NONE) {
		this.setString(string, (sanitize & SANITIZE_STRING) !== 0);
		this.number = number;
		this.setParams(params, (sanitize & SANITIZE_PARAMS) !== 0);
	}

	isSuccess(set = false): boolean {
		if (set) {
			this.number = MESSAGE_SUCCESS;
		}
		return this.number === MESSAGE_SUCCESS;
	}

	isNotice(set = false): boolean {
		if (set) {
			this.number = MESSAGE_NOTICE;
		}
		return this.number === MESSAGE_NOTICE;
	}

	isError(set = false): boolean {
		if (set) {
			this.number = MESSAGE_ERROR;
		}
		return this.number === MESSAGE_ERROR;
	}

	setBBCode(useBBCode: boolean): void {
		this.useBBCode = useBBCode;
	}

	setMessage(message: string, sanitize = false): void {
		this.message = sanitize ? Message.sanitize(message) : message;
	}

	setString(string: string, sanitize = true): void {
		this.string = sanitize ? Message.sanitize(string) : string;
	}

	setNumber(number: MessageNumber): void {
		this.number = number;
	}

	/** Strings are escaped with ENT_COMPAT here, so single quotes stay; numbers and messages are formatted as they are. */
	addParam(param: MessageParam): void {
		if (typeof param === 'string') {
			this.params.push(param.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;')
				.replaceAll('>', '&gt;'));
		} else {
			this.params.push(param);
		}
	}

	/** A parameter that is already HTML. */
	addParamHtml(param: string): void {
		this.params.push(Message.notice(param));
	}

	setParams(params: MessageParam[], sanitize = false): void {
		this.params = sanitize ? Message.sanitize(params) : [...params];
	}

	getParams(): MessageParam[] {
		return this.params;
	}

	addMessage(message: Message, separator = ' '): void {
		// PHP's empty() skips both '' and '0' separators.
		if (!isEmptyString(separator)) {
			this.addedMessages.push(separator);
		}
		this.addedMessages.push(message);
	}

	addMessages(messages: Message[], separator = ' '): void {
		for (const message of messages) {
			this.addMessage(message, separator);
		}
	}

	/** Appends escaped text. */
	addText(message: string, separator = ' '): void {
		this.addMessage(Message.notice(htmlspecialchars(message)), separator);
	}

	addMessagesString(messages: string[], separator = ' '): void {
		for (const message of messages) {
			this.addText(message, separator);
		}
	}

	/** Appends HTML as it is. */
	addHtml(message: string, separator = ' '): void {
		this.addMessage(Message.rawNotice(message), separator);
	}

	getAddedMessages(): (Message | string)[] {
		return this.addedMessages;
	}

	getOnlyMessage(): string {
		return this.message;
	}

	getString(): string {
		return this.string;
	}

	getNumber(): MessageNumber {
		return this.number;
	}

	getLevel(): MessageLevel {
		return levels[this.number];
	}

	isDisplayed(isDisplayed = false): boolean {
		if (isDisplayed) {
			this.displayed = true;
		}
		return this.displayed;
	}

	getMessageWithIcon(message: string): string {
		const level = this.getLevel();
		let image = 's_notice';
		if (level === 'error') {
			image = 's_error';
		} else if (level === 'success') {
			image = 's_success';
		}
		return `${getImage(image)} ${message}`;
	}

	/** Message::getMessage(): icon once displayed, then sprintf() parameters, BBCode and the appended messages. */
	getMessage(state: GeneratorState = defaultMessageState): string {
		let message = this.message === '' ? this.string : this.message;
		if (this.displayed) {
			message = this.getMessageWithIcon(message);
		}
		if (this.params.length > 0) {
			message = sprintf(message, ...this.params.map(param => Message.paramString(param, state)));
		}
		if (this.useBBCode) {
			message = sanitizeMessage(state, message, false, true);
		}
		for (const added of this.addedMessages) {
			message += typeof added === 'string' ? added : added.getMessage(state);
		}
		return message;
	}

	/** Message::getDisplay(): templates/message.twig around the message. */
	getDisplay(state: GeneratorState = defaultMessageState): string {
		this.isDisplayed(true);
		const level = this.getLevel();
		let context = 'primary';
		if (level === 'error') {
			context = 'danger';
		} else if (level === 'success') {
			context = 'success';
		}
		return `<div class="alert alert-${context}" role="alert">\n  ${this.getMessage(state)}\n</div>\n`;
	}

	toString(): string {
		return this.getMessage();
	}
}
