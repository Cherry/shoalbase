// A small strict XML reader with the SimpleXML views the ODS and XML imports rely on.

export interface XmlElement {
	/** The qualified name, such as "table:table-row". */
	name: string;
	prefix: string | null;
	localName: string;
	attributes: Map<string, string>;
	children: (XmlElement | string)[];
}

const PREDEFINED: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: '\'' };
// A name starts with anything but a digit, space or markup character and goes on until space or markup.
const NAME = /^[^\s\d.<>/=!"'?&;-][^\s<>/=!"'?&;]*/;

class Malformed extends Error {}

function codePoint(value: number, valid: boolean): string {
	if (!valid || value === 0 || value > 0x10_FF_FF || (value >= 0xD8_00 && value <= 0xDF_FF)) {
		throw new Malformed('bad character reference');
	}
	return String.fromCodePoint(value);
}

function decodeEntities(text: string): string {
	return text.replaceAll(/&([^;&]*);|&/g, (match, entity: string | undefined) => {
		if (entity === undefined) {
			throw new Malformed('bare ampersand');
		}
		if (entity.startsWith('#x')) {
			return codePoint(Number.parseInt(entity.slice(2), 16), /^#x[\da-f]+$/i.test(entity));
		}
		if (entity.startsWith('#')) {
			return codePoint(Number.parseInt(entity.slice(1), 10), /^#\d+$/.test(entity));
		}
		const value = PREDEFINED[entity];
		if (value === undefined) {
			throw new Malformed(`undefined entity ${match}`);
		}
		return value;
	});
}


function element(name: string): XmlElement {
	const colon = name.indexOf(':');
	return {
		name,
		prefix: colon === -1 ? null : name.slice(0, colon),
		localName: colon === -1 ? name : name.slice(colon + 1),
		attributes: new Map(),
		children: [],
	};
}


function parseDocument(text: string): XmlElement {
	let position = 0;
	let root: XmlElement | null = null;
	const stack: XmlElement[] = [];
	const skip = (pattern: string, end: string): void => {
		const close = text.indexOf(end, position + pattern.length);
		if (close === -1) {
			throw new Malformed(`unterminated ${pattern}`);
		}
		position = close + end.length;
	};
	function skipDoctype(): void {
		let depth = 0;
		for (let index = position; index < text.length; index++) {
			if (text[index] === '[') {
				depth++;
			} else if (text[index] === ']') {
				depth--;
			} else if (text[index] === '>' && depth === 0) {
				position = index + 1;
				return;
			}
		}
		throw new Malformed('unterminated declaration');
	}

	function openTag(): { element: XmlElement; selfClosing: boolean; } {
		position++;
		const name = NAME.exec(text.slice(position, position + 1000))?.[0];
		if (name === undefined) {
			throw new Malformed('bad element name');
		}
		position += name.length;
		const result = element(name);
		for (;;) {
			const space = (/^\s*/.exec(text.slice(position, position + 1000)) as RegExpExecArray)[0];
			position += space.length;
			if (text.startsWith('/>', position)) {
				position += 2;
				return { element: result, selfClosing: true };
			}
			if (text[position] === '>') {
				position++;
				return { element: result, selfClosing: false };
			}
			const attribute = /^([^\s=/>]+)\s*=\s*(["'])/.exec(text.slice(position, position + 1000));
			if (attribute === null || space === '' || !NAME.test(attribute[1]) || result.attributes.has(attribute[1])) {
				throw new Malformed('bad attribute');
			}
			position += attribute[0].length;
			const close = text.indexOf(attribute[2], position);
			const raw = close === -1 ? '' : text.slice(position, close);
			if (close === -1 || raw.includes('<')) {
				throw new Malformed('bad attribute value');
			}
			result.attributes.set(attribute[1], decodeEntities(raw.replaceAll(/[\t\n]/g, ' ')));
			position = close + 1;
		}
	}
	while (position < text.length) {
		const open = text.indexOf('<', position);
		const chunk = text.slice(position, open === -1 ? text.length : open);
		if (chunk !== '') {
			if (stack.length === 0) {
				if (chunk.trim() !== '') {
					throw new Malformed('text outside the root element');
				}
			} else {
				(stack.at(-1) as XmlElement).children.push(decodeEntities(chunk));
			}
		}
		if (open === -1) {
			break;
		}
		position = open;
		if (text.startsWith('<?', position)) {
			skip('<?', '?>');
		} else if (text.startsWith('<!--', position)) {
			skip('<!--', '-->');
		} else if (text.startsWith('<![CDATA[', position)) {
			if (stack.length === 0) {
				throw new Malformed('CDATA outside the root element');
			}
			const close = text.indexOf(']]>', position);
			if (close === -1) {
				throw new Malformed('unterminated CDATA');
			}
			(stack.at(-1) as XmlElement).children.push(text.slice(position + 9, close));
			position = close + 3;
		} else if (text.startsWith('<!', position)) {
			if (root !== null || stack.length > 0) {
				throw new Malformed('declaration inside the document');
			}
			skipDoctype();
		} else if (text.startsWith('</', position)) {
			const match = /^<\/([^\s>]+)\s*>/.exec(text.slice(position));
			const current = stack.pop();
			if (match === null || current === undefined || current.name !== match[1]) {
				throw new Malformed('mismatched end tag');
			}
			position += match[0].length;
		} else {
			const opened = openTag();
			if (stack.length === 0) {
				if (root !== null) {
					throw new Malformed('second root element');
				}
				root = opened.element;
			} else {
				(stack.at(-1) as XmlElement).children.push(opened.element);
			}
			if (!opened.selfClosing) {
				stack.push(opened.element);
			}
		}
	}
	if (root === null || stack.length > 0) {
		throw new Malformed('incomplete document');
	}
	return root;
}

/** simplexml_load_string(): the root element, or null when the document is not well-formed. */
export function parseXml(source: string): XmlElement | null {
	const text = source.replaceAll(/\r\n?/g, '\n');
	try {
		return parseDocument(text);
	} catch {
		return null;
	}
}

/** $element->children($prefix, true): child elements with that prefix, null for none. */
export function childrenOf(parent: XmlElement, prefix: string | null): XmlElement[] {
	return parent.children.filter((child): child is XmlElement => typeof child !== 'string' && child.prefix === prefix);
}

/** $element->{name} in a namespace context: the first matching child, or undefined. */
export function childNamed(parent: XmlElement, prefix: string | null, localName: string): XmlElement | undefined {
	return childrenOf(parent, prefix).find(child => child.localName === localName);
}

/** (string) $element: only the element's own text, not its descendants'. */
export function directText(node: XmlElement): string {
	return node.children.filter(child => typeof child === 'string').join('');
}

/** $element->attributes($prefix, true)[$name], '' when absent. */
export function attributeOf(node: XmlElement, prefix: string | null, localName: string): string {
	return node.attributes.get(prefix === null ? localName : `${prefix}:${localName}`) ?? '';
}

/** Whether getNamespaces(true) would list the prefix: it is declared and used by an element or attribute. */
export function usesPrefix(root: XmlElement, prefix: string): boolean {
	let declared = false;
	let used = false;
	const visit = (node: XmlElement): void => {
		declared ||= node.attributes.has(`xmlns:${prefix}`);
		used ||= node.prefix === prefix || node.attributes.keys().some(name => name.startsWith(`${prefix}:`));
		for (const child of node.children) {
			if (typeof child !== 'string') {
				visit(child);
			}
		}
	};
	visit(root);
	return declared && used;
}
