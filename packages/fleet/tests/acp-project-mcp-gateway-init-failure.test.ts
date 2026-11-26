import { afterAll, describe, expect, it, vi } from 'vitest';

/**
 * F107: sharedAcpProjectMcpGateway initializes services (mailbox opened,
 * SAGE port spawned) BEFORE registerGrant. registerGrant throws when the
 * gateway is closed — reachable when process shutdown (or a test teardown)
 * closes the shared gateway while a worker's services are still initializing.
 * The throw propagated with the initialized services never released: the
 * mailbox stayed open and the SAGE port undisposed. The wrapper must release
 * its cleanups and fail open to the stdio fallback (its documented contract
 * for unavailable HTTP services).
 *
 * Only createProjectMailbox is mocked (a dependency): its initialize()
 * performs the concurrent shutdown, faithfully simulating the race. The
 * gateway, registerGrant and the wrapper under test are real.
 */
const hoisted = vi.hoisted(() => ({ mailboxClosed: 0 }));

vi.mock('@wrongstack/coordination', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@wrongstack/coordination')>();
  return {
    ...actual,
    createProjectMailbox: vi.fn(() => ({
      initialize: vi.fn(async () => {
        // Concurrent shutdown lands while this worker's services initialize.
        const mod = await import('../src/acp-project-mcp-gateway.js');
        await mod.closeSharedAcpProjectMcpGateway();
      }),
      close: vi.fn(async () => {
        hoisted.mailboxClosed++;
      }),
    })),
  };
});

import {
  closeSharedAcpProjectMcpGateway,
  sharedAcpProjectMcpGateway,
} from '../src/acp-project-mcp-gateway.js';

afterAll(async () => {
  await closeSharedAcpProjectMcpGateway();
});

describe('gateway grant failure releases initialized services (F107)', () => {
  it('fails open to stdio and closes the mailbox when the gateway closes mid-init', async () => {
    hoisted.mailboxClosed = 0;
    const grant = await sharedAcpProjectMcpGateway({
      servers: ['mailbox'],
      projectRoot: process.cwd(),
      actor: 'test-worker-f107',
      sessionId: 'sess-f107',
      role: 'executor',
    });
    expect(grant, 'closed gateway fails open to the stdio fallback').toBeUndefined();
    expect(hoisted.mailboxClosed, 'the initialized mailbox is released').toBe(1);
  });
});
