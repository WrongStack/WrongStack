import {
  Activity,
  Check,
  ChevronRight,
  GitCompareArrows,
  Lightbulb,
  ListChecks,
  LoaderCircle,
  RotateCw,
  TerminalSquare,
  XCircle,
} from 'lucide-react';
import { useMemo } from 'react';
import { ActivityEntryBody } from './ActivityEntryBody';
import {
  type ChangedFile,
  type ChatStep,
  chatSteps,
  outputTail,
  type PlanItem,
  stepSeconds,
} from './chat-steps-model';
import { DesignExtractionCard } from './DesignExtractionCard';
import { DesignReviewCard } from './DesignReviewCard';
import { useDesktopText } from './desktop-i18n';
import type { EngineCommand } from './engine-operations';
import type { EngineEvent } from './engine-state';
import { LazyDetails } from './LazyDetails';
import { type ActivityRow, activityRows } from './session-activity-model';
import { ToolKindIcon } from './ToolKindIcon';
import './session-activity.css';
import './chat-steps.css';
import './chat-chrome.css';

/**
 * A turn's work as the conversation shows it: one line per call ("Searched", "Read", "Edited"
 * and its target), the turn's plan as a checklist card, a running command with its live output,
 * and reasoning as a quiet "Thought" line. Each line opens to the same details the run log has.
 * The full run log (iterations, timestamps, filters) stays in the Run activity panel.
 */
export function ChatSteps({
  events,
  live = false,
  showThinking = true,
  projectRoot,
  onOpenFile,
  onOpenDesign,
  command,
}: {
  events: readonly EngineEvent[];
  /** The turn is still running: running calls stay running, edits show their diff inline. */
  live?: boolean | undefined;
  showThinking?: boolean | undefined;
  projectRoot?: string | null | undefined;
  onOpenFile: (path: string) => void;
  onOpenDesign?: (() => void) | undefined;
  command?: EngineCommand | undefined;
}) {
  const steps = useMemo(() => {
    const rows = activityRows(events).map((row) =>
      !live && row.status === 'running' ? { ...row, status: 'info' as const } : row,
    );
    return chatSteps(rows, showThinking);
  }, [events, live, showThinking]);
  if (!steps.length) return null;
  return (
    <div className="session-activity session-activity-compact chat-steps">
      {steps.map((step, index) => (
        <StepView
          key={step.row.id}
          step={step}
          live={live}
          last={index === steps.length - 1}
          projectRoot={projectRoot}
          onOpenFile={onOpenFile}
          onOpenDesign={onOpenDesign}
          command={command}
        />
      ))}
    </div>
  );
}

function StepView({
  step,
  live,
  last,
  projectRoot,
  onOpenFile,
  onOpenDesign,
  command,
}: {
  step: ChatStep;
  live: boolean;
  last: boolean;
  projectRoot?: string | null | undefined;
  onOpenFile: (path: string) => void;
  onOpenDesign?: (() => void) | undefined;
  command?: EngineCommand | undefined;
}) {
  const { t } = useDesktopText();
  const body = <ActivityEntryBody row={step.row} onOpenFile={onOpenFile} command={command} />;
  if (step.kind === 'thought') {
    const thinking = live && last;
    return (
      <LazyDetails
        className="chat-thought activity-kind-reasoning"
        summary={
          <summary className="chat-thought-summary">
            <Lightbulb size={13} aria-hidden="true" />
            <em>
              {thinking
                ? t('chatSteps.thinking')
                : step.durationMs !== undefined
                  ? t('chatSteps.thoughtFor', { time: stepSeconds(step.durationMs) })
                  : t('chatSteps.thought')}
            </em>
            <ChevronRight size={13} className="chat-step-chevron" aria-hidden="true" />
          </summary>
        }
      >
        <pre className="chat-thought-text">{step.row.output}</pre>
      </LazyDetails>
    );
  }
  if (step.kind === 'plan') return <PlanCard items={step.items} />;
  if (step.kind === 'command') return <RunningCommand row={step.row} command={step.command} />;
  if (step.kind === 'note') {
    const failed = step.row.status === 'failed' || step.row.status === 'aborted';
    return (
      <LazyDetails
        className={`chat-step chat-step-note activity-entry activity-${step.row.status} activity-kind-${step.row.kind}`}
        summary={
          <summary>
            <span className="chat-step-icon">
              {step.row.kind === 'retry' ? <RotateCw size={13} /> : <Activity size={13} />}
            </span>
            <span className="activity-entry-label chat-step-label">
              <strong>
                {step.row.label
                  ? t(step.row.label.key, step.row.label.values ?? {})
                  : step.row.title}
              </strong>
            </span>
            {failed ? <XCircle size={14} className="chat-step-status failed" /> : null}
          </summary>
        }
      >
        {body}
      </LazyDetails>
    );
  }
  const { row } = step;
  const verb = step.verb ? t(`chatSteps.verb.${step.verb}`) : row.title;
  return (
    <>
      {row.title === 'design_reference' && (
        <>
          <DesignExtractionCard
            row={row}
            projectRoot={projectRoot}
            onOpenFile={onOpenFile}
            onOpenDesign={onOpenDesign}
          />
          <DesignReviewCard row={row} projectRoot={projectRoot} onOpenFile={onOpenFile} />
        </>
      )}
      <LazyDetails
        className={`chat-step activity-entry activity-${row.status} activity-kind-tool${step.diff && live ? ' with-diff' : ''}`}
        summary={
          <summary
            title={step.verb ? `${row.title}${step.target ? ` · ${step.target}` : ''}` : undefined}
          >
            <span className="chat-step-icon">
              <ToolKindIcon name={row.title} size={13} />
            </span>
            <span className="activity-entry-label chat-step-label">
              <strong>{verb}</strong>
              {step.target ? <code className="chat-step-target">{step.target}</code> : null}
              {/* The conversation is the leader's: only another agent's call names its agent. */}
              {row.agent && row.agent !== 'leader' ? (
                <small className="chat-step-agent">{row.agent}</small>
              ) : null}
            </span>
            {step.added || step.removed ? (
              <span className="chat-step-counts">
                {step.added ? <span className="added">+{step.added}</span> : null}
                {step.removed ? <span className="removed">-{step.removed}</span> : null}
              </span>
            ) : null}
            {row.durationMs !== undefined && (
              <small className="chat-step-time">{stepSeconds(row.durationMs)}</small>
            )}
            <StatusIcon row={row} />
          </summary>
        }
      >
        {body}
      </LazyDetails>
      {/* A small edit in the live turn shows what changed without opening the row. */}
      {step.diff && live && <InlineDiff diff={step.diff} />}
    </>
  );
}

function StatusIcon({ row }: { row: ActivityRow }) {
  const { t } = useDesktopText();
  if (row.status === 'running')
    return (
      <LoaderCircle
        size={14}
        className="spin chat-step-status"
        aria-label={t('runLog.status.running')}
      />
    );
  if (row.status === 'failed')
    return (
      <XCircle
        size={14}
        className="chat-step-status failed"
        aria-label={t('runLog.status.failed')}
      />
    );
  if (row.status === 'done')
    return (
      <Check size={14} className="chat-step-status done" aria-label={t('runLog.status.done')} />
    );
  return null;
}

function InlineDiff({ diff }: { diff: { removed: string[]; added: string[] } }) {
  return (
    <div className="chat-step-diff" aria-hidden="true">
      {diff.removed.map((line, i) => (
        <div key={`r${i}`} className="removed">
          <span>-</span>
          <code>{line || ' '}</code>
        </div>
      ))}
      {diff.added.map((line, i) => (
        <div key={`a${i}`} className="added">
          <span>+</span>
          <code>{line || ' '}</code>
        </div>
      ))}
    </div>
  );
}

/** The turn's latest plan: done, current and waiting items with a progress bar. */
export function PlanCard({ items }: { items: readonly PlanItem[] }) {
  const { t } = useDesktopText();
  const done = items.filter((item) => item.status === 'completed').length;
  return (
    <section className="chat-plan" aria-label={t('chatSteps.plan')}>
      <header>
        <ListChecks size={14} aria-hidden="true" />
        <strong className="chat-plan-title">{t('chatSteps.plan')}</strong>
        <small>{t('chatSteps.planDone', { done, total: items.length })}</small>
      </header>
      <div
        className="chat-plan-bar"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={items.length}
        aria-valuenow={done}
      >
        <span style={{ width: `${items.length ? (done / items.length) * 100 : 0}%` }} />
      </div>
      <ol>
        {items.map((item) => (
          <li key={item.id} className={`chat-plan-item ${item.status}`}>
            <span className="chat-plan-mark" aria-hidden="true">
              {item.status === 'completed' ? (
                <Check size={11} strokeWidth={3} />
              ) : item.status === 'in_progress' ? (
                <i />
              ) : null}
            </span>
            <span>{item.content}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

/** A command still running, with the last lines of what it has printed so far. */
function RunningCommand({ row, command }: { row: ActivityRow; command: string }) {
  const { t } = useDesktopText();
  const tail = outputTail(row.progress, 14);
  return (
    <section className="chat-command" aria-label={t('chatSteps.verb.running')}>
      <header>
        <span className="chat-step-icon">
          <TerminalSquare size={13} />
        </span>
        <strong>{t('chatSteps.verb.running')}</strong>
        <code className="chat-step-target">{command}</code>
        <LoaderCircle size={14} className="spin chat-step-status" aria-hidden="true" />
      </header>
      {tail ? (
        <pre className="chat-command-output" title={t('chatSteps.output')}>
          {tail}
        </pre>
      ) : null}
    </section>
  );
}

/**
 * Under a finished turn: how many files its edits changed, the lines added and removed, each
 * file to open, and the conversation's Changes view to review them all.
 */
export function TurnChanges({
  files,
  onOpenFile,
  onReview,
}: {
  files: readonly ChangedFile[];
  onOpenFile: (path: string) => void;
  onReview?: (() => void) | undefined;
}) {
  const { t } = useDesktopText();
  if (!files.length) return null;
  const added = files.reduce((sum, file) => sum + file.added, 0);
  const removed = files.reduce((sum, file) => sum + file.removed, 0);
  return (
    <section className="chat-turn-changes" aria-label={t('chatSteps.changesLabel')}>
      <GitCompareArrows size={14} aria-hidden="true" />
      <strong className="chat-turn-changes-title">
        {t(files.length === 1 ? 'chatSteps.fileChanged' : 'chatSteps.filesChanged', {
          count: files.length,
        })}
      </strong>
      <span className="chat-step-counts">
        {added ? <span className="added">+{added}</span> : null}
        {removed ? <span className="removed">-{removed}</span> : null}
      </span>
      <span className="chat-turn-files">
        {files.slice(0, 6).map((file) => (
          <button
            key={file.path}
            type="button"
            title={file.path}
            onClick={() => onOpenFile(file.path)}
          >
            {file.path.split(/[/]/).at(-1)}
          </button>
        ))}
        {files.length > 6 ? <small>+{files.length - 6}</small> : null}
      </span>
      {onReview && (
        <button type="button" className="button secondary small" onClick={onReview}>
          {t('chatSteps.review')}
        </button>
      )}
    </section>
  );
}
