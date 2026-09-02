#!/usr/bin/env node
/**
 * Subcommand manifest generator + docs parity checker.
 *
 * Reads the CLI subcommand registration (packages/cli/src/subcommands/index.ts)
 * and the help table (per-subcommand-help-table.ts) to produce:
 *
 * 1. A machine-readable manifest JSON (subcommands-manifest.json)
 * 2. A parity report showing loaders without help entries and vice versa
 *
 * Exit code 0 = full parity, 1 = gaps found.
 *
 * Usage:
 *   node scripts/generate-subcommand-manifest.mjs           # check + report
 *   node scripts/generate-subcommand-manifest.mjs --write   # write manifest JSON
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

// ── Extract subcommand names from the loaders map ────────────────────
const indexPath = join(root, 'packages/cli/src/subcommands/index.ts');
const indexSrc = readFileSync(indexPath, 'utf8');

// Parse loader keys from the `loaders: Record<string, SubcommandLoader>` block
const loaderMatches = [...indexSrc.matchAll(/^\s+(\w+):\s+async\s+\(\)\s*=>/gm)];
const loaderNames = loaderMatches.map((m) => m[1]);

// Extract handler module path for each loader
const handlerMap = {};
for (const match of indexSrc.matchAll(
  /^\s+(\w+):\s+async\s+\(\)\s*=>\s*\(await\s+import\('([^']+)'\)\)\.(\w+),?/gm,
)) {
  handlerMap[match[1]] = { module: match[2], export: match[3] };
}

// ── Extract help table entries ───────────────────────────────────────
const helpTablePath = join(
  root,
  'packages/cli/src/subcommands/handlers/per-subcommand-help-table.ts',
);
const helpSrc = readFileSync(helpTablePath, 'utf8');

const helpMatches = [...helpSrc.matchAll(/^\s{2}(\w+):\s*\{/gm)];
const helpNames = helpMatches.map((m) => m[1]);

// ── Deep help entries ────────────────────────────────────────────────
const deepHelpPath = join(
  root,
  'packages/cli/src/subcommands/handlers/per-subcommand-deep-help-table.ts',
);
const deepSrc = readFileSync(deepHelpPath, 'utf8');
const deepMatches = [...deepSrc.matchAll(/^\s{2}['"]([^'"]+)['"]:\s*\{/gm)];
const deepNames = deepMatches.map((m) => m[1]);

// ── Parity analysis ──────────────────────────────────────────────────
const loaderSet = new Set(loaderNames);
const helpSet = new Set(helpNames);

const loadersWithoutHelp = loaderNames.filter((n) => !helpSet.has(n));
const helpWithoutLoaders = helpNames.filter((n) => !loaderSet.has(n));

// ── Build manifest ───────────────────────────────────────────────────
const manifest = {
  generatedAt: new Date().toISOString(),
  totalLoaders: loaderNames.length,
  totalHelpEntries: helpNames.length,
  totalDeepHelpEntries: deepNames.length,
  subcommands: loaderNames.map((name) => ({
    name,
    handler: handlerMap[name] ?? { module: '(unknown)', export: '(unknown)' },
    hasHelp: helpSet.has(name),
    deepHelpEntries: deepNames.filter((d) => d.startsWith(`${name}:`)),
  })),
  parity: {
    loadersWithoutHelp,
    helpWithoutLoaders,
    isComplete: loadersWithoutHelp.length === 0 && helpWithoutLoaders.length === 0,
  },
};

// ── Output ───────────────────────────────────────────────────────────
const writeFlag = process.argv.includes('--write');

if (writeFlag) {
  const outPath = join(root, 'architecture/subcommands-manifest.json');
  writeFileSync(outPath, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`Manifest written to ${outPath}`);
}

// Report
console.log(`\nSubcommand Manifest Report`);
console.log(`${'='.repeat(50)}`);
console.log(`Loaders: ${loaderNames.length}`);
console.log(`Help entries: ${helpNames.length}`);
console.log(`Deep help entries: ${deepNames.length}`);

if (loadersWithoutHelp.length > 0) {
  console.log(`\n⚠  Loaders WITHOUT help entries (${loadersWithoutHelp.length}):`);
  for (const name of loadersWithoutHelp) {
    console.log(`   - ${name}`);
  }
}

if (helpWithoutLoaders.length > 0) {
  console.log(`\n⚠  Help entries WITHOUT loaders (${helpWithoutLoaders.length}):`);
  for (const name of helpWithoutLoaders) {
    console.log(`   - ${name}`);
  }
}

if (manifest.parity.isComplete) {
  console.log('\n✅  Full parity — every loader has a help entry.');
  process.exit(0);
} else {
  console.log(`\n❌  Parity gaps found.`);
  process.exit(1);
}
