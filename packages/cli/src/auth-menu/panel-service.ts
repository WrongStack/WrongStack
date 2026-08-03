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
import type { ModelsRegistry, ProviderConfig, SecretScrubber, SecretVault } from '@wrongstack/core/types';
import type {
  AuthCatalogRow,
  AuthFlowIo,
  AuthFlowResult,
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
import { addCustomProvider, addKeyForCatalogProvider, addKeyForProvider } from './add-provider.js';
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
async function runFlow(run: () => Promise<boolean>): Promise<AuthFlowResult> {
  try {
    const ok = await run();
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

// ── Service factory ────────────────────────────────────────────────────────

export function createAuthPanelHost(deps: AuthPanelServiceDeps): AuthPanelHost {
  const loadProviders = (): Promise<Record<string, ProviderConfig>> =>
    loadConfigProviders(deps.profileConfigPath, deps.vault);

  const mutate = async (
    mutator: (providers: Record<string, ProviderConfig>) => string | null,
  ): Promise<string | null> => {
    let result: string | null = null;
    try {
      await mutateConfigProviders(
        deps.profileConfigPath,
        deps.vault,
        (all) => {
          result = mutator(all);
        },
        deps.profileConfigPath,
      );
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
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
      return catalog
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
      });
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
      });
    },

    editModelDetails(
      providerId: string,
      modelId: string,
      io: AuthFlowIo,
    ): Promise<AuthFlowResult> {
      return runFlow(async () => {
        const providers = await loadProviders();
        const cfg = providers[providerId];
        if (!cfg) {
          io.onLog(`✗ Provider "${providerId}" no longer in config.`);
          return false;
        }

        // Fetch catalog reference values so the user can see defaults
        const catalogModel = await deps.modelsRegistry
          .getModel(
            cfg.type && cfg.type !== providerId ? cfg.type : providerId,
            modelId,
          )
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
          await io.prompt(
            `Name (current: ${(currentMd['name'] as string) ?? modelId})`,
            { secret: false },
          )
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
        if (ctxRaw) { const n = Number(ctxRaw); if (!Number.isNaN(n) && n >= 0) limit['context'] = n; }
        if (outRaw) { const n = Number(outRaw); if (!Number.isNaN(n) && n >= 0) limit['output'] = n; }
        if (Object.keys(limit).length > 0) modelsDev['limit'] = limit;
        const cost: Record<string, number> = {};
        if (costInRaw) { const n = Number(costInRaw); if (!Number.isNaN(n) && n >= 0) cost['input'] = n; }
        if (costOutRaw) { const n = Number(costOutRaw); if (!Number.isNaN(n) && n >= 0) cost['output'] = n; }
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
                      ...(existingEntry.modelsDev?.['limit'] as Record<string, unknown> ?? {}),
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
      });
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

        const modelId = (
          await io.prompt('Model id', { secret: false })
        ).trim();
        if (!modelId) {
          io.onLog('✗ Model id is required.');
          return false;
        }

        // If from catalog, try to prefill
        if (opts?.fromCatalog) {
          const catalogModel = await deps.modelsRegistry
            .getModel(
              cfg.type && cfg.type !== providerId ? cfg.type : providerId,
              modelId,
            )
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
      });
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
          .getModel(
            cfg.type && cfg.type !== providerId ? cfg.type : providerId,
            modelId,
          )
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
      });
    },

    addCustomProvider(io: AuthFlowIo): Promise<AuthFlowResult> {
      return runFlow(() => addCustomProvider(flowDeps(deps, io)));
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
      });
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
      });
    },
  };
}
