/**
 * Unit tests for the shared skills WebSocket handlers
 * (`packages/webui/src/server/skills-handlers.ts`).
 *
 * These handlers back BOTH the standalone WebUI server and the CLI's
 * `--webui` embedded server. They were extracted from inlined switch cases
 * (the CLI copy had drifted to only handle `skills.list`, leaving the rest
 * as "Unhandled message type"), so these tests pin the one source of truth.
 *
 * Each test drives a handler with a stub SkillsContext (fake skillLoader /
 * skillInstaller + a capturing `send`) — no real I/O, no socket.
 */

import { describe, expect, it, vi } from 'vitest';
import * as nodeFs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { WebSocket } from 'ws';
import type { WSServerMessage } from '../../src/types.js';
import {
  handleSkillsContent,
  handleSkillsCreate,
  handleSkillsEdit,
  handleSkillsExport,
  handleSkillsInstall,
  handleSkillsList,
  handleSkillsUninstall,
  handleSkillsUpdate,
  type SkillsContext,
} from '@wrongstack/webui-server';

/** Build a SkillsContext with stubbed loader/installer (undefined by default). */
function makeCtx(over: Partial<SkillsContext> = {}): SkillsContext {
  return {
    skillLoader: undefined,
    skillInstaller: undefined,
    projectRoot: '/proj',
    ...over,
  };
}

// A ws stub that records every sent message — the handlers' imported `send`
// (from ws-utils) calls `ws.send(JSON.stringify(msg))` only when readyState
// is OPEN, so we fake an OPEN socket and capture the JSON.
function openWs(): { ws: WebSocket; messages: WSServerMessage[] } {
  const messages: WSServerMessage[] = [];
  const ws = {
    readyState: 1, // WebSocket.OPEN
    send: (raw: string) => messages.push(JSON.parse(raw) as WSServerMessage),
  } as never as WebSocket;
  return { ws, messages };
}

const payloadOf = (msgs: WSServerMessage[], type: string) =>
  msgs.find((m) => m.type === type)?.payload as Record<string, unknown> | undefined;

// ── skills.list ───────────────────────────────────────────────────────

describe('handleSkillsList', () => {
  it('reports disabled when no skill loader is wired', async () => {
    const ctx = makeCtx({ skillLoader: undefined });
    const { ws, messages } = openWs();
    await handleSkillsList(ws, ctx);
    expect(payloadOf(messages, 'skills.list')).toEqual({ skills: [], enabled: false });
  });

  it('maps manifests + entry triggers and enriches sourceUrl/ref from the installer', async () => {
    const loader = {
      list: async () => [
        { name: 's1', description: 'one', version: '1.0', source: 'user', path: '/s1/SKILL.md' },
      ],
      listEntries: async () => [{ name: 's1', trigger: 'use when x', scope: ['project'] }],
      readBody: async () => '',
    };
    const installer = {
      listInstalled: async () => [{ name: 's1', source: 'https://github.com/o/r', ref: 'abc' }],
      install: async () => [],
      uninstall: async () => {},
      update: async () => ({ updated: 0, unchanged: 0, errors: [] }),
    };
    const ctx = makeCtx({ skillLoader: loader as never, skillInstaller: installer as never });
    const { ws, messages } = openWs();
    await handleSkillsList(ws, ctx);
    const p = payloadOf(messages, 'skills.list');
    expect(p?.enabled).toBe(true);
    expect((p!.skills as Array<Record<string, unknown>>)[0]).toMatchObject({
      name: 's1',
      trigger: 'use when x',
      scope: ['project'],
      sourceUrl: 'https://github.com/o/r',
      ref: 'abc',
    });
  });

  it('reports an error payload when the loader throws', async () => {
    const loader = {
      list: async () => {
        throw new Error('boom');
      },
      listEntries: async () => [],
      readBody: async () => '',
    };
    const ctx = makeCtx({ skillLoader: loader as never });
    const { ws, messages } = openWs();
    await handleSkillsList(ws, ctx);
    expect(payloadOf(messages, 'skills.list')).toMatchObject({ enabled: true, error: 'boom' });
  });
});

// ── skills.content ────────────────────────────────────────────────────

describe('handleSkillsContent', () => {
  it('refuses when skills are disabled', async () => {
    const ctx = makeCtx({ skillLoader: undefined });
    const { ws, messages } = openWs();
    await handleSkillsContent(ws, ctx, { payload: { name: 'x', source: 'user' } });
    expect(payloadOf(messages, 'skills.content')?.error).toBe('Skills not enabled');
  });

  it('requires a skill name', async () => {
    const loader = { list: async () => [], listEntries: async () => [], readBody: async () => '' };
    const ctx = makeCtx({ skillLoader: loader as never });
    const { ws, messages } = openWs();
    await handleSkillsContent(ws, ctx, { payload: { name: '', source: 'user' } });
    expect(payloadOf(messages, 'skills.content')?.error).toBe('Skill name is required');
  });

  it('returns the body + path for a known skill (case-insensitive)', async () => {
    // The handler reads the body straight from `entry.path` via fs (an
    // intentional optimization over loader.readBody, which re-runs find()),
    // and lists the skill dir for related files — so we stub both here.
    const readFileSpy = vi
      .spyOn(nodeFs.promises, 'readFile')
      .mockResolvedValue('body of myskill' as never);
    const readdirSpy = vi.spyOn(nodeFs.promises, 'readdir').mockResolvedValue([] as never);
    try {
      const loader = {
        list: async () => [],
        listEntries: async () => [
          { name: 'MySkill', path: '/skills/myskill/SKILL.md', scope: ['project'] },
        ],
        readBody: async (n: string) => `body of ${n}`,
      };
      const ctx = makeCtx({ skillLoader: loader as never });
      const { ws, messages } = openWs();
      await handleSkillsContent(ws, ctx, { payload: { name: 'myskill', source: 'project' } });
      expect(payloadOf(messages, 'skills.content')).toMatchObject({
        name: 'myskill',
        body: 'body of myskill',
        path: '/skills/myskill/SKILL.md',
      });
    } finally {
      readFileSpy.mockRestore();
      readdirSpy.mockRestore();
    }
  });

  it('reports not-found for an unknown skill', async () => {
    const loader = { list: async () => [], listEntries: async () => [], readBody: async () => '' };
    const ctx = makeCtx({ skillLoader: loader as never });
    const { ws, messages } = openWs();
    await handleSkillsContent(ws, ctx, { payload: { name: 'nope', source: 'project' } });
    expect(payloadOf(messages, 'skills.content')?.error).toBe('Skill "nope" not found');
  });
});

// ── skills.install / uninstall / update ───────────────────────────────

describe('handleSkillsInstall', () => {
  it('refuses when no installer is wired', async () => {
    const ctx = makeCtx({ skillInstaller: undefined });
    const { ws, messages } = openWs();
    await handleSkillsInstall(ws, ctx, { payload: { ref: 'o/r' } });
    expect(payloadOf(messages, 'skills.installed')?.error).toBe('Skills not enabled');
  });

  it('requires a ref', async () => {
    const installer = {
      listInstalled: async () => [],
      install: async () => [],
      uninstall: async () => {},
      update: async () => ({ updated: 0, unchanged: 0, errors: [] }),
    };
    const ctx = makeCtx({ skillInstaller: installer as never });
    const { ws, messages } = openWs();
    await handleSkillsInstall(ws, ctx, { payload: { ref: '  ' } });
    expect(payloadOf(messages, 'skills.installed')?.success).toBe(false);
  });

  it('installs and echoes the results', async () => {
    const installer = {
      listInstalled: async () => [],
      install: async (_ref: string, _opts: { global?: boolean }) => [{ name: 'r', ok: true }],
      uninstall: async () => {},
      update: async () => ({ updated: 0, unchanged: 0, errors: [] }),
    };
    const ctx = makeCtx({ skillInstaller: installer as never });
    const { ws, messages } = openWs();
    await handleSkillsInstall(ws, ctx, { payload: { ref: 'o/r', global: true } });
    expect(payloadOf(messages, 'skills.installed')).toMatchObject({ success: true, error: null });
  });
});

describe('handleSkillsUninstall', () => {
  it('requires a name', async () => {
    const installer = {
      listInstalled: async () => [],
      install: async () => [],
      uninstall: async () => {},
      update: async () => ({ updated: 0, unchanged: 0, errors: [] }),
    };
    const ctx = makeCtx({ skillInstaller: installer as never });
    const { ws, messages } = openWs();
    await handleSkillsUninstall(ws, ctx, { payload: { name: '' } });
    expect(payloadOf(messages, 'skills.uninstalled')?.error).toBe('Skill name is required');
  });
});

describe('handleSkillsUpdate', () => {
  it('reports updated/unchanged/errors tallies', async () => {
    const installer = {
      listInstalled: async () => [],
      install: async () => [],
      uninstall: async () => {},
      update: async (_name: string | undefined) => ({ updated: 2, unchanged: 1, errors: [] }),
    };
    const ctx = makeCtx({ skillInstaller: installer as never });
    const { ws, messages } = openWs();
    await handleSkillsUpdate(ws, ctx, { payload: {} });
    expect(payloadOf(messages, 'skills.updated')).toMatchObject({
      success: true,
      updated: 2,
      unchanged: 1,
    });
  });
});

// ── skills.create ─────────────────────────────────────────────────────

describe('handleSkillsCreate', () => {
  it('rejects non-kebab-case names', async () => {
    const ctx = makeCtx();
    const { ws, messages } = openWs();
    await handleSkillsCreate(ws, ctx, {
      payload: { name: 'Bad Name', description: 'd', scope: 'project' },
    });
    expect(payloadOf(messages, 'skills.created')?.error).toMatch(/kebab-case/);
  });

  it('rejects when description is empty', async () => {
    const ctx = makeCtx();
    const { ws, messages } = openWs();
    await handleSkillsCreate(ws, ctx, {
      payload: { name: 'ok-name', description: '   ', scope: 'project' },
    });
    expect(payloadOf(messages, 'skills.created')?.error).toMatch(/Description/);
  });

  it('creates project skills under .wrongstack/skills', async () => {
    const tmp = await nodeFs.promises.mkdtemp(path.join(os.tmpdir(), 'skills-create-project-'));
    try {
      const projectRoot = path.join(tmp, 'project');
      const projectSkillsDir = path.join(projectRoot, '.wrongstack', 'skills');
      const ctx = makeCtx({ projectRoot, projectSkillsDir });
      const { ws, messages } = openWs();
      await handleSkillsCreate(ws, ctx, {
        payload: {
          name: 'ok-name',
          description: 'Use when testing project skills.',
          scope: 'project',
        },
      });
      const skillPath = path.join(projectSkillsDir, 'ok-name', 'SKILL.md');
      await expect(nodeFs.promises.readFile(skillPath, 'utf8')).resolves.toContain('name: ok-name');
      expect(payloadOf(messages, 'skills.created')?.skill).toMatchObject({
        path: skillPath,
        scope: 'project',
      });
    } finally {
      await nodeFs.promises.rm(tmp, { recursive: true, force: true });
    }
  });

  it('creates global skills under the user-global skills directory', async () => {
    const tmp = await nodeFs.promises.mkdtemp(path.join(os.tmpdir(), 'skills-create-global-'));
    try {
      const globalSkillsDir = path.join(tmp, '.wrongstack', 'skills');
      const ctx = makeCtx({ globalSkillsDir });
      const { ws, messages } = openWs();
      await handleSkillsCreate(ws, ctx, {
        payload: {
          name: 'global-name',
          description: 'Use when testing global skills.',
          scope: 'global',
        },
      });
      const skillPath = path.join(globalSkillsDir, 'global-name', 'SKILL.md');
      await expect(nodeFs.promises.readFile(skillPath, 'utf8')).resolves.toContain(
        'name: global-name',
      );
      expect(payloadOf(messages, 'skills.created')?.skill).toMatchObject({
        path: skillPath,
        scope: 'global',
      });
    } finally {
      await nodeFs.promises.rm(tmp, { recursive: true, force: true });
    }
  });
});

// ── skills.edit ───────────────────────────────────────────────────────

describe('handleSkillsEdit', () => {
  it('refuses to edit bundled skills', async () => {
    const loader = {
      list: async () => [],
      listEntries: async () => [
        { name: 'bundled', path: '/b/SKILL.md', source: 'bundled', scope: ['bundled'] },
      ],
      readBody: async () => '',
    };
    const ctx = makeCtx({ skillLoader: loader as never });
    const { ws, messages } = openWs();
    await handleSkillsEdit(ws, ctx, { payload: { name: 'bundled', body: 'new body' } });
    expect(payloadOf(messages, 'skills.edited')?.error).toBe('Bundled skills cannot be edited');
  });
});

// ── skills.export ─────────────────────────────────────────────────────

describe('handleSkillsExport', () => {
  it('refuses when skills are disabled', async () => {
    const ctx = makeCtx({ skillLoader: undefined });
    const { ws, messages } = openWs();
    await handleSkillsExport(ws, ctx);
    expect(payloadOf(messages, 'skills.exported')?.error).toBe('Skills not enabled');
  });

  it('produces a base64 zip covering every readable skill', async () => {
    const loader = {
      list: async () => [],
      listEntries: async () => [
        { name: 'a', path: '/a/SKILL.md', scope: ['project'] },
        { name: 'b/c', path: '/b/SKILL.md', scope: ['project'] },
      ],
      readBody: async () => '# body',
    };
    const ctx = makeCtx({ skillLoader: loader as never });
    const { ws, messages } = openWs();
    await handleSkillsExport(ws, ctx);
    const p = payloadOf(messages, 'skills.exported');
    expect(p?.skillCount).toBe(2);
    expect(typeof p?.zipBase64).toBe('string');
    expect((p!.zipBase64 as string).length).toBeGreaterThan(0);
  });
});

// ── skills.edit ───────────────────────────────────────────────────────

describe('handleSkillsEdit', () => {
  const editMsg = (name: string) => ({ payload: { name, body: 'new body' } });

  it('refuses to edit a foreign (read-only) skill — never writes into .claude', async () => {
    const loader = {
      listEntries: async () => [
        {
          name: 'foreign-skill',
          source: 'claude-project',
          path: '/.claude/skills/foreign-skill/SKILL.md',
          trigger: 't',
          scope: [],
        },
      ],
      readBody: async () => '',
    };
    const ctx = makeCtx({ skillLoader: loader as never });
    const { ws, messages } = openWs();
    await handleSkillsEdit(ws, ctx, editMsg('foreign-skill'));
    const p = payloadOf(messages, 'skills.edited');
    expect(p?.success).toBe(false);
    expect(p?.error).toMatch(/read-only/i);
  });

  it('refuses to edit a bundled skill', async () => {
    const loader = {
      listEntries: async () => [
        { name: 'b', source: 'bundled', path: '/b/SKILL.md', trigger: 't', scope: [] },
      ],
      readBody: async () => '',
    };
    const ctx = makeCtx({ skillLoader: loader as never });
    const { ws, messages } = openWs();
    await handleSkillsEdit(ws, ctx, editMsg('b'));
    const p = payloadOf(messages, 'skills.edited');
    expect(p?.success).toBe(false);
    expect(p?.error).toMatch(/Bundled/i);
  });
});
