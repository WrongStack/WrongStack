import { describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import {
  handleSkillsContent,
  handleSkillsCreate,
  handleSkillsEdit,
  handleSkillsInstall,
  handleSkillsUninstall,
  handleSkillsUpdate,
  type SkillsContext,
} from '../src/server/skills-handlers.js';

interface Frame {
  type: string;
  payload: Record<string, unknown>;
}

function openWs(): { ws: WebSocket; messages: Frame[] } {
  const messages: Frame[] = [];
  const ws = {
    readyState: 1,
    send: (raw: string) => messages.push(JSON.parse(raw) as Frame),
  } as unknown as WebSocket;
  return { ws, messages };
}

describe('skills WebSocket handlers untrusted frame & boolean validation (F530)', () => {
  it('rejects null/malformed frames, non-string ref/name, and non-boolean global without throwing', async () => {
    const calls: unknown[] = [];
    const installer = {
      listInstalled: async () => [],
      install: async (ref: string, opts: { global?: boolean }) => {
        calls.push(['install', ref, opts.global]);
        return [{ name: 'ok', ok: true }];
      },
      uninstall: async (name: string, opts: { global?: boolean }) => {
        calls.push(['uninstall', name, opts.global]);
      },
      update: async (name: string | undefined, opts: { global?: boolean }) => {
        calls.push(['update', name, opts.global]);
        return { updated: 1, unchanged: 0, errors: [] };
      },
    };
    const loader = {
      list: async () => [],
      listEntries: async () => [
        { name: 'alpha', path: '/skills/alpha/SKILL.md', source: 'project', scope: ['project'] },
      ],
      readBody: async () => '',
    };
    const ctx: SkillsContext = {
      skillLoader: loader as never,
      skillInstaller: installer as never,
      projectRoot: '/proj',
    };

    for (const badFrame of [null, undefined, 'raw', { payload: null }, { payload: ['arr'] }]) {
      for (const fn of [
        handleSkillsContent,
        handleSkillsInstall,
        handleSkillsUninstall,
        handleSkillsUpdate,
        handleSkillsCreate,
        handleSkillsEdit,
      ]) {
        const { ws, messages } = openWs();
        await expect(fn(ws, ctx, badFrame)).resolves.toBeUndefined();
        expect(messages).toHaveLength(1);
      }
    }
    calls.length = 0;

    for (const badInstall of [
      { payload: { ref: 123 } },
      { payload: { ref: 'owner/repo', global: 'false' } },
    ]) {
      const { ws, messages } = openWs();
      await handleSkillsInstall(ws, ctx, badInstall);
      expect(messages[0]?.payload.success).toBe(false);
    }

    for (const badUninstall of [
      { payload: { name: 99 } },
      { payload: { name: 'alpha', global: 'false' } },
    ]) {
      const { ws, messages } = openWs();
      await handleSkillsUninstall(ws, ctx, badUninstall);
      expect(messages[0]?.payload.success).toBe(false);
    }

    for (const badUpdate of [
      { payload: { name: 99 } },
      { payload: { name: '   ' } },
      { payload: { global: 'false' } },
    ]) {
      const { ws, messages } = openWs();
      await handleSkillsUpdate(ws, ctx, badUpdate);
      expect(messages[0]?.payload.success).toBe(false);
    }

    expect(calls).toEqual([]);

    const contentWs = openWs();
    await handleSkillsContent(contentWs.ws, ctx, {
      payload: { requestId: 'req-42', name: 123, source: 456 },
    });
    expect(contentWs.messages[0]?.payload).toMatchObject({
      requestId: 'req-42',
      name: '',
      error: 'Skill name is required',
    });

    const okUpdate = openWs();
    await handleSkillsUpdate(okUpdate.ws, ctx, { payload: { name: ' alpha ', global: false } });
    expect(okUpdate.messages[0]?.payload.success).toBe(true);
    expect(calls).toEqual([['update', 'alpha', false]]);
  });
});
