/**
 * The Atlas brief — what an agent should already know before it asks anything.
 *
 * Every other part of this subsystem answers a question. This one answers the
 * question nobody asks: *what is this repository?* An agent that has to
 * discover the shape of an 8,000-file monorepo by search costs a dozen tool
 * calls per session and rediscovers the same thing every session. A few
 * hundred tokens of "here are the twenty files everything depends on, here is
 * what each package is for" removes that repeatedly-paid cost.
 *
 * ## Why it is a structure, not a string
 *
 * The renderer lives with the caller because the budget does. The CLI's
 * system-prompt contributor has a hard token ceiling and trims from the
 * bottom; a webui panel or a `--brief` flag would want different cuts of the
 * same data. Building a string here would force one budget on all of them.
 *
 * ## Why it reports staleness rather than hiding it
 *
 * A brief describing code that has since changed is worse than no brief: it
 * is confidently wrong in a way the reader cannot detect. `staleFiles` is
 * carried so the caller can say so out loud.
 */

import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { checkAtlasFreshness } from './atlas-projection.js';
import { type IndexStore, indexStorePool } from './writer.js';
import { posixIndexPath, resolveIndexDir } from './writer-helpers.js';

/** Hubs named in the brief. Past roughly this many, it stops being a summary. */
export const BRIEF_HUB_LIMIT = 20;

/** Packages named in the brief. */
export const BRIEF_PACKAGE_LIMIT = 12;

/** Subsystem one-liners included when the concept layer has run. */
export const BRIEF_SUBSYSTEM_LIMIT = 10;

/** Summaries are truncated to this before they reach a prompt. */
const BRIEF_SUMMARY_CHARS = 160;

export interface AtlasBriefHub {
  path: string;
  /** Rank relative to the most central file in the repository. */
  rank: number;
  /** Concept-layer summary, when the layer has run for this file. */
  concept?: string | undefined;
}

export interface AtlasBriefPackage {
  name: string;
  files: number;
  /** The package's most central file. */
  hub: string;
}

export interface AtlasBriefSubsystem {
  name: string;
  summary: string;
}

export interface AtlasBrief {
  /** True once the rank pass has run; false means only counts are meaningful. */
  ranked: boolean;
  counts: { files: number; symbols: number; packages: number };
  hubs: AtlasBriefHub[];
  packages: AtlasBriefPackage[];
  subsystems: AtlasBriefSubsystem[];
  /**
   * Files whose content changed since the written atlas was generated, or
   * `undefined` when no atlas has been written — a project that never ran
   * `--write` is not stale, it simply has no projection.
   */
  staleFiles?: number | undefined;
}

function trim(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > BRIEF_SUMMARY_CHARS
    ? `${clean.slice(0, BRIEF_SUMMARY_CHARS - 1).trimEnd()}…`
    : clean;
}

/**
 * Build the brief from an open store.
 *
 * Reads only what it names: the ranked head, not the whole ranking. On an
 * index with no ranks this returns `ranked: false` and empty lists rather
 * than falling back to a filename heuristic — a guess presented as the
 * repository's structure is the failure mode this whole subsystem exists to
 * remove.
 */
export async function buildAtlasBrief(store: IndexStore, projectRoot: string): Promise<AtlasBrief> {
  const relativeOf = (file: string): string => {
    const relative = path.relative(projectRoot, file);
    return posixIndexPath(relative && !relative.startsWith('..') ? relative : file);
  };

  const stats = store.getStats();
  const concepts = store.getReadyConceptSummaries();
  const ranked = store.getRankedFiles(BRIEF_HUB_LIMIT);

  const hubs: AtlasBriefHub[] = ranked.map((row) => {
    const concept = concepts.get(row.file);
    return {
      path: relativeOf(row.file),
      rank: row.rank,
      ...(concept !== undefined && concept !== '' ? { concept: trim(concept) } : {}),
    };
  });

  // The package hub comes from the ranking, so a package whose files never
  // reach the ranked head simply has no hub to name and is left out rather
  // than listed with an arbitrary member.
  const counts = store.getPackageFileCounts();
  const hubOf = new Map<string, { file: string; rank: number }>();
  for (const row of store.getRankedFiles(Math.max(counts.size * 4, BRIEF_HUB_LIMIT))) {
    const name = row.package || relativeOf(row.file).split('/')[0] || '(root)';
    const current = hubOf.get(name);
    if (current === undefined || row.rank > current.rank) {
      hubOf.set(name, { file: relativeOf(row.file), rank: row.rank });
    }
  }
  const packages: AtlasBriefPackage[] = [...hubOf.entries()]
    .sort((a, b) => b[1].rank - a[1].rank || a[0].localeCompare(b[0]))
    .slice(0, BRIEF_PACKAGE_LIMIT)
    .map(([name, hub]) => ({ name, files: counts.get(name) ?? 0, hub: hub.file }));

  const subsystems: AtlasBriefSubsystem[] = store
    .getSubsystems()
    .filter((subsystem) => subsystem.summary !== '')
    .slice(0, BRIEF_SUBSYSTEM_LIMIT)
    .map((subsystem) => ({ name: subsystem.name, summary: trim(subsystem.summary) }));

  const brief: AtlasBrief = {
    ranked: hubs.length > 0,
    counts: {
      files: stats.totalFiles,
      symbols: stats.totalSymbols,
      packages: counts.size,
    },
    hubs,
    packages,
    subsystems,
  };

  // Freshness is best-effort: a missing or unreadable atlas is not an error
  // here, it just means there is no drift to report.
  try {
    const freshness = await checkAtlasFreshness(store, projectRoot);
    if (freshness.reason !== 'missing') {
      brief.staleFiles = freshness.changed.length + freshness.removed.length + freshness.added;
    }
  } catch {
    /* no atlas written, or unreadable — nothing to say about drift */
  }

  return brief;
}

/** Reported when a project has no index to summarise. */
export type AtlasBriefIndexMissing = { indexed: false };

/**
 * Build a project's brief, owning the store lifetime.
 *
 * Refuses without an index for the same reason every other project-level
 * entry point does: acquiring a store CREATES the database, and a prompt
 * contributor must never be the thing that indexes a repository.
 */
export async function buildProjectAtlasBrief(
  projectRoot: string,
  opts: { indexDir?: string | undefined } = {},
): Promise<AtlasBrief | AtlasBriefIndexMissing> {
  if (!existsSync(path.join(resolveIndexDir(projectRoot, opts.indexDir), 'index.db'))) {
    return { indexed: false };
  }
  const store = indexStorePool.acquire(projectRoot, { indexDir: opts.indexDir });
  try {
    return await buildAtlasBrief(store, projectRoot);
  } finally {
    indexStorePool.release(store);
  }
}
