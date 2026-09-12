import type { SlashCommand } from '@wrongstack/core/types';
import type { SlashCommandMatch } from './app-state.js';

type SlashCommandEntry = {
  cmd: SlashCommand;
  owner: string;
  fullName: string;
};

const CATEGORY_ORDER = ['Run', 'Session', 'Inspect', 'Agent', 'Config', 'App'] as const;

type RankedMatch = SlashCommandMatch & {
  rank: number;
};

export function selectedSlashCommandLine(picker: {
  open: boolean;
  matches: SlashCommandMatch[];
  selected: number;
}): string | null {
  if (!picker.open || picker.matches.length === 0) return null;
  const picked = picker.matches[picker.selected];
  return picked ? `/${picked.name}` : null;
}

export function buildSlashCommandMatches(
  entries: SlashCommandEntry[],
  rawQuery: string,
): SlashCommandMatch[] {
  const query = normalizeSlashQuery(rawQuery);
  const matches: RankedMatch[] = [];

  for (const entry of entries) {
    const ranked = rankSlashCommand(entry, query);
    if (!ranked) continue;
    matches.push(ranked);
  }

  return matches
    .sort((a, b) => {
      if (a.rank !== b.rank) return a.rank - b.rank;
      const catDiff = CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category);
      if (catDiff !== 0) return catDiff;
      return a.name.localeCompare(b.name);
    })
    .map(({ rank: _rank, ...match }) => match);
}

function normalizeSlashQuery(raw: string): string {
  return raw.trim().replace(/^\/+/, '').toLowerCase();
}

function rankSlashCommand(entry: SlashCommandEntry, query: string): RankedMatch | null {
  const { cmd, owner } = entry;
  if (query === '' && cmd.hidden) return null;

  const name = displayName(entry);
  const lowerName = name.toLowerCase();
  const lowerBare = cmd.name.toLowerCase();
  const aliases = aliasCandidates(entry);
  const category = cmd.category ?? 'App';
  const namespaced = lowerBare !== lowerName;

  let rank: number | null = null;
  let matchedAlias: string | undefined;

  if (query === '') {
    rank = 100;
  } else if (lowerName === query) {
    rank = 0;
  } else if (namespaced && lowerBare === query) {
    // `/plugin` must find `myplugin:plugin`, not only `/myplugin:plugin`.
    rank = 2;
  } else if (aliases.find((alias) => alias.toLowerCase() === query)) {
    rank = 5;
    matchedAlias = aliases.find((alias) => alias.toLowerCase() === query);
  } else if (lowerName.startsWith(query)) {
    rank = 10;
  } else if (namespaced && lowerBare.startsWith(query)) {
    rank = 12;
  } else {
    const prefixAlias = aliases.find((alias) => alias.toLowerCase().startsWith(query));
    if (prefixAlias) {
      rank = 20;
      matchedAlias = prefixAlias;
    }
  }

  if (rank == null) return null;

  return {
    name,
    description: cmd.description,
    argsHint: cmd.argsHint,
    isBuiltin: owner === 'core',
    category,
    ...(matchedAlias ? { matchedAlias } : {}),
    rank,
  };
}

function displayName({ cmd, owner, fullName }: SlashCommandEntry): string {
  if (owner === 'core') return cmd.name;
  return fullName.includes(':') ? fullName : cmd.name;
}

function aliasCandidates({ cmd, owner }: SlashCommandEntry): string[] {
  const aliases = cmd.aliases ?? [];
  if (owner === 'core') return aliases;

  const out = [...aliases];
  for (const alias of aliases) {
    out.push(`${owner}:${alias}`);
  }
  return out;
}
