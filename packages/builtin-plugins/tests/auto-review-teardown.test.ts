import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type { EventMap } from '@wrongstack/contracts/kernel/events';
import type { PluginAPI } from '@wrongstack/contracts/types/plugin';
import { afterEach, describe, expect, it } from 'vitest';
import { createAutoReviewPlugin } from '../src/auto-review-plugin.js';

const tempDirs: string[] = [];

function makeTempRepo(fileName: string, content: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'auto-review-teardown-'));
  tempDirs.push(dir);
  execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir, stdio: 'ignore' });
  writeFileSync(path.join(dir, fileName), 'export const x = 1;\n', 'utf8');
  execFileSync('git', ['add', '.'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: dir, stdio: 'ignore' });
  writeFileSync(path.join(dir, fileName), content, 'utf8');
  return dir;
}

function makeMockApi(cwd: string) {
  const listeners = new Map<string, Array<(payload: unknown) => unknown>>();
  const emitted: Array<{ event: string; payload: unknown }> = [];
  const api = {
    config: {
      cwd,
      extensions: {
        'wstack-auto-review': {
          enabled: true,
          debounceMs: 25,
          provider: 'test',
          model: 'test-model',
          cascadeOn: [],
        },
      },
    },
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    onConfigChange: () => () => {},
    slashCommands: { register: () => {}, unregister: () => {} },
    onPattern: () => () => {},
    events: { on: () => () => {}, emit: () => {}, once: () => () => {} },
    onEvent: <K extends keyof EventMap>(event: K, fn: (payload: EventMap[K]) => unknown) => {
      const list = listeners.get(String(event)) ?? [];
      list.push(fn as (payload: unknown) => unknown);
      listeners.set(String(event), list);
      return () => {};
    },
    emitCustom: (event: string, payload: unknown) => {
      emitted.push({ event, payload });
    },
  } as unknown as PluginAPI;
  return {
    api,
    emitted,
    async emitIteration() {
      for (const fn of listeners.get('iteration.completed') ?? []) {
        await fn({ index: 1, ctx: {} } as unknown as EventMap['iteration.completed']);
      }
    },
  };
}

describe('createAutoReviewPlugin teardown (F194)', () => {
  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  it('cancels pending debounce timer on teardown and does not emit review_needed after unload', async () => {
    const dir = makeTempRepo('defect.ts', 'export const def = 999;\n');
    const mock = makeMockApi(dir);
    const plugin = createAutoReviewPlugin();
    await plugin.setup(mock.api);
    await mock.emitIteration();
    await plugin.teardown?.(mock.api);
    await new Promise((r) => setTimeout(r, 250));
    expect(mock.emitted.filter((e) => e.event === 'chimera.review_needed')).toHaveLength(0);
  });
});
