/**
 * Code Assist route + prompt contract.
 *
 * The invariants worth locking here are not "does it answer" but the two
 * promises the panel makes to the user:
 *
 *  1. A run NEVER creates or swaps a session. If someone later "simplifies"
 *     this by routing through `session.new`, the user silently starts losing
 *     their foreground session and piling up junk sessions in their history —
 *     so this asserts on the exact frames that go out over the socket.
 *  2. A read-only run gets read-only capabilities and is told to recommend
 *     rather than edit. `fix` is the only preset that may write.
 */

import { EventBus } from '@wrongstack/contracts/kernel';
import type { AgentFactory } from '@wrongstack/core/coordination';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { buildCodeAssistPrompt } from '../src/server/code-assist-prompt.js';
import {
  createCodeAssistRouteHandlers,
  handleCodeAssistRoute,
  parseCodeAssistRunRequest,
} from '../src/server/code-assist-routes.js';
import type { WSClientMessage } from '../src/server/types.js';

interface Harness {
  ws: WebSocket;
  sent: Array<{ type: string; payload: Record<string, unknown> }>;
  sentTypes: () => string[];
  factoryArgs: Array<{ allowedCapabilities?: string[] }>;
  emitDelta: (text: string) => void;
  /** Runs INSIDE agent.run, i.e. after the route has subscribed to the bus. */
  duringRun: (fn: () => void) => void;
  run: (payload: unknown) => Promise<boolean>;
  abort: (requestId: string) => Promise<boolean>;
}

function makeHarness(
  opts: { finalText?: string; status?: string; runError?: Error } = {},
): Harness {
  const sent: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const factoryArgs: Array<{ allowedCapabilities?: string[] }> = [];
  const ws = { readyState: 1, send: vi.fn(), on: vi.fn() } as unknown as WebSocket;
  const events = new EventBus();
  // The route subscribes to `events` only AFTER the factory resolves, so a
  // delta can only be observed from inside agent.run.
  let duringRunHook: (() => void) | undefined;

  const factory: AgentFactory = (async (cfg: { allowedCapabilities?: string[] }) => {
    factoryArgs.push(cfg);
    return {
      agent: {
        run: async () => {
          duringRunHook?.();
          if (opts.runError) throw opts.runError;
          return { status: opts.status ?? 'done', finalText: opts.finalText ?? 'answer' };
        },
      },
      events,
      dispose: vi.fn(),
    };
  }) as unknown as AgentFactory;

  const handlers = createCodeAssistRouteHandlers({
    subagentFactory: factory,
    projectRoot: () => '/repo',
    send: (_ws, msg) => {
      sent.push(msg as { type: string; payload: Record<string, unknown> });
    },
  });

  return {
    ws,
    sent,
    sentTypes: () => sent.map((m) => m.type),
    factoryArgs,
    emitDelta: (text: string) => {
      events.emit('provider.text_delta', { text } as never);
    },
    duringRun: (fn: () => void) => {
      duringRunHook = fn;
    },
    run: (payload: unknown) =>
      handleCodeAssistRoute(
        ws,
        { type: 'code.assist.run', payload } as unknown as WSClientMessage,
        handlers,
      ),
    abort: (requestId: string) =>
      handleCodeAssistRoute(
        ws,
        { type: 'code.assist.abort', payload: { requestId } } as unknown as WSClientMessage,
        handlers,
      ),
  };
}

describe('code assist routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('streams started → delta → result and never touches a session', async () => {
    const h = makeHarness({ finalText: 'the analysis' });

    // Emit a delta from inside the run so the private bus is actually observed.
    const originalSend = h.sent.length;
    const promise = h.run({
      requestId: 'r1',
      filePath: 'src/a.ts',
      preset: 'overview',
    });
    h.emitDelta('partial ');
    await promise;

    expect(h.sentTypes()).toEqual(['code.assist.started', 'code.assist.result']);
    // The load-bearing assertion: nothing session-shaped may leave this route.
    for (const type of h.sentTypes()) {
      expect(type.startsWith('session.')).toBe(false);
      expect(type).not.toBe('user_message');
      expect(type).not.toBe('session.new');
    }
    expect(h.sent[originalSend]?.payload).toMatchObject({
      requestId: 'r1',
      preset: 'overview',
    });
    expect(h.sent.at(-1)?.payload).toMatchObject({
      status: 'done',
      text: 'the analysis',
      appliedEdits: false,
    });
  });

  it('forwards streamed deltas to the requesting panel only', async () => {
    const h = makeHarness();
    h.duringRun(() => {
      h.emitDelta('hello ');
      h.emitDelta('world');
    });
    await h.run({ requestId: 'r2', filePath: 'src/a.ts', preset: 'explain' });

    const deltas = h.sent.filter((m) => m.type === 'code.assist.delta');
    expect(deltas.map((d) => d.payload['text']).join('')).toBe('hello world');
  });

  it('gives read-only presets fs.read only and gives fix fs.write', async () => {
    const readOnly = makeHarness();
    await readOnly.run({ requestId: 'a', filePath: 'f.ts', preset: 'bugs' });
    expect(readOnly.factoryArgs[0]?.allowedCapabilities).toEqual(['fs.read']);

    const fixing = makeHarness();
    await fixing.run({ requestId: 'b', filePath: 'f.ts', preset: 'fix' });
    // `shell.restricted` is required, not incidental: the fix prompt orders the
    // agent to run typecheck/tests, which is unimplementable without it. A live
    // run with only fs.read+fs.write produced an agent that correctly refused to
    // edit because it could not verify. Still no network / package installs.
    expect(fixing.factoryArgs[0]?.allowedCapabilities).toEqual([
      'fs.read',
      'fs.write',
      'shell.restricted',
    ]);
  });

  it('does not let a custom question escalate to writes without opt-in', async () => {
    const silent = makeHarness();
    await silent.run({ requestId: 'c', filePath: 'f.ts', preset: 'custom', question: 'q' });
    expect(silent.factoryArgs[0]?.allowedCapabilities).toEqual(['fs.read']);

    const opted = makeHarness();
    await opted.run({
      requestId: 'd',
      filePath: 'f.ts',
      preset: 'custom',
      question: 'q',
      allowEdits: true,
    });
    expect(opted.factoryArgs[0]?.allowedCapabilities).toEqual([
      'fs.read',
      'fs.write',
      'shell.restricted',
    ]);
  });

  it('refuses malformed payloads with a terminal error instead of throwing', async () => {
    const h = makeHarness();
    await h.run({ requestId: 'r', filePath: '', preset: 'overview' });
    expect(h.sent.at(-1)).toMatchObject({ type: 'code.assist.result' });
    expect(h.sent.at(-1)?.payload['status']).toBe('error');
    expect(h.factoryArgs).toHaveLength(0);
  });

  it('rejects an unknown preset', () => {
    expect(parseCodeAssistRunRequest({ requestId: 'r', filePath: 'f.ts', preset: 'rm-rf' })).toBe(
      null,
    );
  });

  it('reports a non-done worker as an error result', async () => {
    const h = makeHarness({ status: 'failed' });
    await h.run({ requestId: 'r', filePath: 'f.ts', preset: 'overview' });
    expect(h.sent.at(-1)?.payload['status']).toBe('error');
  });

  it('treats abort of an unknown run as a no-op', async () => {
    const h = makeHarness();
    await h.abort('never-started');
    expect(h.sent).toHaveLength(0);
  });
});

describe('code assist prompt', () => {
  const base = { requestId: 'r', filePath: 'src/a.ts', symbol: 'doThing' } as const;

  it('demands index grounding and a report of the lookups it used', () => {
    const prompt = buildCodeAssistPrompt(
      { ...base, preset: 'explain' },
      {
        projectRoot: '/repo',
        allowEdits: false,
      },
    );
    expect(prompt).toContain('CODEBASE INDEX');
    expect(prompt).toContain('REPORT YOUR TOOL USE');
    expect(prompt).toContain('doThing');
    expect(prompt).toContain('src/a.ts');
  });

  it('forbids edits on a read-only run and tells it to recommend instead', () => {
    const prompt = buildCodeAssistPrompt(
      { ...base, preset: 'quality' },
      {
        projectRoot: '/repo',
        allowEdits: false,
      },
    );
    expect(prompt).toContain('READ-ONLY run');
    expect(prompt).toContain('RECOMMEND');
  });

  it('allows edits on a fix run and demands verification output', () => {
    const prompt = buildCodeAssistPrompt(
      { ...base, preset: 'fix' },
      {
        projectRoot: '/repo',
        allowEdits: true,
      },
    );
    expect(prompt).toContain('MAY edit files');
    expect(prompt).toContain('Verify it');
    expect(prompt).toContain('do not fundamentally break the system');
  });

  it('asks for a tests assessment on the general presets', () => {
    for (const preset of ['overview', 'quality', 'tests'] as const) {
      const prompt = buildCodeAssistPrompt(
        { ...base, preset },
        {
          projectRoot: '/repo',
          allowEdits: false,
        },
      );
      expect(prompt.toLowerCase()).toContain('test');
    }
  });
});
