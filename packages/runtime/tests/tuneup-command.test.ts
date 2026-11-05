import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { stripAnsi } from '@wrongstack/core/utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildTuneupCommand } from '../src/commands.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** An engine's host: no terminal to ask, no version check, no config doctor. */
function engineHost(config: Record<string, unknown>) {
  const root = mkdtempSync(path.join(tmpdir(), 'tuneup-engine-'));
  dirs.push(root);
  const file = path.join(root, 'config.json');
  writeFileSync(file, JSON.stringify(config));
  let live = config;
  const configStore = {
    get: () => live as never,
    update: vi.fn((next: Record<string, unknown>) => {
      live = next;
    }),
  };
  const missing = path.join(root, 'missing');
  return {
    file,
    configStore,
    host: {
      projectRoot: root,
      configStore: configStore as never,
      paths: {
        globalMemory: missing,
        inProjectAgentsFile: missing,
        projectTrust: missing,
        projectSessions: missing,
      } as never,
      getProfileConfigPath: () => file,
    },
  };
}

describe('/tuneup on an engine', () => {
  it('reports without a version check or a config doctor', async () => {
    const { host } = engineHost({});
    const result = await buildTuneupCommand(host).run('');
    expect(stripAnsi(result?.message ?? '')).toContain('Tune-up');
  });

  it('refuses --pick where nothing can ask about each fix', async () => {
    const { host, file } = engineHost({});
    const before = readFileSync(file, 'utf8');
    const result = await buildTuneupCommand(host).run('fix --pick');
    expect(stripAnsi(result?.message ?? '')).toContain('/tuneup fix to apply them all');
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it('writes the fixes to the profile config with a backup and updates the live config', async () => {
    const { host, file, configStore } = engineHost({});
    const result = await buildTuneupCommand(host).run('fix');
    const written = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    // An empty config always gets adaptive concurrency, the one fix that needs nothing else.
    expect(written['adaptiveConcurrency']).toEqual({ enabled: true });
    expect(stripAnsi(result?.message ?? '')).toContain('adaptive concurrency enabled');
    expect(readFileSync(`${file}.last`, 'utf8')).toBe('{}');
    expect(configStore.update).toHaveBeenCalledWith(written);
  });
});
