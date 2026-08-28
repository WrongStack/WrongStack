import type { Context } from '@wrongstack/core/agent';
import type { EnhanceFailureKind } from '@wrongstack/core/execution';
import {
  buildRefinerContextSections,
  enhanceUserPrompt,
  gatedEnhancerReasoning,
  nextEnhanceTimeout,
  recentTextTurns,
  resolveConfiguredRefinerRef,
  resolveEnhanceFallbackRef,
} from '@wrongstack/core/execution';
import type {
  Config,
  MemoryPort,
  ModelsRegistry,
  Provider,
  ProviderConfig,
} from '@wrongstack/core/types';
import { toErrorMessage } from '@wrongstack/core/utils';
import type { WebSocket } from 'ws';
import { resolveProviderModelMetadata } from './model-catalog.js';
import type { WSServerMessage } from './types.js';
import { validateModelSwitchPayload } from './ws-payload-validation.js';

export interface ModelRefinePayload {
  /** The asking tab's session, stamped by `withSession` on the client. */
  sessionId?: string | undefined;
  text: string;
  timeoutMs?: number | undefined;
  provider?: string | undefined;
  model?: string | undefined;
  previousRefined?: string | undefined;
  previousEnglish?: string | undefined;
  retryFeedback?: string | undefined;
}

export interface ModelOperationsContext {
  context: Context;
  memoryStore?: MemoryPort | undefined;
  modelsRegistry?: ModelsRegistry | undefined;
  getConfig: () => Config | undefined;
  getLiveProviderId: () => string;
  buildProvider: (providerId: string, config: ProviderConfig) => Provider | Promise<Provider>;
  applyModelSwitch: (providerId: string, modelId: string, sessionId?: string) => Promise<void>;
  isRunActive?: ((sessionId?: string) => boolean) | undefined;
  /** Resolve a session's own Context; falls back to the root when unknown. */
  getSessionContext?: ((sessionId?: string) => Context | undefined) | undefined;
  send: (ws: WebSocket, message: WSServerMessage) => void;
  broadcast?: ((message: WSServerMessage) => void) | undefined;
  log?: ((message: string) => void) | undefined;
}

function sendResult(
  context: ModelOperationsContext,
  ws: WebSocket,
  payload: {
    requestId?: string | undefined;
    success: boolean;
    message: string;
    provider?: string | undefined;
    model?: string | undefined;
    previousProvider?: string | undefined;
    previousModel?: string | undefined;
    runActive: boolean;
    /**
     * The tab this result belongs to. A successful switch is BROADCAST (other
     * surfaces mirror the same session), so without it every client applied
     * the new model to whatever session it had in front — switching a model
     * in tab 2 silently re-labelled tab 1.
     */
    sessionId?: string | undefined;
  },
  legacyResult = false,
): void {
  const message = { type: 'model.switch_result', payload };
  if (payload.success && context.broadcast) context.broadcast(message);
  else context.send(ws, message);
  // SimpleUI and older clients do not attach requestId yet. Keep their status
  // notice alive without reintroducing the ambiguous generic result for modern
  // WebUI requests.
  if (legacyResult) {
    context.send(ws, {
      type: 'key.operation_result',
      payload: { success: payload.success, message: payload.message },
    });
  }
}

export function createModelOperations(context: ModelOperationsContext) {
  // A model switch rebuilds and persists shared live session state. Serialize
  // requests from multiple tabs so a slower provider build cannot overwrite a
  // newer selection after it completes.
  let switchQueue: Promise<void> = Promise.resolve();

  async function switchModel(ws: WebSocket, input: unknown): Promise<void> {
    const parsed = validateModelSwitchPayload(input);
    if (!parsed.ok) {
      sendResult(
        context,
        ws,
        {
          success: false,
          message: parsed.message,
          runActive: context.isRunActive?.() ?? false,
        },
        true,
      );
      return;
    }
    const { provider, model, requestId, sessionId } = parsed.value;
    const queued = switchQueue.then(async () => {
      // Report the switch against the TAB that asked, so a "switched from X"
      // toast in tab 2 never quotes tab 3's model. A named session the host
      // cannot serve must REFUSE — `?? context.context` would silently apply
      // the switch to the boot tab's context (cross-tab model bleed).
      const named = sessionId ? context.getSessionContext?.(sessionId) : context.context;
      if (sessionId && !named) {
        context.send(ws, {
          type: 'error',
          payload: {
            phase: 'model.switch',
            message: `Session ${sessionId} is not live in this runtime. Reopen or resume the tab, then retry.`,
            sessionId,
          },
        });
        return;
      }
      const targetCtx = named ?? context.context;
      const previousProvider = targetCtx.provider?.id ?? context.getLiveProviderId();
      const previousModel = targetCtx.model;
      const runActive = context.isRunActive?.(sessionId) ?? false;
      try {
        await context.applyModelSwitch(provider, model, sessionId);
        sendResult(
          context,
          ws,
          {
            ...(requestId ? { requestId } : {}),
            ...(sessionId ? { sessionId } : {}),
            success: true,
            message: `Switched to ${provider} / ${model}`,
            provider,
            model,
            previousProvider,
            previousModel,
            runActive,
          },
          requestId === undefined,
        );
      } catch (error) {
        sendResult(
          context,
          ws,
          {
            ...(requestId ? { requestId } : {}),
            ...(sessionId ? { sessionId } : {}),
            success: false,
            message: `Switch failed: ${toErrorMessage(error)}`,
            provider,
            model,
            previousProvider,
            previousModel,
            runActive,
          },
          requestId === undefined,
        );
      }
    });
    switchQueue = queued.catch(() => undefined);
    await queued;
  }

  async function buildTargetProvider(
    providerId: string,
    config: Config | undefined,
  ): Promise<Provider> {
    return context.buildProvider(
      providerId,
      config?.providers?.[providerId] ?? { type: providerId },
    );
  }

  async function refineModel(ws: WebSocket, payload: ModelRefinePayload): Promise<void> {
    const text = payload.text;
    // Echo the asking tab: refinement runs against that session's model and
    // history, and the reply must be lane-routable — an untagged
    // model.refine_result is dropped by the origin-scoped client handler,
    // silently discarding pre-queue refinement results.
    const stamp =
      typeof payload.sessionId === 'string' && payload.sessionId.length > 0
        ? { sessionId: payload.sessionId }
        : {};
    if (!text?.trim()) {
      context.send(ws, {
        type: 'model.refine_result',
        payload: {
          ...stamp,
          refined: '',
          english: '',
          error: 'Empty text',
          errorKind: 'provider_error',
        },
      });
      return;
    }

    const config = context.getConfig();
    // Refine against the ASKING tab's conversation, on the ASKING tab's model.
    // `context.context` is the shared root — with four tabs live it belongs to
    // whichever session the runtime last switched to, so refining a prompt in
    // tab 3 ran on tab 1's model and fed tab 1's recent turns to the refiner.
    // The history half of that is a cross-session content leak, not just a
    // wrong label.
    const named = payload.sessionId
      ? context.getSessionContext?.(payload.sessionId)
      : context.context;
    if (payload.sessionId && !named) {
      context.send(ws, {
        type: 'error',
        payload: {
          phase: 'model.refine',
          message: `Session ${payload.sessionId} is not live in this runtime. Reopen or resume the tab, then retry.`,
          sessionId: payload.sessionId,
        },
      });
      return;
    }
    const targetCtx = named ?? context.context;
    const liveProviderId = targetCtx.provider?.id ?? context.getLiveProviderId();
    const liveModel = targetCtx.model;
    const fallbackRef = config
      ? resolveEnhanceFallbackRef({ ...config, provider: liveProviderId, model: liveModel })
      : undefined;
    let provider = targetCtx.provider;
    let providerId = liveProviderId;
    let model = liveModel;

    if (payload.provider && payload.model) {
      try {
        provider = await buildTargetProvider(payload.provider, config);
        providerId = payload.provider;
        model = payload.model;
      } catch (error) {
        context.send(ws, {
          type: 'model.refine_result',
          payload: {
            ...stamp,
            refined: text,
            english: text,
            error: `Cannot use ${payload.provider}/${payload.model}: ${toErrorMessage(error)}`,
            errorKind: 'provider_error',
            ...(fallbackRef ? { fallbackRef } : {}),
          },
        });
        return;
      }
    } else if (config) {
      const configuredRef = resolveConfiguredRefinerRef({
        ...config,
        provider: liveProviderId,
        model: liveModel,
      });
      if (configuredRef) {
        const slash = configuredRef.indexOf('/');
        const configuredProvider = slash > 0 ? configuredRef.slice(0, slash) : liveProviderId;
        const configuredModel = slash > 0 ? configuredRef.slice(slash + 1) : configuredRef;
        try {
          provider = await buildTargetProvider(configuredProvider, config);
          providerId = configuredProvider;
          model = configuredModel;
        } catch {
          // An unavailable dedicated refiner must not block the live model.
        }
      }
    }

    const timeoutMs =
      typeof payload.timeoutMs === 'number' && payload.timeoutMs > 0 ? payload.timeoutMs : 90_000;
    try {
      const history = recentTextTurns(targetCtx.messages);
      const contextSections = await buildRefinerContextSections({
        text,
        memoryStore: context.memoryStore,
        context: targetCtx,
      });
      const resolved = context.modelsRegistry
        ? await resolveProviderModelMetadata(
            context.modelsRegistry,
            providerId,
            model,
            config?.providers?.[providerId],
          ).catch(() => undefined)
        : undefined;
      const reasoning = gatedEnhancerReasoning(resolved?.capabilities.reasoningConfig as never);
      let failureKind: EnhanceFailureKind | undefined;
      const result = await enhanceUserPrompt({
        provider,
        model,
        text,
        history,
        contextSections,
        ...(payload.previousRefined
          ? {
              previousRefinement: {
                refined: payload.previousRefined,
                english: payload.previousEnglish || payload.previousRefined,
              },
            }
          : {}),
        ...(payload.retryFeedback ? { retryFeedback: payload.retryFeedback } : {}),
        timeoutMs,
        ...(reasoning ? { reasoning } : {}),
        onError: (reason, kind) => {
          failureKind = kind;
          context.log?.(
            JSON.stringify({
              level: 'warn',
              event: 'model.refine_failed',
              reason,
              kind,
              provider: providerId,
              model,
              timestamp: new Date().toISOString(),
            }),
          );
        },
      });
      if (result) {
        context.send(ws, {
          type: 'model.refine_result',
          payload: {
            ...stamp,
            refined: result.refined,
            english: result.english,
            refinedWith: { provider: providerId, model },
          },
        });
        return;
      }
      context.send(ws, {
        type: 'model.refine_result',
        payload: {
          // Without the stamp this frame is untagged, and the client's
          // origin-scoped handler drops it — an empty refinement left the
          // panel spinning until its own 105s timeout.
          ...stamp,
          refined: text,
          english: text,
          error: 'Refinement returned no result',
          errorKind: failureKind ?? 'empty',
          ...(failureKind === 'timeout'
            ? { retryTimeoutMs: nextEnhanceTimeout(timeoutMs, config?.autonomy) }
            : {}),
          ...(fallbackRef ? { fallbackRef } : {}),
        },
      });
    } catch (error) {
      context.log?.(
        JSON.stringify({
          level: 'error',
          event: 'model.refine.error',
          error: toErrorMessage(error),
          timestamp: new Date().toISOString(),
        }),
      );
      context.send(ws, {
        type: 'model.refine_result',
        payload: {
          ...stamp,
          refined: text,
          english: text,
          error: toErrorMessage(error),
          errorKind: 'provider_error',
          ...(fallbackRef ? { fallbackRef } : {}),
        },
      });
    }
  }

  return { switchModel, refineModel };
}
