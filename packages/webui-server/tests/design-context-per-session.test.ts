import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type WebSocket from 'ws';
import { handleContentRoute } from '../src/server/content-routes.js';

/**
 * The Design Studio kit is a conversation-level choice.
 *
 * Picking a kit pins it on a context's `meta.designStudio`, and that meta is
 * what shapes the agent's system prompt — what it writes, and in which visual
 * language. The gallery pinned it on the LEADER's context, so a pick made in
 * tab 3 silently re-styled whatever tab happened to boot the process, on its
 * next turn, with nothing on screen to say why.
 *
 * The route now hands the design handlers the context of the tab that sent
 * the message, the same way `prefs.update` and `system_prompt.get` do.
 */

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-design-session-'));
});
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

const ws = {} as WebSocket;

function harness() {
  const asked: Array<string | undefined> = [];
  const ctx = {
    getProjectRoot: () => tmp,
    getSkillsContext: () => ({}) as never,
    getPromptsContext: () => ({}) as never,
    getDesignContext: (sessionId?: string) => {
      asked.push(sessionId);
      return { projectRoot: tmp };
    },
    onFileWritten: vi.fn(),
  } as never;
  return { ctx, asked };
}

describe('design messages carry the tab that sent them', () => {
  it.each([
    'design.list',
    'design.use',
    'design.state',
    'design.set',
    'design.tune',
    'design.swap',
    'design.materialize',
    'design.verify',
  ])('%s resolves the asking session', async (type) => {
    const h = harness();

    await handleContentRoute(h.ctx, ws, { type, payload: { sessionId: 'tab-3' } } as never);

    expect(h.asked).toEqual(['tab-3']);
  });

  it('leaves the session unnamed when the client did not stamp one', async () => {
    const h = harness();

    // A single-session host is entitled to the runtime's own context; the
    // fallback has to stay, or a CLI-embedded pick would land nowhere.
    await handleContentRoute(h.ctx, ws, { type: 'design.list' } as never);

    expect(h.asked).toEqual([undefined]);
  });

  it('echoes the asking tab in the response so the gallery can lane-route it', async () => {
    const h = harness();
    const sent: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const capturingWs = {
      readyState: 1,
      send: (data: string) => {
        sent.push(JSON.parse(data) as { type: string; payload: Record<string, unknown> });
      },
    } as never;

    await handleContentRoute(h.ctx, capturingWs, {
      type: 'design.list',
      payload: { sessionId: 'tab-3' },
    } as never);

    const reply = sent.find((m) => m.type === 'design.list');
    expect(reply?.payload.sessionId).toBe('tab-3');
  });

  it('stays untagged when the request carried no session', async () => {
    const h = harness();
    const sent: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const capturingWs = {
      readyState: 1,
      send: (data: string) => {
        sent.push(JSON.parse(data) as { type: string; payload: Record<string, unknown> });
      },
    } as never;

    await handleContentRoute(h.ctx, capturingWs, { type: 'design.list' } as never);

    const reply = sent.find((m) => m.type === 'design.list');
    expect(reply?.payload.sessionId).toBeUndefined();
  });
});
