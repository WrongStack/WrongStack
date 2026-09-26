/**
 * TechStackView — Remediation tab.
 *
 * Fetches the upgrade plan from `GET /api/techstack/remediation` (which also
 * returns the dry-run `preview` already executed server-side as `dryRun: true`)
 * and renders per-item cards:
 *
 * - **Executable ecosystems** (npm, python, rust, go, php, dotnet): the card
 *   has an "Apply" button. Applying calls `POST /api/techstack/remediation/apply`
 *   with the selected item ids — that endpoint goes through the WebUI server's
 *   permission-gated `language_package` bridge, the same trust boundary the
 *   existing remediation-apply handler already enforces.
 * - **Manual ecosystems** (ruby, dart, maven, gradle, swift, elixir, c/cpp):
 *   the card shows the suggested shell command and a "Copy" button instead.
 *
 * Dry-run is always safe to invoke: `applyPlan()` defaults to `dryRun: true`
 * (r28 truthfulness) and the server's `preview` is a dry-run by definition.
 */

import { useCallback, useEffect, useState } from 'react';
import { Check, Copy, Download, Loader2, PlayCircle, RefreshCw, Wand2 } from 'lucide-react';
import { toErrorMessage } from '@wrongstack/core/utils/error';
import {
  type TechStackApplyPlanResult,
  type TechStackUpgradePlan,
  type TechStackUpgradePlanItem,
  useTechStackStore,
} from '@/stores';
import { Button } from '@/components/ui/button';
import {
  ACTION_LABELS,
  Badge,
  ecosystemLabel,
  SEVERITY_META,
  SEVERITY_ORDER,
} from './shared';
import { useAppTranslation } from '@/i18n';

const SEVERITY_BAR: Record<string, string> = {
  critical: 'bg-destructive',
  high: 'bg-destructive/70',
  medium: 'bg-warning',
  low: 'bg-info',
  info: 'bg-muted-foreground/60',
};

function planItemId(item: TechStackUpgradePlanItem): string {
  return `${item.workspaceId}:${item.ecosystem}:${item.dependencyName}:${item.action}`;
}

async function jsonOrThrow<T>(response: Response): Promise<T> {
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    // fall through; the body is null
  }
  if (!response.ok) {
    const detail =
      body && typeof body === 'object' && 'error' in body
        ? String((body as { error?: unknown }).error)
        : text || `${response.status} ${response.statusText}`;
    throw new Error(detail);
  }
  return body as T;
}

async function fetchPlan(): Promise<{
  plan: TechStackUpgradePlan;
  preview: TechStackApplyPlanResult;
}> {
  const res = await fetch('/api/techstack/remediation', { method: 'GET' });
  return jsonOrThrow(res);
}

async function postApply(
  approvedItems: ReadonlyArray<string>,
): Promise<{ plan: TechStackUpgradePlan; result: TechStackApplyPlanResult }> {
  const res = await fetch('/api/techstack/remediation/apply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ approvedItems }),
  });
  return jsonOrThrow(res);
}

export function RemediationTab() {
  const { t } = useAppTranslation();
  const plan = useTechStackStore((state) => state.remediationPlan);
  const preview = useTechStackStore((state) => state.remediationPreview);
  const loading = useTechStackStore((state) => state.remediationLoading);
  const error = useTechStackStore((state) => state.remediationError);
  const setRemediation = useTechStackStore((state) => state.setRemediation);
  const setRemediationLoading = useTechStackStore((state) => state.setRemediationLoading);
  const setRemediationError = useTechStackStore((state) => state.setRemediationError);
  const snapshot = useTechStackStore((state) => state.snapshot);

  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [applyState, setApplyState] = useState<'idle' | 'applying' | 'error'>('idle');
  const [applyError, setApplyError] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<TechStackApplyPlanResult | null>(null);

  const reload = useCallback(async () => {
    if (!snapshot) return;
    setRemediationLoading(true);
    try {
      const fresh = await fetchPlan();
      setRemediation(fresh.plan, fresh.preview);
    } catch (cause) {
      setRemediationError(toErrorMessage(cause));
    }
  }, [snapshot, setRemediation, setRemediationError, setRemediationLoading]);

  useEffect(() => {
    if (!plan && !loading && !error && snapshot) {
      void reload();
    }
  }, [plan, loading, error, snapshot, reload]);

  // Reset selection when the plan identity changes.
  useEffect(() => {
    if (!plan) {
      setSelected(new Set());
      return;
    }
    setSelected(new Set(plan.items.filter((item) => item.executable).map(planItemId)));
  }, [plan?.snapshotId, plan?.generatedAt]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const apply = useCallback(async () => {
    setApplyError(null);
    setApplyState('applying');
    try {
      const { result } = await postApply([...selected]);
      setLastResult(result);
      setApplyState('idle');
    } catch (cause) {
      setApplyError(toErrorMessage(cause));
      setApplyState('error');
    }
  }, [selected]);

  if (!snapshot) {
    return (
      <div className="flex flex-1 items-center justify-center p-8 text-center">
        <p className="max-w-sm text-xs text-muted-foreground">
          {t('activity:techStack.remediationNeedsSnapshot')}
        </p>
      </div>
    );
  }

  if (error && !plan) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
        <p className="max-w-sm text-xs text-destructive" role="alert">
          {error}
        </p>
        <Button variant="outline" size="sm" onClick={() => void reload()}>
          <RefreshCw className="size-3.5" />
          {t('activity:techStack.retry')}
        </Button>
      </div>
    );
  }

  if (loading && !plan) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!plan || plan.items.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center p-8 text-center">
        <div className="flex max-w-sm flex-col gap-2">
          <p className="text-xs font-medium text-success">
            {t('activity:techStack.remediationAllClear')}
          </p>
          <p className="text-xs text-muted-foreground">{t('activity:techStack.remediationHealthy')}</p>
        </div>
      </div>
    );
  }

  const executableCount = plan.items.filter((item) => item.executable).length;
  const manualCount = plan.items.length - executableCount;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-b border-border/70 bg-card/45 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-[9px] font-bold uppercase tracking-[0.16em] text-muted-foreground">
            {t('activity:techStack.upgradePlan')}
          </p>
          {SEVERITY_ORDER.map((severity) => {
            const count = plan.items.filter((item) => item.severity === severity).length;
            if (count === 0) return null;
            return (
              <Badge key={severity} className={SEVERITY_META[severity].badge}>
                {t(SEVERITY_META[severity].labelKey)} · {count}
              </Badge>
            );
          })}
          {executableCount > 0 && (
            <Badge className="border-info/35 bg-info/10 text-info">
              <Wand2 className="size-2.5" />
              {executableCount} {t('activity:techStack.autoExecutable')}
            </Badge>
          )}
          {manualCount > 0 && (
            <Badge className="border-border/70 bg-muted text-muted-foreground">
              {manualCount} {t('activity:techStack.manual')}
            </Badge>
          )}
        </div>
        <p className="mt-2 max-w-3xl text-[10px] leading-relaxed text-muted-foreground">{plan.warning}</p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => void reload()}
            disabled={loading}
          >
            <RefreshCw className={cn('size-3.5', loading && 'animate-spin')} />
            {t('activity:techStack.refreshPlan')}
          </Button>
          <Button
            size="sm"
            onClick={() => void apply()}
            disabled={applyState === 'applying' || selected.size === 0}
          >
            {applyState === 'applying' ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <PlayCircle className="size-3.5" />
            )}
            {t('activity:techStack.applySelected')} ({selected.size})
          </Button>
        </div>
        {applyError && (
          <p role="alert" className="mt-2 text-[10px] text-destructive">
            {applyError}
          </p>
        )}
        {lastResult && (
          <p className="mt-2 text-[10px] text-muted-foreground">
            {lastResult.dryRun
              ? t('activity:techStack.lastResultDryRun', {
                  applied: lastResult.items.filter((i) => i.status === 'applied').length,
                  skipped: lastResult.items.filter((i) => i.status === 'skipped').length,
                  failed: lastResult.items.filter((i) => i.status === 'failed').length,
                })
              : t('activity:techStack.lastResultApplied', {
                  applied: lastResult.items.filter((i) => i.status === 'applied').length,
                  failed: lastResult.items.filter((i) => i.status === 'failed').length,
                })}
          </p>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-3">
        {preview && !lastResult && (
          <p className="mb-3 border border-info/35 bg-info/10 p-2 text-[10px] text-info">
            {t('activity:techStack.dryRunPreviewed', {
              count: preview.items.filter((i) => i.status === 'planned').length,
            })}
          </p>
        )}
        <div className="flex flex-col gap-2">
          {plan.items.map((item) => (
            <PlanItemCard
              key={planItemId(item)}
              item={item}
              selected={selected.has(planItemId(item))}
              onToggle={() => toggle(planItemId(item))}
              t={t}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function PlanItemCard({
  item,
  selected,
  onToggle,
  t,
}: {
  item: TechStackUpgradePlanItem;
  selected: boolean;
  onToggle: () => void;
  t: (key: string) => string;
}) {
  return (
    <article
      className={cn(
        'border border-border/70 bg-card/40 p-2.5',
        selected && 'border-info/50 bg-info/5',
      )}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <span
          aria-hidden="true"
          className={cn('inline-block size-1.5 shrink-0 rounded-full', SEVERITY_BAR[item.severity] ?? 'bg-muted-foreground')}
        />
        <span className="min-w-0 truncate font-mono text-xs text-foreground">
          {item.dependencyName}
        </span>
        <Badge className="border-border/70 bg-muted text-muted-foreground">
          {ecosystemLabel(item.ecosystem, t)}
        </Badge>
        <Badge className={SEVERITY_META[item.severity].badge}>
          {t(SEVERITY_META[item.severity].labelKey)}
        </Badge>
        <Badge className="border-border/70 bg-muted text-muted-foreground">
          {ACTION_LABELS[item.action] ? t(ACTION_LABELS[item.action]) : item.action}
        </Badge>
      </div>
      <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">{item.rationale}</p>
      {item.breakingRisk && (
        <p className="mt-1 border-l-2 border-warning/40 pl-2 text-[10px] leading-relaxed text-warning">
          {item.breakingRisk}
        </p>
      )}
      <PlanItemFooter item={item} selected={selected} onToggle={onToggle} t={t} />
    </article>
  );
}

function PlanItemFooter({
  item,
  selected,
  onToggle,
  t,
}: {
  item: TechStackUpgradePlanItem;
  selected: boolean;
  onToggle: () => void;
  t: (key: string) => string;
}) {
  if (item.executable) {
    return (
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
        <p className="text-[10px] text-muted-foreground">
          {item.currentVersion ?? '—'} → {item.targetVersion ?? 'latest'}
        </p>
        <Button
          variant={selected ? 'default' : 'outline'}
          size="sm"
          onClick={onToggle}
          aria-pressed={selected}
          className="h-7 text-[10px]"
        >
          {selected ? (
            <Check className="size-3" />
          ) : (
            <Download className="size-3" />
          )}
          {selected ? t('activity:techStack.selectedForApply') : t('activity:techStack.selectForApply')}
        </Button>
      </div>
    );
  }
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <Badge className="border-warning/35 bg-warning/10 text-warning">
        {t('activity:techStack.manualCommandNeeded')}
      </Badge>
      {item.suggestedCommand && <ManualCommandRow command={item.suggestedCommand} t={t} />}
    </div>
  );
}

function ManualCommandRow({ command, t }: { command: string; t: (key: string) => string }) {
  const [copied, setCopied] = useState(false);
  return (
    <code className="flex min-w-0 flex-1 items-center justify-between gap-2 border border-border/70 bg-background px-2 py-1 font-mono text-[10px] text-foreground">
      <span className="truncate">{command}</span>
      <Button
        variant="ghost"
        size="sm"
        className="h-6 px-2 text-[10px]"
        onClick={() => {
          void navigator.clipboard.writeText(command).then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
          });
        }}
      >
        {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
        {copied ? t('activity:techStack.copied') : t('activity:techStack.copy')}
      </Button>
    </code>
  );
}

// Local cn — shared imports are fine but this file is a leaf component,
// so the cost of duplicating the helper is one line we already control.
function cn(...parts: ReadonlyArray<string | false | null | undefined>): string {
  return parts.filter((part): part is string => Boolean(part)).join(' ');
}
