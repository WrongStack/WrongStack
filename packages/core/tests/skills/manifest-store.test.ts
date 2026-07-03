import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type InstalledSkillEntry, SkillManifestStore } from '../../src/skills/manifest-store.js';

let tmp: string;
let manifestPath: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'manifest-store-'));
  manifestPath = path.join(tmp, 'sub', 'installed-skills.json');
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

function makeEntry(overrides: Partial<InstalledSkillEntry> = {}): InstalledSkillEntry {
  return {
    name: 'sample',
    source: 'github:u/r',
    ref: 'main',
    scope: 'project',
    projectHash: 'abc',
    installedAt: '2026-05-22T10:00:00Z',
    files: ['SKILL.md'],
    ...overrides,
  };
}

describe('SkillManifestStore', () => {
  it('read returns empty skills list when file missing', async () => {
    const store = new SkillManifestStore(manifestPath);
    const data = await store.read();
    expect(data.skills).toEqual([]);
  });

  it('read returns empty list when manifest is malformed JSON', async () => {
    await fs.mkdir(path.dirname(manifestPath), { recursive: true });
    await fs.writeFile(manifestPath, '{not valid');
    const store = new SkillManifestStore(manifestPath);
    expect((await store.read()).skills).toEqual([]);
  });

  it('read coerces non-array skills to empty list', async () => {
    await fs.mkdir(path.dirname(manifestPath), { recursive: true });
    await fs.writeFile(manifestPath, JSON.stringify({ skills: 'not an array' }));
    const store = new SkillManifestStore(manifestPath);
    expect((await store.read()).skills).toEqual([]);
  });

  it('write creates the parent directory and persists data', async () => {
    const store = new SkillManifestStore(manifestPath);
    await store.write({ skills: [makeEntry()] });
    const raw = await fs.readFile(manifestPath, 'utf8');
    expect(raw.trim().endsWith('}')).toBe(true);
    const parsed = JSON.parse(raw);
    expect(parsed.skills).toHaveLength(1);
  });

  it('read uses in-memory cache after first call', async () => {
    const store = new SkillManifestStore(manifestPath);
    await store.write({ skills: [makeEntry({ name: 'x' })] });
    const first = await store.read();
    // Mutate disk directly — cache should hide this change.
    await fs.writeFile(manifestPath, JSON.stringify({ skills: [makeEntry({ name: 'y' })] }));
    const second = await store.read();
    expect(second).toBe(first);
    expect(second.skills[0]?.name).toBe('x');
  });

  it('invalidateCache forces a fresh re-read', async () => {
    const store = new SkillManifestStore(manifestPath);
    await store.write({ skills: [makeEntry({ name: 'x' })] });
    await fs.writeFile(manifestPath, JSON.stringify({ skills: [makeEntry({ name: 'y' })] }));
    store.invalidateCache();
    const after = await store.read();
    expect(after.skills[0]?.name).toBe('y');
  });

  it('addEntry appends a fresh skill', async () => {
    const store = new SkillManifestStore(manifestPath);
    await store.addEntry(makeEntry({ name: 'a' }));
    await store.addEntry(makeEntry({ name: 'b' }));
    const all = await store.listAll();
    expect(all.map((s) => s.name)).toEqual(['a', 'b']);
  });

  it('addEntry replaces existing entry with same name+scope', async () => {
    const store = new SkillManifestStore(manifestPath);
    await store.addEntry(makeEntry({ name: 'a', ref: 'v1' }));
    await store.addEntry(makeEntry({ name: 'a', ref: 'v2' }));
    const all = await store.listAll();
    expect(all).toHaveLength(1);
    expect(all[0]?.ref).toBe('v2');
  });

  it('addEntry treats same name with different scopes as distinct', async () => {
    const store = new SkillManifestStore(manifestPath);
    await store.addEntry(makeEntry({ name: 'a', scope: 'project' }));
    await store.addEntry(makeEntry({ name: 'a', scope: 'user' }));
    const all = await store.listAll();
    expect(all).toHaveLength(2);
  });

  it('removeEntry returns true and persists deletion on hit', async () => {
    const store = new SkillManifestStore(manifestPath);
    await store.addEntry(makeEntry({ name: 'a' }));
    const ok = await store.removeEntry('a', 'project');
    expect(ok).toBe(true);
    expect(await store.listAll()).toEqual([]);
  });

  it('removeEntry returns false on miss without rewriting', async () => {
    const store = new SkillManifestStore(manifestPath);
    await store.addEntry(makeEntry({ name: 'a' }));
    const before = await fs.readFile(manifestPath, 'utf8');
    const ok = await store.removeEntry('nope', 'project');
    expect(ok).toBe(false);
    const after = await fs.readFile(manifestPath, 'utf8');
    expect(after).toBe(before);
  });

  it('findByName returns all matches across scopes', async () => {
    const store = new SkillManifestStore(manifestPath);
    await store.addEntry(makeEntry({ name: 'same', scope: 'project' }));
    await store.addEntry(makeEntry({ name: 'same', scope: 'user' }));
    await store.addEntry(makeEntry({ name: 'other' }));
    const matches = await store.findByName('same');
    expect(matches).toHaveLength(2);
  });

  it('findByName returns empty array on miss', async () => {
    const store = new SkillManifestStore(manifestPath);
    expect(await store.findByName('nope')).toEqual([]);
  });

  it('findBySource filters by source identifier', async () => {
    const store = new SkillManifestStore(manifestPath);
    await store.addEntry(makeEntry({ name: 'a', source: 'github:u/r' }));
    await store.addEntry(makeEntry({ name: 'b', source: 'github:u/r' }));
    await store.addEntry(makeEntry({ name: 'c', source: 'github:u/other' }));
    const matches = await store.findBySource('github:u/r');
    expect(matches.map((s) => s.name).sort()).toEqual(['a', 'b']);
  });
});
