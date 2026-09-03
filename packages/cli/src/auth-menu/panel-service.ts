/**
 * TUI auth-panel host — the structured, UI-agnostic surface behind the
 * interactive `/auth` panel in the Ink TUI.
 *
 * Two kinds of operations:
 *
 *   - **Direct mutations** (set active key, delete key, remove provider):
 *     plain async methods that mutate the config atomically and return an
 *     error string or `null`.
 *
 *   - **Flows** (add key, add from catalog, add custom, add local, OAuth
 *     sign-in, field edits): the existing battle-tested readline flows from
 *     this package, driven through an {@link AuthFlowIo} bridge. The bridge
 *     adapts `renderer.write*` → panel log lines (ANSI-stripped) and
 *     `reader.readLine/readSecret` → the panel's modal prompt. A rejected
 *     prompt (TUI Esc) aborts the flow before anything is saved.
 *
 * Secrets never cross into the TUI: key values are masked here, and the
 * modal prompt sends the plaintext only INTO the flow (never back out).
 */
import { parseModelRef } from '@wrongstack/core/agent';
import type {
  ModelsRegistry,
  ProviderConfig,
  SecretScrubber,
  SecretVault,
} from '@wrongstack/core/types';
import type {
  AuthCatalogRow,
  AuthFlowIo,
  AuthFlowResult,
  AuthKeyRow,
  AuthLocalPresetRow,
  AuthOAuthKind,
  AuthPanelHost,
  AuthProviderEdit,
  AuthModelEdit,
  AuthKeyEdit,
  AuthProviderRow,
  AuthProviderSetup,
} from '@wrongstack/tui';
import {
  activeLabel,
  loadConfigProviders,
  mutateConfigProviders,
  normalizeKeys,
  nowIso,
  writeKeysBack,
} from '../provider-config-utils.js';
import {
  addCustomProvider,
  addKeyForCatalogProvider,
  addKeyForProvider,
  ownDefinitionsAsCatalog,
} from './add-provider.js';
import { runClaudeOAuthLogin } from './anthropic-oauth.js';
import { runCopilotOAuthLogin } from './github-copilot-oauth.js';
import { runAuthLocal } from './local.js';
import { LOCAL_LLM_PRESETS } from './local-presets.js';
import { runCodexOAuthLogin } from './openai-codex-oauth.js';
import { validateFamily } from './shared.js';
import type { AuthMenuDeps } from './types.js';

export interface AuthPanelServiceDeps {
  vault: SecretVault;
  modelsRegistry: ModelsRegistry;
  /** The sole config file read or written by auth operations. */
  profileConfigPath: string;
  secretScrubber?: SecretScrubber | undefined;
  /** Re-read the live provider snapshot after a successful auth mutation. */
  onProvidersChanged?: (() => Promise<void>) | undefined;
}

// ── Text bridge helpers ────────────────────────────────────────────────────

// Strip SGR color/style sequences — the flows emit `color.*`-formatted text
// for the terminal; the panel log renders plain text with its own styling.
const ANSI_RE = /\u001b\[[0-9;]*m/g;

function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '');
}

/** Normalise a flow prompt ("  ? Label for this key [default]: ") for the modal. */
function cleanPrompt(prompt: string): string {
  return stripAnsi(prompt)
    .replace(/[\r\n]+/g, ' ')
    .replace(/^\s*\?\s*/, '')
    .replace(/[:\s]+$/, '')
    .trim();
}

/** Fan a multi-line renderer write out into individual trimmed log lines. */
function emitLines(io: AuthFlowIo, raw: string, prefix = ''): void {
  for (const line of stripAnsi(raw).split(/\r?\n/)) {
    const text = line.trim();
    if (text.length > 0) io.onLog(prefix + text);
  }
}

/** Adapt an {@link AuthFlowIo} bridge into the deps shape the flows expect. */
function flowDeps(base: AuthPanelServiceDeps, io: AuthFlowIo): AuthMenuDeps {
  return {
    renderer: {
      write: (input: string) => emitLines(io, input),
      writeInfo: (text: string) => emitLines(io, text),
      writeWarning: (text: string) => emitLines(io, text, '⚠ '),
      writeError: (text: string) => emitLines(io, text, '✗ '),
    },
    reader: {
      readLine: (prompt = '') => io.prompt(cleanPrompt(prompt), { secret: false }),
      readSecret: (prompt: string) => io.prompt(cleanPrompt(prompt), { secret: true }),
    },
    modelsRegistry: base.modelsRegistry,
    vault: base.vault,
    profileConfigPath: base.profileConfigPath,
    secretScrubber: base.secretScrubber,
  };
}

function isCancel(err: unknown): boolean {
  return (
    (err instanceof Error && err.name === 'AbortError') ||
    (err instanceof DOMException && err.name === 'AbortError')
  );
}

/** Run a flow, translating throws (Esc-cancel, I/O errors) into a result. */
async function runFlow(
  run: () => Promise<boolean>,
  onSuccess?: (() => Promise<void>) | undefined,
): Promise<AuthFlowResult> {
  try {
    const ok = await run();
    if (ok) await onSuccess?.();
    return { ok };
  } catch (err) {
    if (isCancel(err)) return { ok: false, message: 'Cancelled.' };
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

// ── Display helpers ────────────────────────────────────────────────────────

/** Plain (color-free) key mask: first 4 + last 4 characters. */
export function plainMaskedKey(key: string): string {
  if (!key) return '—';
  if (key.length <= 8) return '•'.repeat(key.length);
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isProviderModelRef(value: unknown, providerId: string): boolean {
  return typeof value === 'string' && parseModelRef(value).provider === providerId;
}

/**
 * Remove references to a deleted provider from fallback routing. Empty named
 * profiles are removed, then every selector pointing at one of those removed
 * profiles is cleared so a live reload never inherits a dangling chain.
 */
function removeProviderFallbackReferences(config: Record<string, unknown>, providerId: string): void {
  const removeModelRefs = (value: unknown): unknown[] | undefined =>
    Array.isArray(value) ? value.filter((ref) => !isProviderModelRef(ref, providerId)) : undefined;

  if (Array.isArray(config['fallbackModels'])) {
    config['fallbackModels'] = removeModelRefs(config['fallbackModels'])!;
  }
  if (typeof config['fallbackBridge'] === 'string' && isProviderModelRef(config['fallbackBridge'], providerId)) {
    delete config['fallbackBridge'];
  }
  if (Array.isArray(config['favoriteModels'])) {
    config['favoriteModels'] = removeModelRefs(config['favoriteModels'])!;
  }
  if (isRecord(config['models'])) {
    for (const [modelId, definition] of Object.entries(config['models'])) {
      if (isRecord(definition) && definition['provider'] === providerId) {
        delete config['models'][modelId];
      }
    }
    if (Object.keys(config['models']).length === 0) delete config['models'];
  }

  const removedProfiles = new Set<string>();
  if (isRecord(config['fallbackProfiles'])) {
    const profiles = config['fallbackProfiles'];
    for (const [name, chain] of Object.entries(profiles)) {
      if (!Array.isArray(chain)) continue;
      const next = chain.filter((ref) => !isProviderModelRef(ref, providerId));
      if (next.length === 0) {
        delete profiles[name];
        removedProfiles.add(name);
      } else {
        profiles[name] = next;
      }
    }
    if (Object.keys(profiles).length === 0) delete config['fallbackProfiles'];
  }

  const clearRemovedProfile = (entry: Record<string, unknown>): void => {
    if (
      typeof entry['fallbackProfile'] === 'string' &&
      removedProfiles.has(entry['fallbackProfile'])
    ) {
      delete entry['fallbackProfile'];
    }
  };

  if (typeof config['fallbackProfile'] === 'string' && removedProfiles.has(config['fallbackProfile'])) {
    delete config['fallbackProfile'];
  }

  if (isRecord(config['modelMatrix'])) {
    for (const [role, value] of Object.entries(config['modelMatrix'])) {
      if (!isRecord(value)) continue;
      if (value['provider'] === providerId) {
        delete value['provider'];
        delete value['model'];
      }
      clearRemovedProfile(value);
      if (Object.keys(value).length === 0) delete config['modelMatrix'][role];
    }
    if (Object.keys(config['modelMatrix']).length === 0) delete config['modelMatrix'];
  }

  if (isRecord(config['modelTiers']) && isRecord(config['modelTiers']['levels'])) {
    const levels = config['modelTiers']['levels'];
    for (const level of Object.values(levels)) {
      if (!isRecord(level)) continue;
      if (level['provider'] === providerId) {
        delete level['provider'];
        delete level['model'];
      }
      clearRemovedProfile(level);
    }
  }

  if (isRecord(config['autonomy'])) {
    const autonomy = config['autonomy'];
    if (autonomy['refinerProvider'] === providerId) {
      delete autonomy['refinerProvider'];
      delete autonomy['refinerModel'];
    }
    if (isProviderModelRef(autonomy['enhanceFallbackModel'], providerId)) {
      delete autonomy['enhanceFallbackModel'];
    }
    if (
      typeof autonomy['refinerFallbackProfile'] === 'string' &&
      removedProfiles.has(autonomy['refinerFallbackProfile'])
    ) {
      delete autonomy['refinerFallbackProfile'];
    }
  }

  if (isRecord(config['brain'])) {
    const brain = config['brain'];
    if (Array.isArray(brain['models'])) {
      brain['models'] = brain['models'].filter(
        (entry) =>
          !isProviderModelRef(entry, providerId) &&
          !(isRecord(entry) && entry['provider'] === providerId),
      );
    }
    if (isRecord(brain['council'])) {
      const council = brain['council'];
      if (Array.isArray(council['voters'])) {
        council['voters'] = council['voters'].filter(
          (entry) =>
            !isProviderModelRef(entry, providerId) &&
            !(isRecord(entry) && entry['provider'] === providerId),
        );
      }
      if (
        isProviderModelRef(council['judge'], providerId) ||
        (isRecord(council['judge']) && council['judge']['provider'] === providerId)
      ) {
        delete council['judge'];
      }
    }
  }

  const councilProfiles = isRecord(config['tools']) && isRecord(config['tools']['council'])
    ? config['tools']['council']['profiles']
    : undefined;
  if (Array.isArray(councilProfiles)) {
    for (const profile of councilProfiles) {
      if (!isRecord(profile)) continue;
      for (const seat of Array.isArray(profile['seats']) ? profile['seats'] : []) {
        if (!isRecord(seat) || !isRecord(seat['target'])) continue;
        const target = seat['target'];
        if (target['providerId'] === providerId) {
          delete target['providerId'];
          delete target['model'];
        }
        if (Array.isArray(target['fallbackModels'])) {
          target['fallbackModels'] = removeModelRefs(target['fallbackModels'])!;
        }
        clearRemovedProfile(target);
        if (Object.keys(target).length === 0) delete seat['target'];
      }
      if (isRecord(profile['judge'])) {
        const judge = profile['judge'];
        if (judge['providerId'] === providerId) {
          delete judge['providerId'];
          delete judge['model'];
        }
        if (Array.isArray(judge['fallbackModels'])) {
          judge['fallbackModels'] = removeModelRefs(judge['fallbackModels'])!;
        }
        clearRemovedProfile(judge);
        if (Object.keys(judge).length === 0) delete profile['judge'];
      }
    }
  }
}

// ── Service factory ────────────────────────────────────────────────────────

export function createAuthPanelHost(deps: AuthPanelServiceDeps): AuthPanelHost {
  const loadProviders = (): Promise<Record<string, ProviderConfig>> =>
    loadConfigProviders(deps.profileConfigPath, deps.vault);

  const mutate = async (
    mutator: (
      providers: Record<string, ProviderConfig>,
      config: Record<string, unknown>,
    ) => string | null,
  ): Promise<string | null> => {
    let result: string | null = null;
    try {
      await mutateConfigProviders(
        deps.profileConfigPath,
        deps.vault,
        (all, config) => {
          result = mutator(all, config);
        },
        deps.profileConfigPath,
      );
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
    if (result === null && deps.onProvidersChanged) {
      try {
        await deps.onProvidersChanged();
      } catch (err) {
        return `Saved, but live config reload failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
    return result;
  };

  return {
    async listProviders(): Promise<AuthProviderRow[]> {
      const providers = await loadProviders();
      const rows: AuthProviderRow[] = [];
      for (const id of Object.keys(providers).sort()) {
        const cfg = providers[id];
        if (!cfg) continue;
        const keys = normalizeKeys(cfg);
        const active = activeLabel(cfg, keys);
        const keyRows: AuthKeyRow[] = keys.map((k) => ({
          label: k.label,
          masked: plainMaskedKey(k.apiKey),
          createdAt: k.createdAt,
          active: k.label === active,
          authMethod: k.authMethod,
          expiresAt: k.expiresAt,
        }));
        rows.push({
          id,
          type: cfg.type,
          family: cfg.family,
          baseUrl: cfg.baseUrl,
          models: cfg.models ? [...cfg.models] : [],
          envVars: cfg.envVars ? [...cfg.envVars] : [],
          keys: keyRows,
        });
      }
      return rows;
    },

    async listCatalog(): Promise<AuthCatalogRow[]> {
      const [catalog, providers] = await Promise.all([
        deps.modelsRegistry.listProviders(),
        loadProviders(),
      ]);
      const saved = new Set(Object.keys(providers));
      return [
        ...catalog,
        ...ownDefinitionsAsCatalog(new Set(catalog.map((provider) => provider.id))),
      ]
        .filter((p) => p.family !== 'unsupported')
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((p) => ({
          id: p.id,
          name: p.name || p.id,
          family: p.family,
          apiBase: p.apiBase,
          envVars: [...p.envVars],
          saved: saved.has(p.id),
        }));
    },

    localPresets(): AuthLocalPresetRow[] {
      return LOCAL_LLM_PRESETS.map((p) => ({ ...p }));
    },

    setActiveKey(providerId: string, label: string): Promise<string | null> {
      return mutate((all) => {
        const p = all[providerId];
        if (!p) return `Provider "${providerId}" no longer in config.`;
        const keys = normalizeKeys(p);
        if (!keys.some((k) => k.label === label)) return `Key "${label}" not found.`;
        writeKeysBack(p, keys);
        p.activeKey = label;
        return null;
      });
    },

    deleteKey(providerId: string, label: string): Promise<string | null> {
      return mutate((all) => {
        const p = all[providerId];
        if (!p) return `Provider "${providerId}" no longer in config.`;
        const keys = normalizeKeys(p);
        if (!keys.some((k) => k.label === label)) return `Key "${label}" not found.`;
        const remaining = keys.filter((k) => k.label !== label);
        writeKeysBack(p, remaining);
        if (p.activeKey === label) p.activeKey = remaining[0]?.label;
        return null;
      });
    },

    removeProvider(providerId: string): Promise<string | null> {
      return mutate((all, config) => {
        if (!all[providerId]) return `Provider "${providerId}" no longer in config.`;
        delete all[providerId];
        removeProviderFallbackReferences(config, providerId);
        return null;
      });
    },

    addKey(providerId: string, io: AuthFlowIo): Promise<AuthFlowResult> {
      return runFlow(async () => {
        const providers = await loadProviders();
        const template = providers[providerId] ?? { type: providerId };
        return addKeyForProvider(providerId, flowDeps(deps, io), template);
      }, deps.onProvidersChanged);
    },

    async saveProviderSetup(setup: AuthProviderSetup): Promise<string | null> {
      const type = setup.type.trim();
      const alias = setup.alias.trim();
      const keyLabel = setup.keyLabel.trim();
      const apiKey = setup.apiKey.trim();
      const family = validateFamily(setup.family);
      if (!type) return 'Provider id is required.';
      if (!alias) return 'Alias is required.';
      if (!family) return 'Choose a supported protocol family.';
      if (!keyLabel) return 'Key alias is required.';
      if (!apiKey) return 'API key is required.';

      const split = (value: string): string[] =>
        value
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean);
      const baseUrl = setup.baseUrl.trim();
      const models = split(setup.models);
      const envVars = split(setup.envVars);
      // Resolve this before entering the synchronous config mutation so the
      // default selection, provider entry, and subsequent live reload are one
      // atomic state transition.
      let catalogDefaultModel: string | undefined;
      try {
        catalogDefaultModel = (await deps.modelsRegistry.getProvider(type))?.models?.[0]?.id;
      } catch {
        // A missing catalog model merely means the user picks a model later.
      }

      const result = await mutate((all, config) => {
        const existing = all[alias];
        if (existing) {
          const existingFamily = existing.family ?? family;
          const existingBaseUrl = existing.baseUrl ?? '';
          if (existingFamily !== family || existingBaseUrl !== baseUrl) {
            return `Alias "${alias}" already uses ${existingFamily} / ${existingBaseUrl || 'default endpoint'}. Choose a different alias.`;
          }
          if (existing.type && existing.type !== type) {
            return `Alias "${alias}" already belongs to provider type "${existing.type}".`;
          }
        }

        const provider: ProviderConfig = existing ?? { type, family };
        provider.type = type;
        provider.family = family;
        if (baseUrl) provider.baseUrl = baseUrl;
        else delete provider.baseUrl;
        if (models.length > 0) provider.models = models;
        else if (setup.source === 'custom') delete provider.models;
        if (envVars.length > 0) provider.envVars = envVars;
        else if (setup.source === 'custom') delete provider.envVars;

        const keys = normalizeKeys(provider);
        if (keys.some((key) => key.label === keyLabel)) {
          return `Key alias "${keyLabel}" already exists for "${alias}". Pick another key alias or update that key.`;
        }
        keys.push({ label: keyLabel, apiKey, createdAt: nowIso() });
        writeKeysBack(provider, keys);
        if (!provider.activeKey) provider.activeKey = keyLabel;
        all[alias] = provider;
        if ((!config['provider'] || !config['model']) && catalogDefaultModel) {
          config['provider'] = alias;
          config['model'] = catalogDefaultModel;
        }
        return null;
      });
      return result;
    },

    async saveProviderEdit(edit: AuthProviderEdit): Promise<string | null> {
      const providerId = edit.providerId.trim();
      const family = validateFamily(edit.family);
      if (!providerId) return 'Provider id is required.';
      if (!family) return 'Choose a supported protocol family.';
      const list = (value: string): string[] =>
        value
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean);
      const baseUrl = edit.baseUrl.trim();
      const models = list(edit.models);
      const envVars = list(edit.envVars);
      return mutate((all) => {
        const provider = all[providerId];
        if (!provider) return `Provider "${providerId}" no longer in config.`;
        provider.family = family;
        if (baseUrl) provider.baseUrl = baseUrl;
        else delete provider.baseUrl;
        if (models.length > 0) provider.models = models;
        else delete provider.models;
        if (envVars.length > 0) provider.envVars = envVars;
        else delete provider.envVars;
        return null;
      });
    },

    async getModelEdit(providerId: string, modelId: string): Promise<AuthModelEdit | null> {
      const provider = (await loadProviders())[providerId];
      if (!provider?.models?.includes(modelId)) return null;
      const details = provider.customModels?.[modelId];
      const modelsDev = details?.modelsDev ?? {};
      const limit = modelsDev['limit'] as Record<string, unknown> | undefined;
      const cost = modelsDev['cost'] as Record<string, unknown> | undefined;
      return {
        providerId,
        modelId,
        name: typeof modelsDev['name'] === 'string' ? modelsDev['name'] : '',
        contextWindow: limit?.['context'] === undefined ? '' : String(limit['context']),
        maxOutput: details?.maxOutput === undefined ? (limit?.['output'] === undefined ? '' : String(limit['output'])) : String(details.maxOutput),
        costInput: cost?.['input'] === undefined ? '' : String(cost['input']),
        costOutput: cost?.['output'] === undefined ? '' : String(cost['output']),
      };
    },

    async saveModelEdit(edit: AuthModelEdit): Promise<string | null> {
      const parse = (value: string, label: string): number | string | undefined => {
        if (!value.trim()) return undefined;
        const number = Number(value);
        return Number.isFinite(number) && number >= 0 ? number : `${label} must be a non-negative number.`;
      };
      const context = parse(edit.contextWindow, 'Context window');
      const output = parse(edit.maxOutput, 'Max output');
      const inputCost = parse(edit.costInput, 'Input cost');
      const outputCost = parse(edit.costOutput, 'Output cost');
      for (const value of [context, output, inputCost, outputCost]) if (typeof value === 'string') return value;
      return mutate((all) => {
        const provider = all[edit.providerId];
        if (!provider?.models?.includes(edit.modelId)) return `Model "${edit.modelId}" no longer exists.`;
        const existing = provider.customModels?.[edit.modelId] ?? {};
        const modelsDev = { ...(existing.modelsDev ?? {}) } as Record<string, unknown>;
        if (edit.name.trim()) modelsDev['name'] = edit.name.trim(); else delete modelsDev['name'];
        const limit = { ...(modelsDev['limit'] as Record<string, unknown> ?? {}) };
        if (context === undefined) delete limit['context']; else limit['context'] = context;
        if (output === undefined) delete limit['output']; else limit['output'] = output;
        if (Object.keys(limit).length) modelsDev['limit'] = limit; else delete modelsDev['limit'];
        const cost = { ...(modelsDev['cost'] as Record<string, unknown> ?? {}) };
        if (inputCost === undefined) delete cost['input']; else cost['input'] = inputCost;
        if (outputCost === undefined) delete cost['output']; else cost['output'] = outputCost;
        if (Object.keys(cost).length) modelsDev['cost'] = cost; else delete modelsDev['cost'];
        if (!provider.customModels) provider.customModels = {};
        provider.customModels[edit.modelId] = { ...existing, ...(Object.keys(modelsDev).length ? { modelsDev } : {}) };
        return null;
      });
    },

    async saveKeyEdit(edit: AuthKeyEdit): Promise<string | null> {
      const label = edit.label.trim();
      const apiKey = edit.apiKey.trim();
      if (!label) return 'Key alias is required.';
      if (!apiKey) return 'API key is required.';
      return mutate((all) => {
        const provider = all[edit.providerId];
        if (!provider) return `Provider "${edit.providerId}" no longer in config.`;
        const keys = normalizeKeys(provider);
        const original = edit.originalLabel;
        if (original && !keys.some((key) => key.label === original)) return `Key "${original}" not found.`;
        if (keys.some((key) => key.label === label && key.label !== original)) return `Key alias "${label}" already exists.`;
        const next = original
          ? keys.map((key) => key.label === original ? { ...key, label, apiKey, createdAt: nowIso() } : key)
          : [...keys, { label, apiKey, createdAt: nowIso() }];
        writeKeysBack(provider, next);
        if (!provider.activeKey || provider.activeKey === original) provider.activeKey = label;
        return null;
      });
    },

    updateKey(providerId: string, label: string, io: AuthFlowIo): Promise<AuthFlowResult> {
      return runFlow(async () => {
        const key = (
          await io.prompt(`New key for ${providerId}/${label}`, { secret: true })
        ).trim();
        if (!key) {
          io.onLog('✗ No key entered.');
          return false;
        }
        const err = await mutate((all) => {
          const p = all[providerId];
          if (!p) return `Provider "${providerId}" no longer in config.`;
          const keys = normalizeKeys(p);
          if (!keys.some((k) => k.label === label)) return `Key "${label}" not found.`;
          writeKeysBack(
            p,
            keys.map((k) => (k.label === label ? { ...k, apiKey: key, createdAt: nowIso() } : k)),
          );
          return null;
        });
        if (err) {
          io.onLog(`✗ ${err}`);
          return false;
        }
        io.onLog(`✓ Updated ${providerId}/${label}.`);
        return true;
      }, deps.onProvidersChanged);
    },

    editField(
      providerId: string,
      field: 'family' | 'baseUrl' | 'models',
      io: AuthFlowIo,
    ): Promise<AuthFlowResult> {
      return runFlow(async () => {
        const providers = await loadProviders();
        const cfg = providers[providerId];
        if (!cfg) {
          io.onLog(`✗ Provider "${providerId}" no longer in config.`);
          return false;
        }

        if (field === 'family') {
          const current = cfg.family ?? 'unset';
          const raw = (
            await io.prompt(
              `Family (anthropic | openai | openai-compatible | google, empty = unset, current: ${current})`,
              { secret: false },
            )
          ).trim();
          if (raw !== '') {
            const validated = validateFamily(raw);
            if (!validated) {
              io.onLog(
                `✗ Invalid family: "${raw}". Must be one of: anthropic, openai, openai-compatible, google.`,
              );
              return false;
            }
            const err = await mutate((all) => {
              const p = all[providerId];
              if (!p) return `Provider "${providerId}" no longer in config.`;
              p.family = validated;
              return null;
            });
            if (err) {
              io.onLog(`✗ ${err}`);
              return false;
            }
            io.onLog(`✓ family → ${validated}`);
            return true;
          }
          const err = await mutate((all) => {
            const p = all[providerId];
            if (!p) return `Provider "${providerId}" no longer in config.`;
            delete p.family;
            return null;
          });
          if (err) {
            io.onLog(`✗ ${err}`);
            return false;
          }
          io.onLog('✓ family → (unset)');
          return true;
        }

        if (field === 'baseUrl') {
          const current = cfg.baseUrl ?? 'unset';
          const raw = (
            await io.prompt(`Base URL (empty = unset, current: ${current})`, { secret: false })
          ).trim();
          const err = await mutate((all) => {
            const p = all[providerId];
            if (!p) return `Provider "${providerId}" no longer in config.`;
            if (raw === '') delete p.baseUrl;
            else p.baseUrl = raw;
            return null;
          });
          if (err) {
            io.onLog(`✗ ${err}`);
            return false;
          }
          io.onLog(`✓ baseUrl → ${raw || '(unset)'}`);
          return true;
        }

        const current = (cfg.models ?? []).join(', ') || 'none';
        const raw = (
          await io.prompt(
            `Model ids (comma-separated, empty = catalog default, current: ${current})`,
            { secret: false },
          )
        ).trim();
        const list = raw
          ? raw
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean)
          : [];
        const err = await mutate((all) => {
          const p = all[providerId];
          if (!p) return `Provider "${providerId}" no longer in config.`;
          if (list.length === 0) delete p.models;
          else p.models = list;
          return null;
        });
        if (err) {
          io.onLog(`✗ ${err}`);
          return false;
        }
        io.onLog(`✓ models → ${list.length === 0 ? '(catalog default)' : list.join(', ')}`);
        return true;
      }, deps.onProvidersChanged);
    },

    editModelDetails(providerId: string, modelId: string, io: AuthFlowIo): Promise<AuthFlowResult> {
      return runFlow(async () => {
        const providers = await loadProviders();
        const cfg = providers[providerId];
        if (!cfg) {
          io.onLog(`✗ Provider "${providerId}" no longer in config.`);
          return false;
        }

        // Fetch catalog reference values so the user can see defaults
        const catalogModel = await deps.modelsRegistry
          .getModel(cfg.type && cfg.type !== providerId ? cfg.type : providerId, modelId)
          .catch(() => undefined);

        const existing = cfg.customModels?.[modelId];
        const currentMd = existing?.modelsDev ?? {};

        io.onLog(
          catalogModel
            ? `Catalog reference: ctx=${catalogModel.capabilities.maxContext ?? '?'}, out=${catalogModel.capabilities.maxOutput ?? '?'}`
            : `(no catalog entry for ${modelId})`,
        );

        // Identity
        const name = (
          await io.prompt(`Name (current: ${(currentMd['name'] as string) ?? modelId})`, {
            secret: false,
          })
        ).trim();

        // Limits
        const ctxRaw = (
          await io.prompt(
            `Context window (current: ${(currentMd.limit as Record<string, unknown>)?.['context'] ?? '?'}, catalog: ${catalogModel?.capabilities.maxContext ?? '?'})`,
            { secret: false },
          )
        ).trim();
        const outRaw = (
          await io.prompt(
            `Max output (current: ${existing?.maxOutput ?? (currentMd.limit as Record<string, unknown>)?.['output'] ?? '?'}, catalog: ${catalogModel?.capabilities.maxOutput ?? '?'})`,
            { secret: false },
          )
        ).trim();

        // Cost
        const costInRaw = (
          await io.prompt(
            `Cost input $/1M (current: ${(currentMd.cost as Record<string, unknown>)?.['input'] ?? '?'}, catalog: ${catalogModel?.cost?.input ?? '?'})`,
            { secret: false },
          )
        ).trim();
        const costOutRaw = (
          await io.prompt(
            `Cost output $/1M (current: ${(currentMd.cost as Record<string, unknown>)?.['output'] ?? '?'}, catalog: ${catalogModel?.cost?.output ?? '?'})`,
            { secret: false },
          )
        ).trim();

        // Build the modelsDev delta
        const modelsDev: Record<string, unknown> = {};
        if (name) modelsDev['name'] = name;
        const limit: Record<string, number> = {};
        if (ctxRaw) {
          const n = Number(ctxRaw);
          if (!Number.isNaN(n) && n >= 0) limit['context'] = n;
        }
        if (outRaw) {
          const n = Number(outRaw);
          if (!Number.isNaN(n) && n >= 0) limit['output'] = n;
        }
        if (Object.keys(limit).length > 0) modelsDev['limit'] = limit;
        const cost: Record<string, number> = {};
        if (costInRaw) {
          const n = Number(costInRaw);
          if (!Number.isNaN(n) && n >= 0) cost['input'] = n;
        }
        if (costOutRaw) {
          const n = Number(costOutRaw);
          if (!Number.isNaN(n) && n >= 0) cost['output'] = n;
        }
        if (Object.keys(cost).length > 0) modelsDev['cost'] = cost;

        if (Object.keys(modelsDev).length === 0) {
          io.onLog('(no changes — nothing entered)');
          return true;
        }

        const err = await mutate((all) => {
          const p = all[providerId];
          if (!p) return `Provider "${providerId}" no longer in config.`;
          if (!p.customModels) p.customModels = {};
          const existingEntry = p.customModels[modelId] ?? {};
          p.customModels[modelId] = {
            ...existingEntry,
            modelsDev: {
              ...(existingEntry.modelsDev ?? {}),
              ...modelsDev,
              // Deep-merge limit/cost so partial overrides don't wipe sub-fields
              ...(limit || existingEntry.modelsDev
                ? {
                    limit: {
                      ...((existingEntry.modelsDev?.['limit'] as Record<string, unknown>) ?? {}),
                      ...limit,
                    },
                  }
                : {}),
              ...(cost || (existingEntry.modelsDev?.['cost'] as Record<string, unknown>)
                ? {
                    cost: {
                      ...((existingEntry.modelsDev?.['cost'] as Record<string, unknown>) ?? {}),
                      ...cost,
                    },
                  }
                : {}),
            },
          };
          return null;
        });
        if (err) {
          io.onLog(`✗ ${err}`);
          return false;
        }
        io.onLog(`✓ ${modelId} updated`);
        return true;
      }, deps.onProvidersChanged);
    },

    addModel(
      providerId: string,
      io: AuthFlowIo,
      opts?: { fromCatalog?: boolean | undefined },
    ): Promise<AuthFlowResult> {
      return runFlow(async () => {
        const providers = await loadProviders();
        const cfg = providers[providerId];
        if (!cfg) {
          io.onLog(`✓ Provider "${providerId}" no longer in config.`);
          return false;
        }

        const modelId = (await io.prompt('Model id', { secret: false })).trim();
        if (!modelId) {
          io.onLog('✗ Model id is required.');
          return false;
        }

        // If from catalog, try to prefill
        if (opts?.fromCatalog) {
          const catalogModel = await deps.modelsRegistry
            .getModel(cfg.type && cfg.type !== providerId ? cfg.type : providerId, modelId)
            .catch(() => undefined);
          if (catalogModel) {
            io.onLog(
              `Found in catalog: ctx=${catalogModel.capabilities.maxContext}, out=${catalogModel.capabilities.maxOutput}`,
            );
          } else {
            io.onLog(`(not found in catalog — entering as custom)`);
          }
        }

        const err = await mutate((all) => {
          const p = all[providerId];
          if (!p) return `Provider "${providerId}" no longer in config.`;
          if (!p.models) p.models = [];
          if (!p.models.includes(modelId)) p.models.push(modelId);
          return null;
        });
        if (err) {
          io.onLog(`✗ ${err}`);
          return false;
        }
        io.onLog(`✓ Added model "${modelId}" to ${providerId}`);
        return true;
      }, deps.onProvidersChanged);
    },

    removeModel(providerId: string, modelId: string): Promise<string | null> {
      return (async () => {
        const err = await mutate((all) => {
          const p = all[providerId];
          if (!p) return `Provider "${providerId}" no longer in config.`;
          if (p.models) {
            p.models = p.models.filter((m) => m !== modelId);
            if (p.models.length === 0) delete p.models;
          }
          if (p.customModels && modelId in p.customModels) {
            delete p.customModels[modelId];
            if (Object.keys(p.customModels).length === 0) delete p.customModels;
          }
          return null;
        });
        return err;
      })();
    },

    resetModelToCatalog(providerId: string, modelId: string): Promise<string | null> {
      return (async () => {
        // Verify the model exists in the catalog before resetting
        const providers = await loadProviders();
        const cfg = providers[providerId];
        if (!cfg) return `Provider "${providerId}" no longer in config.`;

        const catalogModel = await deps.modelsRegistry
          .getModel(cfg.type && cfg.type !== providerId ? cfg.type : providerId, modelId)
          .catch(() => undefined);
        if (!catalogModel) {
          return `Model "${modelId}" not found in catalog — cannot reset.`;
        }

        const err = await mutate((all) => {
          const p = all[providerId];
          if (!p) return `Provider "${providerId}" no longer in config.`;
          if (p.customModels && modelId in p.customModels) {
            delete p.customModels[modelId];
            if (Object.keys(p.customModels).length === 0) delete p.customModels;
          }
          return null;
        });
        return err;
      })();
    },

    addCatalogProvider(catalogId: string, io: AuthFlowIo): Promise<AuthFlowResult> {
      return runFlow(async () => {
        const catalog = await deps.modelsRegistry.listProviders();
        const chosen = catalog.find((p) => p.id === catalogId);
        if (!chosen) {
          io.onLog(`✗ Catalog provider "${catalogId}" not found.`);
          return false;
        }
        return addKeyForCatalogProvider(flowDeps(deps, io), chosen);
      }, deps.onProvidersChanged);
    },

    addCustomProvider(io: AuthFlowIo): Promise<AuthFlowResult> {
      return runFlow(() => addCustomProvider(flowDeps(deps, io)), deps.onProvidersChanged);
    },

    addLocal(presetId: string, io: AuthFlowIo): Promise<AuthFlowResult> {
      return runFlow(async () => {
        const preset = LOCAL_LLM_PRESETS.find((p) => p.id === presetId);
        if (!preset) {
          io.onLog(`✗ Unknown local preset "${presetId}".`);
          return false;
        }
        const url = (
          await io.prompt(`Base URL (Enter = ${preset.defaultBaseUrl})`, { secret: false })
        ).trim();
        // `models: '999'` — capture every model id the health probe discovers
        // (resolveModelList caps at the available list size) so the model
        // picker is immediately useful after the add.
        const code = await runAuthLocal(flowDeps(deps, io), {
          name: preset.id,
          baseUrl: url || undefined,
          models: '999',
        });
        return code === 0;
      }, deps.onProvidersChanged);
    },

    oauthLogin(kind: AuthOAuthKind, io: AuthFlowIo): Promise<AuthFlowResult> {
      return runFlow(async () => {
        const d = flowDeps(deps, io);
        const opts = { signal: io.signal };
        const code =
          kind === 'chatgpt'
            ? await runCodexOAuthLogin(d, opts)
            : kind === 'claude'
              ? await runClaudeOAuthLogin(d, opts)
              : await runCopilotOAuthLogin(d, opts);
        return code === 0;
      }, deps.onProvidersChanged);
    },
  };
}
