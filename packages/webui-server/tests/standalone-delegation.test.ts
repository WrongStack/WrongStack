import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventBus, TOKENS } from '@wrongstack/contracts/kernel';
import type { Config } from '@wrongstack/contracts/types';
import { ToolRegistry } from '@wrongstack/core/registry';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createStandaloneAutoWake,
  installStandaloneDelegation,
  type StandaloneDelegationInput,
} from '../src/server/standalone-delegation.js';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ws-standalone-delegation-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function makeInput(
  overrides: { config?: Partial<Config>; omit?: symbol[] } = {},
): StandaloneDelegationInput & { bound: Map<unknown, () => unknown> } {
  const services = new Map<unknown, unknown>([
    [TOKENS.ConfigStore, { get: () => ({}) }],
    [TOKENS.SystemPromptBuilder, { build: async () => [] }],
    [TOKENS.FallbackProfileManager, {}],
    [TOKENS.SecretScrubber, { scrub: (text: string) => text }],
  ]);
  for (const token of overrides.omit ?? []) services.delete(token);
  const bound = new Map<unknown, () => unknown>();
  const container = {
    safeResolve: (token: unknown) => services.get(token) ?? bound.get(token)?.(),
    resolve: (token: unknown) => services.get(token) ?? bound.get(token)?.(),
    has: (token: unknown) => services.has(token) || bound.has(token),
    bind: (token: unknown, factory: () => unknown) => bound.set(token, factory),
  };
  const config = { provider: 'p', model: 'm', ...overrides.config } as Config;
  return {
    bound,
    container: container as unknown as StandaloneDelegationInput['container'],
    toolRegistry: new ToolRegistry(),
    providerRegistry: {} as StandaloneDelegationInput['providerRegistry'],
    modelsRegistry: {} as StandaloneDelegationInput['modelsRegistry'],
    events: new EventBus(),
    tokenCounter: {} as StandaloneDelegationInput['tokenCounter'],
    skillLoader: undefined,
    tracer: undefined,
    config,
    getConfig: () => config,
    projectRoot: root,
    cwd: root,
    projectSessionsDir: join(root, 'sessions'),
    session: { id: 'boot-session' } as StandaloneDelegationInput['session'],
  };
}

describe('installStandaloneDelegation', () => {
  it('registers the delegate tool for the leader and binds one delegation tracker', async () => {
    const input = makeInput();
    const delegation = installStandaloneDelegation(input);
    expect(delegation).toBeDefined();
    expect(input.toolRegistry.get('delegate')).toBeDefined();
    expect(input.toolRegistry.listForProvider().map((tool) => tool.name)).toContain('delegate');
    expect(input.bound.get(TOKENS.DelegationTracker)?.()).toBe(delegation?.tracker);
    await delegation?.dispose();
  });

  it('binds auto-wake to the engine conversation path and starts a turn for an idle leader', async () => {
    // The controller reads `fleet.delegate` live; no debounce keeps the wake inside the poll.
    const input = makeInput({
      config: { fleet: { delegate: { autoWakeDebounceMs: 0 } } } as Partial<Config>,
    });
    const delegation = installStandaloneDelegation(input);
    const started: Array<[string, string]> = [];
    const wake = delegation?.attachAutoWake({
      abortControllers: new Map(),
      pendingConfirms: new Map(),
      isOpen: (id) => id === 'tab-1',
      isDisplayed: (id) => id === 'tab-1',
      broadcast: () => undefined,
    });
    expect(wake?.port.isOpen('tab-1')).toBe(true);
    expect(wake?.port.isOpen('tab-2')).toBe(false);
    wake?.bindRuntimeTurnStarter(async (sessionId, prompt) => {
      started.push([sessionId, prompt]);
      return true;
    });
    const { leaderDeliveryHub } = await import('@wrongstack/coordination');
    leaderDeliveryHub.enqueue(
      {
        deliveryId: 'dlv_standalone_1',
        sessionId: 'tab-1',
        kind: 'delegation_result',
        createdAt: Date.now(),
        wake: true,
        payload: {
          delegationId: 'del_standalone_1',
          target: 'explore',
          task: 'map the module',
          ok: true,
          handoffs: 0,
          summary: 'done',
        },
      },
      { events: input.events },
    );
    await expect.poll(() => started.length).toBe(1);
    expect(started[0]?.[0]).toBe('tab-1');
    leaderDeliveryHub.take('tab-1', { maxItems: 10, maxChars: 100_000 });
    await delegation?.dispose();
  });

  it('has no workers to stop before any delegation ran', async () => {
    const delegation = installStandaloneDelegation(makeInput());
    expect(delegation?.stopSession('tab-1', ['w-1'])).toBeUndefined();
    await delegation?.dispose();
  });

  it('keeps delegate off when tools.disabledTools names it', () => {
    const input = makeInput({
      config: { tools: { disabledTools: ['delegate'] } } as Partial<Config>,
    });
    expect(installStandaloneDelegation(input)).toBeUndefined();
    expect(input.toolRegistry.get('delegate')).toBeUndefined();
  });

  it('wakes an idle leader for a runtime notice without the delegate tool', async () => {
    // `delegate` disabled: the engine still owns an auto-wake for timers and watches.
    const config = {
      provider: 'p',
      model: 'm',
      tools: { disabledTools: ['delegate'] },
      fleet: { delegate: { autoWakeDebounceMs: 0 } },
    } as unknown as Config;
    const events = new EventBus();
    const autoWake = createStandaloneAutoWake({ events, getConfig: () => config });
    const started: Array<[string, string]> = [];
    const wake = autoWake.attachAutoWake({
      abortControllers: new Map(),
      pendingConfirms: new Map(),
      isOpen: (id) => id === 'tab-notice',
      isDisplayed: (id) => id === 'tab-notice',
      broadcast: () => undefined,
    });
    wake.bindRuntimeTurnStarter(async (sessionId, prompt) => {
      started.push([sessionId, prompt]);
      return true;
    });
    const { enqueueRuntimeNotice, leaderDeliveryHub } = await import('@wrongstack/coordination');
    enqueueRuntimeNotice(
      'tab-notice',
      { source: 'timer', handle: 'wk-standalone', seq: 1, title: 'fired' },
      { events },
    );
    try {
      await expect.poll(() => started.length).toBe(1);
      expect(started[0]).toEqual([
        'tab-notice',
        '[AUTO-WAKE] Runtime notice(s) arrived: timer:wk-standalone#1. Review and continue.',
      ]);
    } finally {
      leaderDeliveryHub.take('tab-notice', { maxItems: 10, maxChars: 100_000 });
      autoWake.dispose();
    }
  });

  it('registers nothing when the engine has no fallback profile manager', () => {
    const input = makeInput({ omit: [TOKENS.FallbackProfileManager] });
    expect(installStandaloneDelegation(input)).toBeUndefined();
    expect(input.toolRegistry.get('delegate')).toBeUndefined();
  });
});
