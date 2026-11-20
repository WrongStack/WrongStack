import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventBus } from '@wrongstack/contracts/kernel';
import type { ConfirmAwaiter, Provider, SessionWriter, Tool } from '@wrongstack/contracts/types';
import { Context } from '@wrongstack/core/agent';
import { DefaultTokenCounter } from '@wrongstack/core/infrastructure';
import { DefaultPermissionPolicy } from '@wrongstack/core/security';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AcpLeaderHost } from '../src/acp-leader/acp-leader-host.js';
import { startLeaderGateway } from '../src/wrongforge-leader/wrongforge-leader-gateway.js';

type Answer = Awaited<ReturnType<ConfirmAwaiter>>;
const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function exercise(answer: Answer, surface: 'repl' | 'events') {
  const directory = await mkdtemp(
    path.join(process.env['WRONGSTACK_BUGHUNT_FIXTURES'] ?? os.tmpdir(), 'wf-confirm-'),
  );
  directories.push(directory);
  const trustFile = path.join(directory, 'trust.json');
  await writeFile(trustFile, '{}');
  const policy = new DefaultPermissionPolicy({ trustFile, yolo: false });
  const events = new EventBus();
  const input = { path: 'a.ts' };
  const tool: Tool = {
    name: 'edit',
    description: 'Edit a file',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
    permission: 'confirm',
    mutating: true,
    subjectKey: 'path',
    execute: async () => 'edited',
  };
  const ctx = new Context({
    cwd: directory,
    projectRoot: directory,
    model: 'fixture',
    tools: [tool],
    systemPrompt: [],
    signal: new AbortController().signal,
    tokenCounter: new DefaultTokenCounter(),
    provider: {
      id: 'fixture',
      capabilities: {
        tools: false,
        parallelTools: false,
        vision: false,
        streaming: false,
        promptCache: false,
        systemPrompt: false,
        jsonMode: false,
        reasoning: false,
        maxContext: 0,
        cacheControl: 'none',
      },
      stream: vi.fn<Provider['stream']>(),
      complete: vi.fn<Provider['complete']>(),
    },
    session: {
      id: 'test-session',
      pendingToolUses: [],
      append: vi.fn<SessionWriter['append']>(),
      appendBatch: vi.fn<SessionWriter['appendBatch']>(),
      flush: vi.fn<SessionWriter['flush']>(),
      close: vi.fn<SessionWriter['close']>(),
      recordFileChange: vi.fn<SessionWriter['recordFileChange']>(),
      recordSideEffect: vi.fn<SessionWriter['recordSideEffect']>(),
      writeCheckpoint: vi.fn<SessionWriter['writeCheckpoint']>(),
      writeFileSnapshot: vi.fn<SessionWriter['writeFileSnapshot']>(),
      truncateToCheckpoint: vi.fn<SessionWriter['truncateToCheckpoint']>(),
      clearSession: vi.fn<SessionWriter['clearSession']>(),
      writeInFlightMarker: vi.fn<SessionWriter['writeInFlightMarker']>(),
      clearInFlightMarker: vi.fn<SessionWriter['clearInFlightMarker']>(),
    },
  });
  if (surface === 'events') events.on('tool.confirm_needed', (event) => event.resolve(answer));
  const host: AcpLeaderHost = {
    events,
    projectRoot: directory,
    getConfig: vi.fn<AcpLeaderHost['getConfig']>(),
    getTool: () => tool,
    listTools: () => [tool],
    permission: () => policy,
    context: () => ctx,
    ...(surface === 'repl'
      ? { confirmAwaiter: async () => answer }
      : { confirmThroughEvents: true }),
    // The host owns execution; the gateway supplies its real approval callback.
    runTool: async (_name, args, run) => {
      const approved = await run?.approve?.(tool, args);
      return { content: approved ? 'edited' : 'denied', isError: !approved };
    },
  };
  expect((await policy.evaluate(tool, input, ctx)).permission).toBe('confirm');
  const gateway = await startLeaderGateway(host, 'test-session');
  if (!gateway) throw new Error('Expected an offered edit tool');
  try {
    const response = await fetch(`${gateway.spec.url}/v1/tools/edit/call`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${gateway.spec.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ input }),
      signal: AbortSignal.timeout(10_000),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: answer !== 'no' && answer !== 'deny' });
    // Reload from disk: the next call and a resumed session must honor the answer.
    const nextPolicy = new DefaultPermissionPolicy({ trustFile, yolo: false });
    return {
      same: await nextPolicy.evaluate(tool, input, ctx),
      other: await nextPolicy.evaluate(tool, { path: 'b.ts' }, ctx),
    };
  } finally {
    await gateway.close();
  }
}

describe('WrongForge leader gateway remembers confirmation scope on every surface', () => {
  it('control: event-surface always-exact persists only the approved input', async () => {
    const result = await exercise('always-exact', 'events');
    expect(result.same).toMatchObject({ permission: 'auto', approvalGrant: true });
    expect(result.other.permission).toBe('confirm');
  });

  it('persists REPL always-exact instead of asking again for the same input', async () => {
    const result = await exercise('always-exact', 'repl');
    expect(result.same).toMatchObject({ permission: 'auto', approvalGrant: true });
    expect(result.other.permission).toBe('confirm');
  });

  it('persists a REPL deny instead of offering the refused path again', async () => {
    const result = await exercise('deny', 'repl');
    expect(result.same.permission).toBe('deny');
    expect(result.other.permission).toBe('confirm');
  });

  it.each(['yes', 'no'] as const)('keeps a one-call REPL %s ephemeral', async (answer) => {
    const result = await exercise(answer, 'repl');
    expect(result.same.permission).toBe('confirm');
    expect(result.other.permission).toBe('confirm');
  });
});
