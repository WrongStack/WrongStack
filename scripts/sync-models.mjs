import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * Helper for maintaining the curated model-catalog overlay
 * (`packages/cli/data/providers.json`) that WrongStack deep-merges on top of
 * models.dev. The overlay is a small *override layer*, not a mirror — this
 * script does NOT regenerate it from upstream. It helps you author and audit
 * entries against the live catalog:
 *
 *   bun scripts/sync-models.mjs --validate                 (default)
 *   bun scripts/sync-models.mjs --diff
 *   bun scripts/sync-models.mjs --extract deepseek
 *   bun scripts/sync-models.mjs --extract deepseek:deepseek-v4-pro
 *
 * Run via: bun run sync:models -- <flags>
 *
 * `--validate` also asserts the SHIPPED file passes the registry's own payload
 * shape gate (`looksLikeModelsPayload(payload, false)`, the exact check
 * `DefaultModelsRegistry.loadOverlayFromUrl` applies to the GitHub-raw overlay).
 * A file that passes the local structural checks but fails that gate is served
 * as base-only, silently: the gate is what decides whether the curated data
 * ever reaches a client, so the local checks alone can say "valid" about an
 * overlay the runtime will throw away.
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

/**
 * The registry's own payload shape gate — `looksLikeModelsPayload`, the exact
 * predicate `DefaultModelsRegistry.loadOverlayFromUrl` runs on the GitHub-raw
 * overlay before it is cached or merged. Loaded from source so this check can
 * never drift from the runtime rule it is guarding.
 */
async function loadShapeGate() {
  const gatePath = resolve(repoRoot, 'packages/core/src/models/models-registry-normalization.ts');
  const mod = await import(pathToFileURL(gatePath).href);
  if (typeof mod.looksLikeModelsPayload !== 'function') {
    throw new Error(`${gatePath} does not export looksLikeModelsPayload`);
  }
  return mod.looksLikeModelsPayload;
}

function jsonType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/**
 * Which entries make the gate reject the payload. Asked one entry at a time so
 * the diagnosis follows the gate's own rules instead of restating them here —
 * if the predicate changes, the culprit list changes with it.
 */
function findGateRejections(looksLikeModelsPayload, overlay) {
  return Object.entries(overlay)
    .filter(([id, entry]) => !looksLikeModelsPayload({ [id]: entry }, false))
    .map(([id, entry]) => ({ id, type: jsonType(entry) }));
}

/**
 * Fail loudly if the runtime would throw this overlay away.
 *
 * The local checks below only assert the file is well-formed JSON of roughly
 * the right shape. The registry decides a payload's fate with
 * `looksLikeModelsPayload`, and a rejected overlay is dropped without a
 * client-visible error: `loadOverlayFromUrl` treats the invalid shape as an
 * overlay outage, so every client keeps serving the models.dev base alone and
 * curated providers/models silently stop arriving until the next release.
 */
async function assertPassesRegistryShapeGate(overlay) {
  let looksLikeModelsPayload;
  try {
    looksLikeModelsPayload = await loadShapeGate();
  } catch (err) {
    console.error(
      `✗ cannot load the registry shape gate: ${err.message}\n` +
        '  Run this script with the repo runtime: bun run sync:models -- --validate',
    );
    process.exit(1);
  }

  // The gate rejects an empty payload, but an empty overlay is a documented
  // no-op (`hasEntries` keeps the base catalog in charge), so it is a warning.
  if (Object.keys(overlay).length === 0) {
    console.warn('⚠ overlay is empty — the runtime merges nothing (base catalog only).');
    return;
  }

  // `requireModels = false`, exactly as the overlay fetch calls it: overlays
  // may be partial diffs, so the gate does not demand a `models` map.
  if (looksLikeModelsPayload(overlay, false)) return;

  const rejected = findGateRejections(looksLikeModelsPayload, overlay);
  console.error('✗ the registry REJECTS this overlay — clients would be served base-only.');
  console.error('  Gate: looksLikeModelsPayload(payload, false) in');
  console.error('        packages/core/src/models/models-registry-normalization.ts');
  console.error(
    `  Rejected entry/entries (${rejected.length}): ` +
      rejected.map((r) => `"${r.id}" (${r.type})`).join(', '),
  );
  console.error(
    '  Every top-level entry must be a non-array object; a top-level array or\n' +
      '  scalar (e.g. the `_removeProviders` directive) fails the whole payload.\n' +
      '  `loadOverlayFromUrl` reads that rejection as an overlay outage and falls\n' +
      '  back to the stale cache, then the bundled file — so this file never\n' +
      '  reaches a client as a live overlay.',
  );
  process.exit(1);
}

async function validate(overlay) {
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
  if (problems !== 0) {
    console.error(`✗ ${problems} problem(s) found`);
    process.exit(1);
  }

  // The local checks above say the file is well-formed; this one says the
  // runtime will actually accept it. Order matters: the registry gate is the
  // check that decides whether curated data reaches a client.
  await assertPassesRegistryShapeGate(overlay);

  const providers = Object.keys(overlay).filter((id) => !id.startsWith('_')).length;
  const models = Object.values(overlay).reduce(
    (n, p) => n + Object.keys(p?.models ?? {}).length,
    0,
  );
  console.log(
    `✓ overlay valid — ${providers} provider(s), ${models} model override(s), ` +
      'accepted by the registry shape gate',
  );
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
    await validate(overlay);
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
