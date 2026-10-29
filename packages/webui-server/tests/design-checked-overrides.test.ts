import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import { type ContentRouteContext, handleContentRoute } from '../src/server/content-routes.js';

it('applies design overrides only over the kit and values the caller reviewed', async () => {
  const base = resolve(tmpdir()),
    dir = await mkdtemp(join(base, 'design-checked-overrides-'));
  const context = {
    getProjectRoot: () => dir,
    getDesignContext: () => ({ projectRoot: dir }),
    getSkillsContext: () => {
      throw Error('Not skills');
    },
    getPromptsContext: () => {
      throw Error('Not prompts');
    },
  } satisfies ContentRouteContext;
  const sent: { type: string; payload: Record<string, unknown> }[] = [];
  const socket = { readyState: 1, send: (message: string) => sent.push(JSON.parse(message)) };
  const call = async (type: string, payload: Record<string, unknown>) => {
    sent.length = 0;
    await handleContentRoute(context, socket as unknown as WebSocket, { type, payload } as never);
    return sent.at(-1)!.payload;
  };
  const active = async () =>
    JSON.parse(await readFile(join(dir, '.design', 'active.json'), 'utf8')) as {
      overrides?: Record<string, string>;
    };
  try {
    expect(await call('design.use', { kit: 'minimal-clarity', stack: 'web' })).toMatchObject({
      ok: true,
    });
    expect(
      await call('design.set', {
        overrides: { primary: '#123456' },
        expected: { kit: 'minimal-clarity', values: { primary: '' } },
      }),
    ).toMatchObject({ ok: true, overrides: { primary: '#123456' } });
    // A window that still saw no override, or another kit, is refused and nothing is written.
    expect(
      await call('design.set', {
        overrides: { primary: '#abcdef' },
        expected: { kit: 'minimal-clarity', values: { primary: '' } },
      }),
    ).toMatchObject({ ok: false, conflict: true });
    expect(
      await call('design.tune', { tune: { radius: 'lg' }, expected: { kit: 'soft-glass' } }),
    ).toMatchObject({ ok: false, conflict: true });
    expect((await active()).overrides).toEqual({ primary: '#123456' });
    // Without `expected`, writes behave as before.
    expect(await call('design.set', { overrides: { accent: '#654321' } })).toMatchObject({
      ok: true,
    });
  } finally {
    expect(dir.startsWith(base + sep)).toBe(true);
    await rm(dir, { recursive: true, force: true });
  }
});
