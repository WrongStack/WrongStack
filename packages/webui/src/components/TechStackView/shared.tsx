/**
 * TechStackView — shared presentation tokens and version helpers.
 *
 * @see docs/specs/techstack-sdd.md §6
 */

import type { ComponentType } from 'react';
import {
  Archive,
  Box,
  Code,
  Code2,
  Component,
  Gem,
  Monitor,
  Package,
  Rocket,
  Shield,
  Terminal,
  Zap,
} from 'lucide-react';
import type {
  TechStackCoverage,
  TechStackDependency,
  TechStackFinding,
  TechStackFindingSeverity,
} from '@/stores';
import { cn } from '@/lib/utils';

// ── Status presentation ───────────────────────────────────────────────────

export interface StatusMeta {
  readonly label: string;
  /** Full literal class strings. */
  readonly badge: string;
  readonly dot: string;
  /** Ranking weight — higher sorts first in the "needs attention" order. */
  readonly weight: number;
}

/**
 * One entry per `DependencyStatus`.
 *
 * Every class here is a complete literal string, never assembled at runtime.
 * Two reasons, and both have already bitten this file's predecessor: Tailwind
 * only ships classes it can see in the source, and deriving a variant by
 * string-munging another token (the old `coverageColor(c).replace(')', ' / 0.15)')`)
 * breaks silently the moment a token is renamed.
 */
export const STATUS_META: Record<string, StatusMeta> = {
  current: {
    label: 'Current',
    badge: 'border-success/35 bg-success/10 text-success',
    dot: 'bg-success',
    weight: 0,
  },
  update_available_safe: {
    label: 'Update available',
    badge: 'border-info/35 bg-info/10 text-info',
    dot: 'bg-info',
    weight: 30,
  },
  update_available_breaking: {
    label: 'Major update',
    badge: 'border-warning/35 bg-warning/10 text-warning',
    dot: 'bg-warning',
    weight: 50,
  },
  vulnerable: {
    label: 'Vulnerable',
    badge: 'border-destructive/45 bg-destructive/15 text-destructive',
    dot: 'bg-destructive',
    weight: 100,
  },
  deprecated: {
    label: 'Deprecated',
    badge: 'border-destructive/35 bg-destructive/10 text-destructive',
    dot: 'bg-destructive',
    weight: 70,
  },
  yanked: {
    label: 'Yanked',
    badge: 'border-destructive/45 bg-destructive/15 text-destructive',
    dot: 'bg-destructive',
    weight: 80,
  },
  unmaintained_suspected: {
    label: 'Unmaintained?',
    badge: 'border-warning/35 bg-warning/10 text-warning',
    dot: 'bg-warning',
    weight: 60,
  },
  blocked_by_constraints: {
    label: 'Blocked',
    badge: 'border-warning/30 bg-warning/5 text-warning',
    dot: 'bg-warning',
    weight: 40,
  },
  private_or_unresolved: {
    label: 'Private',
    badge: 'border-border/70 bg-muted text-muted-foreground',
    dot: 'bg-muted-foreground',
    weight: 10,
  },
  local_path: {
    label: 'Local path',
    badge: 'border-border/70 bg-muted text-muted-foreground',
    dot: 'bg-muted-foreground',
    weight: 5,
  },
  git_dependency: {
    label: 'Git',
    badge: 'border-border/70 bg-muted text-muted-foreground',
    dot: 'bg-muted-foreground',
    weight: 5,
  },
  unsupported: {
    label: 'Unsupported',
    badge: 'border-border/70 bg-muted text-muted-foreground',
    dot: 'bg-muted-foreground',
    weight: 5,
  },
  unknown: {
    label: 'Unknown',
    badge: 'border-border/70 bg-muted text-muted-foreground',
    dot: 'bg-muted-foreground',
    weight: 20,
  },
};

const FALLBACK_STATUS: StatusMeta = {
  label: 'Unknown',
  badge: 'border-border/70 bg-muted text-muted-foreground',
  dot: 'bg-muted-foreground',
  weight: 0,
};

export function statusMeta(status: string): StatusMeta {
  return STATUS_META[status] ?? FALLBACK_STATUS;
}

// ── Ecosystem presentation ───────────────────────────────────────────────

export interface EcosystemMeta {
  /** Human-readable display name for the ecosystem. */
  readonly label: string;
  /** Optional lucide-react icon component for visual identification. */
  readonly icon?: ComponentType<{ className?: string }> | undefined;
}

/**
 * One entry per `EcosystemId` in the TechStack type system.
 *
 * Every label is an explicit literal — computed at read-time from the
 * ecosystem string received from the server, so adding a new ecosystem
 * to `packages/techstack/src/types.ts` requires a matching entry here
 * for the UI to display a human-readable label.
 */
export const ECOSYSTEM_META: Record<string, EcosystemMeta> = {
  npm:     { label: 'npm / Node.js', icon: Package },
  python:  { label: 'Python',        icon: Code2 },
  rust:    { label: 'Rust',          icon: Shield },
  go:      { label: 'Go',            icon: Rocket },
  dotnet:  { label: '.NET',          icon: Monitor },
  php:     { label: 'PHP',           icon: Terminal },
  dart:    { label: 'Dart / Flutter',icon: Component },
  maven:   { label: 'Maven',         icon: Archive },
  gradle:  { label: 'Gradle',        icon: Box },
  ruby:    { label: 'Ruby',          icon: Gem },
  swift:   { label: 'Swift',         icon: Zap },
  elixir:  { label: 'Elixir',        icon: Terminal },
  cpp:     { label: 'C / C++',       icon: Code },
};

const FALLBACK_ECOSYSTEM: EcosystemMeta = { label: 'Unknown' };

export function ecosystemMeta(ecosystem: string): EcosystemMeta {
  return ECOSYSTEM_META[ecosystem] ?? FALLBACK_ECOSYSTEM;
}

/**
 * Renders the ecosystem icon if one is registered, or nothing.
 * Use in list rows, detail headers, and dropdown options where
 * space permits a small visual cue.
 */
export function EcosystemIcon({
  ecosystem,
  className = 'size-3.5 shrink-0',
}: {
  ecosystem: string;
  className?: string;
}) {
  const meta = ecosystemMeta(ecosystem);
  if (!meta.icon) return null;
  const Icon = meta.icon;
  return <Icon className={className} />;
}

/** Statuses that mean "someone should look at this". Drives the metrics strip. */
export function needsAttention(dep: TechStackDependency): boolean {
  return statusMeta(dep.status).weight >= 50;
}

// ── Severity presentation ─────────────────────────────────────────────────

export const SEVERITY_ORDER: readonly TechStackFindingSeverity[] = [
  'critical',
  'high',
  'medium',
  'low',
  'info',
];

export const SEVERITY_META: Record<TechStackFindingSeverity, { label: string; badge: string }> = {
  critical: { label: 'Critical', badge: 'border-destructive/45 bg-destructive/15 text-destructive' },
  high: { label: 'High', badge: 'border-destructive/35 bg-destructive/10 text-destructive' },
  medium: { label: 'Medium', badge: 'border-warning/35 bg-warning/10 text-warning' },
  low: { label: 'Low', badge: 'border-info/35 bg-info/10 text-info' },
  info: { label: 'Info', badge: 'border-border/70 bg-muted text-muted-foreground' },
};

export const ACTION_LABELS: Record<string, string> = {
  none: 'No action',
  upgrade_patch: 'Patch upgrade',
  upgrade_minor: 'Minor upgrade',
  upgrade_major: 'Major upgrade',
  replace: 'Replace',
  remove: 'Remove',
  investigate: 'Investigate',
};

// ── Coverage ──────────────────────────────────────────────────────────────

export interface CoverageMeta {
  readonly label: string;
  readonly badge: string;
  /** Short inline text for the dependency row subtitle (e.g. "limited", "best-effort"). */
  readonly note: string | undefined;
}

export const COVERAGE_META: Record<TechStackCoverage, CoverageMeta> = {
  full: { label: 'Full', badge: 'border-success/35 bg-success/10 text-success', note: undefined },
  partial: {
    label: 'Partial',
    badge: 'border-warning/35 bg-warning/10 text-warning',
    note: 'limited',
  },
  unsupported: {
    label: 'Unsupported',
    badge: 'border-border/70 bg-muted text-muted-foreground',
    note: 'best-effort',
  },
};

/** Lookup helper that returns the FALLBACK for unknown coverage strings. */
export function coverageMeta(coverage: string): CoverageMeta {
  return COVERAGE_META[coverage as TechStackCoverage] ?? COVERAGE_META.unsupported;
}

// ── Version drift ─────────────────────────────────────────────────────────

/**
 * Leading integer of a version string, or `null` when it isn't numeric.
 *
 * Deliberately not a semver parser and deliberately not `compareVersions` from
 * `@wrongstack/techstack` — that package pulls in `node:crypto` and SQLite and
 * cannot cross into the browser bundle. Drift only needs the major component,
 * and the authoritative comparison already happened server-side in
 * `policy/status.ts`; this is presentation.
 */
function majorOf(version: string | undefined): number | null {
  if (!version) return null;
  const match = /^\D*(\d+)/.exec(version);
  if (!match?.[1]) return null;
  const major = Number(match[1]);
  return Number.isFinite(major) ? major : null;
}

export interface VersionDrift {
  /** Whole major versions behind latest stable. `0` when on the latest major. */
  readonly majorsBehind: number;
  /** Human summary, e.g. "2 majors behind". `null` when there's nothing to say. */
  readonly label: string | null;
}

/**
 * How far `locked` sits behind `latestStable`.
 *
 * This is the number the old view never showed — the answer to "sürümler
 * güncel mi" lived in the snapshot the whole time and only ever surfaced as a
 * raw status enum.
 */
export function versionDrift(dep: TechStackDependency): VersionDrift {
  const from = majorOf(dep.locked ?? dep.installed ?? dep.requested);
  const to = majorOf(dep.latestStable);
  if (from === null || to === null || to <= from) {
    return { majorsBehind: 0, label: null };
  }
  const majorsBehind = to - from;
  return {
    majorsBehind,
    label: `${majorsBehind} major${majorsBehind === 1 ? '' : 's'} behind`,
  };
}

/** Version actually in use, with the field precedence the SDD defines. */
export function installedVersion(dep: TechStackDependency): string | null {
  return dep.locked ?? dep.installed ?? dep.requested ?? null;
}

// ── Findings ──────────────────────────────────────────────────────────────

/**
 * Whether a finding came from the LLM research stage rather than from
 * registry/OSV facts.
 *
 * `confidence === 1` is reserved for deterministic findings — the research
 * stage clamps its output strictly below it. Surfacing this distinction is the
 * point: a user must always be able to tell a fact from an interpretation.
 */
export function isInterpretation(finding: TechStackFinding): boolean {
  return finding.confidence < 1;
}

// ── Small presentational atoms ────────────────────────────────────────────

export function Badge({ className, children }: { className: string; children: React.ReactNode }) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1 border px-1.5 py-0.5 text-[10px] font-medium',
        className,
      )}
    >
      {children}
    </span>
  );
}

export function MetricCard({
  label,
  value,
  hint,
  tone = 'default',
}: {
  label: string;
  value: number;
  hint: string;
  tone?: 'default' | 'success' | 'warning' | 'info' | 'destructive';
}) {
  const toneClass = {
    default: 'text-foreground',
    success: 'text-success',
    warning: 'text-warning',
    info: 'text-info',
    destructive: 'text-destructive',
  }[tone];

  return (
    <div className="border border-border/70 bg-card/55 px-3 py-2.5 shadow-[inset_0_1px_0_hsl(var(--foreground)/0.035)]">
      <p className="text-[9px] font-bold uppercase tracking-[0.16em] text-muted-foreground">
        {label}
      </p>
      <div className="mt-1 flex items-end justify-between gap-2">
        <p className={cn('font-mono text-xl font-bold tabular-nums', toneClass)}>{value}</p>
        <p className="truncate text-[9px] text-muted-foreground">{hint}</p>
      </div>
    </div>
  );
}
