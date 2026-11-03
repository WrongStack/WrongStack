/**
 * `provider.probe` must not let a WS frame choose an unbounded lifetime for a
 * server-side outbound request.
 *
 * The probe arms `AbortSignal.timeout(timeoutMs)` on a fetch to the saved
 * provider's `baseUrl` with that provider's API key attached (see
 * `packages/runtime/src/local-llm-probe.ts`), and the sink's own ceiling is
 * `2_147_483_647` ms — the maximum legal timer, ~24.8 days. Before the route
 * bound existed, one frame with `timeoutMs: 2147483647` therefore pinned a
 * credential-bearing request *and* this connection's sequential message
 * dispatch for that whole window. The ceiling now matches the one the sibling
 * `provider.test.run` case in the same validator already applies to this field.
 *
 * Provenance: security-hardening round 2026-10-31; the same hostile + control
 * fixtures first ran RED against the unfixed validator (`.temp_files` boundary
 * proof, `PROBLEM CONFIRMED`, exit 1) and GREEN after the fix.
 */
import { describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import type { ProviderServiceContext } from '../src/server/provider/mutations.js';
import { createProbeHandlers } from '../src/server/provider/probe.js';
import { handleProviderRoute, type ProviderRouteHandlers } from '../src/server/provider-routes.js';

/** Mirrors `MAX_PROBE_TIMEOUT_MS` in provider-routes.ts (same as test.run's cap). */
const POLICY_CEILING_MS = 120_000;

function mockWs() {
  return {
    readyState: 1,
    send: vi.fn(),
  } as never as WebSocket & { send: ReturnType<typeof vi.fn> };
}

function sentMessages(ws: ReturnType<typeof mockWs>) {
  return ws.send.mock.calls.map(
    ([raw]) => JSON.parse(String(raw)) as { type: string; payload: Record<string, unknown> },
  );
}

function routes(): ProviderRouteHandlers & { probe: ReturnType<typeof vi.fn> } {
  const probe = vi.fn(async () => undefined);
  return {
    listProviders: vi.fn(async () => undefined),
    listSavedProviders: vi.fn(async () => undefined),
    listProviderModels: vi.fn(async () => undefined),
    searchProviderModels: vi.fn(async () => undefined),
    switchModel: vi.fn(async () => undefined),
    refineModel: vi.fn(async () => undefined),
    fallbackChoice: vi.fn(async () => undefined),
    suggestFallbacks: vi.fn(async () => undefined),
    adoptDefaultProviderIfUnset: vi.fn(async () => undefined),
    providerHandlers: {
      handleProviderProbe: probe,
    } as never as ProviderRouteHandlers['providerHandlers'],
    probe,
  };
}

async function dispatch(payload: Record<string, unknown>) {
  const ws = mockWs();
  const deps = routes();
  const handled = await handleProviderRoute(ws, { type: 'provider.probe', payload } as never, deps);
  return { ws, deps, handled };
}

describe('provider.probe timeoutMs boundary', () => {
  it('refuses a client-chosen timeout above the policy ceiling without dispatching it', async () => {
    // The maximum legal `AbortSignal.timeout` value: accepted before the fix,
    // which is what made a single frame a ~24.8-day hold on a live request.
    const { ws, deps } = await dispatch({
      providerId: 'custom',
      timeoutMs: 2_147_483_647,
    });

    expect(deps.probe).not.toHaveBeenCalled();
    expect(sentMessages(ws)).toEqual([
      {
        type: 'key.operation_result',
        payload: { success: false, message: 'provider.probe payload is invalid' },
      },
    ]);
  });

  it('refuses a timeout one step past the ceiling', async () => {
    const { deps } = await dispatch({ providerId: 'custom', timeoutMs: POLICY_CEILING_MS + 1 });
    expect(deps.probe).not.toHaveBeenCalled();
  });

  it('dispatches a timeout exactly at the ceiling', async () => {
    const { deps } = await dispatch({ providerId: 'custom', timeoutMs: POLICY_CEILING_MS });
    expect(deps.probe).toHaveBeenCalledTimes(1);
    expect(deps.probe.mock.calls[0]?.[2]).toBe(POLICY_CEILING_MS);
  });

  it('still dispatches an ordinary in-policy timeout unchanged', async () => {
    const { deps } = await dispatch({ providerId: 'custom', timeoutMs: 5_000 });
    expect(deps.probe).toHaveBeenCalledTimes(1);
    expect(deps.probe.mock.calls[0]?.[2]).toBe(5_000);
  });

  it('still accepts an absent timeout, which the sink resolves to its own default', async () => {
    const { deps } = await dispatch({ providerId: 'custom' });
    expect(deps.probe).toHaveBeenCalledTimes(1);
    expect(deps.probe.mock.calls[0]?.[2]).toBeUndefined();
  });

  it('still accepts a zero timeout, the documented "use the default" spelling', async () => {
    const { deps } = await dispatch({ providerId: 'custom', timeoutMs: 0 });
    expect(deps.probe).toHaveBeenCalledTimes(1);
    expect(deps.probe.mock.calls[0]?.[2]).toBe(0);
  });

  it('refuses negative or fractional timeoutMs values and treats Object.prototype providerIds as unconfigured (F930)', async () => {
    for (const badTimeout of [-1, -500, 1.5]) {
      const { ws, deps } = await dispatch({ providerId: 'custom', timeoutMs: badTimeout });
      expect(deps.probe).not.toHaveBeenCalled();
      expect(sentMessages(ws)).toEqual([
        {
          type: 'key.operation_result',
          payload: { success: false, message: 'provider.probe payload is invalid' },
        },
      ]);
    }

    const ws = mockWs();
    const probeHandlers = createProbeHandlers({
      async loadConfigProviders() {
        return {};
      },
      sendMessage(target: WebSocket, msg: unknown) {
        target.send(JSON.stringify(msg));
      },
    } as never as ProviderServiceContext);

    await probeHandlers.handleProviderProbe(ws, 'toString');
    expect(sentMessages(ws)).toEqual([
      {
        type: 'provider.probe',
        payload: { providerId: 'toString', ok: false, status: 'no_provider' },
      },
    ]);
  });
});
