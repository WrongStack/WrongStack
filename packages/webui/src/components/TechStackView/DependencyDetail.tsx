/**
 * TechStackView — single-dependency detail pane.
 *
 * Absorbs what the orphaned `TechStackEvidenceDrawer` used to render (it was
 * wired to a `CustomEvent` nobody listened for, so none of it ever reached a
 * screen) and adds the on-demand LLM deep dive.
 */

import { ArrowLeft, ExternalLink, Loader2, Sparkles } from 'lucide-react';
import type { TechStackDependency, TechStackFinding } from '@/stores';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  ACTION_LABELS,
  Badge,
  coverageMeta,
  ecosystemMeta,
  installedVersion,
  isInterpretation,
  SEVERITY_META,
  statusMeta,
  versionDrift,
} from './shared';

export interface DependencyDetailProps {
  dependency: TechStackDependency;
  findings: readonly TechStackFinding[];
  deepDive: { status: 'idle' | 'loading' | 'error'; error: string | null };
  onDeepDive: (dependency: TechStackDependency) => void;
  onBack: () => void;
  coverage?: string | undefined;
}

export function DependencyDetail({
  dependency,
  findings,
  deepDive,
  onDeepDive,
  onBack,
  coverage,
}: DependencyDetailProps) {
  const meta = statusMeta(dependency.status);
  const installed = installedVersion(dependency);
  const drift = versionDrift(dependency);
  const depCoverageNote = coverage ? coverageMeta(coverage).note : undefined;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="shrink-0 border-b border-border/70 bg-card/45 p-3">
        <div className="flex items-start gap-2">
          <Button
            variant="ghost"
            size="icon"
            onClick={onBack}
            aria-label="Back to dependency list"
            className="shrink-0 md:hidden"
          >
            <ArrowLeft className="size-4" />
          </Button>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <h2 className="min-w-0 truncate font-mono text-sm font-bold text-foreground">
                {dependency.name}
              </h2>
              <Badge className={meta.badge}>{meta.label}</Badge>
            </div>
            <p className="mt-0.5 truncate text-[10px] text-muted-foreground">
              {ecosystemMeta(dependency.ecosystem).label} ·{' '}
              {dependency.direct ? 'direct' : 'transitive'} · {dependency.scope} ·{' '}
              {dependency.sourceType}
              {depCoverageNote && (
                <>
                  <span aria-hidden="true"> · </span>
                  <span className="text-warning">{depCoverageNote}</span>
                </>
              )}
            </p>
          </div>
        </div>

        <div className="mt-2 flex flex-wrap items-baseline gap-2 font-mono text-xs">
          <span className="text-foreground">{installed ?? '—'}</span>
          {dependency.latestStable && dependency.latestStable !== installed && (
            <>
              <span className="text-muted-foreground">→</span>
              <span className="text-info">{dependency.latestStable}</span>
            </>
          )}
          {drift.label && <span className="text-[10px] text-warning">({drift.label})</span>}
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-auto p-3">
        <dl className="grid grid-cols-2 gap-px border border-border/70 bg-border/60">
          <Field label="Constraint" value={dependency.requested ?? '—'} mono />
          <Field label="Locked" value={dependency.locked ?? '—'} mono />
          <Field label="Latest stable" value={dependency.latestStable ?? '—'} mono />
          <Field label="License" value={dependency.license ?? '—'} />
          {dependency.wanted && <Field label="Wanted" value={dependency.wanted} mono />}
          {dependency.resolvable && <Field label="Resolvable" value={dependency.resolvable} mono />}
          {dependency.purl && <Field label="PURL" value={dependency.purl} mono />}
          <Field
            label="Registry flags"
            value={
              [dependency.deprecated && 'deprecated', dependency.yanked && 'yanked']
                .filter(Boolean)
                .join(', ') || 'none'
            }
          />
        </dl>

        {/* Findings */}
        <section className="mt-4">
          <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-[9px] font-bold uppercase tracking-[0.16em] text-muted-foreground">
              Findings
            </h3>
            <Button
              variant="outline"
              size="sm"
              onClick={() => onDeepDive(dependency)}
              disabled={deepDive.status === 'loading'}
              className="h-7 text-[10px]"
            >
              {deepDive.status === 'loading' ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <Sparkles className="size-3" />
              )}
              {deepDive.status === 'loading' ? 'Researching…' : 'Deep dive'}
            </Button>
          </div>

          {deepDive.status === 'error' && deepDive.error && (
            <p role="alert" className="mb-1.5 text-[10px] text-destructive">
              {deepDive.error}
            </p>
          )}

          {findings.length === 0 ? (
            <p className="text-[11px] text-muted-foreground">
              Nothing flagged. Run a deep dive to have the model research this package against the
              web.
            </p>
          ) : (
            <div className="flex flex-col gap-1.5">
              {findings.map((finding) => (
                <div key={finding.id} className="border border-border/70 bg-card/40 p-2">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge className={SEVERITY_META[finding.severity].badge}>
                      {SEVERITY_META[finding.severity].label}
                    </Badge>
                    <Badge className="border-border/70 bg-muted text-muted-foreground">
                      {ACTION_LABELS[finding.action] ?? finding.action}
                    </Badge>
                    {isInterpretation(finding) && (
                      <Badge className="border-info/35 bg-info/10 text-info">
                        <Sparkles className="size-2.5" />
                        AI · {Math.round(finding.confidence * 100)}%
                      </Badge>
                    )}
                  </div>
                  <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                    {finding.rationale}
                  </p>
                  {finding.breakingRisk && (
                    <p className="mt-1 border-l-2 border-warning/40 pl-2 text-[10px] leading-relaxed text-warning">
                      {finding.breakingRisk}
                    </p>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Evidence — every fact on this page traces back to one of these. */}
        <section className="mt-4">
          <h3 className="mb-1.5 text-[9px] font-bold uppercase tracking-[0.16em] text-muted-foreground">
            Evidence
          </h3>
          {dependency.evidence.length === 0 ? (
            <p className="text-[11px] text-muted-foreground">No evidence recorded.</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {dependency.evidence.map((evidence, index) => (
                <li
                  key={`${dependency.id}-evidence-${index}`}
                  className="border border-border/70 bg-card/40 p-2"
                >
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge className="border-border/70 bg-muted text-muted-foreground">
                      {evidence.kind}
                    </Badge>
                    <span className="font-mono text-[9px] text-muted-foreground">
                      {new Date(evidence.retrievedAt).toLocaleString()}
                    </span>
                  </div>
                  {evidence.source.startsWith('http') ? (
                    <a
                      href={evidence.source}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="mt-1 flex min-w-0 items-center gap-1 truncate text-[10px] text-info underline-offset-2 hover:underline"
                    >
                      <span className="truncate">{evidence.source}</span>
                      <ExternalLink className="size-2.5 shrink-0" />
                    </a>
                  ) : (
                    <p className="mt-1 truncate font-mono text-[10px] text-muted-foreground">
                      {evidence.source}
                    </p>
                  )}
                  {evidence.detail && (
                    <p className="mt-0.5 text-[10px] leading-relaxed text-muted-foreground">
                      {evidence.detail}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="bg-card/55 px-2.5 py-1.5">
      <dt className="text-[9px] font-bold uppercase tracking-[0.14em] text-muted-foreground">
        {label}
      </dt>
      <dd className={cn('mt-0.5 truncate text-[11px] text-foreground', mono && 'font-mono')}>
        {value}
      </dd>
    </div>
  );
}
