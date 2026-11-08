import { describe, expect, it } from 'vitest';

import { getSchemaPlugins } from './schema-plugins.ts';
import { getChoice, getOptions } from '../export-import/properties.ts';

const request = { get: {}, request: {}, timeoutPassed: false, section: { format: 'pdf', pdf_show_color: true, pdf_paper: 'A4', svg_show_keys: false } };

describe('getSchemaPlugins', () => {
	it('lists the four schema formats in directory order, PDF picked by default', () => {
		const choice = getChoice(getSchemaPlugins(['A4']), 'pdf');
		expect(choice.map(option => [option.name, option.text, option.is_selected])).toEqual([
			['dia', 'Dia', false],
			['eps', 'EPS', false],
			['pdf', 'PDF', true],
			['svg', 'SVG', false],
		]);
	});

	it('gives every format the common options and only Dia and PDF a paper size from the configuration', () => {
		const html = getOptions(request, getSchemaPlugins(['A4', 'legal']));
		for (const format of ['dia', 'eps', 'pdf', 'svg']) {
			expect(html).toContain(`name="${format}_show_color"`);
			expect(html).toContain(`name="${format}_show_keys"`);
		}
		expect(html).toContain('name="dia_paper"');
		expect(html).toContain('name="pdf_paper"');
		expect(html).not.toContain('name="eps_paper"');
		expect(html).toContain('<option value="legal"');
		expect(html).toContain('name="pdf_table_order"');
		expect(html).not.toContain('name="dia_all_tables_same_width"');
	});
});
