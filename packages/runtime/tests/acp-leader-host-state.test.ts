/**
 * `@wrongstack/runtime` builds the ACP leader's host binding into two bundles
 * (`acp-leader-host`, loaded by the CLI on every exit, and `acp-leader`, the
 * provider). Each carries its own copy of acp-leader-host.ts, so the binding
 * must not live in module scope: a host bound through one copy has to be the
 * host the provider reads through the other, and a leader tracked by one is
 * closed by the other.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

type HostModule = typeof import('../src/acp-leader/acp-leader-host.js');

async function freshCopy(): Promise<HostModule> {
  vi.resetModules();
  return import('../src/acp-leader/acp-leader-host.js');
}

let copies: HostModule[] = [];
afterEach(() => {
  for (const copy of copies) {
    copy.bindAcpLeaderHost(undefined);
    copy.setAcpLeaderSessionAgents(undefined);
  }
  copies = [];
});

describe('the ACP leader host binding', () => {
  it('is one per process, whichever copy of the module binds or reads it', async () => {
    const cli = await freshCopy();
    const provider = await freshCopy();
    copies = [cli, provider];
    expect(provider).not.toBe(cli);

    const host = { projectRoot: '/proj' } as never;
    cli.bindAcpLeaderHost(host);
    expect(provider.acpLeaderHost()).toBe(host);

    const tab = { ctx: {} } as never;
    cli.setAcpLeaderSessionAgents((id) => (id === 'tab-2' ? tab : undefined));
    expect(provider.acpLeaderSessionAgent('tab-2')).toBe(tab);

    provider.confirmAcpLeaderThroughEvents();
    expect(cli.acpLeaderHost()?.confirmThroughEvents).toBe(true);
  });

  it('closes on exit every leader the other copy tracked', async () => {
    const cli = await freshCopy();
    const provider = await freshCopy();
    copies = [cli, provider];
    const closeAll = vi.fn(async () => undefined);
    provider.trackAcpLeader({ closeAll });
    await cli.closeAcpLeaderSessions();
    expect(closeAll).toHaveBeenCalledOnce();
  });

  it('knows which provider ids an agent leads under', async () => {
    const host = await freshCopy();
    copies = [host];
    expect(host.isHostBuiltLeader('acp')).toBe(true);
    expect(host.isHostBuiltLeader('wrongforge')).toBe(true);
    expect(host.isHostBuiltLeader('anthropic')).toBe(false);
    expect(host.isHostBuiltLeader(undefined)).toBe(false);
  });
});
