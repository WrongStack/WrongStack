/**
 * Abort-listener leak regression for the OAuth login flows.
 *
 * `signal.addEventListener('abort', fn, { once: true })` fires at most once —
 * it does NOT unregister when the awaited work finishes normally. Every login
 * flow here takes a CALLER-owned signal (the TUI auth panel hands the same
 * long-lived AbortSignal to each attempt), so a flow that never detaches pins
 * its AbortController and closure for the life of that signal. Three flows had
 * this; the Copilot CLI flow did not, which is what made it a drift bug rather
 * than an unknown one.
 *
 * The test asserts the observable consequence — listener count returns to zero
 * after the flow settles — rather than the implementation, so it keeps holding
 * if the cleanup moves.
 */
import * as http from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Count listeners on an AbortSignal. `EventTarget` exposes no such API, so we
 * wrap add/remove and track the delta — which is exactly the property under
 * test (every add is matched by a remove).
 */
function trackedSignal(): { signal: AbortSignal; live: () => number } {
  const ac = new AbortController();
  const signal = ac.signal;
  let live = 0;
  const add = signal.addEventListener.bind(signal);
  const remove = signal.removeEventListener.bind(signal);
  signal.addEventListener = ((type: string, ...rest: unknown[]) => {
    if (type === 'abort') live += 1;
    return (add as (...a: unknown[]) => void)(type, ...rest);
  }) as typeof signal.addEventListener;
  signal.removeEventListener = ((type: string, ...rest: unknown[]) => {
    if (type === 'abort') live -= 1;
    return (remove as (...a: unknown[]) => void)(type, ...rest);
  }) as typeof signal.removeEventListener;
  return { signal, live: () => live };
}

/** Occupy the flow's loopback callback ports so it takes the manual-paste path. */
async function occupy(ports: readonly number[]): Promise<() => Promise<void>> {
  const servers: http.Server[] = [];
  for (const port of ports) {
    const s = http.createServer(() => {});
    // A port already taken by something else on the dev machine is fine — the
    // flow just sees "busy" either way, which is what we want.
    await new Promise<void>((resolve) => {
      s.once('error', () => resolve());
      s.listen(port, '127.0.0.1', () => resolve());
    });
    servers.push(s);
  }
  return async () => {
    for (const s of servers) await new Promise<void>((r) => s.close(() => r()));
  };
}

const silentDeps = () => ({
  renderer: { write: vi.fn(), writeError: vi.fn(), writeInfo: vi.fn() },
  // Manual-paste prompt: decline immediately so the flow returns without
  // touching the network or persisting anything.
  reader: { readLine: vi.fn().mockResolvedValue('q') },
  modelsRegistry: { getProvider: vi.fn().mockResolvedValue(undefined) },
  profileConfigPath: 'unused-config.json',
  vault: { encrypt: (v: string) => v, decrypt: (v: string) => v, isEncrypted: () => false },
});

let release: (() => Promise<void>) | undefined;

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(async () => {
  await release?.();
  release = undefined;
});

describe('OAuth login flows detach their abort listener', () => {
  it('runCodexOAuthLogin leaves no listener on a caller-owned signal', async () => {
    release = await occupy([1455, 1457]);
    const { runCodexOAuthLogin } = await import('../src/auth-menu/openai-codex-oauth.js');
    const { signal, live } = trackedSignal();

    const code = await runCodexOAuthLogin(silentDeps() as never, { signal });

    expect(code).toBe(1); // user declined at the paste prompt
    expect(live()).toBe(0);
  });

  it('runClaudeOAuthLogin leaves no listener on a caller-owned signal', async () => {
    release = await occupy([53692]);
    const mod = await import('../src/auth-menu/anthropic-oauth.js');
    const run = (mod as Record<string, unknown>)['runClaudeOAuthLogin'] as
      | ((deps: unknown, opts: { signal: AbortSignal }) => Promise<number>)
      | undefined;
    expect(run, 'runClaudeOAuthLogin export').toBeTypeOf('function');
    const { signal, live } = trackedSignal();

    await run!(silentDeps(), { signal });

    expect(live()).toBe(0);
  });
});
