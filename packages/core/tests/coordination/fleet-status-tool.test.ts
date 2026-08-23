/**
 * fleet_status — read-only live peer snapshot tool.
 *
 * Pins: self-registration (calling the tool makes YOU visible to peers),
 * peer listing with truncation, onlineOnly filtering, local-agent
 * enrichment (ctxPct/costUsd merged by name), and the no-peers summary.
 */
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeFleetStatusTool } from '../../src/coordination/fleet-status-tool.js';
import { SqliteMailbox } from '../../src/coordination/sqlite-mailbox.js';
import { mailboxSessionTag } from '../../src/coordination/mailbox-tool.js';
import type { AgentEntry } from '../../src/session-catalog/session-registry.js';

function mockCtx(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { meta: {}, ...overrides };
}

describe('makeFleetStatusTool', () => {
  let mailbox: SqliteMailbox;
  let dir: string;

  beforeEach(async () => {
    dir = path.join(os.tmpdir(), `ws-fleet-status-${randomUUID().slice(0, 8)}`);
    await fs.mkdir(dir, { recursive: true });
    mailbox = new SqliteMailbox(dir);
  });

  afterEach(async () => {
    await mailbox.close().catch(() => {});
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('reports "no other agents" when alone — and registers the caller', async () => {
    const tool = makeFleetStatusTool({ resolveMailbox: () => mailbox });
    const ctx = mockCtx({ meta: { agentId: 'leader', agentName: 'Leader' } });
    const res = (await tool.execute({}, ctx as never, {} as never)) as {
      ok: boolean;
      you: string;
      agents: { id: string; you: boolean }[];
      summary: string;
    };
    expect(res.ok).toBe(true);
    expect(res.you).toBe(`leader@${mailboxSessionTag('default')}`);
    expect(res.summary).toContain('No other agents');
    // Self-registration: the caller is now in the registry.
    expect(res.agents.some((a) => a.you)).toBe(true);
  });

  it('lists online peers with task snippets', async () => {
    await mailbox.registerAgent({
      agentId: 'einstein@abc12345',
      sessionId: 'other',
      name: 'Einstein',
      role: 'Executor',
      pid: 4242,
      source: 'cli',
    });
    await mailbox.heartbeat({
      agentId: 'einstein@abc12345',
      status: 'running',
      currentTask: 'x'.repeat(300),
      toolCalls: 7,
    });

    const tool = makeFleetStatusTool({ resolveMailbox: () => mailbox });
    const ctx = mockCtx({ meta: { agentId: 'leader' } });
    const res = (await tool.execute({}, ctx as never, {} as never)) as {
      agents: { name: string; you: boolean; status: string; currentTask?: string; toolCalls: number }[];
      onlineCount: number;
      summary: string;
    };
    const peer = res.agents.find((a) => a.name === 'Einstein');
    expect(peer).toBeDefined();
    expect(peer?.you).toBe(false);
    expect(peer?.status).toBe('running');
    expect(peer?.toolCalls).toBe(7);
    // 300-char task truncated to snippet length.
    expect(peer?.currentTask?.length ?? 0).toBeLessThanOrEqual(121);
    expect(peer?.currentTask?.endsWith('…')).toBe(true);
    expect(res.summary).toContain('Einstein');
  });

  it('enriches same-process peers from getLocalAgents by name', async () => {
    await mailbox.registerAgent({
      agentId: 'curie@abc12345',
      sessionId: 'other',
      name: 'Curie',
      pid: 4242,
      source: 'cli',
    });
    const local: AgentEntry[] = [
      {
        id: 'sub-1',
        name: 'Curie',
        status: 'running',
        currentTool: 'grep',
        iterations: 9,
        toolCalls: 33,
        costUsd: 0.42,
        ctxPct: 61,
        lastActivityAt: new Date().toISOString(),
      } as AgentEntry,
    ];
    const tool = makeFleetStatusTool({
      resolveMailbox: () => mailbox,
      getLocalAgents: () => local,
    });
    const res = (await tool.execute({}, mockCtx({ meta: { agentId: 'leader' } }) as never, {} as never)) as {
      agents: { name: string; currentTool?: string; iterations: number; toolCalls: number; ctxPct?: number; costUsd?: number }[];
    };
    const peer = res.agents.find((a) => a.name === 'Curie');
    expect(peer).toMatchObject({ currentTool: 'grep', iterations: 9, toolCalls: 33, ctxPct: 61, costUsd: 0.42 });
  });

  it('is read-only metadata-wise', () => {
    const tool = makeFleetStatusTool({ resolveMailbox: () => mailbox });
    expect(tool.mutating).toBe(false);
    expect(tool.permission).toBe('auto');
    expect(tool.capabilities).toContain('coordination.fleet.read');
  });
});
