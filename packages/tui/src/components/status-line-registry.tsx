import type React from 'react';
import {
  clampLine,
  DEFAULT_LINES,
  STATUSLINE_ITEMS,
  type StatuslineItem,
  type StatuslineLine,
  type StatuslineLines,
} from '@wrongstack/core/statusline';
import type { RailSpanEntry } from './powerline-rail.js';
import {
  buildAsyncChipEntries,
  buildSafetyWorkEntries,
  buildVitalsChipEntries,
  buildWorkspaceChipEntries,
  type StatusBarRailBuildParams,
} from './status-bar-rails.js';

/**
 * Status-line registry — the composition layer between the chip contract
 * (`@wrongstack/core/statusline`) and the rail builders in
 * `status-bar-rails.tsx`.
 *
 * The builders stay the single source of chip JSX + data gating; this module
 * owns WHERE each built entry renders: it maps every rail entry id to its
 * canonical chip key, applies the user's per-chip line assignment
 * (`StatuslineLines`), and places the right-anchored chips (version, index)
 * on their assigned line. With default lines the partition is byte-identical
 * to the builders' own grouping, which the `status-bar-rail-order` /
 * `status-bar-separators` suites pin.
 */

/** A rail (physical status bar line) in the detailed layout: left chips in
 * render order plus an optional right-anchored chip. */
export interface DetailedRail {
  entries: RailSpanEntry[];
  rightAnchor: React.ReactElement | null;
}

/**
 * Rail entry ids that are extra spans of a parent chip rather than chips of
 * their own. They travel with the parent's line assignment and density, and
 * exist only so the fitter can shed the 4th mailbox detail without shedding
 * the mailbox counter, and so the hit-test keeps unique span ids.
 */
const SPAN_ALIASES: Record<string, StatuslineItem> = {
  mailbox_peers: 'mailbox',
  mailbox_last: 'mailbox',
  memory_pipeline: 'memory_context',
  memory_pressure: 'memory_context',
};

/**
 * Map a rail entry id to its canonical statusline chip key. Returns null for
 * ids outside the contract — those fall back to their builder's default line.
 */
export function canonicalChipKey(entryId: string): StatuslineItem | null {
  const alias = SPAN_ALIASES[entryId];
  if (alias) return alias;
  // Per-agent rows: `fleet_agent-3` is the 4th agent of the fleet_agents group.
  if (entryId.startsWith('fleet_agent-')) return 'fleet_agents';
  return (STATUSLINE_ITEMS as readonly string[]).includes(entryId)
    ? (entryId as StatuslineItem)
    : null;
}

/** Resolve a chip's line: user override → contract default → builder fallback, clamped to 1–4. */
function assignedLine(
  key: StatuslineItem | null,
  fallback: StatuslineLine,
  lines: StatuslineLines,
): StatuslineLine {
  const override = key != null ? lines[key] : undefined;
  if (override != null) return clampLine(override);
  return key != null ? DEFAULT_LINES[key] : fallback;
}

/** One builder's output plus the line its unmapped ids fall back to. */
export interface RailSource {
  entries: RailSpanEntry[];
  fallbackLine: StatuslineLine;
}

/**
 * Partition built rail entries into four lines. Pure — no builder calls, so
 * tests can exercise line assignment with synthetic entries.
 */
export function partitionRailEntries(
  sources: readonly RailSource[],
  lines: StatuslineLines = {},
): DetailedRail[] {
  const rails: DetailedRail[] = [1, 2, 3, 4].map(() => ({ entries: [], rightAnchor: null }));
  for (const source of sources) {
    for (const entry of source.entries) {
      const line = assignedLine(canonicalChipKey(entry.id), source.fallbackLine, lines);
      rails[line - 1]!.entries.push(entry);
    }
  }
  return rails;
}

/** Right-anchor chips travel with their key and pin to their rail's right edge. */
function placeAnchors(
  rails: DetailedRail[],
  anchors: ReadonlyArray<{ key: StatuslineItem; node: React.ReactElement | null }>,
  lines: StatuslineLines,
): void {
  for (const anchor of anchors) {
    if (!anchor.node) continue;
    const line = assignedLine(anchor.key, DEFAULT_LINES[anchor.key], lines);
    const rail = rails[line - 1]!;
    rail.rightAnchor = rail.rightAnchor ? (
      <>
        {rail.rightAnchor} {anchor.node}
      </>
    ) : (
      anchor.node
    );
  }
}

export interface DetailedRailBuildOptions {
  /** Pre-built provider/model chip (status-bar.tsx owns its dim-provider styling). */
  modelChip: React.ReactElement | null;
  /** Narrower model renderings for the density fitter (model only, provider dropped). */
  modelShortChip?: React.ReactElement | null;
  modelMicroChip?: React.ReactElement | null;
  /** `v{version} (update …)` chip, right-anchored on its assigned line. */
  versionChip: React.ReactElement | null;
  /** Codebase-index health chip, right-anchored on its assigned line. */
  indexChip: React.ReactElement | null;
  /** Per-chip line overrides; absent = `DEFAULT_LINES`. */
  lines?: StatuslineLines | undefined;
}

/**
 * Build the four detailed-mode rails: run the rail builders (which apply
 * each chip's data + hidden gates and attach its density levels), then
 * partition the surviving entries by the user's line assignment. Rails are
 * returned in logical order 1–4; rendering/click-map code decides which
 * rails render.
 */
export function buildDetailedRails(
  p: StatusBarRailBuildParams,
  opts: DetailedRailBuildOptions,
): DetailedRail[] {
  const lines = opts.lines ?? {};
  const rails = partitionRailEntries(
    [
      {
        entries: buildWorkspaceChipEntries(
          p,
          opts.modelChip,
          opts.modelShortChip,
          opts.modelMicroChip,
        ),
        fallbackLine: 1,
      },
      { entries: buildVitalsChipEntries(p), fallbackLine: 2 },
      { entries: buildSafetyWorkEntries(p), fallbackLine: 3 },
      { entries: buildAsyncChipEntries(p), fallbackLine: 4 },
    ],
    lines,
  );
  placeAnchors(
    rails,
    [
      { key: 'version', node: opts.versionChip },
      { key: 'index', node: opts.indexChip },
    ],
    lines,
  );
  return rails;
}
