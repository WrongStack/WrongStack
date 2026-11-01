import * as fs from 'node:fs/promises';
import type { SessionSummary } from '@wrongstack/contracts/types';
import { DefaultSessionStore } from '@wrongstack/core/storage';
import { resolveWstackPaths } from '@wrongstack/core/utils';
import { errMessage } from './ws-utils.js';

/** How many recorded conversations a project usage summary reads at most. */
export const USAGE_SCAN_LIMIT = 5000;

interface ModelRow {
  provider: string;
  model: string;
  sessions: number;
  tokenTotal: number;
}

/**
 * Recorded token totals of a project's conversations per provider and model, from the session
 * catalog. Sessions without a finite total are counted but add no tokens; no price is derived.
 */
export function projectUsageSummary(
  summaries: ReadonlyArray<{ provider?: string; model?: string; tokenTotal?: number }>,
) {
  const byModel = new Map<string, ModelRow>();
  let tokenTotal = 0,
    sessionsWithTokens = 0;
  for (const summary of summaries) {
    const provider = summary.provider || 'unknown',
      model = summary.model || 'unknown';
    const tokens = summary.tokenTotal;
    const counted = typeof tokens === 'number' && Number.isFinite(tokens) && tokens >= 0;
    addRow(byModel, { provider, model, sessions: 1, tokenTotal: counted ? tokens : 0 });
    if (counted) {
      tokenTotal += tokens;
      sessionsWithTokens++;
    }
  }
  return {
    sessions: summaries.length,
    sessionsWithTokens,
    tokenTotal,
    capped: summaries.length >= USAGE_SCAN_LIMIT,
    byModel: sortRows(byModel),
  };
}

/**
 * The same totals for every project in the profile's project list, each read from that
 * project's own recorded conversations. A project whose history cannot be read is listed with
 * its error and adds nothing. Nothing is created for a project that has no history yet.
 */
export async function profileUsageSummary(
  projects: ReadonlyArray<{ name?: string; root: string }>,
  globalRoot: string,
  list: (dir: string, root: string) => Promise<SessionSummary[]> = (dir, root) =>
    new DefaultSessionStore({ dir, projectRoot: root }).list(USAGE_SCAN_LIMIT),
) {
  const byModel = new Map<string, ModelRow>();
  const rows = [];
  let sessions = 0,
    sessionsWithTokens = 0,
    tokenTotal = 0;
  for (const project of projects) {
    if (typeof project?.root !== 'string' || !project.root) continue;
    const name = typeof project.name === 'string' && project.name ? project.name : project.root;
    try {
      const dir = resolveWstackPaths({ projectRoot: project.root, globalRoot }).projectSessions;
      const exists = await fs.stat(dir).then(
        (stat) => stat.isDirectory(),
        () => false,
      );
      const summary = projectUsageSummary(exists ? await list(dir, project.root) : []);
      const { byModel: projectModels, ...totals } = summary;
      rows.push({ name, root: project.root, ...totals });
      for (const row of projectModels) addRow(byModel, row);
      sessions += summary.sessions;
      sessionsWithTokens += summary.sessionsWithTokens;
      tokenTotal += summary.tokenTotal;
    } catch (error) {
      rows.push({ name, root: project.root, error: errMessage(error) });
    }
  }
  return {
    sessions,
    sessionsWithTokens,
    tokenTotal,
    capped: rows.some((row) => 'capped' in row && row.capped),
    byModel: sortRows(byModel),
    // Most tokens first; projects that could not be read last.
    projects: rows.sort(
      (a, b) => ('tokenTotal' in b ? b.tokenTotal : -1) - ('tokenTotal' in a ? a.tokenTotal : -1),
    ),
  };
}

function addRow(rows: Map<string, ModelRow>, row: ModelRow): void {
  const key = JSON.stringify([row.provider, row.model]);
  const current = rows.get(key) ?? {
    provider: row.provider,
    model: row.model,
    sessions: 0,
    tokenTotal: 0,
  };
  current.sessions += row.sessions;
  current.tokenTotal += row.tokenTotal;
  rows.set(key, current);
}

function sortRows(rows: Map<string, ModelRow>): ModelRow[] {
  return [...rows.values()].sort(
    (a, b) => b.tokenTotal - a.tokenTotal || a.provider.localeCompare(b.provider),
  );
}
