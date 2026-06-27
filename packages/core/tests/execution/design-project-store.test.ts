import { existsSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  _resetDesignRulesCache,
  clearPersistedActiveKit,
  designProjectDir,
  loadActiveKit,
  loadProjectDesignRules,
  recordKitChoice,
} from '../../src/execution/design-project-store.js';

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-design-'));
  _resetDesignRulesCache();
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('design-project-store', () => {
  it('recordKitChoice writes active.json, decisions.md, and a self-ignoring .gitignore', async () => {
    await recordKitChoice(root, 'neo-brutalist', 'web', 'design-tool', '2026-06-27T10:00:00.000Z');
    const dir = designProjectDir(root);
    expect(existsSync(path.join(dir, '.gitignore'))).toBe(true);
    expect(await fs.readFile(path.join(dir, '.gitignore'), 'utf8')).toBe('*\n');

    const active = await loadActiveKit(root);
    expect(active).toEqual({ kit: 'neo-brutalist', stack: 'web' });

    const decisions = await fs.readFile(path.join(dir, 'decisions.md'), 'utf8');
    expect(decisions).toContain('kit=neo-brutalist');
    expect(decisions).toContain('stack=web');
    expect(decisions).toContain('via=design-tool');
  });

  it('appends successive decisions to the log', async () => {
    await recordKitChoice(root, 'minimal-clarity', 'web', 'webui', '2026-06-27T10:00:00.000Z');
    await recordKitChoice(root, 'soft-glass', undefined, 'design-tool', '2026-06-27T10:05:00.000Z');
    const decisions = await fs.readFile(path.join(designProjectDir(root), 'decisions.md'), 'utf8');
    expect(decisions.match(/^- /gm)?.length).toBe(2);
    // Latest choice wins in active.json.
    expect((await loadActiveKit(root))?.kit).toBe('soft-glass');
  });

  it('loadActiveKit returns undefined when nothing is persisted', async () => {
    expect(await loadActiveKit(root)).toBeUndefined();
  });

  it('clearPersistedActiveKit removes active.json (keeps decisions log)', async () => {
    await recordKitChoice(root, 'dark-pro', 'web', 'slash', '2026-06-27T10:00:00.000Z');
    await clearPersistedActiveKit(root);
    expect(await loadActiveKit(root)).toBeUndefined();
    expect(existsSync(path.join(designProjectDir(root), 'decisions.md'))).toBe(true);
  });

  it('loadProjectDesignRules reads .design/rules.md (cached per root)', async () => {
    const dir = designProjectDir(root);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'rules.md'), '# Brand\n- Always use 8px grid.\n');
    const rules = await loadProjectDesignRules(root);
    expect(rules).toContain('8px grid');
  });

  it('loadProjectDesignRules returns undefined when no rules file exists', async () => {
    expect(await loadProjectDesignRules(root)).toBeUndefined();
  });
});
