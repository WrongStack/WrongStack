/**
 * VerificationReportPanel — displays the immutable result of
 * `verifyTaskCompletion()` for a Kanban task.
 *
 * Shows the overall verdict, per-check results, file-scope analysis,
 * sub-task aggregation, and evidence attachments. Only rendered when
 * `task.verificationReport` is present.
 */
import type {
  KanbanVerificationAttachment,
  KanbanVerificationReport,
  KanbanVerificationCheckResult,
  KanbanVerificationFileScope,
  KanbanVerificationSubtasks,
} from '@wrongstack/kanban';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  FileCode2,
  FileText,
  ListTree,
  ShieldAlert,
  XCircle,
} from 'lucide-react';
import { useState } from 'react';
import { useAppTranslation } from '@/i18n';

interface VerificationReportPanelProps {
  report: KanbanVerificationReport;
}

const VERDICT_CONFIG: Record<
  KanbanVerificationReport['verdict'],
  { icon: typeof CheckCircle2; labelKey: string; className: string }
> = {
  passed: {
    icon: CheckCircle2,
    labelKey: 'activity:verifyReport.verdictPassed',
    className: 'text-success',
  },
  failed: {
    icon: XCircle,
    labelKey: 'activity:verifyReport.verdictFailed',
    className: 'text-destructive',
  },
  needs_human: {
    icon: AlertTriangle,
    labelKey: 'activity:verifyReport.verdictNeedsHuman',
    className: 'text-warning',
  },
  incomplete: {
    icon: ShieldAlert,
    labelKey: 'activity:verifyReport.verdictIncomplete',
    className: 'text-muted-foreground',
  },
};

const CHECK_STATUS_CONFIG: Record<
  KanbanVerificationCheckResult['status'],
  { labelKey: string; className: string }
> = {
  passed: { labelKey: 'activity:verifyReport.checkPassed', className: 'text-success' },
  failed: { labelKey: 'activity:verifyReport.checkFailed', className: 'text-destructive' },
  skipped: { labelKey: 'activity:verifyReport.checkSkipped', className: 'text-muted-foreground' },
  error: { labelKey: 'activity:verifyReport.checkError', className: 'text-warning' },
};

function formatDuration(start: string, end: string): string {
  const ms = Date.parse(end) - Date.parse(start);
  if (Number.isNaN(ms) || ms < 0) return '';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

function VerdictBadge({ verdict }: { verdict: KanbanVerificationReport['verdict'] }) {
  const { t } = useAppTranslation();
  const cfg = VERDICT_CONFIG[verdict];
  const Icon = cfg.icon;
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold ${cfg.className}`}
    >
      <Icon size={13} />
      {t(cfg.labelKey)}
    </span>
  );
}

function CollapsibleSection({
  title,
  icon: Icon,
  defaultOpen = false,
  children,
}: {
  title: string;
  icon: typeof ChevronDown;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="rounded-md border bg-background">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 px-3 py-2 text-xs font-semibold uppercase text-muted-foreground hover:bg-muted/50"
      >
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        <Icon size={13} />
        {title}
      </button>
      {open && <div className="border-t px-3 py-2 space-y-2">{children}</div>}
    </div>
  );
}

function CheckResultRow({ check }: { check: KanbanVerificationCheckResult }) {
  const cfg = CHECK_STATUS_CONFIG[check.status];
  const { t } = useAppTranslation();
  const [expanded, setExpanded] = useState(false);
  const hasDetail = check.error || check.backingRefs?.length;

  return (
    <div className="rounded border bg-muted/30 px-2.5 py-2 text-xs">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className={`font-medium ${cfg.className}`}>{t(cfg.labelKey)}</span>
            <span className="rounded bg-muted px-1 text-[10px] text-muted-foreground">
              {check.type}
            </span>
          </div>
          <p className="mt-0.5 text-muted-foreground">{check.description}</p>
        </div>
        {hasDetail && (
          <button
            type="button"
            onClick={() => setExpanded(!expanded)}
            className="shrink-0 text-muted-foreground hover:text-foreground"
          >
            {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          </button>
        )}
      </div>
      {expanded && (
        <div className="mt-2 space-y-1.5 border-t pt-2">
          {check.error && (
            <div className="rounded bg-destructive/10 px-2 py-1 text-destructive">
              {check.error}
            </div>
          )}
          {check.backingRefs?.map((ref, i) => (
            <div key={i} className="flex items-center gap-1.5 text-muted-foreground">
              <FileCode2 size={11} />
              <span className="font-mono text-[11px]">{ref.path}</span>
              <span className="text-[10px]">({ref.kind})</span>
              {ref.summary && <span className="truncate">— {ref.summary}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function FileScopeCard({ fileScope }: { fileScope: KanbanVerificationFileScope }) {
  const { t } = useAppTranslation();
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-3 text-xs">
        <span className="text-muted-foreground">
          {t('activity:verifyReport.expected')} <strong>{fileScope.expectedChanges}</strong> changes
        </span>
        <span className="text-muted-foreground">
          {t('activity:verifyReport.actual')} <strong>{fileScope.actualChanges}</strong> changes
        </span>
        <span className={fileScope.scopeMatches ? 'text-success' : 'text-destructive'}>
          {fileScope.scopeMatches ? '✅ Scope matches' : '❌ Scope mismatch'}
        </span>
      </div>
      <div className="space-y-1">
        {fileScope.files.map((file, i) => (
          <div key={i} className="flex items-center gap-2 text-xs font-mono text-muted-foreground">
            <span
              className={
                file.operation === 'create'
                  ? 'text-success'
                  : file.operation === 'delete'
                    ? 'text-destructive'
                    : 'text-muted-foreground'
              }
            >
              {file.operation === 'create' ? '+' : file.operation === 'delete' ? '−' : '∼'}
            </span>
            <span className="min-w-0 flex-1 truncate">{file.path}</span>
            <span className="text-[10px]">
              {file.linesChanged} line{file.linesChanged !== 1 ? 's' : ''}
            </span>
            {!file.expected && (
              <span className="rounded bg-warning/10 px-1 text-[10px] text-warning">
                unexpected
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function SubtaskCard({ subtasks }: { subtasks: KanbanVerificationSubtasks }) {
  const { t } = useAppTranslation();
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        <span>
          {t('activity:verifyReport.total')} <strong>{subtasks.total}</strong>
        </span>
        <span className="text-success">
          {t('activity:verifyReport.completed')} <strong>{subtasks.completed}</strong>
        </span>
        {subtasks.failed > 0 && (
          <span className="text-destructive">
            {t('activity:verifyReport.failed')} <strong>{subtasks.failed}</strong>
          </span>
        )}
      </div>
      <div className="space-y-1">
        {subtasks.children.map((child, i) => (
          <div key={i} className="flex items-center gap-2 text-xs text-muted-foreground">
            {child.verdict === 'passed' ? (
              <span className="text-success">✓</span>
            ) : child.verdict === 'failed' ? (
              <span className="text-destructive">✗</span>
            ) : child.verdict === 'needs_human' ? (
              <span className="text-warning">⚠</span>
            ) : (
              <span className="text-muted-foreground">○</span>
            )}
            <span className="min-w-0 flex-1 truncate">{child.title}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function AttachmentCard({ attachments }: { attachments: KanbanVerificationAttachment[] }) {
  return (
    <div className="space-y-1">
      {attachments.map((att, i) => (
        <div
          key={i}
          className="flex items-start gap-2 rounded border bg-muted/30 px-2 py-1.5 text-xs"
        >
          <FileText size={12} className="mt-0.5 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <div className="font-medium">{att.label}</div>
            <div className="mt-0.5 font-mono text-[11px] text-muted-foreground">
              {att.path ? (
                <span className="truncate block">
                  {att.path}
                  <span className="ml-1 rounded bg-muted px-1 text-[10px]">{att.kind}</span>
                </span>
              ) : (
                <span className="rounded bg-muted px-1 text-[10px]">{att.kind}</span>
              )}
            </div>
            {att.content && (
              <pre className="mt-1 max-h-20 overflow-auto rounded bg-background p-1 text-[10px] text-muted-foreground">
                {att.content.slice(0, 500)}
                {att.content.length > 500 ? '\n…' : ''}
              </pre>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

export function VerificationReportPanel({ report }: VerificationReportPanelProps) {
  const { t } = useAppTranslation();
  return (
    <div className="mt-5 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="text-xs font-semibold uppercase text-muted-foreground">
            {t('activity:verifyReport.verificationReport')}
          </div>
          <VerdictBadge verdict={report.verdict} />
        </div>
        {report.markdownSummary && (
          <div className="text-[11px] text-muted-foreground">
            {formatDuration(report.startedAt, report.completedAt)}
          </div>
        )}
      </div>

      {/* Markdown Summary */}
      {report.markdownSummary && (
        <div className="rounded-md border bg-background px-3 py-2 text-xs text-muted-foreground whitespace-pre-wrap">
          {report.markdownSummary}
        </div>
      )}

      {/* Per-Check Results */}
      {report.checks.length > 0 && (
        <CollapsibleSection
          title={t('activity:verifyReport.checkResults')}
          icon={ListTree}
          defaultOpen={report.verdict !== 'passed'}
        >
          {report.checks.map((check) => (
            <CheckResultRow key={check.checkId} check={check} />
          ))}
        </CollapsibleSection>
      )}

      {/* File Scope */}
      {report.fileScope && (
        <CollapsibleSection
          title={t('activity:verifyReport.fileScope')}
          icon={FileCode2}
          defaultOpen={!report.fileScope.scopeMatches}
        >
          <FileScopeCard fileScope={report.fileScope} />
        </CollapsibleSection>
      )}

      {/* Sub-Task Aggregation */}
      {report.subtasks && (
        <CollapsibleSection title={t('activity:verifyReport.subTasks')} icon={ListTree}>
          <SubtaskCard subtasks={report.subtasks} />
        </CollapsibleSection>
      )}

      {/* Attachments */}
      {report.attachments.length > 0 && (
        <CollapsibleSection title={`Attachments (${report.attachments.length})`} icon={FileText}>
          <AttachmentCard attachments={report.attachments} />
        </CollapsibleSection>
      )}
    </div>
  );
}
