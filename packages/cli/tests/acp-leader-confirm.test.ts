/**
 * The ACP leader on the TUI and the WebUI: the agent's permission questions
 * are asked through the surface's own approval prompt (`tool.confirm_needed`,
 * in the session's tab), never answered by default, and `acp` is offered in
 * the WebUI pickers and built from the CLI's provider registry.
 */
import { EventBus } from '@wrongstack/contracts/kernel';
import type { Config, Tool } from '@wrongstack/contracts/types';
import { scopedApprovalPattern } from '@wrongstack/core/security';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/fleet/acp-wrongstack-bridge.js', () => ({
  installedBridgeAgents: (acp: { agents?: Record<string, unknown> } | undefined) =>
    acp?.agents ? Object.keys(acp.agents) : [],
}));

const { confirmThroughEvents } = await import('../src/acp-leader/acp-leader-confirm.js');
const { acpLeaderPickable, buildAcpLeaderProvider } = await import(
  '../src/acp-leader/acp-leader-picker.js'
);

const TOOL = { name: 'edit' } as Tool;
const CONTEXT = { cwd: '/proj', projectRoot: '/proj' } as never;
const DAY_MS = 24 * 60 * 60 * 1000;

function ask(events: EventBus, opts: { signal?: AbortSignal; timeoutMs?: number } = {}) {
  const permission = {
    trust: vi.fn(async (_rule: { tool: string; pattern: string; ttlMs?: number }) => {}),
    deny: vi.fn(async () => {}),
  };
  const answer = confirmThroughEvents({
    events,
    sessionId: 'tab-2',
    tool: TOOL,
    input: { path: 'a.ts' },
    toolUseId: 'toolu_1',
    suggestedPattern: 'a.ts',
    signal: opts.signal ?? new AbortController().signal,
    permission,
    context: CONTEXT,
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  });
  return { answer, permission };
}

describe('asking about an ACP leader call on the TUI or WebUI', () => {
  it("raises the surface's own prompt in the session's tab and follows the answer", async () => {
    const events = new EventBus();
    const resolved: string[] = [];
    events.on('tool.confirm_resolved', (e) => resolved.push(`${e.toolUseId} ${e.decision}`));
    events.on('tool.confirm_needed', (e) => {
      expect(e).toMatchObject({
        sessionId: 'tab-2',
        toolUseId: 'toolu_1',
        suggestedPattern: 'a.ts',
      });
      e.resolve('always');
    });

    const { answer, permission } = ask(events);

    await expect(answer).resolves.toBe(true);
    expect(permission.trust).toHaveBeenCalledWith({ tool: 'edit', pattern: 'a.ts', ttlMs: DAY_MS });
    expect(resolved).toEqual(['toolu_1 always']);
  });

  it('keeps an "always" answer in the scope the user picked, for a day, like the leader prompt', async () => {
    const events = new EventBus();
    events.on('tool.confirm_needed', (e) => e.resolve('always-exact'));
    const { answer, permission } = ask(events);
    await expect(answer).resolves.toBe(true);
    const rule = permission.trust.mock.calls[0]?.[0];
    // Not the broad 'a.ts' path rule, and not a permanent one.
    expect(rule?.ttlMs).toBe(DAY_MS);
    expect(rule?.pattern).toBe(
      scopedApprovalPattern('always-exact', TOOL, { path: 'a.ts' }, CONTEXT, 'a.ts'),
    );
    expect(rule?.pattern).not.toBe(
      scopedApprovalPattern('always-exact', TOOL, { path: 'b.ts' }, CONTEXT, 'b.ts'),
    );
  });

  it('refuses on no, remembers a deny, and refuses when nobody can answer', async () => {
    const events = new EventBus();
    const off = events.on('tool.confirm_needed', (e) => e.resolve('no'));
    await expect(ask(events).answer).resolves.toBe(false);
    off();

    events.on('tool.confirm_needed', (e) => e.resolve('deny'));
    const denied = ask(events);
    await expect(denied.answer).resolves.toBe(false);
    expect(denied.permission.deny).toHaveBeenCalledWith({ tool: 'edit', pattern: 'a.ts' });

    // No surface listening: a question nobody can answer is refused at once.
    await expect(ask(new EventBus()).answer).resolves.toBe(false);
  });

  it('refuses when nobody answers in time, or when the turn stops', async () => {
    const events = new EventBus();
    const resolved: string[] = [];
    events.on('tool.confirm_needed', () => {});
    events.on('tool.confirm_resolved', (e) => resolved.push(`${e.decision} ${e.source}`));
    await expect(ask(events, { timeoutMs: 5 }).answer).resolves.toBe(false);

    const stop = new AbortController();
    const pending = ask(events, { signal: stop.signal });
    stop.abort();
    await expect(pending.answer).resolves.toBe(false);
    expect(resolved).toEqual(['no brain_timeout', 'abort abort']);
  });
});

describe('acp in the WebUI pickers', () => {
  it('lists the installed agents under acp, and nothing when there are none', () => {
    expect(
      acpLeaderPickable({ acp: { agents: { 'claude-code': {} } } } as unknown as Config),
    ).toEqual([
      {
        id: 'acp',
        type: 'acp',
        models: [
          expect.objectContaining({
            id: 'claude-code',
            description: 'ACP agent leading the session',
          }),
        ],
      },
    ]);
    expect(acpLeaderPickable({} as Config)).toEqual([]);
  });

  it('builds acp from the provider registry and leaves every other provider alone', () => {
    const built = { id: 'acp' };
    const registry = { has: (type: string) => type === 'acp', create: vi.fn(() => built as never) };
    expect(buildAcpLeaderProvider(registry, 'acp', { type: 'acp' } as never)).toBe(built);
    expect(registry.create).toHaveBeenCalledWith({ type: 'acp' }, 'acp');
    expect(buildAcpLeaderProvider(registry, 'zai', { type: 'zai' } as never)).toBeUndefined();
    expect(buildAcpLeaderProvider(undefined, 'acp', {} as never)).toBeUndefined();
  });
});
