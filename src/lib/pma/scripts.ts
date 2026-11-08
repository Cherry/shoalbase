// Port of PhpMyAdmin\Scripts: the ordered, de-duplicated list of JS files a page loads.

export interface ScriptFile {
	/** Relative to js/dist/, or js/ for "vendor/..." and "messages.php" entries. */
	filename: string;
	/** Query parameters; only used for .php entries such as messages.php. */
	params?: Record<string, string>;
}

/** The shape scripts.twig iterates over. */
export interface ScriptEntry {
	filename: string;
	params: Record<string, string>;
	has_onload: 0 | 1;
}

/** Scripts::hasOnloadEvent(): libraries that never register AJAX.registerOnload() handlers. */
export function hasOnloadEvent(filename: string): boolean {
	return !['jquery', 'codemirror', 'messages.php', 'ajax.js', 'cross_framing_protection.js'].some(part => filename.includes(part));
}

/** Scripts::addFile(): later duplicates and empty names are ignored, so upstream order is kept. */
export function addScriptFile(list: ScriptEntry[], file: ScriptFile): void {
	if (file.filename === '' || list.some(entry => entry.filename === file.filename)) {
		return;
	}
	list.push({
		filename: file.filename,
		params: file.params ?? {},
		has_onload: hasOnloadEvent(file.filename) ? 1 : 0,
	});
}

/** Scripts::getFiles(): the "scripts" list of AJAX page responses, which skips entries with a query string. */
export function getScriptFiles(list: ScriptEntry[]): { name: string; fire: 0 | 1; }[] {
	return list
		.filter(entry => !entry.filename.includes('?'))
		.map((entry) => { return { name: entry.filename, fire: entry.has_onload }; });
}
