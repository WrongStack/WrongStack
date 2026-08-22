import { hasProviderCredential, resolveProviderModelList } from '@wrongstack/core/models';
import { DefaultSecretScrubber } from '@wrongstack/core/security';
import { validateProviderBaseUrl } from '@wrongstack/core/tools';
import type { ModelsRegistry, ProviderConfig } from '@wrongstack/core/types';
import { toErrorMessage } from '@wrongstack/core/utils';
import {
  beginOAuthLogin,
  type OAuthKind,
  type OAuthLoginOutcome,
  type OAuthSession,
} from '@wrongstack/providers/oauth';
import { probeLocalLlm } from '@wrongstack/runtime/probe';
import type { WebSocket } from 'ws';
import {
  resolveProviderCatalogForModels,
  resolveProviderModelMetadata,
  SIBLING_CATALOG,
} from './model-catalog.js';
import { searchCatalogModels } from './model-catalog-search.js';
import { loadSavedProviders, saveProviders } from './provider-config-io.js';
import {
  addProvider as addProviderRecord,
  deleteKey as deleteKeyRecord,
  maskedKey,
  normalizeKeys,
  removeProvider as removeProviderRecord,
  setActiveKey as setActiveKeyRecord,
  upsertKey as upsertKeyRecord,
  writeKeysBack,
} from './provider-keys.js';
import type { ConnectedClient, WSServerMessage } from './types.js';
import { errMessage, send as sendToSocket } from './ws-utils.js';

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
  /** Per-model metadata (display name, output limits, capability overrides). */
  customModels?: ProviderConfig['customModels'] | undefined;
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
      customModels: cfg.customModels,
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

/**
 * Probe a saved provider's OpenAI-compatible `/v1/models` and map the
 * discovered ids into the minimal model-descriptor shape the WebUI dropdown
 * needs. Used as a fallback when a config-only custom provider (no saved
 * `models` allowlist, absent from models.dev) would otherwise resolve to an
 * empty list. Returns `[]` on any failure — the caller treats that as "no
 * models" (unchanged behaviour).
 */
export async function probeModelDescriptors(
  cfg: ProviderConfig,
): Promise<Array<{ id: string; name: string; capabilities: [] }>> {
  if (!cfg.baseUrl) return [];
  try {
    const keys = normalizeKeys(cfg);
    const active = keys.find((k) => k.label === cfg.activeKey) ?? keys[0];
    const result = await probeLocalLlm({
      baseUrl: cfg.baseUrl,
      apiKey: active?.apiKey,
      noAuth: false,
      scrubber: probeScrubber,
    });
    if (!result.ok || !result.modelIds) return [];
    return result.modelIds.map((id) => ({ id, name: id, capabilities: [] as [] }));
  } catch {
    return [];
  }
}

export interface ProviderHandlerDeps {
  /** Path to the active profile config; the only provider mutation target. */
  profileConfigPath: string;
  vault: import('@wrongstack/core/types').SecretVault;
  /** Shared config write lock — serialized via chained promises */
  setConfigWriteLock: (lock: Promise<void>) => void;
  getConfigWriteLock: () => Promise<void>;
  /** Broadcast a message to all connected WebUI clients */
  broadcast: (clients: Map<WebSocket, ConnectedClient>, msg: WSServerMessage) => void;
  /** Connected WebUI clients map */
  clients: Map<WebSocket, ConnectedClient>;
  /** Used by the ChatGPT OAuth flow's tier-2 model lookup (best-effort). */
  modelsRegistry?: ModelsRegistry | undefined;
  hasActiveModel?: (() => boolean) | undefined;
  onProvidersLoaded?:
    | ((providers: Record<string, ProviderConfig>) => void | Promise<void>)
    | undefined;
  applyModelSwitch?: ((providerId: string, modelId: string) => Promise<void>) | undefined;
}

export interface ProviderPersistence {
  load(): Promise<Record<string, ProviderConfig>>;
  save(providers: Record<string, ProviderConfig>): Promise<void>;
}

export interface ProviderOperationsDeps {
  providerStore: ProviderPersistence;
  broadcast: (message: WSServerMessage) => void;
  send?: ((ws: WebSocket, message: WSServerMessage) => void) | undefined;
  modelsRegistry?: ModelsRegistry | undefined;
  log?: ((message: string) => void) | undefined;
  hasActiveModel?: (() => boolean) | undefined;
  onProvidersLoaded?:
    | ((providers: Record<string, ProviderConfig>) => void | Promise<void>)
    | undefined;
  applyModelSwitch?: ((providerId: string, modelId: string) => Promise<void>) | undefined;
}

export function createProviderOperations(deps: ProviderOperationsDeps) {
  const sendMessage = deps.send ?? sendToSocket;
  const sendOperationResult = (ws: WebSocket, success: boolean, message: string): void =>
    sendMessage(ws, { type: 'key.operation_result', payload: { success, message } });

  async function loadConfigProviders(): Promise<Record<string, ProviderConfig>> {
    return deps.providerStore.load();
  }

  async function saveConfigProviders(providers: Record<string, ProviderConfig>): Promise<void> {
    await deps.providerStore.save(providers);
  }

  async function handleProvidersList(ws: WebSocket): Promise<void> {
    if (!deps.modelsRegistry) {
      sendOperationResult(ws, false, 'Models registry not available');
      return;
    }
    try {
      const providers = await deps.modelsRegistry.listProviders();
      // `savedIds.has(id)` used to stand in for "has a key". It means "appears
      // in the saved config at all", so a provider saved with only a `baseUrl`
      // reported `hasApiKey: true` and the panel offered it as ready to use.
      // Same rule as the CLI picker and `/modelcaps` now — see
      // `core/src/models/provider-credentials.ts`.
      const savedProviders = await loadConfigProviders();
      sendMessage(ws, {
        type: 'provider.catalog',
        payload: {
          providers: providers.map((provider) => ({
            id: provider.id,
            name: provider.name,
            family: provider.family,
            apiBase: provider.apiBase,
            envVars: provider.envVars,
            modelCount: provider.models.length,
            hasApiKey: hasProviderCredential(provider, { providers: savedProviders }),
          })),
        },
      });
    } catch (error) {
      sendOperationResult(ws, false, errMessage(error));
    }
  }

  async function handleProvidersSaved(ws: WebSocket): Promise<void> {
    try {
      sendMessage(ws, {
        type: 'providers.saved',
        payload: { providers: projectSavedProviders(await loadConfigProviders()) },
      });
    } catch (error) {
      sendOperationResult(ws, false, errMessage(error));
    }
  }

  async function handleProviderModelsSearch(
    ws: WebSocket,
    query: string,
    limit?: number | undefined,
  ): Promise<void> {
    if (!deps.modelsRegistry) {
      sendOperationResult(ws, false, 'Models registry not available');
      return;
    }
    try {
      const matches = await searchCatalogModels(deps.modelsRegistry, query, limit);
      sendMessage(ws, {
        type: 'provider.models.search_result',
        payload: { query, matches },
      });
    } catch (error) {
      sendOperationResult(ws, false, errMessage(error));
    }
  }

  async function handleProviderModels(ws: WebSocket, providerId: string): Promise<void> {
    if (!deps.modelsRegistry) {
      sendOperationResult(ws, false, 'Models registry not available');
      return;
    }
    try {
      const saved = await loadConfigProviders();
      const config = saved[providerId];
      const provider = await resolveProviderCatalogForModels(
        deps.modelsRegistry,
        providerId,
        config,
      );
      const siblingCatalogKey = config?.family ?? providerId;
      const siblingId = SIBLING_CATALOG[siblingCatalogKey];
      const sibling =
        siblingId && siblingId !== providerId
          ? await deps.modelsRegistry.getProvider(siblingId).catch(() => undefined)
          : undefined;
      let models = resolveProviderModelList(
        config?.models,
        provider,
        config?.type ?? providerId,
        sibling,
      );
      if (models.length === 0 && config?.baseUrl) models = await probeModelDescriptors(config);
      const enriched = await Promise.all(
        models.map(async (model) => {
          if (model.contextWindow && model.capabilities.length > 0) return model;
          const resolved = await resolveProviderModelMetadata(
            deps.modelsRegistry as ModelsRegistry,
            providerId,
            model.id,
            config,
          ).catch(() => undefined);
          if (!resolved) return model;
          const capabilities = new Set(model.capabilities);
          if (resolved.capabilities.tools) capabilities.add('tools');
          if (resolved.capabilities.reasoning) capabilities.add('reasoning');
          if (resolved.capabilities.vision) capabilities.add('vision');
          return {
            ...model,
            contextWindow: model.contextWindow ?? resolved.capabilities.maxContext ?? undefined,
            inputCost: model.inputCost ?? resolved.cost?.input,
            outputCost: model.outputCost ?? resolved.cost?.output,
            capabilities: [...capabilities],
          };
        }),
      );
      sendMessage(ws, {
        type: 'provider.models',
        payload: { provider: providerId, models: enriched },
      });
    } catch (error) {
      sendOperationResult(ws, false, errMessage(error));
    }
  }

  async function adoptDefaultProviderIfUnset(providerId: string): Promise<void> {
    if (!deps.applyModelSwitch || deps.hasActiveModel?.()) return;
    const saved = await loadConfigProviders();
    await deps.onProvidersLoaded?.(saved);
    const config = saved[providerId];
    if (!config) return;
    let model = config.models?.[0];
    if (!model && deps.modelsRegistry) {
      const catalogId = config.type && config.type !== providerId ? config.type : providerId;
      const catalog = await deps.modelsRegistry.getProvider(catalogId).catch(() => undefined);
      model = catalog?.models?.[0]?.id;
    }
    if (!model) model = (await probeModelDescriptors(config))[0]?.id;
    if (!model) return;
    try {
      await deps.applyModelSwitch(providerId, model);
    } catch {
      // Best effort: the persisted provider becomes the default next session.
    }
  }

  async function handleKeyUpsert(
    ws: WebSocket,
    providerId: string,
    label: string,
    apiKey: string,
  ): Promise<void> {
    try {
      const providers = await loadConfigProviders();
      const result = upsertKeyRecord(
        providers,
        providerId,
        label,
        apiKey,
        new Date().toISOString(),
      );
      if (result.ok) {
        await saveConfigProviders(providers);
        broadcastSaved(providers);
      }
      sendOperationResult(ws, result.ok, result.message);
    } catch (err) {
      sendOperationResult(ws, false, errMessage(err));
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
      sendOperationResult(ws, result.ok, result.message);
    } catch (err) {
      sendOperationResult(ws, false, errMessage(err));
    }
  }

  async function handleKeySetActive(
    ws: WebSocket,
    providerId: string,
    label: string,
  ): Promise<void> {
    try {
      const providers = await loadConfigProviders();
      const result = setActiveKeyRecord(providers, providerId, label);
      if (result.ok) {
        await saveConfigProviders(providers);
        broadcastSaved(providers);
      }
      sendOperationResult(ws, result.ok, result.message);
    } catch (err) {
      sendOperationResult(ws, false, errMessage(err));
    }
  }

  async function handleProviderAdd(
    ws: WebSocket,
    payload: {
      id: string;
      family: string;
      baseUrl?: string | undefined;
      apiKey?: string | undefined;
      models?: string[] | undefined;
      customModels?: ProviderConfig['customModels'] | undefined;
    },
  ): Promise<boolean> {
    try {
      if (payload.baseUrl !== undefined && payload.baseUrl !== '') {
        const invalid = validateProviderBaseUrl(payload.baseUrl);
        if (invalid) {
          sendOperationResult(ws, false, invalid);
          return false;
        }
      }
      const providers = await loadConfigProviders();
      const result = addProviderRecord(providers, payload, new Date().toISOString());
      if (result.ok) {
        await saveConfigProviders(providers);
        broadcastSaved(providers);
      }
      sendOperationResult(ws, result.ok, result.message);
      if (result.ok) {
        deps.log?.(`[WebUI] Provider "${payload.id}" added via provider.add`);
      }
      return result.ok;
    } catch (err) {
      sendOperationResult(ws, false, errMessage(err));
      return false;
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
      sendOperationResult(ws, result.ok, result.message);
    } catch (err) {
      sendOperationResult(ws, false, errMessage(err));
    }
  }

  /** Broadcast the current saved-provider list to every connected client. */
  function broadcastSaved(providers: Record<string, ProviderConfig>): void {
    deps.broadcast({
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
        sendOperationResult(ws, false, `Unknown provider "${providerId}"`);
        return;
      }
      delete cfg.models;
      await saveConfigProviders(providers);
      sendOperationResult(ws, true, `Cleared model allowlist for ${providerId}`);
      broadcastSaved(providers);
    } catch (err) {
      sendOperationResult(ws, false, errMessage(err));
    }
  }

  /** Set/update a single custom model definition for a provider (ME-3). */
  async function handleCustomModelSet(
    ws: WebSocket,
    providerId: string,
    modelId: string,
    definition: NonNullable<ProviderConfig['customModels']>[string],
  ): Promise<void> {
    try {
      const providers = await loadConfigProviders();
      const cfg = Object.hasOwn(providers, providerId) ? providers[providerId] : undefined;
      if (!cfg) {
        sendOperationResult(ws, false, `Unknown provider "${providerId}"`);
        return;
      }
      if (!cfg.customModels) cfg.customModels = {};
      cfg.customModels[modelId] = definition;
      // ME-3 follow-up: keep the models[] allowlist in sync so a newly
      // added custom model is visible in pickers/providers.saved and an
      // existing one stays listed. Add when absent; never remove here
      // (set is upsert, not delete).
      if (!cfg.models) cfg.models = [];
      if (!cfg.models.includes(modelId)) cfg.models.push(modelId);
      await saveConfigProviders(providers);
      sendOperationResult(ws, true, `Saved model "${modelId}" for ${providerId}`);
      broadcastSaved(providers);
    } catch (err) {
      sendOperationResult(ws, false, errMessage(err));
    }
  }

  /** Remove a single custom model entry for a provider (ME-3). */
  async function handleCustomModelRemove(
    ws: WebSocket,
    providerId: string,
    modelId: string,
  ): Promise<void> {
    try {
      const providers = await loadConfigProviders();
      const cfg = Object.hasOwn(providers, providerId) ? providers[providerId] : undefined;
      if (!cfg) {
        sendOperationResult(ws, false, `Unknown provider "${providerId}"`);
        return;
      }
      if (cfg.customModels && Object.hasOwn(cfg.customModels, modelId)) {
        delete cfg.customModels[modelId];
        if (Object.keys(cfg.customModels).length === 0) delete cfg.customModels;
        // ME-3 follow-up: keep the models[] allowlist in sync — a removed
        // custom model should no longer appear in pickers/providers.saved.
        if (cfg.models) {
          cfg.models = cfg.models.filter((m) => m !== modelId);
          if (cfg.models.length === 0) delete cfg.models;
        }
        await saveConfigProviders(providers);
        sendOperationResult(ws, true, `Removed model "${modelId}" from ${providerId}`);
        broadcastSaved(providers);
      } else {
        sendOperationResult(ws, false, `Model "${modelId}" not found in ${providerId}`);
      }
    } catch (err) {
      sendOperationResult(ws, false, errMessage(err));
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
        sendOperationResult(ws, false, `Unknown provider "${providerId}"`);
        return;
      }
      cfg.models = [...previousModels];
      await saveConfigProviders(providers);
      sendOperationResult(ws, true, `Restored ${previousModels.length} model(s) for ${providerId}`);
      broadcastSaved(providers);
    } catch (err) {
      sendOperationResult(ws, false, errMessage(err));
    }
  }

  /** Update a saved provider's wire config (family / baseUrl / envVars / models / customModels). */
  async function handleProviderUpdate(
    ws: WebSocket,
    payload: {
      id: string;
      family?: string | undefined;
      baseUrl?: string | undefined;
      envVars?: string[] | undefined;
      models?: string[] | undefined;
      customModels?: ProviderConfig['customModels'] | undefined;
    },
  ): Promise<void> {
    try {
      const providers = await loadConfigProviders();
      const cfg = providers[payload.id];
      if (!cfg) {
        sendOperationResult(ws, false, `Unknown provider "${payload.id}"`);
        return;
      }
      // `provider.probe` sends the saved key to whatever `baseUrl` says and
      // echoes a slice of the response body back over this socket, so an
      // unvalidated write here is both a credential-delivery and a readable-SSRF
      // primitive. `provider_manage` has validated this since WS-013; this path
      // reached the same field without it.
      if (payload.baseUrl !== undefined && payload.baseUrl !== '') {
        const invalid = validateProviderBaseUrl(payload.baseUrl);
        if (invalid) {
          sendOperationResult(ws, false, invalid);
          return;
        }
      }
      if (payload.family !== undefined) cfg.family = payload.family as ProviderConfig['family'];
      if (payload.baseUrl !== undefined) cfg.baseUrl = payload.baseUrl;
      if (payload.envVars !== undefined) cfg.envVars = payload.envVars;
      if (payload.models !== undefined) cfg.models = payload.models;
      if (payload.customModels !== undefined) cfg.customModels = payload.customModels;
      await saveConfigProviders(providers);
      sendOperationResult(ws, true, `Updated ${payload.id}`);
      broadcastSaved(providers);
    } catch (err) {
      sendOperationResult(ws, false, errMessage(err));
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
      sendMessage(ws, { type: 'provider.probe', payload: { providerId, ...payload } });
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
    sendMessage(ws, { type: 'auth.oauth.status', payload: { kind, phase, ...extra } });
  }

  /** Persist a successful login by upserting the OAuth credential. */
  async function persistOAuthOutcome(
    outcome: OAuthLoginOutcome,
    customProviderId?: string,
  ): Promise<void> {
    const providers = await loadConfigProviders();
    const providerId = customProviderId ?? outcome.providerId;
    const existing = providers[providerId];
    const p: ProviderConfig = existing ? { ...existing } : { type: providerId };
    p.family = outcome.family as ProviderConfig['family'];
    if (!p.baseUrl) p.baseUrl = outcome.baseUrl;
    if (outcome.models.length > 0) p.models = [...outcome.models];
    const keys = normalizeKeys(p).filter((k) => k.label !== outcome.apiKey.label);
    keys.push(outcome.apiKey);
    writeKeysBack(p, keys);
    p.activeKey = outcome.apiKey.label;
    providers[providerId] = p;
    await saveConfigProviders(providers);
    broadcastSaved(providers);
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

      const session = await beginOAuthLogin(kind, { modelsRegistry: deps.modelsRegistry });
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

  return {
    handleProvidersList,
    handleProvidersSaved,
    handleProviderModels,
    handleProviderModelsSearch,
    adoptDefaultProviderIfUnset,
    broadcastSaved,
    handleKeyUpsert,
    handleKeyDelete,
    handleKeySetActive,
    handleProviderAdd,
    handleProviderRemove,
    handleProviderClearModels,
    handleCustomModelSet,
    handleCustomModelRemove,
    handleProviderUndoClear,
    handleProviderUpdate,
    handleProviderProbe,
    handleOAuthStart,
    handleOAuthCode,
    handleOAuthCancel,
    loadConfigProviders,
  };
}

/**
 * Standalone-host adapter. It preserves the existing serialized profile-file
 * persistence while delegating all provider and OAuth behavior to the
 * store-backed canonical operations factory.
 */
export function createProviderHandlers(deps: ProviderHandlerDeps) {
  let configWriteLock = deps.getConfigWriteLock();
  const providerStore: ProviderPersistence = {
    load: () => loadSavedProviders(deps.profileConfigPath, deps.vault),
    save: async (providers) => {
      const next = configWriteLock
        .then(() => saveProviders(deps.profileConfigPath, deps.vault, providers))
        .catch((error) => {
          console.error(
            JSON.stringify({
              level: 'error',
              event: 'webui.provider_save_failed',
              message: toErrorMessage(error),
              timestamp: new Date().toISOString(),
            }),
          );
        });
      configWriteLock = next;
      deps.setConfigWriteLock(next);
      await next;
    },
  };
  return createProviderOperations({
    providerStore,
    broadcast: (message) => deps.broadcast(deps.clients, message),
    modelsRegistry: deps.modelsRegistry,
    log: (message) => console.log(message),
    hasActiveModel: deps.hasActiveModel,
    onProvidersLoaded: deps.onProvidersLoaded,
    applyModelSwitch: deps.applyModelSwitch,
  });
}
