import { describe, expect, it } from 'vitest';

import { formatChangelog } from './changelog.ts';

describe('formatChangelog', () => {
	it('links issues, releases, advisories and FAQ entries through url.php', () => {
		const html = formatChangelog([
			'5.2.3 (2025-10-07)',
			'- issue #19548 Fix <b> in https://example.org/x_y',
			'- issue PMASA-2025-1 and CVE-2025-1234, see FAQ 1.34',
			'5.2.0.1 (2022-05-10)',
			'4.0.0.0 (2013-05-03)',
			'    ### Highlights',
			'2001-02-03 Jane Doe  <jane@example.org>',
		].join('\n'));
		expect(html).toContain('<a target="_blank" rel="noopener noreferrer" href="url.php?url=https://github.com/phpmyadmin/phpmyadmin/issues/19548">issue #19548</a> Fix &lt;b&gt;');
		expect(html).toContain('href="url.php?url=https://example.org/x_y">https://example.org/x_y</a>');
		expect(html).toContain('href="url.php?url=https://www.phpmyadmin.net/security/PMASA-2025-1/">PMASA-2025-1</a>');
		expect(html).toContain('href="url.php?url=https://www.cve.org/CVERecord?id=CVE-2025-1234">CVE-2025-1234</a>');
		expect(html).toContain('href="url.php?url=https://docs.phpmyadmin.net/en/latest/faq.html#faq1-34">FAQ 1.34</a>');
		expect(html).toContain('<a id="5_2_0_1"></a><a target="_blank" rel="noopener noreferrer" href="url.php?url=https://github.com/phpmyadmin/phpmyadmin/commits/RELEASE_5_2_0_1">5.2.0.1 (2022-05-10)</a>');
		expect(html).toContain('<a id="4_0_0"></a>');
		expect(html).toContain('    ### <b>Highlights</b>');
		expect(html).toContain('2001-02-03 <a target="_blank" rel="noopener noreferrer" href="mailto:jane@example.org">Jane Doe</a>');
	});
});
