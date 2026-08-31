import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DefaultPromptLoader } from '../../src/execution/prompt-loader.js';
import { promptChecksum } from '../../src/storage/prompt-store.js';
import { BUILTIN_PROMPT_CATEGORIES } from '../../src/types/prompt.js';
import type { JSONSchema } from '../../src/types/tool.js';
import { validateAgainstSchema } from '../../src/utils/json-schema-validate.js';
import { resolveWstackPaths } from '../../src/utils/wstack-paths.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(here, '..', '..', 'data', 'prompts');
const promptsDir = path.join(dataDir, 'prompts');

interface BuiltinIndex {
  datasetVersion: number;
  count: number;
  categories: { id: string; count: number }[];
  prompts: { id: string; slug: string; category: string; checksum: string; file: string }[];
}

function readIndex(): BuiltinIndex {
  return JSON.parse(fs.readFileSync(path.join(dataDir, 'index.json'), 'utf8'));
}

function allPromptFiles(): string[] {
  const out: string[] = [];
  for (const cat of fs.readdirSync(promptsDir)) {
    const catDir = path.join(promptsDir, cat);
    if (!fs.statSync(catDir).isDirectory()) continue;
    for (const f of fs.readdirSync(catDir)) {
      if (f.endsWith('.json')) out.push(path.join(catDir, f));
    }
  }
  return out;
}

describe('builtin prompt dataset', () => {
  const schema = JSON.parse(
    fs.readFileSync(path.join(dataDir, 'schema.json'), 'utf8'),
  ) as JSONSchema;
  const files = allPromptFiles();
  const index = readIndex();

  it('ships at least 100 prompts', () => {
    expect(files.length).toBeGreaterThanOrEqual(100);
    expect(index.count).toBe(files.length);
  });

  it('every prompt file validates against schema.json', () => {
    const failures: string[] = [];
    for (const file of files) {
      const entry = JSON.parse(fs.readFileSync(file, 'utf8'));
      const result = validateAgainstSchema(entry, schema);
      if (!result.ok) {
        failures.push(
          `${path.basename(file)}: ${result.errors.map((e) => `${e.path} ${e.message}`).join('; ')}`,
        );
      }
    }
    expect(failures).toEqual([]);
  });

  it('has unique slugs and ids', () => {
    const slugs = new Set<string>();
    const ids = new Set<string>();
    for (const file of files) {
      const entry = JSON.parse(fs.readFileSync(file, 'utf8'));
      expect(slugs.has(entry.slug), `dup slug ${entry.slug}`).toBe(false);
      expect(ids.has(entry.id), `dup id ${entry.id}`).toBe(false);
      slugs.add(entry.slug);
      ids.add(entry.id);
    }
  });

  it('every checksum matches its content', () => {
    for (const file of files) {
      const entry = JSON.parse(fs.readFileSync(file, 'utf8'));
      expect(entry.checksum, path.basename(file)).toBe(promptChecksum(entry.content));
    }
  });

  it('every category is in the known taxonomy (and not the uncategorized sentinel)', () => {
    const known = new Set(BUILTIN_PROMPT_CATEGORIES.filter((c) => c !== 'uncategorized'));
    for (const file of files) {
      const entry = JSON.parse(fs.readFileSync(file, 'utf8'));
      expect(known.has(entry.category), `${entry.slug} has category ${entry.category}`).toBe(true);
    }
  });

  it('index.json count and category counts match the files on disk', () => {
    const perCat = new Map<string, number>();
    for (const file of files) {
      const entry = JSON.parse(fs.readFileSync(file, 'utf8'));
      perCat.set(entry.category, (perCat.get(entry.category) ?? 0) + 1);
    }
    for (const c of index.categories) {
      expect(c.count, `index count for ${c.id}`).toBe(perCat.get(c.id));
    }
  });

  it('every index ref resolves to an existing file', () => {
    for (const ref of index.prompts) {
      expect(fs.existsSync(path.join(dataDir, ref.file)), ref.file).toBe(true);
    }
  });

  it('declared variables appear as {{placeholders}} in content', () => {
    for (const file of files) {
      const entry = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const v of entry.variables ?? []) {
        expect(
          entry.content.includes(`{{${v.name}}}`),
          `${entry.slug}: variable "${v.name}" not referenced in content`,
        ).toBe(true);
      }
    }
  });

  it('ships the Elite Bug Hunter round and cleanup contract', () => {
    const entry = JSON.parse(
      fs.readFileSync(path.join(promptsDir, 'debugging', 'elite-bug-hunter.json'), 'utf8'),
    ) as { slug: string; content: string; variables?: unknown[] };
    expect(entry.slug).toBe('elite-bug-hunter');
    expect(entry.variables).toBeUndefined();
    expect(entry.content).toContain('exactly one concrete bug');
    expect(entry.content).toContain('exit non-zero and print an explicit `FAIL`');
    expect(entry.content).toContain('.temp_files/elite-bug-hunter/<round-id>/');
    expect(entry.content).toContain('Never delete `.temp_files/` wholesale');
    expect(entry.content).toContain('Do not hunt or fix a second issue');
  });

  it('the DefaultPromptLoader loads the bundled dataset from disk', async () => {
    const paths = resolveWstackPaths({
      projectRoot: path.join(here, 'fixture-empty'),
      globalRoot: path.join(here, 'fixture-empty-global'),
    });
    const loader = new DefaultPromptLoader({ paths, bundledDir: dataDir });
    const all = await loader.list();
    expect(all.length).toBe(files.length);
    expect(all.every((e) => e.source === 'builtin')).toBe(true);
    const cats = await loader.categories();
    expect(cats.reduce((n, c) => n + c.count, 0)).toBe(files.length);
  });
});
