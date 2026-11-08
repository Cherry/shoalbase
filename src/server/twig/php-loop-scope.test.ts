// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { createPmaEnvironment } from './environment';
import { phpScopedNodeExecutor } from './php-loop-scope';
import { createTemplateState } from './state';

async function render(templates: Record<string, string>): Promise<string> {
	const env = createPmaEnvironment({ templates, state: createTemplateState({}) });
	const template = await env.loadTemplate('t.twig');
	return template.render(env, {}, { nodeExecutor: phpScopedNodeExecutor });
}

describe('phpScopedNodeExecutor', () => {
	it('drops variables first set inside a for loop but keeps updates to existing ones, as tbl_chart.twig relies on', async () => {
		const source = '{% set seen = null %}{% for i in [1, 2] %}{% set seen = i %}{% set last = i %}{% endfor %}[{{ seen }}][{{ last }}]';
		expect(await render({ 't.twig': source })).toBe('[2][]');
	});

	it('applies to nested loops and included templates', async () => {
		const templates = {
			't.twig': '{% for a in [1] %}{% for b in [2] %}{% set inner = b %}{% endfor %}[{{ inner }}]{% endfor %}{{ include("i.twig") }}',
			'i.twig': '{% for c in [3] %}{% set leaked = c %}{% endfor %}[{{ leaked }}]',
		};
		expect(await render(templates)).toBe('[][]');
	});
});
