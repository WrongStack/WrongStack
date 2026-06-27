import os from 'node:os';
import type { Config, ModelsDevModel, ModelsRegistry, ResolvedProvider } from '@wrongstack/core';
import { color, expectDefined, setOutputLineGuard, setRawMode, writeOut } from '@wrongstack/core';
import { toErrorMessage } from '@wrongstack/core/utils';
import { appendHistory, backupCurrent } from './config-history.js';
import type { ReadlineInputReader } from './input-reader.js';
import { hasApiKey, visibleModelIds } from './provider-helpers.js';
import type { TerminalRenderer } from './renderer.js';

// Simple theme alias (avoids importing the full theme module just for one color)
const theme = { primary: color.amber };

/**
 * Filter providers by a free-text query: case-insensitive substring match
 * against the provider id OR display name. An empty/whitespace query returns
 * all providers (as a copy). Input order is preserved. Powers the live
 * type-to-filter provider picker.
 */
export function filterProviders(query: string, providers: ResolvedProvider[]): ResolvedProvider[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...providers];
  return providers.filter(
    (p) => p.id.toLowerCase().includes(q) || p.name.toLowerCase().includes(q),
  );
}

export interface ProviderPickerState {
  query: string;
  selected: number;
  status: 'typing' | 'submitted' | 'cancelled';
}

/**
 * Advance the live type-to-filter provider picker by one raw input chunk.
 * Pure: given the current state, a key chunk (a single keystroke, a paste, or
 * a multi-byte arrow escape sequence), and the number of providers matching
 * the CURRENT query, returns the next state. The raw-stdin loop in
 * runLiveProviderPicker is a thin shell around this so the input logic is
 * fully unit-testable.
 */
export function applyPickerKey(
  state: ProviderPickerState,
  chunk: string,
  matchCount: number,
): ProviderPickerState {
  // Arrow keys arrive as a 3-byte CSI sequence.
  if (chunk === '\x1b[A') return { ...state, selected: Math.max(0, state.selected - 1) };
  if (chunk === '\x1b[B')
    return { ...state, selected: Math.min(Math.max(0, matchCount - 1), state.selected + 1) };
  // Lone Esc clears the query (same as Ctrl+U).
  if (chunk === '\x1b') return { ...state, query: '', selected: 0, status: 'typing' };
  // Ignore other escape sequences (left/right arrows, etc.).
  if (chunk.charCodeAt(0) === 0x1b) return state;

  let query = state.query;
  let selected = state.selected;
  const status: ProviderPickerState['status'] = 'typing';
  for (const ch of chunk) {
    if (ch === '\r' || ch === '\n') {
      return { ...state, status: matchCount > 0 ? 'submitted' : 'typing' };
    }
    if (ch === '\x03') return { ...state, status: 'cancelled' };
    if (ch === '\x15') {
      query = '';
      selected = 0;
      continue;
    }
    if (ch === '\x7f' || ch === '\b') {
      if (query.length > 0) query = query.slice(0, -1);
      selected = 0;
      continue;
    }
    if (ch < ' ') continue; // skip stray control bytes
    query += ch;
    selected = 0;
  }
  return { query, selected, status };
}

/** Preferred family display order; remaining families follow in insertion order. */
const PROVIDER_FAMILY_PREFERRED_ORDER = [
  'anthropic',
  'anthropic-oauth',
  'openai',
  'openai-codex',
  'github-copilot',
  'google',
  'openai-compatible',
];

/** Max providers rendered in one live-picker frame (keeps a frame in-viewport). */
export const LIVE_PICKER_MAX_VISIBLE = 15;

/**
 * Order providers for display: grouped by wire family in preferred order, then
 * alphabetical by id within each family. Pure. Shared by the live render and
 * the raw-stdin loop so the selection index and the rendered cursor always
 * refer to the same provider.
 */
function orderProvidersForDisplay(filtered: ResolvedProvider[]): ResolvedProvider[] {
  const families = new Map<string, ResolvedProvider[]>();
  for (const p of filtered) {
    const arr = families.get(p.family) ?? [];
    arr.push(p);
    families.set(p.family, arr);
  }
  const order = [
    ...PROVIDER_FAMILY_PREFERRED_ORDER.filter((f) => families.has(f)),
    ...[...families.keys()].filter((f) => !PROVIDER_FAMILY_PREFERRED_ORDER.includes(f)),
  ];
  const flat: ResolvedProvider[] = [];
  for (const fam of order) {
    const arr = (families.get(fam) ?? [])
      .slice()
      .sort((a, b) => a.id.toLowerCase().localeCompare(b.id.toLowerCase()));
    flat.push(...arr);
  }
  return flat;
}

/**
 * Render the live type-to-filter provider view as one string: the query line,
 * providers grouped by wire family (preferred order, alphabetical within each
 * family), the selected provider marked with ▶, and a key hint. Capped to
 * LIVE_PICKER_MAX_VISIBLE rows so a frame always fits the viewport (the raw
 * loop redraws by moving the cursor up and clearing). Pure.
 */
export function renderLiveProviderList(
  query: string,
  filtered: ResolvedProvider[],
  selectedIdx: number,
): string {
  const ordered = orderProvidersForDisplay(filtered);
  const visible = ordered.slice(0, LIVE_PICKER_MAX_VISIBLE);
  let out = `? Select provider: ${query}\n`;
  let flat = 0;
  let lastFamily = '';
  for (const p of visible) {
    if (p.family !== lastFamily) {
      out += `  ${p.family}\n`;
      lastFamily = p.family;
    }
    const marker = flat === selectedIdx ? '▶ ' : '  ';
    out += `${marker}${p.id.padEnd(24)} ${p.name}\n`;
    flat++;
  }
  if (ordered.length > LIVE_PICKER_MAX_VISIBLE) {
    out += `  … ${ordered.length - LIVE_PICKER_MAX_VISIBLE} more — type to filter\n`;
  }
  out += '  ↑↓ move · Enter select · Esc clear · Ctrl+C quit';
  return out;
}

/**
 * Filter models by a free-text query: case-insensitive substring match against
 * the model id OR display name. Empty/whitespace query returns all (copy).
 * Powers the live type-to-filter model picker.
 */
export function filterModels(query: string, models: ModelsDevModel[]): ModelsDevModel[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...models];
  return models.filter((m) => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q));
}

/**
 * Render the live type-to-filter model view as one string: the provider header,
 * the query line, models sorted newest-first (release_date desc) with context /
 * cost / capability columns, the selected model marked with ▶, and a key hint.
 * Capped to LIVE_PICKER_MAX_VISIBLE rows so a frame fits the viewport. Pure.
 */
export function renderLiveModelList(
  query: string,
  filtered: ModelsDevModel[],
  selectedIdx: number,
  header: string,
): string {
  const ordered = [...filtered].sort((a, b) =>
    (b.release_date ?? '').localeCompare(a.release_date ?? ''),
  );
  const visible = ordered.slice(0, LIVE_PICKER_MAX_VISIBLE);
  let out = `  ${header}\n? Select model: ${query}\n`;
  let flat = 0;
  for (const m of visible) {
    const ctx = m.limit?.context ? `${(m.limit.context / 1000).toFixed(0)}k`.padStart(6) : '     ?';
    const cost = m.cost?.input !== undefined ? `$${m.cost.input}/$${m.cost.output ?? '?'}` : '';
    const caps: string[] = [];
    if (m.tool_call) caps.push('tools');
    if (m.reasoning) caps.push('reason');
    if (m.modalities?.input?.includes('image')) caps.push('vision');
    const marker = flat === selectedIdx ? '▶ ' : '  ';
    out += `${marker}${m.id.padEnd(34)}${ctx}  ${cost.padEnd(12)} ${caps.join(',')}\n`;
    flat++;
  }
  if (ordered.length > LIVE_PICKER_MAX_VISIBLE) {
    out += `  … ${ordered.length - LIVE_PICKER_MAX_VISIBLE} more — type to filter\n`;
  }
  out += '  ↑↓ move · Enter select · Esc clear · Ctrl+C quit';
  return out;
}

/**
 * Save provider + model to the global config file.
 * Creates backups + history entries before writing.
 * Returns true if saved successfully.
 */
export async function saveToGlobalConfig(
  configPath: string,
  provider: string,
  model: string,
  homeFn: () => string = () => process.env.HOME ?? os.homedir(),
): Promise<boolean> {
  try {
    const { atomicWrite } = await import('@wrongstack/core');
    const fs = await import('node:fs/promises');

    let existing: Record<string, unknown> = {};
    try {
      const raw = await fs.readFile(configPath, 'utf8');
      existing = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      // No existing config
    }

    const oldCfg = { ...existing };
    existing.provider = provider;
    existing.model = model;

    // Backup before writing — best-effort (never blocks save)
    try {
      await backupCurrent(homeFn);
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
      );
    } catch {
      // best-effort
    }

    return true;
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
}

/**
 * Interactive provider + model picker. Lists supported providers grouped
 * by wire family — by default only those with an API key (env or stored
 * config), so you see only what you can actually launch into. Falls back
 * to the full catalog when no keys are found anywhere.
 *
 * When `defaultProvider`/`defaultModel` are passed, they're pre-selected
 * so the user can press Enter to accept the previous choice.
 */
/**
 * Live type-to-filter provider picker (TTY only). Takes over stdin in raw mode
 * and redraws the filtered, family-grouped list on every keystroke. Thin I/O
 * shell around the pure filterProviders / applyPickerKey / renderLiveProviderList
 * helpers (which are fully unit-tested). Returns the chosen provider, or
 * undefined on cancel. runPicker only calls this when stdin is a TTY; non-TTY
 * callers (CI, piped input, tests) fall through to the numbered readLine picker.
 */
async function runLiveProviderPicker(
  displayList: ResolvedProvider[],
): Promise<ResolvedProvider | undefined> {
  const stdin = process.stdin;
  const out = process.stdout;
  if (!stdin.isTTY || !out.isTTY) return undefined;

  setOutputLineGuard(null);
  let state: ProviderPickerState = { query: '', selected: 0, status: 'typing' };
  let ordered = orderProvidersForDisplay(filterProviders(state.query, displayList));
  // Selection lives within the visible window so it always maps to a rendered row.
  const visibleCount = (): number => Math.min(ordered.length, LIVE_PICKER_MAX_VISIBLE);
  const clamp = (): void => {
    if (state.selected >= visibleCount()) state.selected = Math.max(0, visibleCount() - 1);
  };
  clamp();
  let frame = renderLiveProviderList(state.query, ordered, state.selected);
  writeOut(frame);

  return new Promise<ResolvedProvider | undefined>((resolve) => {
    const wasRaw = stdin.isRaw;
    const wasPaused = stdin.isPaused();
    setRawMode(stdin, true);
    stdin.resume();
    stdin.setEncoding('utf8');

    const cleanup = (): void => {
      stdin.off('data', onData);
      setRawMode(stdin, wasRaw);
      if (wasPaused) stdin.pause();
    };
    const repaint = (): void => {
      // Move back to the top of the previous frame and clear to end of screen.
      const ups = (frame.match(/\n/g) ?? []).length;
      writeOut(`\x1b[${ups}A\r\x1b[J`);
      ordered = orderProvidersForDisplay(filterProviders(state.query, displayList));
      clamp();
      frame = renderLiveProviderList(state.query, ordered, state.selected);
      writeOut(frame);
    };
    const onData = (chunk: string): void => {
      ordered = orderProvidersForDisplay(filterProviders(state.query, displayList));
      state = applyPickerKey(state, chunk, visibleCount());
      // applyPickerKey may have changed the query (type/paste) — recompute against
      // the NEW query before resolving a selection, so a paste like "zzz\r" can't
      // submit a provider from the pre-paste list.
      ordered = orderProvidersForDisplay(filterProviders(state.query, displayList));
      clamp();
      if (state.status === 'cancelled') {
        cleanup();
        writeOut('\n');
        resolve(undefined);
        return;
      }
      if (state.status === 'submitted') {
        // Query emptied the matches mid-chunk (e.g. paste): stay in the picker.
        if (ordered.length === 0) {
          state = { ...state, status: 'typing' };
          repaint();
          return;
        }
        const pick = ordered[state.selected] ?? ordered[0];
        cleanup();
        writeOut('\n');
        resolve(pick);
        return;
      }
      repaint();
    };
    stdin.on('data', onData);
  });
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
    `\n${color.bold(theme.primary('WrongStack') + color.dim(' — Provider & Model Selection'))}\n`,
  );
  renderer.write(color.dim('Loading provider catalog…\n'));

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

  if (merged.length === 0) {
    renderer.writeError('No supported providers found in catalog.');
    return undefined;
  }

  // Filter to keyed providers. If none are keyed (fresh install, no env
  // vars set), fall back to the full list and prompt the user to add a
  // key — picking a keyless provider here is still useful because the
  // very next step (`wstack auth <prov>`) needs to know which provider.
  const keyed = merged.filter((p) => hasApiKey(p, config));
  let displayList = keyed;
  let showingFallback = false;
  if (keyed.length === 0) {
    displayList = merged;
    showingFallback = true;
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
    'openai-compatible',
  ];
  const familyOrder = [
    ...preferredOrder.filter((f) => families.has(f)),
    ...[...families.keys()].filter((f) => !preferredOrder.includes(f)),
  ];
  let idx = 1;
  let defaultIdx: number | undefined;
  renderer.write('\n');
  for (const fam of familyOrder) {
    // Sort within each family alphabetically (case-insensitive) by id.
    const list = [...(families.get(fam) ?? [])].sort((a, b) =>
      a.id.toLowerCase().localeCompare(b.id.toLowerCase()),
    );
    if (!list || list.length === 0) continue;
    renderer.write(`  ${color.bold(fam)}\n`);
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
      const idLabel = isDefault ? color.bold(p.id) : p.id;
      const suffix = isDefault ? color.dim(' (default)') : '';
      renderer.write(
        `  ${color.dim(`${idx}.`.padStart(4))} ${marker} ${idLabel.padEnd(22)} ${color.dim(p.name)}${suffix}\n`,
      );
      ordered.push({ provider: p, index: idx });
      idx++;
    }
  }

  if (showingFallback) {
    renderer.write(
      `\n  ${color.yellow('⚠ No API keys detected.')} ${color.dim('Pick a provider, then run `wstack auth <provider>` to add one.')}\n`,
    );
  } else {
    renderer.write(`\n  ${color.dim('● = env key   ◉ = stored in config   ○ = no key')}\n`);
  }

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

/**
 * Live type-to-filter model picker (TTY only). Mirrors runLiveProviderPicker:
 * takes over stdin in raw mode and redraws the filtered, newest-first model
 * list on every keystroke. Selection indexes the release_date-desc order used
 * by renderLiveModelList so the ▶ cursor and Enter always agree. Returns the
 * chosen model, or undefined on cancel.
 */
async function runLiveModelPicker(
  provider: ResolvedProvider,
  defaultModel?: string,
): Promise<ModelsDevModel | undefined> {
  const stdin = process.stdin;
  const out = process.stdout;
  if (!stdin.isTTY || !out.isTTY) return undefined;

  const header = `${provider.name} (${provider.id}) models:`;
  const byNewest = (a: ModelsDevModel, b: ModelsDevModel): number =>
    (b.release_date ?? '').localeCompare(a.release_date ?? '');
  // Pre-select the default model (if any) in newest-first order.
  const ranked = [...provider.models].sort(byNewest);
  const defaultIdx =
    defaultModel !== undefined ? ranked.findIndex((m) => m.id === defaultModel) : -1;

  setOutputLineGuard(null);
  let state: ProviderPickerState = {
    query: '',
    selected: defaultIdx >= 0 ? defaultIdx : 0,
    status: 'typing',
  };
  const order = (filtered: ModelsDevModel[]): ModelsDevModel[] => [...filtered].sort(byNewest);
  let ordered = order(filterModels(state.query, provider.models));
  const visibleCount = (): number => Math.min(ordered.length, LIVE_PICKER_MAX_VISIBLE);
  const clamp = (): void => {
    if (state.selected >= visibleCount()) state.selected = Math.max(0, visibleCount() - 1);
  };
  clamp();
  let frame = renderLiveModelList(state.query, ordered, state.selected, header);
  writeOut(frame);

  return new Promise<ModelsDevModel | undefined>((resolve) => {
    const wasRaw = stdin.isRaw;
    const wasPaused = stdin.isPaused();
    setRawMode(stdin, true);
    stdin.resume();
    stdin.setEncoding('utf8');

    const cleanup = (): void => {
      stdin.off('data', onData);
      setRawMode(stdin, wasRaw);
      if (wasPaused) stdin.pause();
    };
    const repaint = (): void => {
      const ups = (frame.match(/\n/g) ?? []).length;
      writeOut(`\x1b[${ups}A\r\x1b[J`);
      ordered = order(filterModels(state.query, provider.models));
      clamp();
      frame = renderLiveModelList(state.query, ordered, state.selected, header);
      writeOut(frame);
    };
    const onData = (chunk: string): void => {
      ordered = order(filterModels(state.query, provider.models));
      state = applyPickerKey(state, chunk, visibleCount());
      // applyPickerKey may have changed the query — recompute before resolving.
      ordered = order(filterModels(state.query, provider.models));
      clamp();
      if (state.status === 'cancelled') {
        cleanup();
        writeOut('\n');
        resolve(undefined);
        return;
      }
      if (state.status === 'submitted') {
        if (ordered.length === 0) {
          state = { ...state, status: 'typing' };
          repaint();
          return;
        }
        const pick = ordered[state.selected] ?? ordered[0];
        cleanup();
        writeOut('\n');
        resolve(pick);
        return;
      }
      repaint();
    };
    stdin.on('data', onData);
  });
}

async function pickModel(
  provider: ResolvedProvider,
  registry: ModelsRegistry,
  renderer: TerminalRenderer,
  reader: ReadlineInputReader,
  defaultModel?: string | undefined,
): Promise<PickerResult | undefined> {
  renderer.write(`\n  ${color.bold(provider.name)} ${color.dim(`(${provider.id})`)} models:\n\n`);

  const models = [...provider.models].sort((a, b) =>
    (b.release_date ?? '').localeCompare(a.release_date ?? ''),
  );

  if (models.length === 0) {
    renderer.writeError('  No models listed for this provider in the catalog.');
    return undefined;
  }

  // TTY: live type-to-filter model picker. Non-TYY (CI/piped/tests) falls
  // through to the paginated numbered picker below.
  if (process.stdin.isTTY) {
    const chosen = await runLiveModelPicker(provider, defaultModel);
    if (!chosen) {
      renderer.write(color.dim('Cancelled.\n'));
      return undefined;
    }
    renderer.write(
      `\n  ${color.green('✓')} ${color.bold(provider.id)} / ${color.bold(chosen.id)}\n\n`,
    );
    return { provider: provider.id, model: chosen.id };
  }

  // Find default-model index for the "Enter = default" hint.
  const defaultIdxInModels =
    defaultModel !== undefined ? models.findIndex((m) => m.id === defaultModel) : -1;

  // Show paginated — up to 30 at a time
  const pageSize = 30;
  let offset = 0;

  while (offset < models.length) {
    const page = models.slice(offset, offset + pageSize);
    for (let i = 0; i < page.length; i++) {
      const m = expectDefined(page[i]);
      const num = offset + i + 1;
      const ctx = m.limit?.context
        ? `${(m.limit.context / 1000).toFixed(0)}k`.padStart(6)
        : '     ?';
      const cost = m.cost?.input !== undefined ? `$${m.cost.input}/$${m.cost.output ?? '?'}` : '';
      const caps: string[] = [];
      if (m.tool_call) caps.push('tools');
      if (m.reasoning) caps.push('reason');
      if (m.modalities?.input?.includes('image')) caps.push('vision');
      const capStr = caps.length > 0 ? color.dim(caps.join(',')) : '';
      const isDefault = m.id === defaultModel;
      const idLabel = isDefault ? color.bold(m.id) : m.id;
      const suffix = isDefault ? color.dim(' (default)') : '';
      renderer.write(
        `  ${color.dim(`${num}.`.padStart(5))} ${idLabel.padEnd(44)} ${color.dim(ctx)}  ${color.dim(cost.padEnd(14))} ${capStr}${suffix}\n`,
      );
    }
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
    limit?: { context?: number | undefined };
    cost?: { input?: number | undefined; output?: number | undefined };
    tool_call?: boolean | undefined;
    reasoning?: boolean | undefined;
    modalities?: { input?: string[] | undefined };
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
