/**
 * Subscription OAuth login (ChatGPT / Claude / Copilot) for the embedded
 * WebUI server. Mirrors the standalone server's `oauth-handlers`, but persists
 * through the `ProviderConfigStore` on `WsHandlerContext`.
 *
 * The flow engine (`@wrongstack/providers/oauth`) is IO-free — it drives the
 * loopback / device-code protocol and returns a persistence-agnostic outcome
 * that we upsert here. Progress is surfaced to the client as `auth.oauth.status`.
 */

import type { ProviderConfig } from '@wrongstack/core';
import { toErrorMessage } from '@wrongstack/core/utils';
import {
  beginOAuthLogin,
  type OAuthKind,
  type OAuthLoginOutcome,
  type OAuthSession,
} from '@wrongstack/providers/oauth';
import type { WebSocket } from 'ws';
import { normalizeKeys, writeKeysBack } from '../provider-config.js';
import type { WsHandlerContext } from './index.js';
import { broadcastSaved } from './providers.js';

type OAuthPhase =
  | 'awaiting_browser'
  | 'awaiting_code'
  | 'exchanging'
  | 'fetching_models'
  | 'success'
  | 'error';

/** One in-flight session per kind, process-wide (single-user embedded server). */
const oauthSessions = new Map<OAuthKind, OAuthSession>();

function sendStatus(
  ctx: WsHandlerContext,
  ws: WebSocket,
  kind: OAuthKind,
  phase: OAuthPhase,
  extra: Record<string, unknown> = {},
): void {
  ctx.send(ws, { type: 'auth.oauth.status', payload: { kind, phase, ...extra } });
}

async function persistOutcome(ctx: WsHandlerContext, outcome: OAuthLoginOutcome): Promise<void> {
  const providers = await ctx.providerStore.load();
  const existing = providers[outcome.providerId];
  const p: ProviderConfig = existing ? { ...existing } : { type: outcome.providerId };
  p.family = outcome.family as ProviderConfig['family'];
  if (!p.baseUrl) p.baseUrl = outcome.baseUrl;
  p.models = [...outcome.models];
  const keys = normalizeKeys(p).filter((k) => k.label !== outcome.apiKey.label);
  keys.push(outcome.apiKey);
  writeKeysBack(p, keys);
  p.activeKey = outcome.apiKey.label;
  providers[outcome.providerId] = p;
  await ctx.providerStore.save(providers);
  broadcastSaved(ctx, providers);
}

async function finish(
  ctx: WsHandlerContext,
  ws: WebSocket,
  kind: OAuthKind,
  outcome: OAuthLoginOutcome | null,
): Promise<void> {
  if (!outcome) {
    sendStatus(ctx, ws, kind, 'error', { message: 'Sign-in cancelled or timed out.' });
    return;
  }
  sendStatus(ctx, ws, kind, 'fetching_models', { providerId: outcome.providerId });
  await persistOutcome(ctx, outcome);
  sendStatus(ctx, ws, kind, 'success', {
    providerId: outcome.providerId,
    message: `Signed in — saved as ${outcome.providerId} (${outcome.models.length} models).`,
  });
}

export async function handleOAuthStart(
  ctx: WsHandlerContext,
  ws: WebSocket,
  kind: OAuthKind,
): Promise<void> {
  try {
    oauthSessions.get(kind)?.close();
    oauthSessions.delete(kind);

    const session = await beginOAuthLogin(kind, { modelsRegistry: ctx.modelsRegistry });
    oauthSessions.set(kind, session);

    if (kind === 'copilot') {
      sendStatus(ctx, ws, kind, 'awaiting_code', {
        providerId: session.providerId,
        verificationUri: session.verificationUri,
        userCode: session.userCode,
        bound: false,
      });
    } else {
      sendStatus(ctx, ws, kind, 'awaiting_browser', {
        providerId: session.providerId,
        authorizeUrl: session.authorizeUrl,
        bound: session.bound,
      });
    }

    const drive = kind === 'copilot' || session.bound;
    if (drive) {
      void (async () => {
        try {
          const outcome = await session.waitForCompletion();
          await finish(ctx, ws, kind, outcome);
        } catch (err) {
          sendStatus(ctx, ws, kind, 'error', { message: toErrorMessage(err) });
        } finally {
          if (oauthSessions.get(kind) === session) oauthSessions.delete(kind);
        }
      })();
    }
  } catch (err) {
    sendStatus(ctx, ws, kind, 'error', { message: toErrorMessage(err) });
  }
}

export async function handleOAuthCode(
  ctx: WsHandlerContext,
  ws: WebSocket,
  kind: OAuthKind,
  input: string,
): Promise<void> {
  const session = oauthSessions.get(kind);
  if (!session) {
    sendStatus(ctx, ws, kind, 'error', {
      message: 'No active sign-in for this provider — start the login again.',
    });
    return;
  }
  try {
    sendStatus(ctx, ws, kind, 'exchanging', { providerId: session.providerId });
    const outcome = await session.completeWithCode(input);
    await finish(ctx, ws, kind, outcome);
  } catch (err) {
    sendStatus(ctx, ws, kind, 'error', { message: toErrorMessage(err) });
  } finally {
    session.close();
    if (oauthSessions.get(kind) === session) oauthSessions.delete(kind);
  }
}

export function handleOAuthCancel(ctx: WsHandlerContext, ws: WebSocket, kind: OAuthKind): void {
  oauthSessions.get(kind)?.close();
  oauthSessions.delete(kind);
  sendStatus(ctx, ws, kind, 'error', { message: 'Sign-in cancelled.' });
}
