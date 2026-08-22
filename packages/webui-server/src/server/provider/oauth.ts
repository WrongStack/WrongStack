import type { ProviderConfig } from '@wrongstack/core/types';
import {
  beginOAuthLogin,
  type OAuthKind,
  type OAuthLoginOutcome,
  type OAuthSession,
} from '@wrongstack/providers/oauth';
import type { WebSocket } from 'ws';
import { errMessage } from '../ws-utils.js';
import { normalizeKeys, writeKeysBack } from './keys-records.js';
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
  const oauthSessions = new Map<OAuthKind, OAuthSession>();
  const customProviderIds = new Map<OAuthKind, string>();

  function sendOAuthStatus(
    ws: WebSocket,
    kind: OAuthKind,
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
    outcome: OAuthLoginOutcome,
    customProviderId?: string,
  ): Promise<void> {
    const providers = await ctx.loadConfigProviders();
    const providerId = customProviderId ?? outcome.providerId;
    const existing = providers[providerId];
    const p: ProviderConfig = existing ? { ...existing } : { type: providerId };
    p.family = outcome.family as ProviderConfig['family'];
    if (!p.baseUrl) p.baseUrl = outcome.baseUrl;
    // OAuth replaces the allowlist only when it actually resolved one —
    // an empty list keeps whatever the user curated (memory-pinned).
    if (outcome.models.length > 0) p.models = [...outcome.models];
    const keys = normalizeKeys(p).filter((k) => k.label !== outcome.apiKey.label);
    keys.push(outcome.apiKey);
    writeKeysBack(p, keys);
    p.activeKey = outcome.apiKey.label;
    providers[providerId] = p;
    await ctx.saveConfigProviders(providers);
    ctx.broadcastSaved(providers);
  }

  async function finishOAuth(
    ws: WebSocket,
    kind: OAuthKind,
    outcome: OAuthLoginOutcome | null,
    customProviderId?: string,
  ): Promise<void> {
    if (!outcome) {
      sendOAuthStatus(ws, kind, 'error', { message: 'Sign-in cancelled or timed out.' });
      return;
    }
    const providerId = customProviderId ?? outcome.providerId;
    sendOAuthStatus(ws, kind, 'fetching_models', { providerId });
    await persistOAuthOutcome(outcome, customProviderId);
    sendOAuthStatus(ws, kind, 'success', {
      providerId,
      message: `Signed in — saved as ${providerId} (${outcome.models.length} models).`,
    });
  }

  async function handleOAuthStart(
    ws: WebSocket,
    kind: OAuthKind,
    customProviderId?: string,
  ): Promise<void> {
    try {
      oauthSessions.get(kind)?.close();
      oauthSessions.delete(kind);

      // The modelsRegistry is passed through verbatim (undefined keeps the
      // engine's registry-free mode; memory-pinned).
      const session = await beginOAuthLogin(kind, { modelsRegistry: ctx.deps.modelsRegistry });
      if (customProviderId) customProviderIds.set(kind, customProviderId);
      else customProviderIds.delete(kind);
      oauthSessions.set(kind, session);
      const providerId = customProviderId ?? session.providerId;

      if (kind === 'copilot') {
        sendOAuthStatus(ws, kind, 'awaiting_code', {
          providerId,
          verificationUri: session.verificationUri,
          userCode: session.userCode,
          bound: false,
        });
      } else {
        sendOAuthStatus(ws, kind, 'awaiting_browser', {
          providerId,
          authorizeUrl: session.authorizeUrl,
          bound: session.bound,
        });
      }

      // Drive to completion in the background when there is something to wait
      // for: the copilot device poll, or a bound loopback callback. When the
      // loopback could not bind, we wait for a manual `auth.oauth.code` paste.
      const drive = kind === 'copilot' || session.bound;
      if (drive) {
        void (async () => {
          try {
            const outcome = await session.waitForCompletion();
            await finishOAuth(ws, kind, outcome, customProviderIds.get(kind));
          } catch (err) {
            sendOAuthStatus(ws, kind, 'error', { message: errMessage(err) });
          } finally {
            if (oauthSessions.get(kind) === session) {
              oauthSessions.delete(kind);
              customProviderIds.delete(kind);
            }
          }
        })();
      }
    } catch (err) {
      sendOAuthStatus(ws, kind, 'error', { message: errMessage(err) });
    }
  }

  async function handleOAuthCode(ws: WebSocket, kind: OAuthKind, input: string): Promise<void> {
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
      const outcome = await session.completeWithCode(input);
      await finishOAuth(ws, kind, outcome, customProviderIds.get(kind));
    } catch (err) {
      sendOAuthStatus(ws, kind, 'error', { message: errMessage(err) });
    } finally {
      session.close();
      if (oauthSessions.get(kind) === session) {
        oauthSessions.delete(kind);
        customProviderIds.delete(kind);
      }
    }
  }

  function handleOAuthCancel(ws: WebSocket, kind: OAuthKind): void {
    oauthSessions.get(kind)?.close();
    oauthSessions.delete(kind);
    customProviderIds.delete(kind);
    sendOAuthStatus(ws, kind, 'error', { message: 'Sign-in cancelled.' });
  }

  return { handleOAuthStart, handleOAuthCode, handleOAuthCancel };
}
