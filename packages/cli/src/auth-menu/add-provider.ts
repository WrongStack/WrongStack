import type { ProviderConfig, ResolvedProvider, WireFamily } from '@wrongstack/core';
import { color } from '@wrongstack/core';
import {
  mutateConfigProviders,
  normalizeKeys,
  nowIso,
  writeKeysBack,
} from '../provider-config-utils.js';
import { loadProviders } from './helpers.js';
import {
  renderOAuthLoginOptions,
  runOAuthLoginChoice,
} from './oauth-menu.js';
import { runLiveProviderPicker } from '../picker.js';
import { readKeyInput, suggestLabel, validateFamily } from './shared.js';
import type { AuthMenuDeps } from './types.js';

/* ------------------------------------------------------------------ */
/*  Add from catalog — pick a known provider from models.dev            */
/* ------------------------------------------------------------------ */

export async function addFromCatalog(deps: AuthMenuDeps): Promise<boolean> {
  let catalog: ResolvedProvider[] = [];
  try {
    catalog = (await deps.modelsRegistry.listProviders()).filter((p) => p.family !== 'unsupported');
  } catch {
    deps.renderer.writeWarning('Catalog unavailable — falling back to manual entry.\n');
  }

  if (catalog.length === 0) {
    return addManualEntry(deps);
  }

  const saved = new Set(Object.keys(await loadProviders(deps)));
  deps.renderer.write(
    color.dim(
      `  Catalog: ${catalog.length} providers. Type to filter, ↑/↓ navigate, Enter to select.\n`,
    ),
  );
  deps.renderer.write(`  ${color.dim('◉ already saved   ○ no key yet')}\n\n`);
  renderOAuthLoginOptions(deps);
  deps.renderer.write('\n');

  const chosen = await runLiveProviderPicker(catalog, saved);
  if (!chosen) {
    // User cancelled — offer OAuth as an alternative.
    deps.renderer.write(
      `\n  ${color.dim('OAuth login options:')} ${color.dim('chatgpt')}, ${color.dim('claude')}, or ${color.dim('copilot')}?\n`,
    );
    const answer = (
      await deps.reader.readLine(
        `  ${color.amber('?')} OAuth or q to quit ${color.dim('[chatgpt/claude/copilot]')}: `,
      )
    ).trim();
    if (answer && await runOAuthLoginChoice(deps, answer, { allowNumeric: false })) {
      return true;
    }
    return false;
  }

  return addKeyForCatalogProvider(deps, chosen);
}

/**
 * Prompt for family/baseUrl/alias overrides, then add a key.
 * Returns true if a key was added.
 */
async function addKeyForCatalogProvider(
  deps: AuthMenuDeps,
  chosen: ResolvedProvider,
): Promise<boolean> {
  deps.renderer.write(
    color.dim(`\n  Defaults from models.dev — press Enter to keep, or type overrides.\n`),
  );

  // Family override
  const famRaw = (
    await deps.reader.readLine(
      `  ${color.amber('?')} Family ${color.dim(`[${chosen.family}]`)} ${color.dim('(q to quit)')}: `,
    )
  ).trim();
  if (famRaw === 'q') return false;
  let family: WireFamily = chosen.family as WireFamily;
  if (famRaw) {
    const validated = validateFamily(famRaw);
    if (!validated) {
      deps.renderer.writeError(
        `Invalid family: "${famRaw}" (must be: anthropic, openai, openai-compatible, google).`,
      );
      return false;
    }
    family = validated;
  }

  // Base URL override
  const baseRaw = (
    await deps.reader.readLine(
      `  ${color.amber('?')} Base URL ${color.dim(`[${chosen.apiBase ?? 'unset'}]`)} ${color.dim('(q to quit)')}: `,
    )
  ).trim();
  if (baseRaw === 'q') return false;
  const baseUrl: string | undefined = baseRaw || chosen.apiBase;

  // Alias
  const providersNow = await loadProviders(deps);
  let suggestedAlias = chosen.id;
  if (family !== (chosen.family as WireFamily)) {
    let candidate = `${chosen.id}-${family}`;
    let n = 2;
    while (providersNow[candidate]) {
      candidate = `${chosen.id}-${family}-${n}`;
      n++;
    }
    suggestedAlias = candidate;
  }
  const aliasRaw = (
    await deps.reader.readLine(
      `  ${color.amber('?')} Save as alias ${color.dim(`[${suggestedAlias}]`)} ${color.dim('(used with --provider <alias>)')}: `,
    )
  ).trim();
  const alias = aliasRaw || suggestedAlias;

  // Check for conflicting existing entry
  const existing = providersNow[alias];
  if (existing) {
    const sameFamily = (existing.family ?? (chosen.family as WireFamily)) === family;
    const sameBase = (existing.baseUrl ?? chosen.apiBase) === baseUrl;
    if (!sameFamily || !sameBase) {
      deps.renderer.writeError(
        `Alias "${alias}" already exists with different family/baseUrl.\n  ` +
          `Existing: family=${existing.family ?? '(unset)'}, baseUrl=${existing.baseUrl ?? '(unset)'}\n  ` +
          `New:      family=${family}, baseUrl=${baseUrl ?? '(unset)'}\n  ` +
          `Pick a different alias to keep them separate.`,
      );
      return false;
    }
  }

  return addKeyForProvider(alias, deps, {
    type: chosen.id,
    family,
    baseUrl,
    envVars: chosen.envVars,
  });
}

/* ------------------------------------------------------------------ */
/*  Add custom provider — fully user-defined (bypasses catalog)        */
/* ------------------------------------------------------------------ */

export async function addCustomProvider(deps: AuthMenuDeps): Promise<boolean> {
  deps.renderer.write(
    `\n${color.bold('Custom provider')} ${color.dim('— for local models or proxies not in the catalog.')}\n`,
  );

  const type = (
    await deps.reader.readLine(
      `  ${color.amber('?')} Provider id ${color.dim('(e.g. "local-llama", "my-proxy", q to quit)')}: `,
    )
  ).trim();
  if (!type || type === 'q') return false;

  const existing = (await loadProviders(deps))[type];
  if (existing) {
    deps.renderer.writeWarning(`"${type}" already exists. Pick it from the main menu to edit.`);
    return false;
  }

  const familyRaw = (
    await deps.reader.readLine(
      `  ${color.amber('?')} Wire family ${color.dim('(anthropic | openai | openai-compatible | google)')} ${color.dim('(q to quit)')}: `,
    )
  ).trim();
  if (familyRaw === 'q') return false;
  const family = validateFamily(familyRaw);
  if (!family) {
    deps.renderer.writeError(`Invalid family: "${familyRaw}"`);
    return false;
  }

  const baseUrl = (
    await deps.reader.readLine(
      `  ${color.amber('?')} Base URL ${color.dim('(e.g. http://localhost:11434/v1, optional)')}: `,
    )
  ).trim();

  const modelsRaw = (
    await deps.reader.readLine(
      `  ${color.amber('?')} Model ids ${color.dim('(comma-separated, optional)')}: `,
    )
  ).trim();
  const models = modelsRaw
    ? modelsRaw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : undefined;

  const envVarsRaw = (
    await deps.reader.readLine(
      `  ${color.amber('?')} Env var names ${color.dim('(comma-separated, optional)')}: `,
    )
  ).trim();
  const envVars = envVarsRaw
    ? envVarsRaw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : undefined;

  return addKeyForProvider(type, deps, {
    type,
    family,
    ...(baseUrl ? { baseUrl } : {}),
    ...(models ? { models } : {}),
    ...(envVars ? { envVars } : {}),
  });
}

/* ------------------------------------------------------------------ */
/*  Manual entry — fallback when catalog is unavailable                */
/* ------------------------------------------------------------------ */

async function addManualEntry(deps: AuthMenuDeps): Promise<boolean> {
  const pid = (
    await deps.reader.readLine(`  ${color.amber('?')} Provider id ${color.dim('[q to quit]')}: `)
  ).trim();
  if (!pid || pid === 'q') return false;

  const famRaw = (
    await deps.reader.readLine(
      `  ${color.amber('?')} Family ${color.dim('(anthropic/openai/openai-compatible/google)')}: `,
    )
  ).trim();
  const family = validateFamily(famRaw);
  if (!family) {
    deps.renderer.writeError(`Invalid family: "${famRaw}"`);
    return false;
  }

  const baseUrl = (
    await deps.reader.readLine(`  ${color.amber('?')} Base URL ${color.dim('(optional)')}: `)
  ).trim();

  return addKeyForProvider(pid, deps, {
    type: pid,
    family,
    ...(baseUrl ? { baseUrl } : {}),
  });
}

/* ------------------------------------------------------------------ */
/*  Core: add a key to a provider                                     */
/* ------------------------------------------------------------------ */

export async function addKeyForProvider(
  providerId: string,
  deps: AuthMenuDeps,
  template: Partial<ProviderConfig>,
): Promise<boolean> {
  const providers = await loadProviders(deps);
  const existing = providers[providerId];
  const existingKeys = existing ? normalizeKeys(existing) : [];
  const usedLabels = new Set(existingKeys.map((k) => k.label));

  const label = await promptForLabel(deps, usedLabels);
  if (!label) return false;

  const apiKey = await readKeyInput(deps, `API key for ${providerId}/${label}`);
  if (!apiKey) return false;

  await mutateConfigProviders(deps.globalConfigPath, deps.vault, (all) => {
    const existingProv: ProviderConfig = all[providerId] ?? {
      type: providerId,
      ...template,
    };
    if (!existingProv.type) existingProv.type = providerId;
    if (!existingProv.family && template.family) {
      existingProv.family = template.family;
    }
    if (!existingProv.baseUrl && template.baseUrl) {
      existingProv.baseUrl = template.baseUrl;
    }
    if (!existingProv.envVars && template.envVars) {
      existingProv.envVars = template.envVars;
    }
    const list = normalizeKeys(existingProv);
    list.push({ label, apiKey, createdAt: nowIso() });
    writeKeysBack(existingProv, list);
    if (!existingProv.activeKey) existingProv.activeKey = label;
    all[providerId] = existingProv;
  });

  deps.renderer.write(
    `  ${color.green('✓')} Saved ${color.bold(providerId)}/${color.bold(label)}.\n`,
  );
  deps.renderer.write(color.dim(`  Launch: wstack --provider ${providerId} "<task>"\n`));
  return true;
}

async function promptForLabel(deps: AuthMenuDeps, usedLabels: Set<string>): Promise<string | null> {
  const defaultLabel = suggestLabel(usedLabels);
  const labelRaw = (
    await deps.reader.readLine(
      `  ${color.amber('?')} Label for this key ${color.dim(`[${defaultLabel}]`)}: `,
    )
  ).trim();
  const label = labelRaw || defaultLabel;
  if (usedLabels.has(label)) {
    deps.renderer.writeError(`Label "${label}" is already used. Use update (u) instead.`);
    return null;
  }
  return label;
}
