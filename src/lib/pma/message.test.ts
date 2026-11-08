import { describe, expect, it } from 'vitest';

import {
	MESSAGE_ERROR,
	MESSAGE_NOTICE,
	MESSAGE_SUCCESS,
	Message,
	SANITIZE_BOOTH,
	defaultMessageState,
} from './message.ts';

const ERROR_ICON = '<img src="themes/dot.gif" title="" alt="" class="icon ic_s_error">';

describe('Message', () => {
	it('renders an error like the live 404 page', () => {
		const message = Message.error('Error 404! The page [code]/x[/code] was not found.');
		expect(message.getDisplay()).toBe(`<div class="alert alert-danger" role="alert">\n  ${ERROR_ICON} Error 404! The page <code>/x</code> was not found.\n</div>\n`);
	});

	it('uses the upstream default texts for empty success and error messages', () => {
		expect(Message.success().getMessage()).toBe('Your SQL query has been executed successfully.');
		expect(Message.success('0').getMessage()).toBe('Your SQL query has been executed successfully.');
		expect(Message.error().getMessage()).toBe('Error');
	});

	it('maps levels to Bootstrap contexts and icons', () => {
		expect(Message.success('Done').getDisplay()).toContain('alert-success" role="alert">\n  <img src="themes/dot.gif" title="" alt="" class="icon ic_s_success"> Done');
		expect(Message.notice('Note').getDisplay()).toContain('alert-primary" role="alert">\n  <img src="themes/dot.gif" title="" alt="" class="icon ic_s_notice"> Note');
	});

	it('only adds the icon once the message has been displayed', () => {
		const message = Message.notice('Plain');
		expect(message.getMessage()).toBe('Plain');
		expect(message.isDisplayed()).toBe(false);
		message.getDisplay();
		expect(message.isDisplayed()).toBe(true);
		expect(message.toString()).toBe('<img src="themes/dot.gif" title="" alt="" class="icon ic_s_notice"> Plain');
	});

	it('escapes string parameters but not numbers or nested messages', () => {
		const message = Message.error('Table %s has %d rows: %s');
		message.addParam('<b>');
		message.addParam(3);
		message.addParamHtml('<i>x</i>');
		expect(message.getMessage()).toBe('Table &lt;b&gt; has 3 rows: <i>x</i>');
		expect(message.getParams()).toHaveLength(3);
	});

	it('keeps single quotes in string parameters, as ENT_COMPAT does', () => {
		const message = Message.success('You have updated the privileges for %s.');
		message.addParam('\'a&b\'@"%"');
		expect(message.getMessage()).toBe('You have updated the privileges for \'a&amp;b\'@&quot;%&quot;.');
	});

	it('pluralises the affected, deleted and inserted rows messages like English ngettext()', () => {
		expect(Message.getMessageForAffectedRows(1).getMessage()).toBe('1 row affected.');
		expect(Message.getMessageForAffectedRows(0).getMessage()).toBe('0 rows affected.');
		expect(Message.getMessageForDeletedRows(2).getMessage()).toBe('2 rows deleted.');
		expect(Message.getMessageForInsertedRows(1).getMessage()).toBe('1 row inserted.');
		expect(Message.getMessageForInsertedRows(5).isSuccess()).toBe(true);
	});

	it('keeps raw HTML away from BBCode decoding', () => {
		const raw = Message.rawError('[em]x[/em] <b>y</b>');
		expect(raw.getMessage()).toBe('[em]x[/em] <b>y</b>');
		expect(raw.isError()).toBe(true);
		expect(Message.rawNotice('n').isNotice()).toBe(true);
		expect(Message.rawSuccess('s').isSuccess()).toBe(true);
		expect(Message.notice('[em]x[/em] <b>').getMessage()).toBe('<em>x</em> <b>');
	});

	it('decodes documentation BBCode with the given generator state', () => {
		const message = Message.notice('[doc@faq1-34]FAQ[/doc]');
		expect(message.getMessage()).toBe('<a href="./doc/html/faq.html#faq1-34" target="documentation">FAQ</a>');
		expect(message.getMessage({ ...defaultMessageState, hasLocalDocs: false })).toContain('https%3A%2F%2Fdocs.phpmyadmin.net%2Fen%2Flatest%2Ffaq.html%23faq1-34');
	});

	it('appends added messages with their separators', () => {
		const message = Message.success('Saved.');
		message.addText('<script>');
		message.addHtml('<br>', '');
		message.addMessages([Message.notice('[em]a[/em]')], '0');
		message.addMessagesString(['b&c'], ' | ');
		expect(message.getMessage()).toBe('Saved. &lt;script&gt;<br><em>a</em> | b&amp;c');
		expect(message.getAddedMessages()).toHaveLength(6);
	});

	it('sanitises the string and parameters when asked to by the constructor', () => {
		const message = new Message('<%s>', MESSAGE_NOTICE, ['<x>', 5, Message.notice('<y>')], SANITIZE_BOOTH);
		expect(message.getString()).toBe('&lt;%s&gt;');
		expect(message.getParams()).toEqual(['&lt;x&gt;', '5', '&lt;y&gt;']);
		expect(Message.sanitize('"&"')).toBe('&quot;&amp;&quot;');
		expect(Message.sanitize(Message.notice('<z>'))).toBe('&lt;z&gt;');
	});

	it('switches levels and exposes its parts', () => {
		const message = new Message('text');
		expect(message.getLevel()).toBe('notice');
		expect(message.isError(true)).toBe(true);
		expect(message.isSuccess(true)).toBe(true);
		expect(message.isNotice(true)).toBe(true);
		message.setNumber(MESSAGE_ERROR);
		expect(message.getNumber()).toBe(MESSAGE_ERROR);
		message.setMessage('<only>', true);
		expect(message.getOnlyMessage()).toBe('&lt;only&gt;');
		message.setString('<s>');
		expect(message.getString()).toBe('&lt;s&gt;');
		message.setParams(['<p>']);
		expect(message.getParams()).toEqual(['<p>']);
		expect(new Message('', MESSAGE_SUCCESS).getMessage()).toBe('');
	});
});
