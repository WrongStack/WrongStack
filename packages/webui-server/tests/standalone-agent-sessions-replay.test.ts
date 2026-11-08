import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventBus, TOKENS } from '@wrongstack/contracts/kernel';
import type { Config } from '@wrongstack/contracts/types';
import { ToolRegistry } from '@wrongstack/core/registry';
import { sessionScopedPath } from '@wrongstack/core/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type WebSocket from 'ws';
import { createConnectionHandler } from '../src/server/connection-handler.js';
import type { LoadAgentSessions } from '../src/server/session-agent-sessions.js';
import {
  installStandaloneDelegation,
  type StandaloneDelegationInput,
} from '../src/server/standalone-delegation.js';

/**
 * A reopened desktop conversation used to come back with an empty agent panel: the standalone
 * engine never ran an agent monitor (so no worker transcript was ever written) and its connect
 * payload never carried `agentSessions`. Desktop reopens a conversation by booting an engine
 * that resumes it on a private socket; the window then connects, so the connect payload is the
 * replay it shows (CLI parity: `cli/src/webui-server/connection-handler.ts`). The shared
 * `session.resume` reply deliberately stays without it (`session-live-resume.test.ts`).
 */

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ws-agent-sessions-replay-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const SPAWNED = [
  { type: 'agent_spawned', ts: '2026-11-08T10:00:00.000Z', agentId: 'sub-1', role: 'coder' },
];
const LINE = {
  id: 'e1',
  subagentId: 'sub-1',
  agentName: 'coder',
  ts: '2026-11-08T10:00:01.000Z',
  kind: 'text',
  content: 'refactored the parser',
  iteration: 1,
};
const loader: LoadAgentSessions = async (ids) =>
  ids.map((subagentId) => ({ subagentId, agentName: 'coder', transcript: [LINE] }));

async function writeTranscript(transcriptsDir: string, id: string): Promise<void> {
  await mkdir(join(transcriptsDir, id), { recursive: true });
  await writeFile(
    join(transcriptsDir, id, 'transcript.jsonl'),
    `${JSON.stringify({ ...LINE, subagentId: id })}\n`,
  );
}

describe('the standalone connect payload carries the subagents', () => {
  it('adds agentSessions to the first session.start', async () => {
    const handler = createConnectionHandler({
      getSessionId: () => 'sess_boot',
      sessionStartPayload: async () => ({ sessionId: 'sess_boot' }),
      tokenCounter: { total: () => ({}) } as never,
      context: { agentId: 'a', projectRoot: '/repo', messages: [] } as never,
      loadReplay: async () => ({ messages: [], events: SPAWNED as never }),
      loadAgentSessions: loader,
      clients: new Map(),
      pendingConfirms: new Map(),
      goalHandler: { addClient: vi.fn() } as never,
      specsHandler: { addClient: vi.fn() } as never,
      sddBoardHandler: { addClient: vi.fn() } as never,
      sddWizardHandler: { addClient: vi.fn() } as never,
      worktreeHandler: { addClient: vi.fn() } as never,
      collabHandler: { addClient: vi.fn() } as never,
      terminalHandler: { addClient: vi.fn() } as never,
      handleMessage: vi.fn(),
    });
    const ws = new EventEmitter() as unknown as WebSocket;
    Object.defineProperty(ws, 'readyState', { value: 1 });
    const frames: Array<{ type: string; payload: Record<string, unknown> }> = [];
    ws.send = ((raw: string) => frames.push(JSON.parse(raw))) as never;
    ws.close = vi.fn() as never;

    handler(ws);

    await vi.waitFor(() => expect(frames.some((f) => f.type === 'session.start')).toBe(true));
    const start = frames.find((f) => f.type === 'session.start');
    expect(start?.payload['agentSessions']).toEqual([
      expect.objectContaining({ subagentId: 'sub-1', transcript: [LINE] }),
    ]);
  });
});

function delegationInput(): StandaloneDelegationInput {
  const services = new Map<unknown, unknown>([
    [TOKENS.ConfigStore, { get: () => ({}) }],
    [TOKENS.SystemPromptBuilder, { build: async () => [] }],
    [TOKENS.FallbackProfileManager, {}],
    [TOKENS.SecretScrubber, { scrub: (text: string) => text }],
  ]);
  const container = {
    safeResolve: (token: unknown) => services.get(token),
    resolve: (token: unknown) => services.get(token),
    has: (token: unknown) => services.has(token),
    bind: () => undefined,
  };
  const config = { provider: 'p', model: 'm' } as Config;
  return {
    container: container as never,
    toolRegistry: new ToolRegistry(),
    providerRegistry: {} as never,
    modelsRegistry: {} as never,
    events: new EventBus(),
    tokenCounter: {} as never,
    skillLoader: undefined,
    tracer: undefined,
    config,
    getConfig: () => config,
    projectRoot: root,
    cwd: root,
    projectSessionsDir: join(root, 'sessions'),
    session: { id: 'boot-session' } as never,
  };
}

describe('the standalone engine keeps its workers’ transcripts', () => {
  it('reads back a transcript this engine’s agent monitor wrote', async () => {
    const delegation = installStandaloneDelegation(delegationInput());
    if (!delegation) throw new Error('delegation was not installed');
    // The fleet host starts the monitor with its director: that is what records the
    // transcripts and emits the `agent.timeline.message` frames the desktop folds live.
    const hostOptions = (delegation.host as unknown as { opts: Record<string, unknown> }).opts;
    expect(hostOptions['agentMonitor']).toBeDefined();
    const fleetRoot = sessionScopedPath(join(root, 'sessions'), 'boot-session', '');
    await writeTranscript(join(fleetRoot, 'subagents', 'transcripts'), 'sub-1');

    const rows = await delegation?.loadAgentSessions(['sub-1']);

    expect(rows?.[0]?.transcript?.[0]?.content).toBe('refactored the parser');
    await delegation?.dispose();
  });

  it('finds a transcript an earlier engine process wrote, through the journal’s session path', async () => {
    const delegation = installStandaloneDelegation(delegationInput());
    const oldFleet = sessionScopedPath(join(root, 'sessions'), 'old-boot', '');
    await writeTranscript(join(oldFleet, 'subagents', 'transcripts'), 'sub-2');

    const rows = await delegation?.loadAgentSessions(
      ['sub-2'],
      [
        {
          agentId: 'sub-2',
          status: 'completed',
          interleavedEventCount: 0,
          transcriptPath: join(oldFleet, 'subagents', 'old-boot', 'sub-2.jsonl'),
        },
      ],
    );

    expect(rows?.map((row) => row.subagentId)).toEqual(['sub-2']);
    expect(rows?.[0]?.transcript?.[0]?.content).toBe('refactored the parser');
    await delegation?.dispose();
  });
});
