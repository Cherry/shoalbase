// Port of PhpMyAdmin\Transformations without pmadb: the plugin list is static and no column has MIME settings.
import data from './transformations.json' with { type: 'json' };

interface TransformationsData {
	mimeTypes: AvailableMimeTypes;
	plugins: Record<string, { name: string; description: string; }>;
}

/** Transformations::getAvailableMimeTypes(). */
export interface AvailableMimeTypes {
	mimetype: Record<string, string>;
	transformation: string[];
	transformation_file: string[];
	input_transformation: string[];
	input_transformation_file: string[];
	empty_mimetype?: Record<string, string>;
}

const transformations = data as TransformationsData;

export function getAvailableMimeTypes(): AvailableMimeTypes {
	return transformations.mimeTypes;
}

/** Transformations::getName(): the plugin's display name, '' for unknown files. */
export function getName(file: string): string {
	return transformations.plugins[file]?.name ?? '';
}

/** Transformations::getDescription(). */
export function getDescription(file: string): string {
	return transformations.plugins[file]?.description ?? '';
}

/** Transformations::getMime(): needs the column_info table of pmadb, so it is always null in production. */
export function getMime(): null {
	return null;
}

/** Transformations::fixUpMime(): "image_jpeg" becomes "Image_JPEG". */
export function fixUpMime(value: string): string {
	const upper = value.replaceAll('jpeg', 'JPEG').replaceAll('png', 'PNG');
	const spaced = upper.replaceAll(/([0-9_]+)/g, '$1 ');
	return spaced.replaceAll(/(^|[ \t\r\n\f\v])([a-z])/g, (_match, space: string, letter: string) => space + letter.toUpperCase()).replaceAll(' ', '');
}

// PHP's stripslashes().
const stripSlashes = (value: string): string => value.replaceAll(/\\(.?)/g, (_match, character: string) => (character === '0' ? '\0' : character));

/** Transformations::getOptions(): splits "a, 'b,c', d" into its options, keeping quoted commas. */
export function getOptions(optionString: string): string[] {
	if (optionString === '') {
		return [];
	}
	const parts = optionString.split(',');
	const result: string[] = [];
	for (let option = parts.shift(); option !== undefined; option = parts.shift()) {
		let value = option;
		const trimmed = option.trim();
		if (trimmed.length > 1 && trimmed.startsWith('\'') && trimmed.endsWith('\'')) {
			value = trimmed.slice(1, -1);
		} else if (trimmed.startsWith('\'')) {
			let joined = option.trimStart();
			let rtrimmed = '';
			for (let next = parts.shift(); next !== undefined; next = parts.shift()) {
				joined += `,${next}`;
				rtrimmed = joined.trimEnd();
				if (rtrimmed.endsWith('\'')) {
					break;
				}
			}
			value = rtrimmed.slice(1, -1);
		}
		result.push(stripSlashes(value));
	}
	return result;
}
