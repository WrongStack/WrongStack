/**
 * CLI-level smoke test for the Chimera subagent 429 → waiting-room wiring
 * fix in `packages/cli/src/fleet/host-subagent-factory.ts`.
 *
 * Mirrors the subagent dispatch path:
 *   1. `MultiAgentHostOptions.statusTracker` is populated by
 *      `brain-and-orchestration.ts` with the leader's shared
 *      `ProviderModelStatusTracker` instance.
 *   2. `createHostSubagentFactory(...)` reads `host.opts.statusTracker`
 *      and threads it into the subagent's `createFallbackModelExtension`
 *      call (the fix).
 *   3. A 429 from the subagent's first provider call lands on the
 *      fallback extension's `wrapProviderRunner`, which records the
 *      failure into the shared tracker.
 *   4. The shared tracker transitions the (provider, model) pair to
 *      `state: 'blocked'` (waiting room).
 *   5. `/provider-status` (waiting view) renders the blocked pair.
 *
 * The test wires a real tracker and the actual `createFallbackModelExtension`
 * together (not the full `MultiAgentHost` scaffold), then drives
 * `buildProviderStatusCommand(tracker).run('waiting')` to verify the user-
 * facing render reflects the new wiring within the same turn.
 */

import type { Context } from '@wrongstack/core/agent';
import { createFallbackModelExtension } from '@wrongstack/core/agent';
import { ProviderModelStatusTracker } from '@wrongstack/core/coordination';
import { EventBus } from '@wrongstack/core/kernel';
import type { Config, Provider, Request, Response } from '@wrongstack/core/types';
import { ProviderError } from '@wrongstack/core/types';
import { describe, expect, it, vi } from 'vitest';
import { buildProviderStatusCommand } from '../src/slash-commands/provider-status.js';

function makeProvider(id: string): Provider {
  return { id, capabilities: { streaming: false } } as never as Provider;
}

function makeConfig(): Config {
  return {
    provider: 'reviewer-primary',
    model: 'reviewer-model',
    fallbackModels: ['backup/reviewer-backup-model'],
    providers: {
      'reviewer-primary': { type: 'openai', apiKey: 'sk-primary' },
      backup: { type: 'openai', apiKey: 'sk-backup' },
    },
  } as never as Config;
}

const okResponse = {
  content: [{ type: 'text', text: 'review ok' }],
  stopReason: 'end_turn',
  usage: { input: 1, output: 1 },
  model: 'reviewer-backup-model',
} as never as Response;

describe('Chimera subagent 429 → /provider-status waiting room', () => {
  it('a single 429 in the subagent fallback extension transitions the pair to blocked and surfaces in /provider-status waiting', async () => {
    // 1. Stand up the shared tracker — the same singleton the leader would
    //    have populated via brain-and-orchestration.ts → MultiAgentHostOptions.
    const tracker = new ProviderModelStatusTracker();

    // 2. Stand up the subagent fallback extension with the tracker threaded
    //    through, exactly as the post-fix host-subagent-factory.ts wiring.
    const config = makeConfig();
    const ext = createFallbackModelExtension({
      getConfig: () => config,
      fallbackProfileManager: undefined as never,
      getFallbackModels: () => config.fallbackModels,
      getPrimaryTarget: () => ({ providerId: 'reviewer-primary', model: 'reviewer-model' }),
      buildProvider: async (providerId: string) => makeProvider(providerId),
      events: new EventBus(),
      statusTracker: tracker,
      now: () => 1_700_000_000_000,
    });

    // 3. Drive a subagent wrap call with a 429 rate_limit on the first
    //    inner invocation, mirroring the symptom Chimera reviewers were
    //    hitting on deepseek-v4-flash / MiniMax-M3.
    const ctx = {
      provider: makeProvider('reviewer-primary'),
      model: 'reviewer-model',
      session: { id: 'session-subagent-1' },
      agentId: 'chimera-review-1',
    } as never as Context;
    const request = {
      model: 'reviewer-model',
      messages: [],
      maxTokens: 100,
    } as never as Request;

    const inner = vi
      .fn()
      .mockRejectedValueOnce(
        new ProviderError('rate limited', 429, true, 'reviewer-primary', { kind: 'rate_limit' }),
      )
      .mockResolvedValueOnce(okResponse);

    const response = await ext.wrapProviderRunner?.(ctx, request, inner);

    // Fallback chain rotated to the backup model and succeeded.
    expect(response).toBe(okResponse);
    expect(ctx.model).toBe('reviewer-backup-model');

    // 4. Tracker must show the doomed pair as blocked — same singleton
    //    the leader's `/provider-status` command reads from.
    expect(tracker.isAvailable('reviewer-primary', 'reviewer-model')).toBe(false);
    const blocked = tracker.getBlocked();
    expect(blocked).toHaveLength(1);
    expect(blocked[0]?.providerId).toBe('reviewer-primary');
    expect(blocked[0]?.model).toBe('reviewer-model');
    expect(blocked[0]?.lastErrorKind).toBe('rate_limit');
    expect(blocked[0]?.stateExpiresAt).not.toBeNull();

    // 5. Render the user-facing /provider-status waiting view — the same
    //    slash command the leader would invoke at runtime. The blocked
    //    pair must surface in the output (proves the user sees the
    //    waiting-room entry, not just internal state).
    const result = await buildProviderStatusCommand(tracker).run('waiting');
    if (!result) throw new Error('/provider-status waiting returned no view');

    expect(result.message).toContain('reviewer-primary/reviewer-model');
    expect(result.message).toContain('blocked');
    expect(result.message).toContain('1 rate-limited');
  });

  it('the unfiltered /provider-status view also surfaces the blocked pair', async () => {
    // Same setup as above, but assert the default view (no subcommand)
    // reflects the block — that's the user-facing surface when they type
    // `/provider-status` without arguments.
    const tracker = new ProviderModelStatusTracker();
    const config = makeConfig();
    const ext = createFallbackModelExtension({
      getConfig: () => config,
      fallbackProfileManager: undefined as never,
      getFallbackModels: () => config.fallbackModels,
      getPrimaryTarget: () => ({ providerId: 'reviewer-primary', model: 'reviewer-model' }),
      buildProvider: async (providerId: string) => makeProvider(providerId),
      events: new EventBus(),
      statusTracker: tracker,
      now: () => 1_700_000_000_000,
    });

    const ctx = {
      provider: makeProvider('reviewer-primary'),
      model: 'reviewer-model',
      session: { id: 'session-subagent-2' },
      agentId: 'chimera-review-2',
    } as never as Context;
    const request = {
      model: 'reviewer-model',
      messages: [],
      maxTokens: 100,
    } as never as Request;

    const inner = vi
      .fn()
      .mockRejectedValueOnce(
        new ProviderError('rate limited', 429, true, 'reviewer-primary', {
          kind: 'rate_limit',
        }),
      )
      .mockResolvedValueOnce(okResponse);

    await ext.wrapProviderRunner?.(ctx, request, inner);

    const result = await buildProviderStatusCommand(tracker).run('');
    if (!result) throw new Error('/provider-status returned no view');

    // The default view shows summary counts plus every tracked pair.
    expect(result.message).toContain('Summary');
    expect(result.message).toContain('1 blocked');
    expect(result.message).toContain('reviewer-primary/reviewer-model');
  });
});
