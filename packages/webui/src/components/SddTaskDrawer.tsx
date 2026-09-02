import {
  Activity,
  ArrowLeft,
  Check,
  Clock,
  FileText,
  GitBranch,
  Maximize2,
  Minimize2,
  RotateCcw,
  Split,
  Square,
  Terminal,
  Trash2,
  UserCog,
  X,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import type { ModelCandidate } from '@/hooks/useProviderModels';
import { agentInitials, fmtDuration, priorityStyle, statusStyle } from '@/lib/sdd-theme';
import { cn } from '@/lib/utils';
import { useAppTranslation } from '@/i18n';
import type { BoardTaskItem, SddBoardFeedEntry } from '@/stores';
import { ModelPicker } from './ModelPicker';

/**
 * SddTaskDrawer — the per-task "show": full detail of a clicked task. Status,
 * the worker on it, worktree, timing, description, dependency chain (clickable),
 * and run controls (retry / reassign).
 */
export function SddTaskDrawer({
  task,
  allTasks,
  feed,
  now,
  expanded,
  modelCandidates,
  defaultModel,
  onClose,
  onToggleExpanded,
  onRetry,
  onReassign,
  onSetModel,
  onSetVerification,
  onCancel,
  onDelete,
  onSplit,
  onSelectTask,
}: {
  task: BoardTaskItem;
  allTasks: BoardTaskItem[];
  feed: SddBoardFeedEntry[];
  now: number;
  expanded?: boolean;
  modelCandidates: ModelCandidate[];
  defaultModel?: string | undefined;
  onClose: () => void;
  onToggleExpanded?: () => void;
  onRetry: (id: string) => void;
  onReassign: (id: string, agentName: string) => void;
  onSetModel: (id: string, model: string | undefined, provider?: string | undefined) => void;
  onSetVerification: (id: string, verificationCommand: string | undefined) => void;
  onCancel: (id: string) => void;
  onDelete: (id: string) => void;
  onSplit: (id: string, subtasks: Array<{ title: string; description: string }>) => void;
  onSelectTask: (id: string) => void;
}): React.ReactElement {
  const { t } = useAppTranslation();
  const s = statusStyle(task.displayStatus);
  const StatusIcon = s.icon;
  const running = task.displayStatus === 'in_progress';
  const deletable =
    task.displayStatus === 'pending' ||
    task.displayStatus === 'blocked' ||
    task.displayStatus === 'queued';
  const [reassigning, setReassigning] = useState(false);
  const [reassignName, setReassignName] = useState('');
  // Inline confirm gate for the destructive controls (no native confirm()).
  const [confirm, setConfirm] = useState<null | 'stop' | 'delete'>(null);
  const [splitting, setSplitting] = useState(false);
  const [splitText, setSplitText] = useState('');
  // Per-task verification command editor (completion gate).
  const [verifyEditing, setVerifyEditing] = useState(false);
  const [verifyText, setVerifyText] = useState(task.verificationCommand ?? '');

  const submitReassign = () => {
    if (reassignName.trim()) {
      onReassign(task.id, reassignName.trim());
      setReassigning(false);
      setReassignName('');
    }
  };

  // Parse the split textarea: one sub-task per line, `Title :: description`
  // (description optional → falls back to the title).
  const submitSplit = () => {
    const subtasks = splitText
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((line) => {
        const [title, ...rest] = line.split('::');
        const t = (title ?? '').trim();
        const desc = rest.join('::').trim();
        return { title: t, description: desc || t };
      })
      .filter((s) => s.title);
    if (subtasks.length) {
      onSplit(task.id, subtasks);
      setSplitting(false);
      setSplitText('');
    }
  };

  const byShort = useMemo(() => new Map(allTasks.map((t) => [t.shortId, t])), [allTasks]);
  const dependents = useMemo(
    () => allTasks.filter((t) => t.deps.includes(task.shortId)),
    [allTasks, task.shortId],
  );
  const taskEvents = useMemo(
    () => feed.filter((e) => e.taskId === task.id || e.taskShortId === task.shortId),
    [feed, task.id, task.shortId],
  );

  const elapsed =
    task.startedAt && !task.completedAt
      ? fmtDuration(now - task.startedAt)
      : task.startedAt && task.completedAt
        ? fmtDuration(task.completedAt - task.startedAt)
        : null;

  return (
    <div className="sdd-rise flex h-full min-h-0 min-w-0 flex-col">
      {/* header */}
      <div
        className={cn(
          'flex items-center gap-2 border-b border-border/70 bg-card/70 px-3 py-2',
          expanded && 'px-5 py-3',
        )}
      >
        <button
          type="button"
          onClick={onClose}
          className="text-muted-foreground hover:text-foreground"
          title={t('activity:sddTask.backTitle')}
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <span className="font-mono text-xs text-muted-foreground">{task.shortId}</span>
        {onToggleExpanded && (
          <button
            type="button"
            onClick={onToggleExpanded}
            className="ml-1 inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition hover:bg-muted hover:text-foreground"
            title={
              expanded ? t('activity:sddTask.collapseTitle') : t('activity:sddTask.expandTitle')
            }
            aria-label={
              expanded ? t('activity:sddTask.collapseTitle') : t('activity:sddTask.expandTitle')
            }
            aria-pressed={expanded}
          >
            {expanded ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
          </button>
        )}
        <span
          className={cn(
            'ml-auto flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px]',
            s.ring,
            s.text,
          )}
        >
          <StatusIcon className={cn('h-3 w-3', running && 'animate-spin')} />
          {s.label}
        </span>
      </div>

      <div
        className={cn(
          'min-h-0 min-w-0 flex-1 overflow-auto overscroll-contain',
          expanded ? 'grid grid-cols-2 content-start gap-4 p-5' : 'space-y-3 p-3',
        )}
      >
        <h3
          className={cn(
            'text-sm font-semibold leading-snug text-foreground',
            expanded && 'col-span-2 text-lg',
          )}
        >
          {task.title}
        </h3>

        {/* worker */}
        {task.agentName && (
          <div className="flex items-center gap-2 rounded-lg border border-border/70 bg-muted/45 p-2">
            <span
              className={cn(
                'flex h-7 w-7 items-center justify-center rounded-full text-[10px] font-bold text-white',
                running ? 'bg-warning sdd-agent-live' : 'bg-muted-foreground',
              )}
            >
              {agentInitials(task.agentName)}
            </span>
            <div className="leading-tight">
              <div className="text-xs font-medium text-foreground">{task.agentName}</div>
              <div className="text-[10px] text-muted-foreground">
                {running ? t('activity:sddTask.workingOn') : t('activity:sddTask.assigned')}
              </div>
            </div>
          </div>
        )}

        {/* meta grid */}
        <div className="grid grid-cols-2 gap-1.5 text-[11px]">
          <Meta label={t('activity:sddTask.metaPriority')}>
            <span className={cn('font-medium uppercase', priorityStyle(task.priority).text)}>
              {task.priority}
            </span>
          </Meta>
          <Meta label={t('activity:sddTask.metaType')}>{task.type}</Meta>
          {elapsed && (
            <Meta
              label={
                task.completedAt
                  ? t('activity:sddTask.metaDuration')
                  : t('activity:sddTask.metaElapsed')
              }
            >
              <span className="flex items-center gap-1">
                <Clock className="h-3 w-3 text-muted-foreground" />
                {elapsed}
              </span>
            </Meta>
          )}
          {task.retries ? (
            <Meta label={t('activity:sddTask.metaRetries')}>
              <span className="flex items-center gap-1 text-destructive">
                <RotateCcw className="h-3 w-3" />
                {task.retries}
              </span>
            </Meta>
          ) : null}
          {task.worktreeBranch && (
            <Meta label={t('activity:sddTask.metaWorktree')} full>
              <span
                className="flex items-center gap-1 font-mono text-foreground"
                title={task.worktreeBranch}
              >
                <GitBranch className="h-3 w-3 text-muted-foreground" />
                <span className="truncate">{task.worktreeBranch}</span>
              </span>
            </Meta>
          )}
        </div>

        {/* per-task model assignment (overrides the run default) */}
        <div>
          <div className="mb-1 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            {t('activity:sddTask.workerModel')}
            {!task.model && defaultModel && (
              <span className="font-normal normal-case text-muted-foreground">
                · {t('activity:sddTask.runDefault', { model: defaultModel })}
              </span>
            )}
          </div>
          <ModelPicker
            value={task.model}
            provider={task.provider}
            candidates={modelCandidates}
            placeholder={
              defaultModel
                ? t('activity:sddTask.runDefaultPlaceholderModel', { model: defaultModel })
                : t('activity:sddTask.runDefaultPlaceholder')
            }
            onPick={(model, provider) => onSetModel(task.id, model, provider)}
            onReset={task.model ? () => onSetModel(task.id, undefined, undefined) : undefined}
          />
          {task.fallbackModels && task.fallbackModels.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-1">
              {task.fallbackModels.map((f) => (
                <span
                  key={f}
                  className="rounded bg-muted px-1.5 py-0.5 font-mono text-[9px] text-muted-foreground"
                >
                  ↳ {f}
                </span>
              ))}
            </div>
          )}
        </div>

        {/* per-task verification command (completion gate) */}
        <div>
          <div className="mb-1 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            {t('activity:sddTask.verificationCmd')}
            <span className="font-normal normal-case text-muted-foreground">
              · {t('activity:sddTask.gatesCompletion')}
            </span>
          </div>
          {verifyEditing ? (
            <div className="flex flex-col gap-1">
              <input
                value={verifyText}
                onChange={(e) => setVerifyText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    onSetVerification(task.id, verifyText.trim() || undefined);
                    setVerifyEditing(false);
                  } else if (e.key === 'Escape') {
                    setVerifyText(task.verificationCommand ?? '');
                    setVerifyEditing(false);
                  }
                }}
                placeholder={t('activity:sddTask.verifyPlaceholder')}
                className="w-full rounded border border-border bg-background px-2 py-1 font-mono text-[11px] text-foreground"
              />
              <div className="flex gap-1">
                <button
                  type="button"
                  onClick={() => {
                    onSetVerification(task.id, verifyText.trim() || undefined);
                    setVerifyEditing(false);
                  }}
                  className="rounded bg-primary px-2 py-0.5 text-[10px] text-primary-foreground hover:opacity-90"
                >
                  {t('common:action.save')}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setVerifyText(task.verificationCommand ?? '');
                    setVerifyEditing(false);
                  }}
                  className="rounded bg-muted px-2 py-0.5 text-[10px] text-muted-foreground hover:bg-muted/80"
                >
                  {t('common:action.cancel')}
                </button>
              </div>
            </div>
          ) : task.verificationCommand ? (
            <div className="flex items-center gap-1">
              {task.verificationState && (
                <span
                  title={task.verificationDetail}
                  className={
                    task.verificationState === 'passed'
                      ? 'rounded bg-success/10 px-1.5 py-0.5 text-[10px] text-success'
                      : 'rounded bg-destructive/10 px-1.5 py-0.5 text-[10px] text-destructive'
                  }
                >
                  {task.verificationState === 'passed' ? '✓ verified' : '✗ failed'}
                </span>
              )}
              <code className="flex-1 truncate rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-foreground">
                {task.verificationCommand}
              </code>
              <button
                type="button"
                onClick={() => setVerifyEditing(true)}
                className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-muted/80"
              >
                {t('common:action.edit')}
              </button>
              <button
                type="button"
                onClick={() => onSetVerification(task.id, undefined)}
                className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-muted/80"
              >
                {t('common:action.clear')}
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setVerifyEditing(true)}
              className="rounded border border-dashed border-border px-2 py-1 text-[10px] text-muted-foreground hover:bg-muted"
            >
              {t('activity:sddTask.addVerify')}
            </button>
          )}
        </div>

        {/* description */}
        {task.description && (
          <div className={cn(expanded && 'col-span-2')}>
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              {t('activity:sddTask.description')}
            </div>
            <p className="whitespace-pre-wrap rounded-md bg-muted p-2 text-[11px] leading-relaxed text-foreground">
              {task.description}
            </p>
          </div>
        )}

        <TaskEventLog events={taskEvents} expanded={expanded} />

        {/* dependency chain */}
        {task.deps.length > 0 && (
          <DepList
            title={t('activity:sddTask.dependsOn')}
            shortIds={task.deps}
            byShort={byShort}
            onSelectTask={onSelectTask}
          />
        )}
        {dependents.length > 0 && (
          <DepList
            title={t('activity:sddTask.blocks')}
            shortIds={dependents.map((d) => d.shortId)}
            byShort={byShort}
            onSelectTask={onSelectTask}
          />
        )}
      </div>

      {/* actions — inline, no native alert/confirm/prompt */}
      <div className={cn('border-t border-border p-2', expanded && 'px-5 py-3')}>
        {reassigning ? (
          <div className="sdd-rise flex items-center gap-1.5">
            <input
              value={reassignName}
              onChange={(e) => setReassignName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submitReassign();
                if (e.key === 'Escape') setReassigning(false);
              }}
              placeholder={t('activity:sddTask.newWorkerPlaceholder')}
              className="min-w-0 flex-1 rounded-md border border-border/70 bg-background px-2 py-1.5 text-xs outline-none focus:border-primary/60"
            />
            <button
              type="button"
              onClick={submitReassign}
              disabled={!reassignName.trim()}
              className="rounded-md bg-primary/10 px-2 py-1.5 text-xs font-medium text-primary hover:bg-primary/15 disabled:opacity-40"
            >
              <Check className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => setReassigning(false)}
              className="rounded-md bg-muted px-2 py-1.5 text-xs text-muted-foreground hover:bg-muted"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ) : confirm ? (
          <div className="sdd-rise flex items-center gap-2">
            <span className="flex-1 text-xs text-foreground">
              {confirm === 'stop'
                ? t('activity:sddTask.confirmStop')
                : t('activity:sddTask.confirmDelete')}
            </span>
            <button
              type="button"
              onClick={() => {
                if (confirm === 'stop') onCancel(task.id);
                else onDelete(task.id);
                setConfirm(null);
              }}
              className="inline-flex items-center gap-1 rounded-md bg-destructive/10 px-2.5 py-1.5 text-xs font-medium text-destructive hover:bg-destructive/15"
            >
              <Check className="h-3.5 w-3.5" />{' '}
              {confirm === 'stop' ? t('common:action.stop') : t('common:action.delete')}
            </button>
            <button
              type="button"
              onClick={() => setConfirm(null)}
              className="rounded-md bg-muted px-2 py-1.5 text-xs text-muted-foreground hover:bg-muted"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => onRetry(task.id)}
              title={t('activity:sddTask.retryTitle')}
              className="inline-flex flex-1 items-center justify-center gap-1 rounded-md bg-warning/12 py-1.5 text-xs font-medium text-warning hover:bg-warning/18"
            >
              <RotateCcw className="h-3.5 w-3.5" /> {t('common:action.retry')}
            </button>
            <button
              type="button"
              onClick={() => setReassigning(true)}
              className="inline-flex flex-1 items-center justify-center gap-1 rounded-md bg-primary/10 py-1.5 text-xs font-medium text-primary hover:bg-primary/15"
            >
              <UserCog className="h-3.5 w-3.5" /> {t('activity:sddTask.reassign')}
            </button>
            {running && (
              <button
                type="button"
                onClick={() => setConfirm('stop')}
                title={t('activity:sddTask.stopTitle')}
                className="inline-flex flex-1 items-center justify-center gap-1 rounded-md bg-destructive/10 py-1.5 text-xs font-medium text-destructive hover:bg-destructive/15"
              >
                <Square className="h-3.5 w-3.5" /> {t('common:action.stop')}
              </button>
            )}
            {!running && (
              <button
                type="button"
                onClick={() => setSplitting(true)}
                title={t('activity:sddTask.splitTitle')}
                className="inline-flex flex-1 items-center justify-center gap-1 rounded-md bg-primary/10 py-1.5 text-xs font-medium text-primary hover:bg-primary/15"
              >
                <Split className="h-3.5 w-3.5" /> {t('activity:sddTask.split')}
              </button>
            )}
            {deletable && (
              <button
                type="button"
                onClick={() => setConfirm('delete')}
                title={t('activity:sddTask.deleteTitle')}
                className="inline-flex flex-1 items-center justify-center gap-1 rounded-md bg-destructive/10 py-1.5 text-xs font-medium text-destructive hover:bg-destructive/15"
              >
                <Trash2 className="h-3.5 w-3.5" /> {t('common:action.delete')}
              </button>
            )}
          </div>
        )}
        {splitting && (
          <div className="mt-2 flex flex-col gap-2">
            <label className="text-[11px] text-muted-foreground" htmlFor="sdd-split-input">
              {t('activity:sddTask.splitHint')}
            </label>
            <textarea
              id="sdd-split-input"
              rows={3}
              value={splitText}
              onChange={(e) => setSplitText(e.target.value)}
              placeholder={t('activity:sddTask.splitPlaceholder')}
              className="w-full resize-y rounded-md border border-border/70 bg-background px-2 py-1.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            />
            <div className="flex gap-2">
              <button
                type="button"
                onClick={submitSplit}
                className="inline-flex flex-1 items-center justify-center gap-1 rounded-md bg-primary/10 py-1.5 text-xs font-medium text-primary hover:bg-primary/15"
              >
                <Split className="h-3.5 w-3.5" /> {t('activity:sddTask.splitInto')}
              </button>
              <button
                type="button"
                onClick={() => {
                  setSplitting(false);
                  setSplitText('');
                }}
                className="rounded-md bg-muted px-2 py-1.5 text-xs text-muted-foreground hover:bg-muted"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function TaskEventLog({ events, expanded }: { events: SddBoardFeedEntry[]; expanded?: boolean }) {
  const { t } = useAppTranslation();
  // Task events are bounded (per task), show all without pagination.
  return (
    <section
      className={cn(
        'rounded-lg border border-border/70 bg-background/45',
        expanded && 'col-span-2',
      )}
    >
      <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2.5">
        <Activity className="h-4 w-4 text-primary" />
        <h4 className="text-xs font-semibold text-foreground">{t('activity:sddTask.eventLog')}</h4>
        <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
          {events.length}
        </span>
        <span className="ml-auto text-[10px] text-muted-foreground">
          {t('activity:sddTask.newestFirst')}
        </span>
      </div>

      {events.length === 0 ? (
        <p className="px-3 py-5 text-center text-[11px] text-muted-foreground">
          {t('activity:sddTask.noEvents')}
        </p>
      ) : (
        <div
          className={cn(
            'divide-y divide-border/45 overflow-auto',
            expanded ? 'max-h-[32rem]' : 'max-h-72',
          )}
        >
          {events.map((event, index) => {
            const isFile = event.kind === 'file';
            const isTool = event.kind === 'tool';
            const failed =
              event.ok === false || event.kind === 'failed' || event.kind === 'verification_failed';
            const Icon = isFile ? FileText : isTool ? Terminal : Activity;
            return (
              <div
                key={`${event.ts}-${event.kind}-${index}`}
                className={cn(
                  'grid grid-cols-[4.75rem_1rem_minmax(0,1fr)] gap-2 px-3 py-2.5 text-[11px]',
                  failed && 'bg-destructive/[0.035]',
                )}
              >
                <time
                  dateTime={new Date(event.ts).toISOString()}
                  className="font-mono text-[10px] text-muted-foreground"
                  title={new Date(event.ts).toLocaleString()}
                >
                  {new Date(event.ts).toLocaleTimeString([], {
                    hour: '2-digit',
                    minute: '2-digit',
                    second: '2-digit',
                  })}
                </time>
                <Icon
                  className={cn(
                    'mt-0.5 h-3.5 w-3.5',
                    failed
                      ? 'text-destructive'
                      : isFile
                        ? 'text-info'
                        : isTool
                          ? 'text-warning'
                          : 'text-primary',
                  )}
                />
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-1.5">
                    {event.action && (
                      <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] font-medium text-foreground">
                        {event.action}
                      </span>
                    )}
                    {event.agentName && (
                      <span className="text-[10px] text-muted-foreground">{event.agentName}</span>
                    )}
                    {event.durationMs !== undefined && (
                      <span className="text-[10px] text-muted-foreground">
                        {event.durationMs < 1000
                          ? `${Math.round(event.durationMs)}ms`
                          : `${(event.durationMs / 1000).toFixed(1)}s`}
                      </span>
                    )}
                  </div>
                  {event.filePath ? (
                    <code className="mt-1 block break-all font-mono text-[10px] leading-relaxed text-foreground">
                      {event.filePath}
                    </code>
                  ) : event.detail ? (
                    <code className="mt-1 block break-words font-mono text-[10px] leading-relaxed text-muted-foreground">
                      {event.detail}
                    </code>
                  ) : (
                    <p className="mt-1 break-words leading-relaxed text-foreground">{event.text}</p>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function Meta({
  label,
  children,
  full,
}: {
  label: string;
  children: React.ReactNode;
  full?: boolean;
}) {
  return (
    <div
      className={cn('rounded-md border border-border bg-muted/50 px-2 py-1', full && 'col-span-2')}
    >
      <div className="text-[9px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="text-foreground">{children}</div>
    </div>
  );
}

function DepList({
  title,
  shortIds,
  byShort,
  onSelectTask,
}: {
  title: string;
  shortIds: string[];
  byShort: Map<string, BoardTaskItem>;
  onSelectTask: (id: string) => void;
}) {
  return (
    <div>
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </div>
      <div className="flex flex-wrap gap-1">
        {shortIds.map((sid) => {
          const dep = byShort.get(sid);
          return (
            <button
              key={sid}
              type="button"
              disabled={!dep}
              onClick={() => dep && onSelectTask(dep.id)}
              className="flex items-center gap-1 rounded-full border border-border bg-muted px-2 py-0.5 text-[10px] text-foreground hover:bg-muted disabled:opacity-50"
              title={dep?.title}
            >
              <span
                className={cn(
                  'h-1.5 w-1.5 rounded-full',
                  statusStyle(dep?.displayStatus ?? 'pending').dot,
                )}
              />
              <span className="font-mono">{sid}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
