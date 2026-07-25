import type { Config, ResolvedProvider } from '@wrongstack/core/types';
import { color } from '@wrongstack/core/utils';
import type { ReadlineInputReader } from '../input-reader.js';
import type { TerminalRenderer } from '../renderer.js';
import { boxBottom, boxDivider, boxRow, boxTop, padVisible, theme } from './frame.js';

export interface NumberedProviderSelection {
  provider: ResolvedProvider;
  modelHint?: string | undefined;
}

const PROVIDER_FAMILY_PREFERRED_ORDER = [
  'anthropic',
  'anthropic-oauth',
  'openai',
  'openai-codex',
  'github-copilot',
  'google',
  'openai-compatible',
];

export async function selectProviderFromNumberedList(opts: {
  displayList: ResolvedProvider[];
  showingFallback: boolean;
  config?: Config | undefined;
  defaultProvider?: string | undefined;
  defaultModel?: string | undefined;
  renderer: TerminalRenderer;
  reader: ReadlineInputReader;
}): Promise<NumberedProviderSelection | undefined> {
  const { displayList, showingFallback, config, defaultProvider, defaultModel, renderer, reader } =
    opts;
  const families = new Map<string, ResolvedProvider[]>();
  for (const p of displayList) {
    const list = families.get(p.family) ?? [];
    list.push(p);
    families.set(p.family, list);
  }

  const ordered: Array<{ provider: ResolvedProvider; index: number }> = [];
  const familyOrder = [
    ...PROVIDER_FAMILY_PREFERRED_ORDER.filter((f) => families.has(f)),
    ...[...families.keys()].filter((f) => !PROVIDER_FAMILY_PREFERRED_ORDER.includes(f)),
  ];
  let idx = 1;
  let defaultIdx: number | undefined;
  renderer.write('\n');
  renderer.write(`${boxTop('Select a provider')}\n`);
  for (const fam of familyOrder) {
    const list = [...(families.get(fam) ?? [])].sort((a, b) =>
      a.id.toLowerCase().localeCompare(b.id.toLowerCase()),
    );
    if (!list || list.length === 0) continue;
    renderer.write(`${boxRow(`${theme.accent('·')} ${color.dim(fam.toUpperCase())}`)}\n`);
    for (const p of list) {
      const envFound = p.envVars.some((v) => !!process.env[v]);
      const entry = config?.providers?.[p.id];
      const configKey =
        (typeof entry?.apiKey === 'string' && entry.apiKey.length > 0) ||
        (Array.isArray(entry?.apiKeys) && entry?.apiKeys?.some((k) => k?.apiKey));
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
      if (def) return { provider: def.provider, modelHint: defaultModel };
    }
    renderer.write(color.dim('Cancelled.\n'));
    return undefined;
  }

  const providerIdx = Number.parseInt(providerAnswer, 10);
  if (Number.isNaN(providerIdx) || providerIdx < 1 || providerIdx > ordered.length) {
    const byId = ordered.find((o) => o.provider.id.toLowerCase() === providerAnswer.toLowerCase());
    if (!byId) {
      renderer.writeError(`Invalid selection: "${providerAnswer}"`);
      return undefined;
    }
    return { provider: byId.provider, modelHint: defaultModel };
  }

  const chosen = ordered[providerIdx - 1];
  if (!chosen) return undefined;
  const modelHint = chosen.provider.id === defaultProvider ? defaultModel : undefined;
  return { provider: chosen.provider, modelHint };
}
