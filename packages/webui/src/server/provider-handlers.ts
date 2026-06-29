import type { WebSocket } from 'ws';
import type { ModelsRegistry, ProviderConfig } from '@wrongstack/core';
import { DefaultSecretScrubber } from '@wrongstack/core';
import {
  beginOAuthLogin,
  type OAuthKind,
  type OAuthLoginOutcome,
  type OAuthSession,
} from '@wrongstack/providers/oauth';
import { probeLocalLlm } from '@wrongstack/runtime/probe';
import { loadSavedProviders, saveProviders } from './provider-config-io.js';
import { toErrorMessage } from '@wrongstack/core/utils';
import {
  upsertKey as upsertKeyRecord,
  deleteKey as deleteKeyRecord,
  setActiveKey as setActiveKeyRecord,
  addProvider as addProviderRecord,
  removeProvider as removeProviderRecord,
  maskedKey,
  normalizeKeys,
  writeKeysBack,
} from './provider-keys.js';
import type { ConnectedClient, WSServerMessage } from './types.js';
import { send, sendResult, errMessage } from './ws-utils.js';

/**
 * Wire shape of one saved provider as broadcast over `providers.saved`.
 * The WebUI's `<ProviderModelsPanel>` consumes this — when
 * `pickedModelId` / `models` is missing, the panel renders the empty
 * state.
 */
export interface SavedProviderView {
  id: string;
  family?: string | undefined;
  baseUrl?: string | undefined;
  /** Saved model allowlist, verbatim (undefined / [] both possible). */
  models?: string[] | undefined;
  /** First entry of `models`, or undefined when the list is empty/unset. */
  pickedModelId?: string | undefined;
  apiKeys: Array<{
    label: string;
    maskedKey: string;
    isActive: boolean;
    createdAt: string;
  }>;
}

/**
 * Canonical projection from in-memory `ProviderConfig` to the
 * `providers.saved` wire shape. Pure (no I/O) so it's unit-tested in
 * isolation — see `tests/server/provider-handlers-projection.test.ts`.
 *
 * Secrets never leave: every key is run through `maskedKey` before it
 * reaches the wire.
 */
export function projectSavedProviders(
  providers: Record<string, ProviderConfig>,
): SavedProviderView[] {
  return Object.entries(providers).map(([id, cfg]) => {
    const keys = normalizeKeys(cfg);
    const models = cfg.models;
    const view: SavedProviderView = {
      id,
      family: cfg.family ?? id,
      baseUrl: cfg.baseUrl,
      models,
      apiKeys: keys.map((k) => ({
        label: k.label,
        maskedKey: maskedKey(k.apiKey),
        isActive: k.label === cfg.activeKey,
        createdAt: k.createdAt,
      })),
    };
    const picked = models && models.length > 0 ? models[0] : undefined;
    if (picked !== undefined) view.pickedModelId = picked;
    return view;
  });
}

/** Shared scrubber for probe error/body redaction. */
const probeScrubber = new DefaultSecretScrubber();

export interface ProviderHandlerDeps {
  globalConfigPath: string;
  vault: import('@wrongstack/core').SecretVault;
  /** Shared config write lock — serialized via chained promises */
  setConfigWriteLock: (lock: Promise<void>) => void;
  getConfigWriteLock: () => Promise<void>;
  /** Broadcast a message to all connected WebUI clients */
  broadcast: (clients: Map<WebSocket, ConnectedClient>, msg: WSServerMessage) => void;
  /** Connected WebUI clients map */
  clients: Map<WebSocket, ConnectedClient>;
  /** Used by the ChatGPT OAuth flow's tier-2 model lookup (best-effort). */
  modelsRegistry?: ModelsRegistry | undefined;
}

export function createProviderHandlers(deps: ProviderHandlerDeps) {
  const { globalConfigPath, vault, broadcast, clients } = deps;
  let configWriteLock = deps.getConfigWriteLock();

  async function loadConfigProviders(): Promise<Record<string, ProviderConfig>> {
    return loadSavedProviders(globalConfigPath, vault);
  }

  async function saveConfigProviders(providers: Record<string, ProviderConfig>): Promise<void> {
    const next = configWriteLock
      .then(() => saveProviders(globalConfigPath, vault, providers))
      .catch((err) => {
        const msg = toErrorMessage(err);
        console.error(JSON.stringify({
          level: 'error',
          event: 'webui.provider_save_failed',
          message: msg,
          timestamp: new Date().toISOString(),
        }));
      });
    configWriteLock = next;
    deps.setConfigWriteLock(next);
    await next;
  }

  async function handleKeyUpsert(ws: WebSocket, providerId: string, label: string, apiKey: string): Promise<void> {
    try {
      const providers = await loadConfigProviders();
      const result = upsertKeyRecord(providers, providerId, label, apiKey, new Date().toISOString());
      if (result.ok) {
        await saveConfigProviders(providers);
        broadcastSaved(providers);
      }
      sendResult(ws, result.ok, result.message);
    } catch (err) {
      sendResult(ws, false, errMessage(err));
    }
  }

  async function handleKeyDelete(ws: WebSocket, providerId: string, label: string): Promise<void> {
    try {
      const providers = await loadConfigProviders();
      const result = deleteKeyRecord(providers, providerId, label);
      if (result.ok) {
        await saveConfigProviders(providers);
        broadcastSaved(providers);
      }
      sendResult(ws, result.ok, result.message);
    } catch (err) {
      sendResult(ws, false, errMessage(err));
    }
  }

  async function handleKeySetActive(ws: WebSocket, providerId: string, label: string): Promise<void> {
    try {
      const providers = await loadConfigProviders();
      const result = setActiveKeyRecord(providers, providerId, label);
      if (result.ok) {
        await saveConfigProviders(providers);
        broadcastSaved(providers);
      }
      sendResult(ws, result.ok, result.message);
    } catch (err) {
      sendResult(ws, false, errMessage(err));
    }
  }

  async function handleProviderAdd(ws: WebSocket, payload: { id: string; family: string; baseUrl?: string | undefined; apiKey?: string | undefined }): Promise<void> {
    try {
      const providers = await loadConfigProviders();
      const result = addProviderRecord(providers, payload, new Date().toISOString());
      if (result.ok) {
        await saveConfigProviders(providers);
        broadcastSaved(providers);
      }
      sendResult(ws, result.ok, result.message);
      if (result.ok) {
        console.log(`[WebUI] Provider "${payload.id}" added via provider.add`);
      }
    } catch (err) {
      sendResult(ws, false, errMessage(err));
    }
  }

  async function handleProviderRemove(ws: WebSocket, providerId: string): Promise<void> {
    try {
      const providers = await loadConfigProviders();
      const result = removeProviderRecord(providers, providerId);
      if (result.ok) {
        await saveConfigProviders(providers);
        broadcastSaved(providers);
      }
      sendResult(ws, result.ok, result.message);
    } catch (err) {
      sendResult(ws, false, errMessage(err));
    }
  }

  /** Broadcast the current saved-provider list to every connected client. */
  function broadcastSaved(providers: Record<string, ProviderConfig>): void {
    broadcast(clients, {
      type: 'providers.saved',
      payload: { providers: projectSavedProviders(providers) },
    });
  }

  /** Remove the saved model allowlist for a provider. */
  async function handleProviderClearModels(ws: WebSocket, providerId: string): Promise<void> {
    try {
      const providers = await loadConfigProviders();
      const cfg = providers[providerId];
      if (!cfg) {
        sendResult(ws, false, `Unknown provider "${providerId}"`);
        return;
      }
      delete cfg.models;
      await saveConfigProviders(providers);
      sendResult(ws, true, `Cleared model allowlist for ${providerId}`);
      broadcastSaved(providers);
    } catch (err) {
      sendResult(ws, false, errMessage(err));
    }
  }

  /** Restore a previously-cleared model allowlist (pairs with clear). */
  async function handleProviderUndoClear(
    ws: WebSocket,
    providerId: string,
    previousModels: string[],
  ): Promise<void> {
    try {
      const providers = await loadConfigProviders();
      const cfg = providers[providerId];
      if (!cfg) {
        sendResult(ws, false, `Unknown provider "${providerId}"`);
        return;
      }
      cfg.models = [...previousModels];
      await saveConfigProviders(providers);
      sendResult(ws, true, `Restored ${previousModels.length} model(s) for ${providerId}`);
      broadcastSaved(providers);
    } catch (err) {
      sendResult(ws, false, errMessage(err));
    }
  }

  /** Update a saved provider's wire config (family / baseUrl / envVars / models). */
  async function handleProviderUpdate(
    ws: WebSocket,
    payload: {
      id: string;
      family?: string | undefined;
      baseUrl?: string | undefined;
      envVars?: string[] | undefined;
      models?: string[] | undefined;
    },
  ): Promise<void> {
    try {
      const providers = await loadConfigProviders();
      const cfg = providers[payload.id];
      if (!cfg) {
        sendResult(ws, false, `Unknown provider "${payload.id}"`);
        return;
      }
      if (payload.family !== undefined) cfg.family = payload.family as ProviderConfig['family'];
      if (payload.baseUrl !== undefined) cfg.baseUrl = payload.baseUrl;
      if (payload.envVars !== undefined) cfg.envVars = payload.envVars;
      if (payload.models !== undefined) cfg.models = payload.models;
      await saveConfigProviders(providers);
      sendResult(ws, true, `Updated ${payload.id}`);
      broadcastSaved(providers);
    } catch (err) {
      sendResult(ws, false, errMessage(err));
    }
  }

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
      send(ws, { type: 'provider.probe', payload: { providerId, ...payload } });
    try {
      const providers = await loadConfigProviders();
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

  // ── Subscription OAuth login (ChatGPT / Claude / Copilot) ──────────────────
  //
  // One in-flight session per kind, shared across clients (single-user). A
  // second start for the same kind closes the prior one. The engine
  // (@wrongstack/providers/oauth) is IO-free — persistence is local below.

  const oauthSessions = new Map<OAuthKind, OAuthSession>();

  function sendOAuthStatus(
    ws: WebSocket,
    kind: OAuthKind,
    phase: 'awaiting_browser' | 'awaiting_code' | 'exchanging' | 'fetching_models' | 'success' | 'error',
    extra: Record<string, unknown> = {},
  ): void {
    send(ws, { type: 'auth.oauth.status', payload: { kind, phase, ...extra } });
  }

  /** Persist a successful login by upserting the OAuth credential. */
  async function persistOAuthOutcome(outcome: OAuthLoginOutcome): Promise<void> {
    const providers = await loadConfigProviders();
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
    await saveConfigProviders(providers);
    broadcastSaved(providers);
  }

  async function finishOAuth(
    ws: WebSocket,
    kind: OAuthKind,
    outcome: OAuthLoginOutcome | null,
  ): Promise<void> {
    if (!outcome) {
      sendOAuthStatus(ws, kind, 'error', { message: 'Sign-in cancelled or timed out.' });
      return;
    }
    sendOAuthStatus(ws, kind, 'fetching_models', { providerId: outcome.providerId });
    await persistOAuthOutcome(outcome);
    sendOAuthStatus(ws, kind, 'success', {
      providerId: outcome.providerId,
      message: `Signed in — saved as ${outcome.providerId} (${outcome.models.length} models).`,
    });
  }

  async function handleOAuthStart(ws: WebSocket, kind: OAuthKind): Promise<void> {
    try {
      oauthSessions.get(kind)?.close();
      oauthSessions.delete(kind);

      const session = await beginOAuthLogin(kind, { modelsRegistry: deps.modelsRegistry });
      oauthSessions.set(kind, session);

      if (kind === 'copilot') {
        sendOAuthStatus(ws, kind, 'awaiting_code', {
          providerId: session.providerId,
          verificationUri: session.verificationUri,
          userCode: session.userCode,
          bound: false,
        });
      } else {
        sendOAuthStatus(ws, kind, 'awaiting_browser', {
          providerId: session.providerId,
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
            await finishOAuth(ws, kind, outcome);
          } catch (err) {
            sendOAuthStatus(ws, kind, 'error', { message: errMessage(err) });
          } finally {
            if (oauthSessions.get(kind) === session) oauthSessions.delete(kind);
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
      sendOAuthStatus(ws, kind, 'exchanging', { providerId: session.providerId });
      const outcome = await session.completeWithCode(input);
      await finishOAuth(ws, kind, outcome);
    } catch (err) {
      sendOAuthStatus(ws, kind, 'error', { message: errMessage(err) });
    } finally {
      session.close();
      if (oauthSessions.get(kind) === session) oauthSessions.delete(kind);
    }
  }

  function handleOAuthCancel(ws: WebSocket, kind: OAuthKind): void {
    oauthSessions.get(kind)?.close();
    oauthSessions.delete(kind);
    sendOAuthStatus(ws, kind, 'error', { message: 'Sign-in cancelled.' });
  }

  return {
    handleKeyUpsert,
    handleKeyDelete,
    handleKeySetActive,
    handleProviderAdd,
    handleProviderRemove,
    handleProviderClearModels,
    handleProviderUndoClear,
    handleProviderUpdate,
    handleProviderProbe,
    handleOAuthStart,
    handleOAuthCode,
    handleOAuthCancel,
    loadConfigProviders,
  };
}
