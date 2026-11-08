// The parts of PHP's XMLWriter (libxml2's xmlTextWriter with indenting on) that the SVG and Dia schema exporters use.

type NodeState = 'name' | 'text';

interface OpenNode {
	name: string;
	state: NodeState;
}

/** xmlBufAttrSerializeTxtContent(): attribute values escape quotes and whitespace controls too. */
function escapeAttribute(value: string): string {
	return value.replaceAll(/[&<>"\n\r\t]/g, (character) => {
		const entities: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\n': '&#10;', '\r': '&#13;', '\t': '&#9;' };
		return entities[character];
	});
}

/** xmlEncodeSpecialChars(): what XMLWriter::text() escapes. */
function escapeText(value: string): string {
	return value.replaceAll(/[&<>"\r]/g, (character) => {
		const entities: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\r': '&#13;' };
		return entities[character];
	});
}

export class XmlWriter {
	private output = '';
	private readonly nodes: OpenNode[] = [];
	private doIndent = true;

	constructor(private readonly indentString = ' '.repeat(3)) {}

	private writeIndent(): void {
		this.output += this.indentString.repeat(this.nodes.length - 1);
	}

	/** Closes the start tag of the innermost element before content goes into it. */
	private closeStartTag(newline: boolean): void {
		const current = this.nodes.at(-1);
		if (current?.state === 'name') {
			this.output += newline ? '>\n' : '>';
			current.state = 'text';
		}
	}

	startDocument(): void {
		this.output += '<?xml version="1.0" encoding="UTF-8"?>\n';
	}

	/** startDtd() and endDtd() with a public and a system id. */
	writeDtd(name: string, publicId: string, systemId: string): void {
		this.output += `<!DOCTYPE ${name}\nPUBLIC "${publicId}"\n       "${systemId}">\n`;
	}

	startElement(name: string): void {
		this.closeStartTag(true);
		this.nodes.push({ name, state: 'name' });
		this.writeIndent();
		this.output += `<${name}`;
	}

	writeAttribute(name: string, value: string): void {
		this.output += ` ${name}="${escapeAttribute(value)}"`;
	}

	text(content: string): void {
		this.writeRaw(escapeText(content));
	}

	writeRaw(content: string): void {
		this.closeStartTag(false);
		this.doIndent = false;
		this.output += content;
	}

	endElement(): void {
		const current = this.nodes.at(-1);
		if (current === undefined) {
			return;
		}
		if (current.state === 'name') {
			this.doIndent = true;
			this.output += '/>';
		} else {
			if (this.doIndent) {
				this.writeIndent();
			}
			this.doIndent = true;
			this.output += `</${current.name}>`;
		}
		this.output += '\n';
		this.nodes.pop();
	}

	/** endDocument(): closes whatever is still open. */
	endDocument(): void {
		while (this.nodes.length > 0) {
			this.endElement();
		}
	}

	flush(): string {
		const result = this.output;
		this.output = '';
		return result;
	}
}
