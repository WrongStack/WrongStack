/**
 * TechStackView — findings, grouped by severity.
 *
 * `snapshot.findings` has been populated by `enrich()` since day one and was
 * never rendered anywhere. This is the action list: what to do, why, and on
 * what evidence.
 */

import { Sparkles } from 'lucide-react';
import { usePagination } from '@/hooks/usePagination';
import type { TechStackDependency, TechStackFinding } from '@/stores';
import { cn } from '@/lib/utils';
import { ACTION_LABELS, Badge, isInterpretation, SEVERITY_META, SEVERITY_ORDER } from './shared';
import { Pagination } from '../ui/pagination';
import { useAppTranslation } from '@/i18n';

interface FindingsPanelProps {
  findings: readonly TechStackFinding[];
  dependenciesById: ReadonlyMap<string, TechStackDependency>;
  onSelectDependency: (dependencyId: string) => void;
}

export function FindingsPanel({
  findings,
  dependenciesById,
  onSelectDependency,
}: FindingsPanelProps) {
  const { t } = useAppTranslation();
  const findingPage = usePagination(findings, 20);
  if (findings.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center p-8 text-center">
        <p className="max-w-sm text-xs text-muted-foreground">
          {t('activity:techStack.noFindingsRun')}{' '}
          <span className="font-mono text-foreground">{t('activity:techStack.analyze')}</span>{' '}
          {t('activity:techStack.toCheckVersionsAndAdvisoriesAgainst')}
        </p>
      </div>
    );
  }

  const grouped = SEVERITY_ORDER.map(
    (severity) => [severity, findingPage.pageItems.filter((f) => f.severity === severity)] as const,
  ).filter(([, items]) => items.length > 0);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-auto p-3">
        <div className="flex flex-col gap-4">
          {grouped.map(([severity, items]) => (
            <section key={severity}>
              <div className="mb-1.5 flex items-center gap-2">
                <Badge className={SEVERITY_META[severity].badge}>
                  {t(SEVERITY_META[severity].labelKey)}
                </Badge>
                <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
                  {items.length}
                </span>
              </div>
              <div className="flex flex-col gap-1.5">
                {items.map((finding) => (
                  <FindingCard
                    key={finding.id}
                    finding={finding}
                    dependency={dependenciesById.get(finding.dependencyId)}
                    onSelectDependency={onSelectDependency}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      </div>
      <Pagination
        page={findingPage.page}
        pageSize={findingPage.pageSize}
        totalItems={findingPage.totalItems}
        onPageChange={findingPage.setPage}
        itemLabel="findings"
      />
    </div>
  );
}

function FindingCard({
  finding,
  dependency,
  onSelectDependency,
}: {
  finding: TechStackFinding;
  dependency: TechStackDependency | undefined;
  onSelectDependency: (dependencyId: string) => void;
}) {
  const { t } = useAppTranslation();
  const interpreted = isInterpretation(finding);

  return (
    <div className="border border-border/70 bg-card/40 p-2.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          onClick={() => onSelectDependency(finding.dependencyId)}
          className="min-w-0 truncate font-mono text-xs text-foreground underline-offset-2 hover:underline"
        >
          {dependency?.name ?? finding.dependencyId}
        </button>
        <Badge className="border-border/70 bg-muted text-muted-foreground">
          {ACTION_LABELS[finding.action] ? t(ACTION_LABELS[finding.action]) : finding.action}
        </Badge>
        {/* The fact/interpretation divide. Deterministic findings come from the
            registry and OSV; anything below confidence 1.0 is the LLM reading
            sources, and the user is entitled to know which they're looking at. */}
        {interpreted && (
          <Badge className="border-info/35 bg-info/10 text-info">
            <Sparkles className="size-2.5" />
            AI · {Math.round(finding.confidence * 100)}%
          </Badge>
        )}
      </div>

      <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
        {finding.rationale}
      </p>

      {finding.breakingRisk && (
        <p className="mt-1 border-l-2 border-warning/40 pl-2 text-[10px] leading-relaxed text-warning">
          {finding.breakingRisk}
        </p>
      )}

      {finding.evidence.length > 0 && (
        <ul className={cn('mt-1.5 flex flex-col gap-0.5')}>
          {finding.evidence.slice(0, 4).map((evidence, index) => (
            <li key={`${finding.id}-${index}`} className="min-w-0 truncate text-[10px]">
              {evidence.source.startsWith('http') ? (
                <a
                  href={evidence.source}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="text-info underline-offset-2 hover:underline"
                >
                  {evidence.detail ?? evidence.source}
                </a>
              ) : (
                <span className="text-muted-foreground">{evidence.detail ?? evidence.source}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
