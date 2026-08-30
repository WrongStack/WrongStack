import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Helper for maintaining the curated model-catalog overlay
 * (`packages/cli/data/providers.json`) that WrongStack deep-merges on top of
 * models.dev. The overlay is a small *override layer*, not a mirror — this
 * script does NOT regenerate it from upstream. It helps you author and audit
 * entries against the live catalog:
 *
 *   node scripts/sync-models.mjs --validate                 (default)
 *   node scripts/sync-models.mjs --diff
 *   node scripts/sync-models.mjs --extract deepseek
 *   node scripts/sync-models.mjs --extract deepseek:deepseek-v4-pro
 *
 * Run via: pnpm run sync:models -- <flags>
 */

const MODELS_DEV_URL = 'https://models.dev/api.json';
const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const OVERLAY_PATH = resolve(repoRoot, 'packages/cli/data/providers.json');

function parseArgs(argv) {
  const out = { mode: 'validate', target: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--diff') out.mode = 'diff';
    else if (a === '--validate') out.mode = 'validate';
    else if (a === '--extract') {
      out.mode = 'extract';
      out.target = argv[++i];
    }
  }
  return out;
}

function readOverlay() {
  if (!existsSync(OVERLAY_PATH)) {
    console.error(`overlay not found: ${OVERLAY_PATH}`);
    process.exit(1);
  }
  try {
    return JSON.parse(readFileSync(OVERLAY_PATH, 'utf8'));
  } catch (err) {
    console.error(`overlay is not valid JSON: ${err.message}`);
    process.exit(1);
  }
}

async function fetchUpstream() {
  const res = await fetch(MODELS_DEV_URL, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${MODELS_DEV_URL}`);
  return res.json();
}

function validate(overlay) {
  let problems = 0;
  for (const [pid, p] of Object.entries(overlay)) {
    if (typeof p !== 'object' || p === null) {
      console.error(`✗ provider "${pid}" is not an object`);
      problems++;
      continue;
    }
    if (p.models && typeof p.models === 'object') {
      for (const [mid, m] of Object.entries(p.models)) {
        if (typeof m !== 'object' || m === null) {
          console.error(`✗ ${pid}.${mid} is not an object`);
          problems++;
        }
      }
    }
  }
  const providers = Object.keys(overlay).length;
  const models = Object.values(overlay).reduce(
    (n, p) => n + Object.keys(p.models ?? {}).length,
    0,
  );
  if (problems === 0) {
    console.log(`✓ overlay valid — ${providers} provider(s), ${models} model override(s)`);
  } else {
    console.error(`✗ ${problems} problem(s) found`);
    process.exit(1);
  }
}

function diff(overlay, upstream) {
  const overrides = [];
  const additions = [];
  const redundant = [];
  for (const [pid, p] of Object.entries(overlay)) {
    const up = upstream[pid];
    if (!up) {
      additions.push(`+ provider ${pid} (not in models.dev)`);
      continue;
    }
    for (const [mid, m] of Object.entries(p.models ?? {})) {
      const upModel = up.models?.[mid];
      if (!upModel) {
        additions.push(`+ model ${pid}:${mid} (not in models.dev)`);
        continue;
      }
      // Compare only the fields the overlay sets.
      const changed = [];
      let allEqual = true;
      for (const [k, v] of Object.entries(m)) {
        if (k === 'id' || k === 'name') continue;
        if (JSON.stringify(v) !== JSON.stringify(upModel[k])) {
          changed.push(k);
          allEqual = false;
        }
      }
      if (changed.length) overrides.push(`~ ${pid}:${mid} overrides [${changed.join(', ')}]`);
      if (allEqual && Object.keys(m).some((k) => k !== 'id' && k !== 'name')) {
        redundant.push(`= ${pid}:${mid} matches models.dev — overlay is redundant, can drop`);
      }
    }
  }
  const lines = [...additions, ...overrides, ...redundant];
  if (lines.length === 0) console.log('overlay is empty (no-op).');
  else console.log(lines.join('\n'));
}

function extract(upstream, target) {
  if (!target) {
    console.error('usage: --extract <providerId>[:<modelId>]');
    process.exit(1);
  }
  const idx = target.indexOf(':');
  const pid = idx === -1 ? target : target.slice(0, idx);
  const mid = idx === -1 ? undefined : target.slice(idx + 1);
  const p = upstream[pid];
  if (!p) {
    console.error(`provider "${pid}" not found in models.dev`);
    process.exit(1);
  }
  let snippet;
  if (mid) {
    const m = p.models?.[mid];
    if (!m) {
      console.error(`model "${mid}" not found under "${pid}"`);
      process.exit(1);
    }
    snippet = { [pid]: { id: p.id, name: p.name, npm: p.npm, models: { [mid]: m } } };
  } else {
    snippet = {
      [pid]: { id: p.id, name: p.name, npm: p.npm, api: p.api, env: p.env, models: p.models },
    };
  }
  console.log('// paste into packages/cli/data/providers.json and trim to the fields you want:');
  console.log(JSON.stringify(snippet, null, 2));
}

async function main() {
  const { mode, target } = parseArgs(process.argv.slice(2));
  const overlay = mode === 'extract' ? {} : readOverlay();
  if (mode === 'validate') {
    validate(overlay);
    return;
  }
  const upstream = await fetchUpstream();
  if (mode === 'diff') diff(overlay, upstream);
  else if (mode === 'extract') extract(upstream, target);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
