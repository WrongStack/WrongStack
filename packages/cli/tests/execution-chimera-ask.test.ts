import { afterEach, describe, expect, it, vi } from 'vitest';
import { waitForChimeraAskApproval } from '../src/execution-chimera-ask.js';

afterEach(() => {
  vi.restoreAllMocks();
});

function reply(body: string, overrides: Record<string, unknown> = {}) {
  return {
    id: 'reply-1',
    from: 'leader@session',
    audience: 'all',
    body,
    ...overrides,
  };
}

function harness(queryResults: unknown[], append = vi.fn().mockResolvedValue(undefined)) {
  const query = vi.fn();
  for (const result of queryResults) query.mockResolvedValueOnce(result);
  query.mockResolvedValue([]);
  const mailbox = { query, ack: vi.fn().mockResolvedValue(undefined) };
  const session = { append };
  return { mailbox, session, query };
}

describe('waitForChimeraAskApproval', () => {
  it.each(['yes', '👍 ship it', 'I definitely approve this'])(
    'accepts a leader approval: %s',
    async (body) => {
      const { mailbox, session } = harness([[reply(body)]]);
      await expect(
        waitForChimeraAskApproval({
          mailbox: mailbox as never,
          messageId: 'ask-1',
          meta: { chimeraPollIntervalMs: 0 },
          session: session as never,
          askTimeoutMs: 100,
        }),
      ).resolves.toBe(true);
      expect(mailbox.ack).toHaveBeenCalledWith(
        expect.objectContaining({ messageId: 'reply-1', completed: true }),
      );
      expect(session.append).not.toHaveBeenCalled();
    },
  );

  it('records explicit rejection and tolerates acknowledgement failure', async () => {
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { mailbox, session } = harness([[reply("don't do it")]]);
    mailbox.ack.mockRejectedValueOnce('ack failed');

    await expect(
      waitForChimeraAskApproval({
        mailbox: mailbox as never,
        messageId: 'ask-1',
        meta: { chimeraPollIntervalMs: 0 },
        session: session as never,
        askTimeoutMs: 100,
      }),
    ).resolves.toBe(false);

    expect(session.append).toHaveBeenCalledWith(expect.objectContaining({ type: 'llm_response' }));
    expect(warnings.mock.calls.flat().join(' ')).toContain('chimera_ask_ack_failed');
    expect(warnings.mock.calls.flat().join(' ')).toContain('chimera_ask_rejected');
  });

  it('times out immediately, including aborted and non-finite polling requests', async () => {
    const append = vi.fn().mockRejectedValue(new Error('closed'));
    const { mailbox, session } = harness([], append);
    const controller = new AbortController();
    controller.abort();

    await expect(
      waitForChimeraAskApproval({
        mailbox: mailbox as never,
        messageId: 'ask-1',
        meta: {
          chimeraPollIntervalMs: Number.NaN,
          chimeraAbortSignal: controller.signal,
        },
        session: session as never,
        askTimeoutMs: 100,
      }),
    ).resolves.toBe(false);
    expect(mailbox.query).toHaveBeenCalledOnce();
    expect(append).toHaveBeenCalledOnce();
  });

  it('stops after five non-leader replies', async () => {
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const nonLeader = [reply('yes', { from: 'worker@session' })];
    const { mailbox, session } = harness([nonLeader, nonLeader, nonLeader, nonLeader, nonLeader]);

    await expect(
      waitForChimeraAskApproval({
        mailbox: mailbox as never,
        messageId: 'ask-1',
        meta: { chimeraPollIntervalMs: 0 },
        session: session as never,
        askTimeoutMs: 1_000,
      }),
    ).resolves.toBe(false);
    expect(mailbox.query).toHaveBeenCalledTimes(5);
    expect(warnings.mock.calls.flat().join(' ')).toContain(
      'execution.chimera_ask_non_leader_threshold',
    );
  });
});
