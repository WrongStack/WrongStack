import type { ProviderAuthSession } from '@wrongstack/contracts/types';
import {
  applyProviderAuthOutcome,
  createBuiltinProviderAuthRegistry,
} from '@wrongstack/providers/oauth';
import type { WebSocket } from 'ws';
import { errMessage } from '../ws-utils.js';
import type { ProviderServiceContext } from './mutations.js';

/**
 * Subscription OAuth login state machine (ChatGPT / Claude / Copilot) — 6B-2.
 * Moved verbatim from provider-handlers.ts:
 *
 * One in-flight session per kind, shared across clients (single-user). A
 * second start for the same kind closes the prior one. The engine
 * (@wrongstack/providers/oauth) is IO-free — persistence is local below.
 */
export function createOauthHandlers(ctx: ProviderServiceContext) {
  const registry = ctx.deps.providerAuthRegistry ?? createBuiltinProviderAuthRegistry();
  const oauthSessions = new Map<string, ProviderAuthSession>();
  const customProviderIds = new Map<string, string>();
  const attempts = new Map<string, AbortController>();
  const completed = new WeakSet<ProviderAuthSession>();

  function sendOAuthStatus(
    ws: WebSocket,
    kind: string,
    phase:
      | 'awaiting_browser'
      | 'awaiting_code'
      | 'exchanging'
      | 'fetching_models'
      | 'success'
      | 'error',
    extra: Record<string, unknown> = {},
  ): void {
    ctx.sendMessage(ws, { type: 'auth.oauth.status', payload: { kind, phase, ...extra } });
  }

  /** Persist a successful login by upserting the OAuth credential. */
  async function persistOAuthOutcome(
    outcome: import('@wrongstack/contracts/types').ProviderAuthOutcome,
    customProviderId?: string,
    live: () => boolean = () => true,
  ): Promise<boolean> {
    const providers = await ctx.loadConfigProviders();
    if (!live()) return false;
    applyProviderAuthOutcome(providers, outcome, {
      targetProviderId: customProviderId,
    });
    await ctx.saveConfigProviders(providers);
    ctx.broadcastSaved(providers);
    return true;
  }

  async function finishOAuth(
    ws: WebSocket,
    kind: string,
    outcome: import('@wrongstack/contracts/types').ProviderAuthOutcome | null,
    customProviderId?: string,
    session?: ProviderAuthSession,
  ): Promise<void> {
    if (session && (oauthSessions.get(kind) !== session || completed.has(session))) return;
    if (session) completed.add(session);
    if (!outcome) {
      sendOAuthStatus(ws, kind, 'error', { message: 'Sign-in cancelled or timed out.' });
      return;
    }
    const providerId = customProviderId ?? outcome.providerId;
    sendOAuthStatus(ws, kind, 'fetching_models', { providerId });
    const live = () => !session || oauthSessions.get(kind) === session;
    if (!(await persistOAuthOutcome(outcome, customProviderId, live)) || !live()) return;
    sendOAuthStatus(ws, kind, 'success', {
      providerId,
      message: `Signed in — saved as ${providerId} (${outcome.models.length} models).`,
    });
  }

  async function handleOAuthStart(
    ws: WebSocket,
    kind: string,
    customProviderId?: string,
  ): Promise<void> {
    attempts.get(kind)?.abort();
    const attempt = new AbortController();
    attempts.set(kind, attempt);
    try {
      oauthSessions.get(kind)?.close();
      oauthSessions.delete(kind);

      // The modelsRegistry is passed through verbatim (undefined keeps the
      // engine's registry-free mode; memory-pinned).
      const strategy = registry.resolveId(kind) === 'chatgpt-api' ? registry.get(kind) : undefined;
      const saved =
        strategy?.id === 'chatgpt-api'
          ? (await ctx.loadConfigProviders())[customProviderId ?? strategy.providerId]
          : undefined;
      const credential =
        saved?.apiKeys?.find((key) => key.label === saved.activeKey) ?? saved?.apiKeys?.[0];
      const session = await registry.begin(
        kind,
        { modelsRegistry: ctx.deps.modelsRegistry, ...(credential ? { credential } : {}) },
        attempt.signal,
      );
      if (attempts.get(kind) !== attempt || attempt.signal.aborted) {
        session.close();
        return;
      }
      if (customProviderId) customProviderIds.set(kind, customProviderId);
      else customProviderIds.delete(kind);
      oauthSessions.set(kind, session);
      const providerId = customProviderId ?? session.providerId;

      if (session.interaction.type === 'device_code') {
        sendOAuthStatus(ws, kind, 'awaiting_code', {
          providerId,
          verificationUri: session.interaction.verificationUri,
          userCode: session.interaction.userCode,
          bound: false,
        });
      } else {
        sendOAuthStatus(ws, kind, 'awaiting_browser', {
          providerId,
          authorizeUrl: session.interaction.authorizeUrl,
          bound: session.interaction.bound,
        });
      }

      // Drive to completion in the background when there is something to wait
      // for: the copilot device poll, or a bound loopback callback. When the
      // loopback could not bind, we wait for a manual `auth.oauth.code` paste.
      const drive = session.interaction.type === 'device_code' || session.interaction.bound;
      if (drive) {
        void (async () => {
          try {
            const outcome = await session.waitForCompletion(attempt.signal);
            // Use the id captured when THIS session started: a newer sign-in
            // for the same kind may have replaced `customProviderIds` while
            // this one was in flight, and applying our outcome to its id would
            // save the credential under the wrong provider.
            await finishOAuth(ws, kind, outcome, customProviderId, session);
          } catch (err) {
            if (oauthSessions.get(kind) === session)
              sendOAuthStatus(ws, kind, 'error', { message: errMessage(err) });
          } finally {
            session.close();
            if (oauthSessions.get(kind) === session) {
              oauthSessions.delete(kind);
              customProviderIds.delete(kind);
              attempts.delete(kind);
            }
          }
        })();
      }
    } catch (err) {
      if (attempts.get(kind) === attempt) {
        attempts.delete(kind);
        sendOAuthStatus(ws, kind, 'error', { message: errMessage(err) });
      }
    }
  }

  async function handleOAuthCode(ws: WebSocket, kind: string, input: string): Promise<void> {
    const session = oauthSessions.get(kind);
    if (!session) {
      sendOAuthStatus(ws, kind, 'error', {
        message: 'No active sign-in for this provider — start the login again.',
      });
      return;
    }
    try {
      sendOAuthStatus(ws, kind, 'exchanging', {
        providerId: customProviderIds.get(kind) ?? session.providerId,
      });
      // Capture the target before awaiting: a concurrent sign-in start for the
      // same kind replaces the map entry, and this completion belongs to the
      // session we looked up, not to whatever started while it was in flight.
      const customProviderId = customProviderIds.get(kind);
      const outcome = await session.completeWithCode(input, attempts.get(kind)?.signal);
      await finishOAuth(ws, kind, outcome, customProviderId, session);
    } catch (err) {
      if (oauthSessions.get(kind) === session)
        sendOAuthStatus(ws, kind, 'error', { message: errMessage(err) });
    } finally {
      session.close();
      if (oauthSessions.get(kind) === session) {
        oauthSessions.delete(kind);
        customProviderIds.delete(kind);
        attempts.delete(kind);
      }
    }
  }

  function handleOAuthCancel(ws: WebSocket, kind: string): void {
    attempts.get(kind)?.abort();
    attempts.delete(kind);
    oauthSessions.get(kind)?.close();
    oauthSessions.delete(kind);
    customProviderIds.delete(kind);
    sendOAuthStatus(ws, kind, 'error', { message: 'Sign-in cancelled.' });
  }

  function handleOAuthList(ws: WebSocket): void {
    ctx.sendMessage(ws, { type: 'auth.oauth.providers', payload: { providers: registry.list() } });
  }

  return {
    handleOAuthStart,
    handleOAuthCode,
    handleOAuthCancel,
    handleOAuthList,
    resolveOAuthStrategyId: (input: string) => registry.resolveId(input),
  };
}
