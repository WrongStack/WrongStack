import type { WireFamily } from '@wrongstack/contracts/types';
import { color } from '@wrongstack/core/utils';
import { visibleModelIds } from '../../provider-helpers.js';
import type { SubcommandHandler } from '../contracts.js';
import {
  modelsAdd,
  modelsCaps,
  modelsList,
  modelsRemove,
  modelsReset,
  positionals,
  subcommandFlags,
} from './providers-models-custom.js';
import {
  getCatalogProviderForConfigProvider,
  modelsHidden,
  modelsHide,
  modelsShow,
} from './providers-models-visibility.js';
export const providersCmd: SubcommandHandler = async (args, deps) => {
  // This file DOCUMENTS the stripped-flag problem and ships `subcommandFlags`
  // for it (below), yet this handler still scanned `args` directly — so
  // `providers --all` / `--unsupported` silently showed the default families.
  const providerFlags = subcommandFlags(args, deps);
  const showAll = providerFlags['all'] === true || providerFlags['all'] === 'true';
  const showUnsupported =
    providerFlags['unsupported'] === true || providerFlags['unsupported'] === 'true';
  try {
    const all = await deps.modelsRegistry.listProviders();
    const byFamily: Record<WireFamily, typeof all> = {
      anthropic: [],
      'anthropic-oauth': [],
      openai: [],
      'openai-compatible': [],
      'openai-codex': [],
      'github-copilot': [],
      google: [],
      'google-antigravity': [],
      unsupported: [],
    };
    for (const p of all) byFamily[p.family].push(p);
    const families: WireFamily[] = showUnsupported
      ? ['unsupported']
      : showAll
        ? ['anthropic', 'openai', 'google', 'openai-compatible', 'unsupported']
        : ['anthropic', 'openai', 'google', 'openai-compatible'];
    for (const family of families) {
      const list = byFamily[family];
      if (list.length === 0) continue;
      deps.renderer.write(`\n${color.bold(family)} (${list.length}):\n`);
      for (const p of list) {
        const envFound = p.envVars.some((v) => process.env[v]);
        const marker = envFound ? color.green('●') : color.dim('○');
        const envHint = p.envVars[0] ? color.dim(`[${p.envVars[0]}]`) : '';
        const note = family === 'unsupported' ? color.dim('(needs plugin)') : '';
        deps.renderer.write(
          `  ${marker} ${p.id.padEnd(20)} ${p.name.padEnd(28)} ${envHint} ${note}\n`,
        );
      }
    }
    deps.renderer.write(
      `\n${color.dim(`Current: ${deps.config.provider ?? '<unset>'} / ${deps.config.model ?? '<unset>'}. Use --all to include unsupported families.`)}\n`,
    );
    return 0;
  } catch (err) {
    deps.renderer.writeError(
      `Failed to list providers: ${err instanceof Error ? err.message : err}`,
    );
    return 1;
  }
};

const DEFAULT_PER_PAGE = 15;

export const modelsCmd: SubcommandHandler = async (args, deps) => {
  const sub = args[0];

  // ---- visibility commands ----
  if (sub === 'hide') return modelsHide(args.slice(1), deps);
  if (sub === 'show') return modelsShow(args.slice(1), deps);
  if (sub === 'hidden') return modelsHidden(args.slice(1), deps);
  if (sub === 'reset') return modelsReset(args.slice(1), deps);

  // ---- custom model commands ----
  if (sub === 'add') return modelsAdd(args.slice(1), deps);
  if (sub === 'remove') return modelsRemove(args.slice(1), deps);
  if (sub === 'list') return modelsList(args.slice(1), deps);
  if (sub === 'caps' || sub === 'capabilities') return modelsCaps(args.slice(1), deps);

  if (sub === 'refresh') {
    deps.renderer.writeInfo('Refreshing models.dev cache…');
    try {
      const payload = await deps.modelsRegistry.refresh();
      deps.renderer.writeInfo(
        `Cached ${Object.keys(payload).length} providers to ${deps.paths.modelsCache}`,
      );
      return 0;
    } catch (err) {
      deps.renderer.writeError(`Refresh failed: ${err instanceof Error ? err.message : err}`);
      return 1;
    }
  }

  const flags = subcommandFlags(args, deps);
  const search = typeof flags['search'] === 'string' ? flags['search'].toLowerCase() : '';
  // A value-less flag parses as `true`, and Number(true) is 1 — one row a page.
  if (flags['per-page'] === true) {
    deps.renderer.writeError('--per-page needs a number.\n');
    return 1;
  }
  const perPage = Number(flags['per-page']) > 0 ? Number(flags['per-page']) : DEFAULT_PER_PAGE;
  const page = Math.max(1, Number(flags['page']) || 1);

  // Use first positional arg as provider if given, else fall back to configured default.
  // Flags (--search, --page) filter/paginate the list — they don't change the provider.
  const providerId = positionals(args)[0] ?? deps.config.provider ?? '';
  if (!providerId) {
    deps.renderer.writeError(
      'Usage: wstack models <provider> [--search <term>] [--page N] [--per-page N]',
    );
    return 1;
  }

  const { providerId: lookupId, provider } = await getCatalogProviderForConfigProvider(
    providerId,
    deps,
  );
  if (!provider) {
    deps.renderer.writeError(
      lookupId !== providerId
        ? `Alias "${providerId}" points at catalog id "${lookupId}" which is not in the cache.`
        : `Provider "${providerId}" not in catalog.`,
    );
    return 1;
  }
  if (lookupId !== providerId)
    deps.renderer.write(
      color.dim(`(showing catalog models for "${lookupId}" via alias "${providerId}")\n`),
    );
  deps.renderer.write(`${color.bold(provider.name)} ${color.dim(`(${provider.id})`)}\n`);
  if (provider.doc) deps.renderer.write(color.dim(`Docs: ${provider.doc}\n`));

  const savedProvider = deps.config.providers?.[providerId];
  const userModels = savedProvider?.models;
  const catalogById = new Map(provider.models.map((m) => [m.id, m]));
  const allKnownSorted = [...provider.models].sort((a, b) =>
    (b.release_date ?? '').localeCompare(a.release_date ?? ''),
  );
  const visibleIds = visibleModelIds(
    providerId,
    deps.config,
    allKnownSorted.map((m) => m.id),
    savedProvider,
  );
  const allSorted = visibleIds.map((id) => catalogById.get(id) ?? { id, name: id });

  if (userModels !== undefined) {
    const hiddenCount = Math.max(0, allKnownSorted.length - visibleIds.length);
    const restoredCount = Math.max(0, visibleIds.length - userModels.length);
    deps.renderer.write(
      color.dim(
        `(${visibleIds.length} visible model(s)${restoredCount > 0 ? `, ${restoredCount} from providers.json/catalog fallback` : ' from your saved config'}${hiddenCount > 0 ? `, ${hiddenCount} hidden` : ''})\n`,
      ),
    );
  }

  const filtered = search
    ? allSorted.filter((m) => m.id.toLowerCase().includes(search))
    : allSorted;

  const total = filtered.length;
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const actualPage = Math.min(page, totalPages);
  const start = (actualPage - 1) * perPage;
  const pageItems = filtered.slice(start, start + perPage);
  const end = Math.min(start + pageItems.length, total);

  // Header
  const pageHint = totalPages > 1 ? color.cyan(`[page ${actualPage}/${totalPages}]`) : '';
  const searchHint = search
    ? color.yellow(` (filtered: "${search}" — ${total} match${total === 1 ? '' : 'es'})`)
    : color.dim(` (${total} model${total === 1 ? '' : 's'})`);
  deps.renderer.write(`${pageHint}${searchHint}\n`);

  if (pageItems.length === 0) {
    deps.renderer.write(color.dim('(no models match)\n'));
  } else {
    if (start > 0)
      deps.renderer.write(color.dim(`  ${String.fromCharCode(8593)} ${start} above\n`));
    for (const m of pageItems) {
      const caps: string[] = [];
      if ('tool_call' in m && m.tool_call) caps.push('tools');
      if ('reasoning' in m && m.reasoning) caps.push('reasoning');
      if ('modalities' in m && m.modalities?.input?.includes('image')) caps.push('vision');
      const ctx =
        'limit' in m && m.limit?.context ? `${(m.limit.context / 1000).toFixed(0)}k` : '?';
      const cost =
        'cost' in m && m.cost?.input !== undefined ? `${m.cost.input}/${m.cost.output ?? '?'}` : '';
      deps.renderer.write(
        `  ${m.id.padEnd(40)} ${color.dim(ctx.padStart(6))}  ${color.dim(cost.padEnd(14))} ${color.dim(caps.join(','))}\n`,
      );
    }
    if (end < total)
      deps.renderer.write(color.dim(`  ${String.fromCharCode(8595)} ${total - end} below\n`));
  }

  // Navigation footer
  const navLines: string[] = [];
  if (totalPages > 1) {
    if (actualPage > 1) navLines.push(`--page ${actualPage - 1} (prev)`);
    if (actualPage < totalPages) navLines.push(`--page ${actualPage + 1} (next)`);
  }
  navLines.push('--search <term> (filter)');
  deps.renderer.write(color.dim(`\n${navLines.join(' · ')}\n`));

  const age = await deps.modelsRegistry.ageSeconds();
  deps.renderer.write(
    color.dim(
      `Cache age: ${isFinite(age) ? `${Math.round(age / 60)}m` : 'never fetched'}. Run \`wstack models refresh\` to update.\n`,
    ),
  );
  return 0;
};
