import type { HqCommandAuditEntry } from '@wrongstack/hq';
import { afterEach, expect, it, vi } from 'vitest';
import { requestAcpSettings } from '../src/features/console/acp-settings-request.js';
import { useHqStore } from '../src/hq/data/store/index.js';

afterEach(() => {
  vi.unstubAllGlobals();
  useHqStore.setState({ commandStatuses: [] });
});
const status = (patch: Partial<HqCommandAuditEntry> = {}): HqCommandAuditEntry => ({
  commandId: 'command',
  type: 'acp-config',
  clientId: 'client',
  enqueuedBy: 'operator',
  enqueuedAt: new Date().toISOString(),
  status: 'queued',
  ...patch,
});
it('waits for this client acknowledgement rather than reporting a queued command as saved', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(JSON.stringify({ commandId: 'command', queued: true }), { status: 202 }),
    ),
  );
  let done = false;
  const pending = requestAcpSettings('client', 'session', 'fixture').then((result) => {
    done = true;
    return result;
  });
  useHqStore.getState().applyCommandStatus(status());
  await Promise.resolve();
  expect(done).toBe(false);
  useHqStore.getState().applyCommandStatus(
    status({
      clientId: 'different',
      status: 'acked',
      ackStatus: 'completed',
      acpConfig: { agentId: 'fixture', options: [], applied: {} },
    }),
  );
  await Promise.resolve();
  expect(done).toBe(false);
  useHqStore.getState().applyCommandStatus(
    status({
      status: 'acked',
      ackStatus: 'completed',
      acpConfig: { agentId: 'fixture', options: [], applied: { thought: 'ultra' } },
    }),
  );
  await expect(pending).resolves.toMatchObject({ applied: { thought: 'ultra' } });
});
it('observes a response that arrived before the HTTP enqueue response was consumed', async () => {
  const acpConfig = { agentId: 'fixture', options: [], applied: {} };
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      useHqStore
        .getState()
        .applyCommandStatus(status({ status: 'acked', ackStatus: 'completed', acpConfig }));
      return new Response(JSON.stringify({ commandId: 'command' }), { status: 202 });
    }),
  );
  await expect(requestAcpSettings('client', 'session', 'fixture')).resolves.toEqual(acpConfig);
});
it('returns a failed acknowledgement to the operator', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ commandId: 'command' }), { status: 202 })),
  );
  const pending = requestAcpSettings('client', 'session', 'fixture');
  useHqStore
    .getState()
    .applyCommandStatus(
      status({ status: 'acked', ackStatus: 'failed', ackMessage: 'Agent login required' }),
    );
  await expect(pending).rejects.toThrow('Agent login required');
});
