import { probeLocalLlm } from '@wrongstack/runtime/probe';
import type { WebSocket } from 'ws';
import { errMessage } from '../ws-utils.js';
import { normalizeKeys } from './keys-records.js';
import type { ProviderServiceContext } from './mutations.js';
import { probeScrubber } from './projection.js';

/**
 * Health probing (6B-2). Moved verbatim from provider-handlers.ts.
 */
export function createProbeHandlers(ctx: ProviderServiceContext) {
  /**
   * Run a health probe against a saved provider's `/v1/models` and
   * reply with a `provider.probe` message. Never throws — the
   * `ProbeResult` carries the failure mode in its `status`.
   */
  async function handleProviderProbe(
    ws: WebSocket,
    providerId: string,
    timeoutMs?: number,
  ): Promise<void> {
    const reply = (payload: Record<string, unknown>): void =>
      ctx.sendMessage(ws, { type: 'provider.probe', payload: { providerId, ...payload } });
    try {
      const providers = await ctx.loadConfigProviders();
      const cfg = providers[providerId];
      if (!cfg) {
        reply({ ok: false, status: 'no_provider' });
        return;
      }
      if (!cfg.baseUrl) {
        reply({ ok: false, status: 'no_base_url' });
        return;
      }
      const keys = normalizeKeys(cfg);
      const active = keys.find((k) => k.label === cfg.activeKey) ?? keys[0];
      const result = await probeLocalLlm({
        baseUrl: cfg.baseUrl,
        apiKey: active?.apiKey,
        noAuth: false,
        scrubber: probeScrubber,
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      });
      reply(result as never as Record<string, unknown>);
    } catch (err) {
      reply({ ok: false, status: 'unreachable', detail: errMessage(err) });
    }
  }

  return { handleProviderProbe };
}
