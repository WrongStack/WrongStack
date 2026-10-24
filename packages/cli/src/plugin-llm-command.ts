import type { Config } from '@wrongstack/contracts/types';
import { atomicWrite } from '@wrongstack/core/utils';
import { errorResult, isRecord, readConfig } from './plugin-config.js';
import type { PluginManagementDeps, PluginManagementResult } from './plugin-management-types.js';

const PLUGIN_LLM_USAGE = [
  'Usage:',
  '  wstack plugin llm                               List every per-plugin LLM override.',
  "  wstack plugin llm <plugin>                      Show one plugin's LLM override.",
  '  wstack plugin llm <plugin> <provider> [model]   Route this plugin through a provider (and model).',
  '  wstack plugin llm <plugin> - <model>            Keep the session provider, override only the model.',
  '  wstack plugin llm <plugin> --clear              Remove the override (back to the session default).',
  '',
  'The override is stored as config.extensions.<plugin>.llm and is used by',
  'every api.llm call the plugin makes. Without an override, plugins follow',
  'the active session provider/model (the chat leader).',
].join('\n');

/**
 * Render every configured per-plugin LLM override. Reads
 * `config.extensions.<plugin>.llm` across all plugins so the user can
 * see, at a glance, which plugins deviate from the session default.
 */
function renderPluginLlmOverviews(config: Config, sessionDefault: string): string {
  const rows: Array<{ name: string; provider: string; model: string }> = [];
  for (const [pluginName, ext] of Object.entries(config.extensions ?? {})) {
    const llm = (ext as Record<string, unknown>)?.['llm'];
    if (llm && typeof llm === 'object') {
      const o = llm as { provider?: string; model?: string };
      rows.push({
        name: pluginName,
        provider: o.provider ?? '(session)',
        model: o.model ?? '(session)',
      });
    }
  }
  const lines = [`Per-plugin LLM routing (session default: ${sessionDefault}):`];
  if (rows.length === 0) {
    lines.push(
      '  No plugin overrides — every plugin follows the session default.',
      '  Set one with: wstack plugin llm <plugin> <provider> [model]',
    );
  } else {
    rows.sort((a, b) => a.name.localeCompare(b.name));
    for (const r of rows) {
      lines.push(`  ${r.name.padEnd(24)} provider=${r.provider.padEnd(16)} model=${r.model}`);
    }
    lines.push('', 'Clear one with: wstack plugin llm <plugin> --clear');
  }
  return lines.join('\n');
}

/**
 * `wstack plugin llm …` — per-plugin LLM routing. The chat leader's
 * provider/model stays the DEFAULT; this stores an override under
 * `config.extensions[<plugin>].llm = { provider?, model? }` which
 * `api.llm` resolves ahead of the session default on every call.
 */
export async function runPluginLlmCommand(
  args: string[],
  deps: PluginManagementDeps,
): Promise<PluginManagementResult> {
  const sessionDefault = `${deps.config.provider ?? '?'} / ${deps.config.model ?? '?'}`;

  // ── List: `plugin llm` (no name) or `plugin llm list` ──────────────
  if (args.length === 0 || args[0] === 'list') {
    return {
      code: 0,
      level: 'output',
      message: renderPluginLlmOverviews(deps.config, sessionDefault),
    };
  }

  const name = args[0];
  if (!name || name.startsWith('-')) return errorResult(PLUGIN_LLM_USAGE);

  const currentOverride = deps.config.extensions?.[name]?.['llm'];

  // ── Show ───────────────────────────────────────────────────────────
  if (args.length === 1) {
    const lines = [`LLM routing for plugin "${name}":`];
    if (currentOverride && typeof currentOverride === 'object') {
      const o = currentOverride as { provider?: string; model?: string };
      lines.push(
        `  override: provider=${o.provider ?? '(session)'} model=${o.model ?? '(session)'}`,
        `  session default: ${sessionDefault}`,
      );
    } else {
      lines.push(
        `  no override — follows the session default (${sessionDefault}).`,
        `  Set one with: wstack plugin llm ${name} <provider> [model]`,
      );
    }
    return { code: 0, level: 'output', message: lines.join('\n') };
  }

  const existing = await readConfig(deps.configPath);
  const fileExtensions = isRecord(existing.extensions)
    ? (existing.extensions as Record<string, unknown>)
    : {};
  const pluginExt = isRecord(fileExtensions[name])
    ? { ...(fileExtensions[name] as Record<string, unknown>) }
    : {};

  // ── Clear ──────────────────────────────────────────────────────────
  if (args[1] === '--clear' || args[1] === 'clear') {
    if (!('llm' in pluginExt) && !currentOverride) {
      return { code: 0, level: 'info', message: `Plugin "${name}" has no LLM override.` };
    }
    delete pluginExt['llm'];
    if (Object.keys(pluginExt).length === 0) delete fileExtensions[name];
    else fileExtensions[name] = pluginExt;
    existing.extensions = fileExtensions;
    await atomicWrite(deps.configPath, JSON.stringify(existing, null, 2), { mode: 0o600 });
    const merged = mergeExtensionsForPatch(deps.config, fileExtensions);
    // The in-memory config may still carry the old override — the merge
    // above unions both sources, so drop the key explicitly.
    const mergedEntry = merged[name];
    if (mergedEntry) {
      delete mergedEntry['llm'];
      if (Object.keys(mergedEntry).length === 0) delete merged[name];
    }
    return {
      code: 0,
      level: 'info',
      message:
        `Cleared LLM override for "${name}" — it now follows the session default (${sessionDefault}). ` +
        'Takes effect immediately for api.llm calls.',
      patch: { extensions: merged },
    };
  }

  // ── Set ────────────────────────────────────────────────────────────
  const providerArg = args[1];
  const modelArg = args[2];
  if (!providerArg || providerArg.startsWith('--')) return errorResult(PLUGIN_LLM_USAGE);
  const provider = providerArg === '-' ? undefined : providerArg;
  const model = modelArg && modelArg !== '-' ? modelArg : undefined;
  if (!provider && !model) return errorResult(PLUGIN_LLM_USAGE);

  const llm: Record<string, unknown> = {};
  if (provider) llm['provider'] = provider;
  if (model) llm['model'] = model;
  pluginExt['llm'] = llm;
  fileExtensions[name] = pluginExt;
  existing.extensions = fileExtensions;
  await atomicWrite(deps.configPath, JSON.stringify(existing, null, 2), { mode: 0o600 });

  // Soft sanity note: an unknown provider name still works if the
  // models.dev catalog knows it, but flag likely typos against the
  // user's configured providers.
  const configured = Object.keys(deps.config.providers ?? {});
  const note =
    provider && configured.length > 0 && !configured.includes(provider)
      ? `\nNote: "${provider}" is not in config.providers (configured: ${configured.join(', ')}). ` +
        'Catalog providers (anthropic, openai, …) still resolve if credentials are available.'
      : '';

  const merged = mergeExtensionsForPatch(deps.config, fileExtensions);
  return {
    code: 0,
    level: 'info',
    message:
      `Plugin "${name}" now routes api.llm calls via ` +
      `provider=${provider ?? '(session)'} model=${model ?? '(session)'}. ` +
      `Session default stays ${sessionDefault}. Takes effect immediately for api.llm calls.${note}`,
    patch: { extensions: merged },
  };
}

/**
 * patchConfig is a shallow merge — build the FULL extensions map:
 * in-memory config first, then the file's (just-written) entries win.
 */
function mergeExtensionsForPatch(
  config: Config,
  fileExtensions: Record<string, unknown>,
): Record<string, Record<string, unknown>> {
  const merged: Record<string, Record<string, unknown>> = {};
  for (const [k, v] of Object.entries(config.extensions ?? {})) {
    merged[k] = { ...v };
  }
  for (const [k, v] of Object.entries(fileExtensions)) {
    if (isRecord(v)) merged[k] = { ...(merged[k] ?? {}), ...v };
  }
  // A cleared plugin entry must disappear from the merged view too.
  for (const k of Object.keys(merged)) {
    if (!(k in fileExtensions) && !(k in (config.extensions ?? {}))) delete merged[k];
  }
  return merged;
}
