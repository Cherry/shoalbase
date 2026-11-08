import nodecraft from '@nodecraft/eslint-config';
import eslintPluginAstro from 'eslint-plugin-astro';

import type { Linter } from 'eslint';

const jsonIgnore = ['**/*.json'];
const withJsonIgnore = (configs: Linter.Config[]) => configs.map((config) => {
	return {
		...config,
		ignores: [...(config.ignores || []), ...jsonIgnore],
	};
});

export default [
	{
		ignores: ['dist/**', 'dist-bin/**', '.visual-dist/**', 'coverage/**', '.wrangler/**', '.reference/**', '.research-phpmyadmin/**', '**/.astro/**', 'worker-configuration.d.ts', 'src/generated/**', 'vendor/**', 'public/js/**', 'public/doc/**', 'tests/fixtures/**', 'tests/parity-report/**', 'tests/visual/report/**', 'tests/visual/.results/**', 'website/package-lock.json', 'website/node_modules/**', 'website/public/main.js', '**/.dist/**', '**/out/**'],
	},
	...withJsonIgnore(nodecraft.configs.typescript),
	...nodecraft.configs.json,
	...eslintPluginAstro.configs.recommended,
	{
		ignores: jsonIgnore,
		rules: {
			'n/no-unsupported-features/es-syntax': 'off',
			'n/no-missing-import': 'off',
			'n/no-unsupported-features/node-builtins': 'off',
			'@stylistic/no-mixed-operators': 'off',
			'@typescript-eslint/triple-slash-reference': 'off',
		},
	},
] satisfies Linter.Config[];
