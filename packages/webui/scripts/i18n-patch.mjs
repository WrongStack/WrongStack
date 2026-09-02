// i18n-patch.mjs — merge new translation keys into locale JSON files.
//
// Usage: node i18n-patch.mjs <spec.json> [--dry-run]
//
// spec.json shape (deep-merged into each locales/<lang>/<ns>.json):
// {
//   "<namespace>": {
//     "<lang>": {
//       "<group>": { "<key>": "<value>" }   // nested groups supported
//     }
//   }
// }
//
// Existing keys keep their position; new keys/groups are appended.
// Files are rewritten with 2-space indent + trailing newline (matches biome).
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOCALES = resolve(__dirname, '../src/i18n/locales');
const LANGS = ['en', 'tr', 'de', 'fr', 'it', 'es', 'pt-BR'];

const specPath = process.argv[2];
const dryRun = process.argv.includes('--dry-run');
if (!specPath) {
  console.error('usage: i18n-patch.mjs <spec.json>');
  process.exit(1);
}

/** Deep-merge `src` into `dst` (append-only: never overwrites a string with undefined). */
function deepMerge(dst, src) {
  for (const [k, v] of Object.entries(src)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      if (typeof dst[k] !== 'object' || dst[k] === null) dst[k] = {};
      deepMerge(dst[k], v);
    } else {
      dst[k] = v;
    }
  }
  return dst;
}

const spec = JSON.parse(readFileSync(specPath, 'utf8'));
let changed = 0;

for (const [ns, byLang] of Object.entries(spec)) {
  for (const lang of LANGS) {
    const additions = byLang[lang];
    if (!additions) continue;
    const file = resolve(LOCALES, lang, `${ns}.json`);
    const original = readFileSync(file, 'utf8');
    const obj = JSON.parse(original);
    const before = JSON.stringify(obj);
    deepMerge(obj, additions);
    if (JSON.stringify(obj) === before) continue; // nothing new
    if (!dryRun) writeFileSync(file, `${JSON.stringify(obj, null, 2)}\n`);
    changed++;
    console.log(`  patched ${lang}/${ns}.json`);
  }
}

console.log(
  `${dryRun ? '[dry-run] ' : ''}${changed} file(s) ${dryRun ? 'would change' : 'patched'}`,
);
