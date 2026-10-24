import os from 'node:os';
import type {
  Config,
  ModelsRegistry,
  ReasoningEffort,
  ResolvedProvider,
} from '@wrongstack/contracts/types';
import { color, expectDefined, toErrorMessage, withFileLock } from '@wrongstack/core/utils';
import { appendHistory, backupCurrent } from './config-history.js';
import type { ReadlineInputReader } from './input-reader.js';
import { EFFORT_KEEP } from './picker-effort.js';
import { runLiveModelPicker } from './picker-model-picker.js';
import { appendLocalPresetProviders, runLiveProviderPicker } from './picker-provider-list.js';
import {
  boxBottom,
  boxDivider,
  boxRow,
  boxTop,
  codexPickerPreamble,
  padVisible,
  theme,
} from './picker-ui.js';
import { hasApiKey, isKeylessLocalProvider, visibleModelIds } from './provider-helpers.js';
import type { TerminalRenderer } from './renderer.js';

export { applyPickerKey, type ProviderPickerState } from './picker-key-state.js';
export {
  filterModels,
  LIVE_PICKER_MAX_VISIBLE,
  renderLiveModelList,
} from './picker-model-picker.js';
export {
  filterProviders,
  renderLiveProviderList,
  runLiveProviderPicker,
} from './picker-provider-list.js';
export { codexPickerPreamble } from './picker-ui.js';

/**
 * Save provider + model to the global config file.
 * Creates backups + history entries before writing.
 * Returns true if saved successfully.
 */
export async function saveToGlobalConfig(
  configPath: string,
  provider: string,
  model: string,
  options: {
    /** Written to `modelRuntime.reasoning.effort` — the key `/effort` and the settings panel own. */
    effort?: ReasoningEffort | undefined;
    homeFn?: (() => string) | undefined;
  } = {},
): Promise<boolean> {
  const { effort, homeFn = () => process.env.HOME ?? os.homedir() } = options;
  try {
    return await withFileLock(configPath, async () => {
      const { atomicWrite } = await import('@wrongstack/core/utils');
      const fs = await import('node:fs/promises');

      let existing: Record<string, unknown> = {};
      try {
        const raw = await fs.readFile(configPath, 'utf8');
        // A UTF-8 BOM (PowerShell 5.1 writes one) is dropped, as the config loader does.
        existing = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw) as Record<
          string,
          unknown
        >;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }

      const oldCfg = { ...existing };
      existing.provider = provider;
      existing.model = model;
      if (effort) {
        const modelRuntime = isPlainRecord(existing.modelRuntime) ? existing.modelRuntime : {};
        const reasoning = isPlainRecord(modelRuntime.reasoning) ? modelRuntime.reasoning : {};
        existing.modelRuntime = { ...modelRuntime, reasoning: { ...reasoning, effort } };
      }

      // Backup before writing — best-effort (never blocks save)
      try {
        await backupCurrent(homeFn, configPath);
      } catch (err) {
        console.warn(
          JSON.stringify({
            level: 'warn',
            event: 'picker.backup_failed',
            message: toErrorMessage(err),
            timestamp: new Date().toISOString(),
          }),
        );
      }

      await atomicWrite(configPath, JSON.stringify(existing, null, 2), { mode: 0o600 });

      // Record in history — best-effort (never blocks save)
      try {
        await appendHistory(
          oldCfg,
          existing,
          `Provider/model changed: ${oldCfg.provider ?? '(none)'} → ${provider}, ${oldCfg.model ?? '(none)'} → ${model}`,
          homeFn,
          configPath,
        );
      } catch {
        // best-effort
      }

      return true;
    });
  } catch (err) {
    console.warn(
      JSON.stringify({
        level: 'warn',
        event: 'picker.save_failed',
        message: toErrorMessage(err),
        timestamp: new Date().toISOString(),
      }),
    );
    return false;
  }
}

export interface PickerResult {
  provider: string;
  model: string;
  /**
   * Reasoning effort chosen on the model's ←/→ strip. Absent when the user
   * kept `default` (or the model has no strip) — the configured effort stays.
   */
  effort?: ReasoningEffort | undefined;
}

export async function runPicker(deps: {
  modelsRegistry: ModelsRegistry;
  renderer: TerminalRenderer;
  reader: ReadlineInputReader;
  config?: Config | undefined;
  defaultProvider?: string | undefined;
  defaultModel?: string | undefined;
}): Promise<PickerResult | undefined> {
  const { modelsRegistry, renderer, reader, config, defaultProvider, defaultModel } = deps;

  renderer.write(
    `\n${theme.accent(color.bold('▌ WrongStack'))}  ${color.dim('Provider & Model Selection')}\n`,
  );
  renderer.write(color.dim(`${theme.chrome('·')} Loading provider catalog…\n`));

  let providers: ResolvedProvider[];
  try {
    providers = await modelsRegistry.listProviders();
  } catch {
    renderer.writeError(
      'Failed to load provider catalog. Pass --provider and --model to skip the picker.',
    );
    return undefined;
  }

  // Drop unsupported wire families — they need a plugin and can't be
  // selected through this path.
  const supported = providers.filter((p) => p.family !== 'unsupported');

  // Build the display list by overlaying saved config on top of the
  // catalog. Two kinds of saved entries matter:
  //   1. The map key matches a catalog id (`zai-coding-plan`) — the
  //      user may have overridden family/baseUrl. We MUST honor those
  //      overrides for grouping/display, otherwise an entry the user
  //      saved as `family: "anthropic"` would still appear under the
  //      catalog's `openai-compatible` group.
  //   2. The map key is an alias not in the catalog. Its `cfg.type` may
  //      still point at a catalog id, in which case we inherit the
  //      model list and display name from there.
  const catalogById = new Map(supported.map((p) => [p.id, p]));
  const overlay = config?.providers ?? {};
  const seen = new Set<string>();
  const merged: ResolvedProvider[] = [];
  for (const p of supported) {
    const cfg = overlay[p.id];
    seen.add(p.id);
    if (cfg) {
      merged.push({
        ...p,
        family: cfg.family ?? p.family,
        apiBase: cfg.baseUrl ?? p.apiBase,
        envVars: cfg.envVars && cfg.envVars.length > 0 ? cfg.envVars : p.envVars,
        // When the user has saved an explicit model list, it wins — they
        // know which models their endpoint actually serves (e.g. LM
        // Studio, vLLM, or a proxy with custom model ids). Otherwise the
        // catalog list keeps providing suggestions.
        models: visibleModelIds(
          p.id,
          config ?? ({ providers: {} } as Config),
          p.models.map((m) => m.id),
          cfg,
        ).map((m) => p.models.find((pm) => pm.id === m) ?? { id: m, name: m }),
      });
    } else {
      merged.push(p);
    }
  }
  for (const [id, cfg] of Object.entries(overlay)) {
    if (seen.has(id)) continue;
    if (!cfg?.family || cfg.family === 'unsupported') continue;
    const catalogType = cfg.type && cfg.type !== id ? cfg.type : undefined;
    const inherited = catalogType ? catalogById.get(catalogType) : undefined;
    merged.push({
      id,
      name: inherited ? `${inherited.name} ${color.dim('(alias)')}` : id,
      family: cfg.family,
      apiBase: cfg.baseUrl ?? inherited?.apiBase,
      envVars: cfg.envVars ?? inherited?.envVars ?? [],
      models: visibleModelIds(
        id,
        config ?? ({ providers: {} } as Config),
        (inherited?.models ?? []).map((m) => m.id),
        cfg,
      ).map((m) => inherited?.models.find((pm) => pm.id === m) ?? { id: m, name: m }),
      npm: inherited?.npm,
    });
  }

  // Filter to usable providers: those with a key, plus keyless local
  // gateways (omniroute/LiteLLM/… on a loopback address) which need no
  // credential and so are immediately launchable. If none qualify (fresh
  // install, no env vars set), fall back to the full list and prompt the
  // user to add a key — picking a keyless provider here is still useful
  // because the very next step (`wstack auth <prov>`) needs to know which.
  const keyed = merged.filter((p) => hasApiKey(p, config) || isKeylessLocalProvider(p));
  let displayList = keyed;
  let showingFallback = false;
  if (keyed.length === 0) {
    displayList = merged;
    // The full-catalog fallback only makes sense when there's actually a
    // catalog to fall back on. With an empty catalog, the only thing we'll
    // show is the keyless local presets (injected below), which need no
    // key — so don't nag the user about missing keys in that case.
    showingFallback = merged.length > 0;
  }

  // Surface the built-in local-server presets (OmniRoute / Ollama / vLLM /
  // LM Studio) that aren't already in the catalog or saved config. Done
  // AFTER the keyed/fallback decision so these always-keyless entries
  // don't suppress the "no keys anywhere → show full catalog" fallback;
  // they're simply appended to whichever list we're about to show.
  appendLocalPresetProviders(displayList);

  if (displayList.length === 0) {
    renderer.writeError('No supported providers found in catalog.');
    return undefined;
  }

  // TTY: live type-to-filter picker. Non-TTY (CI, piped, tests) falls through
  // to the numbered readLine picker below.
  if (process.stdin.isTTY) {
    const chosen = await runLiveProviderPicker(displayList);
    if (!chosen) {
      renderer.write(color.dim('Cancelled.\n'));
      return undefined;
    }
    return pickModel(chosen, modelsRegistry, renderer, reader, defaultModel);
  }

  // Group by family for nicer display
  const families = new Map<string, ResolvedProvider[]>();
  for (const p of displayList) {
    const list = families.get(p.family) ?? [];
    list.push(p);
    families.set(p.family, list);
  }

  // Build a flat numbered list (family → providers). Track which entry
  // matches the current default so we can highlight + accept Enter.
  const ordered: Array<{ provider: ResolvedProvider; index: number }> = [];
  // Preferred grouping order, then any remaining families present in the list.
  // The trailing append is essential: OAuth / subscription families
  // (anthropic-oauth, openai-codex, github-copilot) live only in saved config,
  // never the catalog — a fixed allowlist would silently drop them from the
  // launch picker even though they have keys.
  const preferredOrder = [
    'anthropic',
    'anthropic-oauth',
    'openai',
    'openai-codex',
    'github-copilot',
    'google',
    'google-antigravity',
    'openai-compatible',
  ];
  const familyOrder = [
    ...preferredOrder.filter((f) => families.has(f)),
    ...[...families.keys()].filter((f) => !preferredOrder.includes(f)),
  ];
  let idx = 1;
  let defaultIdx: number | undefined;
  renderer.write('\n');
  renderer.write(`${boxTop('Select a provider')}\n`);
  for (const fam of familyOrder) {
    // Sort within each family alphabetically (case-insensitive) by id.
    const list = [...(families.get(fam) ?? [])].sort((a, b) =>
      a.id.toLowerCase().localeCompare(b.id.toLowerCase()),
    );
    if (!list || list.length === 0) continue;
    // Family section label — dim UPPERCASE with a leading accent tick, matching
    // the live picker's grouping. `fam` (a lowercased id) stays contained.
    renderer.write(`${boxRow(`${theme.accent('·')} ${color.dim(fam.toUpperCase())}`)}\n`);
    for (const p of list) {
      const envFound = p.envVars.some((v) => !!process.env[v]);
      const entry = config?.providers?.[p.id];
      const configKey =
        (typeof entry?.apiKey === 'string' && entry.apiKey.length > 0) ||
        (Array.isArray(entry?.apiKeys) && entry?.apiKeys?.some((k) => k?.apiKey));
      // ● green = env key, ◉ cyan = stored in config, ○ dim = no key
      const marker = envFound ? color.green('●') : configKey ? color.cyan('◉') : color.dim('○');
      const isDefault = p.id === defaultProvider;
      if (isDefault) defaultIdx = idx;
      const idLabel = isDefault ? theme.accent(color.bold(p.id)) : p.id;
      const suffix = isDefault ? color.dim(' (default)') : '';
      renderer.write(
        `${boxRow(`${color.dim(`${idx}.`.padStart(4))} ${marker} ${padVisible(idLabel, 22)} ${color.dim(p.name)}${suffix}`)}\n`,
      );
      ordered.push({ provider: p, index: idx });
      idx++;
    }
  }

  renderer.write(`${boxDivider()}\n`);
  if (showingFallback) {
    renderer.write(
      `${boxRow(`${color.yellow('⚠ No API keys detected.')} ${color.dim('Run `wstack auth <provider>` after picking.')}`)}\n`,
    );
  } else {
    renderer.write(`${boxRow(color.dim('● env key   ◉ stored in config   ○ no key'))}\n`);
  }
  renderer.write(`${boxBottom()}\n`);

  // Provider prompt. Enter on an empty line accepts the default when one
  // is present; otherwise we treat it as cancel.
  const defaultHint =
    defaultIdx !== undefined && defaultProvider
      ? ` ${color.dim(`[Enter = ${defaultProvider}]`)}`
      : '';
  const providerAnswer = (
    await reader.readLine(
      `\n${color.amber('?')} Select provider (1-${ordered.length})${defaultHint} ${color.dim('[q to quit]')}: `,
    )
  ).trim();

  if (providerAnswer.toLowerCase() === 'q') {
    renderer.write(color.dim('Cancelled.\n'));
    return undefined;
  }

  if (!providerAnswer) {
    if (defaultIdx !== undefined) {
      const def = ordered[defaultIdx - 1];
      if (def) return pickModel(def.provider, modelsRegistry, renderer, reader, defaultModel);
    }
    renderer.write(color.dim('Cancelled.\n'));
    return undefined;
  }

  const providerIdx = Number.parseInt(providerAnswer, 10);
  if (Number.isNaN(providerIdx) || providerIdx < 1 || providerIdx > ordered.length) {
    // Try matching by id
    const byId = ordered.find((o) => o.provider.id.toLowerCase() === providerAnswer.toLowerCase());
    if (!byId) {
      renderer.writeError(`Invalid selection: "${providerAnswer}"`);
      return undefined;
    }
    return pickModel(byId.provider, modelsRegistry, renderer, reader, defaultModel);
  }

  const chosen = ordered[providerIdx - 1];
  if (!chosen) return undefined;
  // Only honor the default-model hint when the user picked the default
  // provider; switching providers invalidates it.
  const modelHint = chosen.provider.id === defaultProvider ? defaultModel : undefined;
  return pickModel(chosen.provider, modelsRegistry, renderer, reader, modelHint);
}

async function pickModel(
  provider: ResolvedProvider,
  registry: ModelsRegistry,
  renderer: TerminalRenderer,
  reader: ReadlineInputReader,
  defaultModel?: string | undefined,
): Promise<PickerResult | undefined> {
  // Boxed header. The `<name> (<id>) models:` text is kept contiguous (a test
  // asserts it verbatim, and colors are no-ops off-TTY).
  renderer.write(`\n${boxTop('Select a model')}\n`);
  renderer.write(
    `${boxRow(`${color.bold(provider.name)} ${color.dim(`(${provider.id})`)} models:`)}\n`,
  );
  renderer.write(`${boxBottom()}\n`);
  // openai-codex picker mirrors the official Codex CLI header; only current
  // models are listed, but legacy ids remain usable via --model / config.json.
  // Uses the same helper as the live-TTY preamble so the two paths can't drift.
  const codexBlock = codexPickerPreamble(provider);
  if (codexBlock) renderer.write(codexBlock);

  const models = [...provider.models].sort((a, b) =>
    (b.release_date ?? '').localeCompare(a.release_date ?? ''),
  );

  if (models.length === 0) {
    // No catalog models — common for a freshly-picked local-server preset
    // (OmniRoute / Ollama / LM Studio / …) whose model list auto-discovers
    // at boot or is known only to the user. Instead of dead-ending, let
    // them type a model id directly. Empty input cancels.
    renderer.write(
      color.dim(
        '  No models listed yet for this provider — type a model id to use it ' +
          '(local servers auto-discover models at launch).\n',
      ),
    );
    const typed = (
      await reader.readLine(`\n${color.amber('?')} Model id ${color.dim('(or Enter to cancel)')}: `)
    ).trim();
    if (!typed) {
      renderer.write(color.dim('Cancelled.\n'));
      return undefined;
    }
    renderer.write(`\n  ${color.green('✓')} ${color.bold(provider.id)} / ${color.bold(typed)}\n\n`);
    return { provider: provider.id, model: typed };
  }

  // TTY: live type-to-filter model picker. Non-TYY (CI/piped/tests) falls
  // through to the paginated numbered picker below.
  if (process.stdin.isTTY) {
    const chosen = await runLiveModelPicker(provider, defaultModel);
    if (!chosen) {
      renderer.write(color.dim('Cancelled.\n'));
      return undefined;
    }
    const effort = chosen.effort === EFFORT_KEEP ? undefined : chosen.effort;
    const effortSuffix = effort ? color.dim(` · effort ${effort}`) : '';
    renderer.write(
      `\n  ${color.green('✓')} ${color.bold(provider.id)} / ${color.bold(chosen.model.id)}${effortSuffix}\n\n`,
    );
    return { provider: provider.id, model: chosen.model.id, ...(effort ? { effort } : {}) };
  }

  // Find default-model index for the "Enter = default" hint.
  const defaultIdxInModels =
    defaultModel !== undefined ? models.findIndex((m) => m.id === defaultModel) : -1;

  // Show paginated — up to 30 at a time
  const pageSize = 30;
  let offset = 0;

  while (offset < models.length) {
    const page = models.slice(offset, offset + pageSize);
    const pageFrom = offset + 1;
    const pageTo = Math.min(offset + page.length, models.length);
    // Each page is its own box so pagination prompts sit cleanly between boxes.
    renderer.write(`${boxTop(`Models ${pageFrom}–${pageTo} of ${models.length}`)}\n`);
    for (let i = 0; i < page.length; i++) {
      const m = expectDefined(page[i]);
      const num = offset + i + 1;
      const ctxRaw = m.limit?.context ? `${(m.limit.context / 1000).toFixed(0)}k` : '?';
      const ctx = theme.ctx(ctxRaw.padStart(6));
      const cost = m.cost?.input !== undefined ? `$${m.cost.input}/$${m.cost.output ?? '?'}` : '';
      const costCol = cost ? theme.cost(cost) : '';
      const capTags: string[] = [];
      if (m.tool_call) capTags.push('tools');
      if (m.reasoning) capTags.push('reason');
      if (m.modalities?.input?.includes('image')) capTags.push('vision');
      const capStr = capTags.map((c) => theme.caps(c)).join(color.dim(' '));
      const isDefault = m.id === defaultModel;
      const idLabel = isDefault ? theme.accent(color.bold(m.id)) : m.id;
      const suffix = isDefault ? color.dim(' (default)') : '';
      const num5 = color.dim(`${num}.`.padStart(5));
      renderer.write(
        `${boxRow(`${num5} ${padVisible(idLabel, 34)} ${ctx}  ${padVisible(costCol, 11)} ${capStr}${suffix}`)}\n`,
      );
    }
    renderer.write(`${boxBottom()}\n`);
    offset += pageSize;

    if (offset < models.length) {
      const more = (
        await reader.readLine(
          `\n${color.amber('?')} Showing ${Math.min(offset, models.length)}/${models.length} — Enter number, ${color.dim('Enter')} for more, or ${color.dim('q')} to quit: `,
        )
      ).trim();
      if (more.toLowerCase() === 'q') {
        renderer.write(color.dim('Cancelled.\n'));
        return undefined;
      }
      if (!more) continue; // show next page
      return resolveModelSelection(more, models, provider, registry, renderer, reader);
    }
  }

  // All shown — final prompt. Enter accepts the default model when present.
  const defaultHint =
    defaultIdxInModels >= 0 && defaultModel ? ` ${color.dim(`[Enter = ${defaultModel}]`)}` : '';
  const answer = (
    await reader.readLine(
      `\n${color.amber('?')} Select model (1-${models.length})${defaultHint} ${color.dim('[q to quit]')}: `,
    )
  ).trim();
  if (answer.toLowerCase() === 'q') {
    renderer.write(color.dim('Cancelled.\n'));
    return undefined;
  }
  if (!answer) {
    if (defaultIdxInModels >= 0 && defaultModel) {
      renderer.write(
        `\n  ${color.green('✓')} ${color.bold(provider.id)} / ${color.bold(defaultModel)}\n\n`,
      );
      return { provider: provider.id, model: defaultModel };
    }
    renderer.write(color.dim('Cancelled.\n'));
    return undefined;
  }
  return resolveModelSelection(answer, models, provider, registry, renderer, reader);
}

async function resolveModelSelection(
  answer: string,
  models: {
    id: string;
    name: string;
    release_date?: string | undefined;
    limit?: { context?: number | undefined } | undefined;
    cost?: { input?: number | undefined; output?: number | undefined } | undefined;
    tool_call?: boolean | undefined;
    reasoning?: boolean | undefined;
    modalities?: { input?: string[] | undefined } | undefined;
  }[],
  provider: ResolvedProvider,
  _registry: ModelsRegistry,
  renderer: TerminalRenderer,
  _reader: ReadlineInputReader,
): Promise<PickerResult | undefined> {
  const idx = Number.parseInt(answer, 10);
  let modelId: string | undefined;

  if (!Number.isNaN(idx) && idx >= 1 && idx <= models.length) {
    modelId = models[idx - 1]?.id;
  } else {
    // Try fuzzy matching by id
    const lower = answer.toLowerCase();
    const match = models.find((m) => m.id.toLowerCase() === lower);
    if (match) {
      modelId = match.id;
    } else {
      // Partial match
      const partial = models.filter((m) => m.id.toLowerCase().includes(lower));
      if (partial.length === 1) {
        modelId = partial[0]?.id;
      } else if (partial.length > 1) {
        renderer.writeError(`"${answer}" matches multiple models. Be more specific.`);
        return undefined;
      }
    }
  }

  if (!modelId) {
    // Use as-is (user might know the exact model string)
    modelId = answer;
  }

  renderer.write(`\n  ${color.green('✓')} ${color.bold(provider.id)} / ${color.bold(modelId)}\n\n`);

  return { provider: provider.id, model: modelId };
}

// --- Helpers ---

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
