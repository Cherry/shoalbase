import { describe, expect, it } from 'vitest';

import {
	fixUpMime,
	getAvailableMimeTypes,
	getDescription,
	getMime,
	getName,
	getOptions,
} from './transformations.ts';

describe('transformation plugins', () => {
	it('lists the 5.2.3 plugins in Transformations::getAvailableMimeTypes() order', () => {
		const types = getAvailableMimeTypes();
		expect(Object.keys(types.mimetype)).toEqual(['Image/JPEG', 'Text/Plain', 'Application/Octetstream', 'Image/PNG', 'Text/Octetstream']);
		expect(types.transformation[0]).toBe('Application/Octetstream: Download');
		expect(types.input_transformation_file.at(-1)).toBe('Text_Plain_Substring.php');
		expect(getName('Output/Text_Plain_Json.php')).toBe('JSON');
		expect(getDescription('Text_Plain_Substring.php')).toContain('Displays a part of a string.');
		expect(getName('nope.php')).toBe('');
		expect(getDescription('nope.php')).toBe('');
		expect(getMime()).toBeNull();
	});

	it('normalizes stored MIME names like fixUpMime()', () => {
		expect(fixUpMime('image_jpeg')).toBe('Image_JPEG');
		expect(fixUpMime('text_plain__inline.inc.php')).toBe('Text_Plain__Inline.inc.php');
		expect(fixUpMime('text/plain')).toBe('Text/plain');
	});

	it('splits transformation options, keeping quoted commas and stripping slashes', () => {
		expect(getOptions('')).toEqual([]);
		expect(getOptions('a, \'b,c\' ,d')).toEqual(['a', 'b,c', 'd']);
		expect(getOptions(String.raw`'x', it\'s`)).toEqual(['x', ' it\'s']);
		expect(getOptions('\'open, never closed')).toEqual(['open, never close']);
		expect(getOptions('\'dangling')).toEqual(['']);
		expect(getOptions(String.raw`a\0b`)).toEqual(['a\0b']);
	});
});
