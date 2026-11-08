// Adds a small "via Shoalbase" credit under phpMyAdmin's logos, so users can tell this port from phpMyAdmin itself.
// It is applied on the Worker's way out, so the rendering code that the parity diffs compare stays byte for byte.
const MARK = '<a class="shoalbase-mark" href="https://shoalbase.dev/" target="_blank" rel="noopener noreferrer" style="display: block; margin-top: 2px; text-align: center; font-size: 11px; line-height: 1.5; color: inherit; opacity: 0.6; text-decoration: none;">via Shoalbase</a>';

export function withShoalbaseMark(response: Response): Response {
	const type = response.headers.get('Content-Type') ?? '';
	// AJAX pages arrive as JSON and keep the navigation panel of the full page they were loaded into, so only full pages need it.
	if (!type.startsWith('text/html') || typeof HTMLRewriter === 'undefined') {
		return response;
	}
	return new HTMLRewriter()
		.on('#pmalogo', {
			element(element) {
				element.append(MARK, { html: true });
			},
		})
		// The login logo is a link itself, so the credit goes after it rather than inside.
		.on('a.logo', {
			element(element) {
				element.after(MARK, { html: true });
			},
		})
		.transform(response);
}
