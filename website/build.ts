// Strips the types from src/main.ts into public/main.js with Node's own TypeScript support, so the site needs no bundler.
import { readFileSync, writeFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';

const source = readFileSync(new URL('./src/main.ts', import.meta.url), 'utf8');
writeFileSync(new URL('./public/main.js', import.meta.url), stripTypeScriptTypes(source));
