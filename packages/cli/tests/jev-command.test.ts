import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config } from '@wrongstack/contracts/types';
import { DefaultConfigStore } from '@wrongstack/core/storage';
import { recordJevActivity } from '@wrongstack/core/typesafe';
import { describe, expect, it, vi } from 'vitest';
import type { SlashCommandContext } from '../src/slash-commands/command-context.js';
import { buildJevCommand } from '../src/slash-commands/jev.js';

describe('/jev', () => {
  it('persists the master off/on switch without deleting the key or feature choices', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jev-master-'));
    try {
      const file = join(dir, 'config.json');
      const store = new DefaultConfigStore({
        version: 1,
        typesafe: { enabled: true, judgments: { brain: false } },
      } as Config);
      await writeFile(file, JSON.stringify(store.get()));
      const command = buildJevCommand({
        configStore: store,
        paths: { profileConfig: () => file },
      } as unknown as SlashCommandContext);
      expect((await command.run('off'))?.message).toContain('saved');
      expect(JSON.parse(await readFile(file, 'utf8')).typesafe).toEqual({
        enabled: false,
        judgments: { brain: false },
      });
      expect((await command.run('on'))?.message).toContain('saved');
      expect(store.get().typesafe).toMatchObject({ enabled: true, judgments: { brain: false } });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it('shows features, settings and activity entry points without exposing a credential', async () => {
    const command = buildJevCommand({
      configStore: new DefaultConfigStore({
        version: 1,
        typesafe: { apiKey: 'private-key' },
      } as Config),
    } as unknown as SlashCommandContext);
    const result = await command.run('');
    expect(result?.message).toContain('/jev logs');
    expect(result?.message).toContain('memoryRecall');
    expect(result?.message).not.toContain('private-key');
  });
  it('persists feature switches through the shared settings path', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jev-command-'));
    try {
      const file = join(dir, 'config.json');
      const store = new DefaultConfigStore({ version: 1 } as Config);
      const command = buildJevCommand({
        configStore: store,
        paths: { profileConfig: () => file },
      } as unknown as SlashCommandContext);
      expect((await command.run('feature brain off'))?.message).toContain('saved');
      expect(JSON.parse(await readFile(file, 'utf8')).typesafe.judgments.brain).toBe(false);
      expect(store.get().typesafe?.judgments?.brain).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it('persists the content-logging switch and reports it in /jev logs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jev-logcontent-'));
    try {
      const file = join(dir, 'config.json');
      const store = new DefaultConfigStore({ version: 1 } as Config);
      const command = buildJevCommand({
        configStore: store,
        paths: { profileConfig: () => file },
      } as unknown as SlashCommandContext);
      expect((await command.run('logs'))?.message).toContain('/jev logcontent on');
      expect((await command.run('logcontent on'))?.message).toContain('saved');
      expect(JSON.parse(await readFile(file, 'utf8')).typesafe.logContent).toBe(true);
      expect((await command.run('logs'))?.message).toContain('never in this view');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it('refuses credential setup on surfaces without masked input', async () => {
    const readText = vi.fn();
    const command = buildJevCommand({
      configStore: new DefaultConfigStore({ version: 1 } as Config),
      paths: {},
      readText,
    } as unknown as SlashCommandContext);
    expect((await command.run('login typesafe'))?.message).toContain(
      'Secure key input unavailable',
    );
    expect(readText).not.toHaveBeenCalled();
  });

  it('never prints request, response or error content in /jev logs, even with content logging on', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jev-logtail-'));
    try {
      const file = join(dir, 'config.json');
      const command = buildJevCommand({
        configStore: new DefaultConfigStore({ version: 1 } as Config),
        paths: { profileConfig: () => file },
      } as unknown as SlashCommandContext);
      // Content logging is ON, so this entry is the one a real full record
      // would produce — which is exactly the shape /jev logs must not print.
      expect((await command.run('logcontent on'))?.message).toContain('saved');
      recordJevActivity({
        id: 'req-1',
        at: Date.now(),
        feature: 'tool',
        project: dir,
        route: 'typesafe',
        model: 'jev-latest',
        durationMs: 12,
        outcome: 'answered',
        inputTokens: 5,
        outputTokens: 2,
        answers: { ready: 0.9 },
        request: {
          state: { plan: 'SENTINEL-STATE' },
          questions: { ready: { type: 'noul', instructions: 'SENTINEL-INSTRUCTION' } },
        },
        response: { answers: { ready: { type: 'noul', noul: 0.9, note: 'SENTINEL-RESULT' } } },
        error: { message: 'SENTINEL-ERROR' },
      });
      const message = (await command.run('logs'))?.message ?? '';
      expect(message).toContain('never in this view');
      // Metadata is still there: the strip is about payloads, not entries.
      expect(message).toContain('tool');
      expect(message).toContain('0.9');
      for (const sentinel of [
        'SENTINEL-STATE',
        'SENTINEL-INSTRUCTION',
        'SENTINEL-RESULT',
        'SENTINEL-ERROR',
      ]) {
        expect(message).not.toContain(sentinel);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
