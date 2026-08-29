/**
 * session.start payload builder for the CLI WebUI bridge.
 *
 * Builds the payload enriched with per-model cost rates and max-context cap.
 * Used by the initial connect handler and every broadcast path (model.switch,
 * mode.switch, session.resume, etc.) so the frontend always has the correct
 * cost rates for live computation.
 *
 * PR 11 of Issue #30: extracted from `webui-server.ts`.
 */
import * as path from 'node:path';
import type { Context } from '@wrongstack/core/agent';
import type { ModelsRegistry } from '@wrongstack/core/types';
import { DEFAULT_CONTEXT_WINDOW_MODE_ID } from '@wrongstack/core/types';
import { protocolAdvertisement } from '@wrongstack/webui-protocol';
import type { UpdateInfo } from '../update-check.js';
import { getCostRates } from './cost-helpers.js';

/** @see UpdateInfo in ../update-check.ts for the canonical shape. */
export type BootUpdateInfo = UpdateInfo;

/** The slice of `CliWebUIOptions` the payload builder actually reads. */
export interface SessionStartPayloadDeps {
  agent: { ctx: Context };
  session: { id: string };
  /**
   * The Context of ONE session, without creating it.
   *
   * `session.start` is sent for a named session — a resume, a background tab's
   * announce, a model switch in a tab that is not in front — and everything in
   * the payload (model, provider, context mode, window size, cost rates, the
   * context-fill estimate) is a property of THAT session, not of whichever
   * session the leader agent happens to point at. Reading the leader is how a
   * background tab ended up displaying the foreground tab's model and billing
   * its tokens at the foreground tab's rates. Falls back to the leader when
   * the id is unknown, which is exactly the single-session host.
   */
  getSessionContext?: ((sessionId: string) => Context | undefined) | undefined;
  modelsRegistry?: ModelsRegistry | undefined;
  statusTracker?: import('@wrongstack/core/coordination').ProviderModelStatusTracker | undefined;
  modeId?: string | undefined;
  projectRoot?: string | undefined;
  updateInfo?: BootUpdateInfo | undefined;
}

export type BuildSessionStartPayload = (
  overrides?: Record<string, unknown>,
  needsSetup?: boolean,
) => Promise<Record<string, unknown>>;

/**
 * Callers pass optional overrides for fields that vary per context
 * (reset, mode, replayMessages, etc.).
 */
export function createSessionStartPayloadBuilder(
  deps: SessionStartPayloadDeps,
): BuildSessionStartPayload {
  return async function buildSessionStartPayload(
    overrides?: Record<string, unknown>,
    needsSetup = false,
  ) {
    // Which session is this payload describing? The overrides name it on every
    // addressed path (resume, per-tab re-announce); without one it is the
    // leader's own session, which is what a single-session host always wants.
    const targetSessionId =
      typeof overrides?.['sessionId'] === 'string' && overrides['sessionId']
        ? (overrides['sessionId'] as string)
        : (deps.agent.ctx.session?.id ?? deps.session.id);
    const ctx = deps.getSessionContext?.(targetSessionId) ?? deps.agent.ctx;
    const startedAt =
      typeof ctx.session?.startedAt === 'string' && ctx.session.startedAt.length > 0
        ? ctx.session.startedAt
        : undefined;
    let maxContext = 0;
    let inputCost = 0;
    let outputCost = 0;
    let cacheReadCost = 0;
    const updateInfo = deps.updateInfo;
    try {
      if (deps.modelsRegistry) {
        const m = await deps.modelsRegistry.getModel(ctx.provider.id, ctx.model);
        const registryMax = m?.capabilities.maxContext;
        // Fall back to the live provider's capabilities if the registry has no override.
        // The provider is the authoritative source for the model's default context window.
        maxContext = registryMax ?? ctx.provider.capabilities?.maxContext ?? 0;
        const rates = getCostRates(m);
        inputCost = rates.input;
        outputCost = rates.output;
        cacheReadCost = rates.cacheRead;
      } else {
        // No registry — use the provider's default capabilities directly.
        maxContext = ctx.provider.capabilities?.maxContext ?? 0;
      }
    } catch {
      /* best-effort; cost stays $0 */
    }
    // The last pre-flight token estimate — drives the context-fill bar in the
    // WebUI. Emitting it here ensures the bar is accurate on reconnect/refresh
    // instead of staying at 0% until the next ctx.pct event.
    const lastInputTokens =
      typeof ctx.lastRequestTokens === 'number' && ctx.lastRequestTokens > 0
        ? ctx.lastRequestTokens
        : 0;

    return {
      sessionId: targetSessionId,
      ...(startedAt ? { startedAt } : {}),
      model: ctx.model,
      provider: ctx.provider.id,
      mode: deps.modeId ?? 'default',
      projectName: deps.projectRoot ? path.basename(deps.projectRoot) : undefined,
      // Frontend reads `projectRoot` from session.start (ws-handlers setEnv) —
      // omitting it left the store's projectRoot empty after a project switch.
      projectRoot: deps.projectRoot ?? (ctx as { projectRoot?: string }).projectRoot ?? '',
      cwd: deps.projectRoot ?? (ctx as { projectRoot?: string }).projectRoot ?? '',
      needsSetup, // true when provider/model not configured and running in --webui mode
      contextMode: String(ctx.meta?.['contextWindowMode'] ?? DEFAULT_CONTEXT_WINDOW_MODE_ID),
      maxContext,
      inputCost,
      outputCost,
      cacheReadCost,
      lastInputTokens,
      providerStatuses: deps.statusTracker?.getAllStatuses() ?? [],
      appVersion: updateInfo?.current,
      latestVersion: updateInfo?.latest,
      updateAvailable: updateInfo?.outdated ?? false,
      updateCheckFailed: updateInfo?.checkFailed ?? false,
      ...protocolAdvertisement(),
      ...overrides,
    };
  };
}
