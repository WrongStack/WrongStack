import type { MailboxAgentStatus } from '@wrongstack/coordination';
import { describe, expect, it } from 'vitest';
import { readPromptOnlineAgents } from '../src/server/prompt-online-agents.js';

const agent = { agentId: 'leader' } as unknown as MailboxAgentStatus;

describe('readPromptOnlineAgents', () => {
  it('returns the online agents the mailbox answers with', async () => {
    const agents = await readPromptOnlineAgents('/project', {
      mailbox: () => ({ getAgentStatuses: async () => [agent] }),
    });
    expect(agents).toEqual([agent]);
  });

  it('builds without the list when the mailbox server does not answer in time', async () => {
    const started = performance.now();
    const agents = await readPromptOnlineAgents('/project', {
      deadlineMs: 50,
      mailbox: () => ({ getAgentStatuses: () => new Promise<MailboxAgentStatus[]>(() => {}) }),
    });
    expect(agents).toEqual([]);
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it('builds without the list when the mailbox fails, synchronously or not', async () => {
    await expect(
      readPromptOnlineAgents('/project', {
        mailbox: () => {
          throw new Error('no server');
        },
      }),
    ).resolves.toEqual([]);
    await expect(
      readPromptOnlineAgents('/project', {
        mailbox: () => ({ getAgentStatuses: () => Promise.reject(new Error('refused')) }),
      }),
    ).resolves.toEqual([]);
  });
});
