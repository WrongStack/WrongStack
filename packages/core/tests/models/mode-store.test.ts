import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, } from 'vitest';
import { DefaultModeStore, loadProjectModes, loadUserModes } from '../../src/models/mode-store.js';
import { DEFAULT_MODES } from '../../src/types/mode.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mode-store-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('DefaultModeStore', () => {
  it('organizes built-in modes into token-saving lite and deep/full families', () => {
    const ids = DEFAULT_MODES.map((mode) => mode.id);

    expect(ids).toEqual(
      expect.arrayContaining([
        'brief',
        'review-lite',
        'audit-lite',
        'plan-lite',
        'debug-lite',
        'test-lite',
        'refactor-lite',
        'research-lite',
        'code-reviewer',
        'code-auditor',
        'architect',
        'debugger',
        'tester',
        'refactorer',
        'teach',
        'research-web',
      ]),
    );
    expect(DEFAULT_MODES.filter((mode) => mode.tags?.includes('lite')).length).toBeGreaterThanOrEqual(8);
    expect(DEFAULT_MODES.filter((mode) => mode.tags?.includes('deep')).length).toBeGreaterThanOrEqual(8);
    expect(DEFAULT_MODES.find((mode) => mode.id === 'review-lite')?.prompt).toContain('Token-saving');
    expect(DEFAULT_MODES.find((mode) => mode.id === 'code-reviewer')?.name).toBe('Review Deep');
  });

  it('loads a non-empty prompt for every non-default built-in mode', () => {
    const modesWithoutPrompts = DEFAULT_MODES.filter(
      (mode) => mode.id !== 'default' && mode.prompt.trim().length === 0,
    ).map((mode) => mode.id);

    expect(modesWithoutPrompts).toEqual([]);
    expect(DEFAULT_MODES.find((mode) => mode.id === 'audit-lite')?.prompt).toContain('Audit Lite Mode');
    expect(DEFAULT_MODES.find((mode) => mode.id === 'research-lite')?.prompt).toContain('Research Lite Mode');
  });

  it('has "default" active mode when no config file', async () => {
    const store = new DefaultModeStore({ directory: tmpDir });
    const mode = await store.getActiveMode();
    // Falls back to 'default' when no mode.json exists yet
    expect(mode?.id).toBe('default');
  });

  it('listModes returns default modes', async () => {
    const store = new DefaultModeStore({ directory: tmpDir });
    const modes = await store.listModes();
    expect(modes.length).toBeGreaterThan(0);
  });

  it('getMode returns mode by id', async () => {
    const store = new DefaultModeStore({ directory: tmpDir });
    const mode = await store.getMode('default');
    expect(mode).toBeDefined();
    expect(mode?.id).toBe('default');
  });

  it('getMode returns null for unknown', async () => {
    const store = new DefaultModeStore({ directory: tmpDir });
    const mode = await store.getMode('unknown-mode');
    expect(mode).toBeNull();
  });

  it('setActiveMode persists', async () => {
    const store = new DefaultModeStore({ directory: tmpDir });
    await store.setActiveMode('default');
    const reloaded = new DefaultModeStore({ directory: tmpDir });
    const mode = await reloaded.getActiveMode();
    expect(mode?.id).toBe('default');
  });

  it('setActiveMode to null is persisted and reloaded as null', async () => {
    const store = new DefaultModeStore({ directory: tmpDir });
    await store.setActiveMode(null);
    const reloaded = new DefaultModeStore({ directory: tmpDir });
    const mode = await reloaded.getActiveMode();
    // Null is persisted; on reload activeModeId stays null and getActiveMode returns null
    expect(mode).toBeNull();
  });

  it('addMode inserts new mode', async () => {
    const store = new DefaultModeStore({ directory: tmpDir });
    await store.addMode({
      id: 'custom',
      name: 'Custom',
      description: 'A custom mode',
      prompt: 'custom prompt',
      tags: [],
    });
    const mode = await store.getMode('custom');
    expect(mode?.name).toBe('Custom');
  });

  it('addMode replaces existing', async () => {
    const store = new DefaultModeStore({ directory: tmpDir });
    await store.addMode({ id: 'default', name: 'Renamed', description: '', prompt: '', tags: [] });
    const mode = await store.getMode('default');
    expect(mode?.name).toBe('Renamed');
  });

  it('removeMode throws for built-in', async () => {
    const store = new DefaultModeStore({ directory: tmpDir });
    await expect(store.removeMode('default')).rejects.toThrow('Cannot remove built-in');
  });

  it('removeMode removes custom mode', async () => {
    const store = new DefaultModeStore({ directory: tmpDir });
    await store.addMode({ id: 'custom', name: 'Custom', description: '', prompt: '', tags: [] });
    await store.removeMode('custom');
    const mode = await store.getMode('custom');
    expect(mode).toBeNull();
  });
});

describe('loadProjectModes', () => {
  it('returns empty when dir does not exist', async () => {
    // Use a path that Windows can resolve as definitely non-existent
    const nonExistent = path.join(os.tmpdir(), 'wstack-non-existent-' + Date.now());
    const modes = await loadProjectModes(nonExistent);
    expect(modes).toEqual([]);
  });

  it('loads modes from directory', async () => {
    const modeFile = path.join(tmpDir, 'my-mode.md');
    await fs.writeFile(modeFile, 'My custom mode description\n第二行', 'utf8');
    const modes = await loadProjectModes(tmpDir);
    expect(modes).toHaveLength(1);
    expect(modes[0]!.id).toBe('my-mode');
    expect(modes[0]!.name).toBe('My Mode');
  });

  it('skips non-markdown files', async () => {
    await fs.writeFile(path.join(tmpDir, 'data.json'), '{}', 'utf8');
    const modes = await loadProjectModes(tmpDir);
    expect(modes).toHaveLength(0);
  });
});

describe('loadUserModes', () => {
  it('returns empty when file does not exist', async () => {
    const modes = await loadUserModes(tmpDir);
    expect(modes).toEqual([]);
  });

  it('loads modes from manifest', async () => {
    const manifest = {
      modes: [{ id: 'user1', name: 'User', description: '', prompt: 'hello', tags: [] }],
    };
    await fs.writeFile(path.join(tmpDir, 'modes.json'), JSON.stringify(manifest), 'utf8');
    const modes = await loadUserModes(tmpDir);
    expect(modes).toHaveLength(1);
    expect(modes[0]!.id).toBe('user1');
  });
});
