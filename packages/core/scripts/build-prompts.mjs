#!/usr/bin/env node
/**
 * build-prompts.mjs — compile the curated builtin prompt dataset.
 *
 * Reads human/agent-authored seeds from `data/prompts/_seed/<category>.jsonl`
 * (one JSON object per line) and emits, deterministically:
 *   - `data/prompts/prompts/<category>/<slug>.json`  — one bare PromptEntry each
 *   - `data/prompts/index.json`                       — manifest (counts + refs)
 *
 * Deterministic by design (no Date.now / no randomness): builtin `id === slug`
 * and timestamps are a fixed dataset epoch, so re-running produces byte-identical
 * output and never churns git. Bump DATASET_VERSION + DATASET_DATE when the
 * dataset meaningfully changes.
 *
 * Zero dependencies — runs on plain Node. `pnpm --filter @wrongstack/core build:prompts`.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const DATASET_VERSION = 1;
const DATASET_DATE = '2026-01-01T00:00:00.000Z';

// Keep in sync with BUILTIN_PROMPT_CATEGORIES in src/types/prompt.ts
// (the dataset test cross-checks every category against that source of truth).
const CATEGORIES = [
  'coding',
  'debugging',
  'refactoring',
  'testing',
  'code-review',
  'architecture',
  'performance',
  'devops',
  'documentation',
  'data-analysis',
  'writing',
  'research',
  'product',
  'agentic-workflows',
  'meta-prompting',
];

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(here, '..', 'data', 'prompts');
const seedDir = path.join(dataDir, '_seed');
const outDir = path.join(dataDir, 'prompts');

function slugify(name) {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64)
      .replace(/-+$/g, '') || 'prompt'
  );
}

function checksum(content) {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function fail(msg) {
  console.error(`[build-prompts] ERROR: ${msg}`);
  process.exit(1);
}

function normalizeVariables(raw, slug) {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) fail(`${slug}: variables must be an array`);
  const out = [];
  for (const v of raw) {
    if (!v || typeof v.name !== 'string' || !v.name) fail(`${slug}: each variable needs a name`);
    const entry = { name: v.name };
    if (typeof v.description === 'string') entry.description = v.description;
    if (typeof v.default === 'string') entry.default = v.default;
    if (v.required === true) entry.required = true;
    if (Array.isArray(v.enum) && v.enum.length > 0) {
      if (!v.enum.every((x) => typeof x === 'string'))
        fail(`${slug}: variable ${v.name} enum must be strings`);
      entry.enum = v.enum;
    }
    if (v.multiline === true) entry.multiline = true;
    out.push(entry);
  }
  return out;
}

function main() {
  if (!fs.existsSync(seedDir)) fail(`seed dir not found: ${seedDir}`);

  // Clean output dir so deleted seeds don't leave stale files behind.
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  const seenSlugs = new Set();
  const entries = [];

  for (const category of CATEGORIES) {
    const seedFile = path.join(seedDir, `${category}.jsonl`);
    if (!fs.existsSync(seedFile)) continue;
    const lines = fs.readFileSync(seedFile, 'utf8').split('\n');
    let lineNo = 0;
    for (const line of lines) {
      lineNo++;
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('//')) continue;
      let obj;
      try {
        obj = JSON.parse(trimmed);
      } catch (err) {
        fail(`${category}.jsonl:${lineNo}: invalid JSON — ${err.message}`);
      }
      if (typeof obj.title !== 'string' || !obj.title)
        fail(`${category}.jsonl:${lineNo}: missing title`);
      if (typeof obj.description !== 'string' || !obj.description)
        fail(`${category}.jsonl:${lineNo}: missing description`);
      if (typeof obj.content !== 'string' || !obj.content)
        fail(`${category}.jsonl:${lineNo}: missing content`);
      const tags = Array.isArray(obj.tags) ? obj.tags.filter((t) => typeof t === 'string') : [];
      const slug = obj.slug ? slugify(obj.slug) : slugify(obj.title);
      if (seenSlugs.has(slug)) fail(`duplicate slug "${slug}" (from ${category}.jsonl:${lineNo})`);
      seenSlugs.add(slug);

      const entry = {
        id: slug, // deterministic + unique; loaders dedup by slug anyway
        slug,
        title: obj.title,
        description: obj.description,
        content: obj.content,
        category,
        tags,
        source: 'builtin',
        favorite: false,
        checksum: checksum(obj.content),
        createdAt: DATASET_DATE,
        updatedAt: DATASET_DATE,
      };
      const variables = normalizeVariables(obj.variables, slug);
      if (variables) entry.variables = variables;
      if (typeof obj.author === 'string') entry.author = obj.author;
      if (typeof obj.version === 'string') entry.version = obj.version;
      if (typeof obj.license === 'string') entry.license = obj.license;

      const catDir = path.join(outDir, category);
      fs.mkdirSync(catDir, { recursive: true });
      const rel = path.posix.join('prompts', category, `${slug}.json`);
      fs.writeFileSync(path.join(catDir, `${slug}.json`), `${JSON.stringify(entry, null, 2)}\n`);
      entries.push({ entry, file: rel });
    }
  }

  if (entries.length === 0) fail('no prompts found in seeds');

  // Build index.json (manifest). Stable ordering: by category, then slug.
  entries.sort((a, b) =>
    a.entry.category === b.entry.category
      ? a.entry.slug.localeCompare(b.entry.slug)
      : a.entry.category.localeCompare(b.entry.category),
  );

  const counts = new Map();
  for (const { entry } of entries)
    counts.set(entry.category, (counts.get(entry.category) ?? 0) + 1);

  const index = {
    datasetVersion: DATASET_VERSION,
    generatedAt: DATASET_DATE,
    count: entries.length,
    categories: [...counts.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([id, count]) => ({ id, label: id, count })),
    prompts: entries.map(({ entry, file }) => ({
      id: entry.id,
      slug: entry.slug,
      title: entry.title,
      description: entry.description,
      category: entry.category,
      tags: entry.tags,
      checksum: entry.checksum,
      file,
    })),
  };
  fs.writeFileSync(path.join(dataDir, 'index.json'), `${JSON.stringify(index, null, 2)}\n`);

  console.log(`[build-prompts] wrote ${entries.length} prompts across ${counts.size} categories.`);
}

main();
