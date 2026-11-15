/**
 * Regression: a prompt aborted while its session is still being created must
 * not leave that session open on the agent.
 *
 * `prompt()` races `session/new` against the caller's abort signal. When the
 * abort wins, the id is never adopted, so the late-session helper is the only
 * chance to release it. `session/cancel` only cancels a turn and releases
 * nothing, so an agent that advertises `sessionCapabilities.close` must get a
 * real `session/close`; an agent without the capability keeps the cancel.
 */
import { describe, expect, it } from 'vitest';
import { ACPSession, textContent } from '../src/client/acp-session.js';
import type { ACPMessage } from '../src/types/acp-messages.js';

const tick = () => new Promise((r) => setTimeout(r, 5));

class LateCreationAgent {
  sent: ACPMessage[] = [];
  private handlers: Array<(m: ACPMessage) => void> = [];
  private pendingNewId: string | number | null = null;

  constructor(private readonly supportsClose: boolean) {}

  async start(): Promise<void> {}

  stop(): void {}

  onMessage(h: (m: ACPMessage) => void): () => void {
    this.handlers.push(h);
    return () => {};
  }

  async send(m: ACPMessage): Promise<void> {
    this.sent.push(m);
    if (m.method === 'initialize') {
      setImmediate(() =>
        this.emit({
          method: 'initialize',
          id: m.id,
          result: {
            protocolVersion: 1,
            agentCapabilities: this.supportsClose ? { sessionCapabilities: { close: {} } } : {},
            agentInfo: { name: 'fake', version: '1' },
            authMethods: [],
          },
        } as never as ACPMessage),
      );
    } else if (m.method === 'session/new') {
      // Withheld so the caller aborts while creation is still in flight.
      this.pendingNewId = m.id as string | number;
    }
  }

  /** The abandoned creation completing after its waiter gave up. */
  completeCreation(sessionId = 'sess_late'): void {
    const id = this.pendingNewId;
    if (id === null) throw new Error('session/new was never sent');
    this.emit({
      method: 'session/new',
      id,
      result: { sessionId, modes: { currentModeId: 'code', availableModes: [{ id: 'code' }] } },
    } as never as ACPMessage);
  }

  methods(): string[] {
    return this.sent
      .map((m) => m.method)
      .filter((method) => method === 'session/close' || method === 'session/cancel');
  }

  private emit(m: ACPMessage): void {
    for (const h of [...this.handlers]) h(m);
  }
}

async function abortDuringCreation(supportsClose: boolean): Promise<LateCreationAgent> {
  const agent = new LateCreationAgent(supportsClose);
  const session = await ACPSession.connect(agent as never, {
    command: 'fake',
    projectRoot: process.cwd(),
  });
  try {
    const controller = new AbortController();
    const pending = session.prompt([textContent('hello')], controller.signal);
    for (let i = 0; i < 20 && !agent.sent.some((m) => m.method === 'session/new'); i++) {
      await tick();
    }
    controller.abort();
    await expect(pending).resolves.toMatchObject({ stopReason: 'cancelled' });
    agent.completeCreation();
    await tick();
    await tick();
    return agent;
  } finally {
    await session.close();
  }
}

describe('abort during session creation releases the abandoned session', () => {
  it('closes it when the agent advertises session/close', async () => {
    const agent = await abortDuringCreation(true);
    const closed = agent.sent.filter((m) => m.method === 'session/close');
    expect(agent.methods()).toEqual(['session/close']);
    expect(closed[0]?.params).toEqual({ sessionId: 'sess_late' });
    expect(typeof closed[0]?.id).toBe('number');
  });

  it('keeps the session/cancel fallback for an agent that cannot close', async () => {
    const agent = await abortDuringCreation(false);
    expect(agent.methods()).toEqual(['session/cancel']);
    expect(agent.sent.some((m) => m.method === 'session/close')).toBe(false);
  });
});
