/**
 * A project-wide provider rebuild reaches every tab, and only the tabs it owns.
 *
 * WrongProxy toggles and credential hot-reloads rebuild the SAME provider with
 * a different base URL or key. The swap used to land on the root context only,
 * so every conversation opened before it kept the old object — routed the old
 * way, authenticated with the replaced key — with nothing on screen to say so.
 */
import { describe, expect, it } from 'vitest';
import { fanOutProviderRebuild } from '../src/server/provider-fanout.js';

const oldProvider = { id: 'openai', capabilities: {} } as never;
const rebuilt = { id: 'openai', capabilities: {} } as never;
const ownChoice = { id: 'anthropic', capabilities: {} } as never;

function ctx(provider: unknown) {
  return { provider } as never;
}

describe('fanOutProviderRebuild', () => {
  it('moves every conversation still on the replaced provider', () => {
    const root = ctx(rebuilt);
    const tab2 = ctx(oldProvider);
    const tab3 = ctx(oldProvider);
    const agents: Record<string, { ctx: never }> = { s2: { ctx: tab2 }, s3: { ctx: tab3 } };

    const moved = fanOutProviderRebuild({
      sessionAgentIds: () => ['s2', 's3'],
      peekAgent: (id) => (id ? agents[id] : undefined),
      previous: oldProvider,
      next: rebuilt,
      applied: root,
    });

    expect(moved.sort()).toEqual(['s2', 's3']);
    expect((tab2 as { provider: unknown }).provider).toBe(rebuilt);
    expect((tab3 as { provider: unknown }).provider).toBe(rebuilt);
  });

  it('leaves a tab that picked its own provider alone', () => {
    // A model switch is a per-conversation choice. Overwriting it here would
    // be exactly the cross-tab write this fan-out exists to avoid.
    const chosen = ctx(ownChoice);
    const agents: Record<string, { ctx: never }> = { s2: { ctx: chosen } };

    const moved = fanOutProviderRebuild({
      sessionAgentIds: () => ['s2'],
      peekAgent: (id) => (id ? agents[id] : undefined),
      previous: oldProvider,
      next: rebuilt,
      applied: ctx(rebuilt),
    });

    expect(moved).toEqual([]);
    expect((chosen as { provider: unknown }).provider).toBe(ownChoice);
  });

  it('is a no-op for a host with one conversation', () => {
    expect(
      fanOutProviderRebuild({
        previous: oldProvider,
        next: rebuilt,
        applied: ctx(rebuilt),
      }),
    ).toEqual([]);
  });

  it('never revisits the context that was already applied', () => {
    const root = ctx(rebuilt);
    const agents: Record<string, { ctx: never }> = { s1: { ctx: root } };
    expect(
      fanOutProviderRebuild({
        sessionAgentIds: () => ['s1'],
        peekAgent: (id) => (id ? agents[id] : undefined),
        previous: oldProvider,
        next: rebuilt,
        applied: root,
      }),
    ).toEqual([]);
  });
});
