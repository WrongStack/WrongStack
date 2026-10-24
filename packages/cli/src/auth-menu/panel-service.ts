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
import type { ProviderConfig } from '@wrongstack/contracts/types';
import { toErrorMessage } from '@wrongstack/core/utils';
import type {
  AuthCatalogRow,
  AuthFlowIo,
  AuthFlowResult,
  AuthKeyEdit,
  AuthKeyRow,
  AuthLocalPresetRow,
  AuthOAuthKind,
  AuthPanelHost,
  AuthProviderRow,
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
import { runAuthLocal } from './local.js';
import { LOCAL_LLM_PRESETS } from './local-presets.js';
import type { AuthPanelServiceDeps } from './panel-flow-bridge.js';
import { flowDeps, plainMaskedKey, runFlow } from './panel-flow-bridge.js';
import { createProviderEdits } from './panel-provider-edits.js';
import { providerAuthStrategiesFor, runProviderAuthLogin } from './provider-auth-login.js';
import { validateFamily } from './shared.js';

export type { AuthPanelServiceDeps } from './panel-flow-bridge.js';
export { plainMaskedKey } from './panel-flow-bridge.js';

// ── Service factory ────────────────────────────────────────────────────────

export function createAuthPanelHost(deps: AuthPanelServiceDeps): AuthPanelHost {
  const loadProviders = (): Promise<Record<string, ProviderConfig>> =>
    loadConfigProviders(deps.profileConfigPath, deps.vault, {
      warn: (message) => {
        throw new Error(message);
      },
    });

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
      return toErrorMessage(err);
    }
    if (result === null && deps.onProvidersChanged) {
      try {
        await deps.onProvidersChanged();
      } catch (err) {
        return `Saved, but live config reload failed: ${toErrorMessage(err)}`;
      }
    }
    return result;
  };

  return {
    oauthStrategies: () => providerAuthStrategiesFor(deps),
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
      return mutate((all) => {
        if (!all[providerId]) return `Provider "${providerId}" no longer in config.`;
        delete all[providerId];
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
    ...createProviderEdits({ deps, mutate, loadProviders }),

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
        if (original && !keys.some((key) => key.label === original))
          return `Key "${original}" not found.`;
        if (keys.some((key) => key.label === label && key.label !== original))
          return `Key alias "${label}" already exists.`;
        const next = original
          ? keys.map((key) =>
              key.label === original ? { ...key, label, apiKey, createdAt: nowIso() } : key,
            )
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

    addLocal(
      presetId: string,
      io: AuthFlowIo,
      opts?: { baseUrl?: string; apiKey?: string; alias?: string },
    ): Promise<AuthFlowResult> {
      return runFlow(async () => {
        const preset = LOCAL_LLM_PRESETS.find((p) => p.id === presetId);
        if (!preset) {
          io.onLog(`✗ Unknown local preset "${presetId}".`);
          return false;
        }
        // Form-shaped path (opts present): no interactive prompts — the TUI
        // form hands over the URL and the key decision up front. An empty
        // apiKey string means "save without a key" (the old Enter-to-skip).
        // Legacy path (no opts): prompt for the URL; runAuthLocal then
        // prompts for the optional key itself.
        const url =
          opts?.baseUrl !== undefined
            ? opts.baseUrl.trim()
            : (
                await io.prompt(`Base URL (Enter = ${preset.defaultBaseUrl})`, {
                  secret: false,
                })
              ).trim();
        // `models: '999'` — capture every model id the health probe discovers
        // (resolveModelList caps at the available list size) so the model
        // picker is immediately useful after the add.
        const code = await runAuthLocal(flowDeps(deps, io), {
          name: preset.id,
          ...(opts?.alias !== undefined ? { alias: opts.alias } : {}),
          baseUrl: url || undefined,
          apiKey: opts !== undefined ? (opts.apiKey ?? '').trim() : undefined,
          models: '999',
        });
        return code === 0;
      }, deps.onProvidersChanged);
    },

    oauthLogin(kind: AuthOAuthKind, io: AuthFlowIo): Promise<AuthFlowResult> {
      return runFlow(async () => {
        const d = flowDeps(deps, io);
        const strategy = providerAuthStrategiesFor(deps).find((entry) => entry.id === kind);
        const profiles = await loadProviders();
        const baseAlias = strategy?.providerId ?? kind;
        let alias = baseAlias;
        for (let n = 2; profiles[alias]; n++) alias = `${baseAlias}-${n}`;
        const input = (
          await d.reader.readLine(`Auth profile alias [${alias}] (q to cancel): `)
        ).trim();
        if (input.toLowerCase() === 'q') return false;
        const code = await runProviderAuthLogin(d, kind, {
          signal: io.signal,
          providerId: input || alias,
        });
        return code === 0;
      }, deps.onProvidersChanged);
    },
  };
}
