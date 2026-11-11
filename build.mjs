// Concatenates src/*.js (in name order) into the installable userscript.
// Usage: node build.mjs   → writes meldkamerspel.user.js
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';

const dir = new URL('./src/', import.meta.url);
const parts = readdirSync(dir)
  .filter((f) => f.endsWith('.js'))
  .sort()
  .map((f) => readFileSync(new URL(f, dir), 'utf8'));
const out = parts.join('').replace(/\n+$/, '') + '\n';
writeFileSync(new URL('./meldkamerspel.user.js', import.meta.url), out);
console.log(`meldkamerspel.user.js: ${out.split('\n').length} lines from ${parts.length} parts`);
