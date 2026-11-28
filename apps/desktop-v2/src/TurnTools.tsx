import type { TFunction } from 'i18next';
import { CheckCircle2, ChevronRight, LoaderCircle, Sparkles, Wrench, XCircle } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { ChatSteps, TurnChanges } from './ChatSteps';
import { changedFiles, MEASURABLE_MS, stepSeconds, stepsDuration } from './chat-steps-model';
import { formatTokens, type TurnStats } from './context-usage';
import {
  type ConversationDisplay,
  conversationAppearanceDefaults,
} from './conversation-appearance';
import { useDesktopText } from './desktop-i18n';
import type { EngineCommand } from './engine-operations';
import type { EngineEvent } from './engine-state';
import { LazyDetails } from './LazyDetails';
import { activityRows } from './session-activity-model';
import { ToolKindIcon } from './ToolKindIcon';
import { toolInputHint } from './tool-input-view';
import { turnToolSummary } from './turn-tools';
import './session-status.css';

/**
 * The tool work of one finished turn, kept with the answer it led to: what the turn took
 * (iterations, tokens) and a one-line summary that opens the same activity view the live run
 * shows.
 */
export function TurnTools({
  display = conversationAppearanceDefaults,
  events,
  stats,
  onOpenFile,
  command,
}: {
  events: readonly EngineEvent[];
  display?: ConversationDisplay | undefined;
  stats?: TurnStats | undefined;
  onOpenFile: (path: string) => void;
  command?: EngineCommand | undefined;
}) {
  const { t } = useDesktopText();
  const summary = turnToolSummary(events);
  const meta = stats ? turnMeta(stats, t) : '';
  if (summary.calls === 0 && !meta) return null;
  return (
    <>
      {meta && <p className="chat-turn-meta">{meta}</p>}
      {summary.calls > 0 &&
        (display.groupToolCalls ? (
          <LazyDetails
            className="chat-run-activity turn-tools"
            summary={
              <summary>
                <ChevronRight size={14} className="activity-chevron" aria-hidden="true" />
                <Wrench size={12} aria-hidden="true" />{' '}
                {t('turn.workedWith', { calls: toolCalls(summary.calls, t) })}
                {summary.failed ? ` · ${t('turn.failed', { count: summary.failed })}` : ''} ·{' '}
                {summary.text}
              </summary>
            }
          >
            <ChatSteps
              showThinking={display.showThinkingLogs}
              events={events}
              onOpenFile={onOpenFile}
              command={command}
            />
          </LazyDetails>
        ) : (
          <ChatSteps
            showThinking={display.showThinkingLogs}
            events={events}
            onOpenFile={onOpenFile}
            command={command}
          />
        ))}
    </>
  );
}
function toolCalls(count: number, t: TFunction<'desktop'>): string {
  return t(count === 1 ? 'turn.toolCall' : 'turn.toolCalls', { count });
}
function turnMeta(stats: TurnStats, t: TFunction<'desktop'>): string {
  const parts: string[] = [];
  if (stats.iterations)
    parts.push(
      t(stats.iterations === 1 ? 'turn.iteration' : 'turn.iterations', {
        count: stats.iterations,
      }),
    );
  if (stats.prompt) parts.push(t('turn.promptTokens', { tokens: formatTokens(stats.prompt) }));
  if (stats.output) parts.push(t('turn.output', { tokens: formatTokens(stats.output) }));
  if (stats.prompt && stats.cacheRead)
    parts.push(t('turn.cache', { percent: Math.round((stats.cacheRead / stats.prompt) * 100) }));
  if (stats.durationMs !== undefined) parts.push(formatDuration(stats.durationMs));
  return parts.join(' · ');
}
/** "42 s", "3 min 05 s", "1 h 02 min". */
function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ${String(seconds % 60).padStart(2, '0')} s`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} min`;
}
/** The last non-empty line of the reasoning text, shortened for one line of the card. */
function lastThought(text: string): string {
  const line =
    text
      .split('\n')
      .map((item) => item.trim())
      .filter(Boolean)
      .at(-1) ?? '';
  return line.length > 160 ? `…${line.slice(-159)}` : line;
}
/**
 * The running turn's card under the conversation: how long it has been running and what it is
 * doing now (the tool it runs or the last line it thought), as the WebUI's working bubble shows.
 * Its motion uses transform and opacity only, so it never repaints the transcript around it.
 */
export function AgentWorking({
  waiting,
  since,
  timeline = [],
  showThinking = true,
}: {
  /** The turn waits for answers to its questions. */
  waiting: boolean;
  /** When the turn's first iteration started; unknown in journals without frame times. */
  since: number | null;
  /** The running turn's frames, for the step it is on now. */
  timeline?: readonly EngineEvent[] | undefined;
  showThinking?: boolean | undefined;
}) {
  const { t } = useDesktopText();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!since) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [since]);
  const step = useMemo(() => {
    const row = activityRows(timeline)
      .filter((item) => item.kind === 'tool' || item.kind === 'reasoning')
      .at(-1);
    if (!row) return null;
    if (row.kind === 'reasoning')
      return showThinking && row.output ? { thinking: true, text: lastThought(row.output) } : null;
    return row.status === 'running' ? { thinking: false, text: row.title } : null;
  }, [timeline, showThinking]);
  return (
    <div className={`agent-working${waiting ? ' waiting' : ''}`} role="status">
      <span className="agent-working-orb" aria-hidden="true">
        <Sparkles size={13} />
      </span>
      <span className="agent-working-body">
        <span className="agent-working-head">
          <strong>{waiting ? t('working.waiting') : t('working.busy')}</strong>
          {!waiting && (
            <span className="agent-working-dots" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
          )}
          {since ? (
            <span className="agent-working-elapsed">{formatDuration(now - since)}</span>
          ) : null}
        </span>
        {step && !waiting && (
          <span className={`agent-working-step${step.thinking ? ' thinking' : ''}`}>
            {step.thinking ? (
              <>
                <em>{t('working.thinking')}</em> {step.text}
              </>
            ) : (
              <>
                <LoaderCircle size={11} className="spin" />{' '}
                {t('working.running', { tool: step.text })}
              </>
            )}
          </span>
        )}
      </span>
    </div>
  );
}
/**
 * The running turn's work starts open, then respects the reader's disclosure choice through
 * updates and completion. Calls, thinking and retries are grouped by their originating iteration.
 */
export function LiveRunActivity({
  display = conversationAppearanceDefaults,
  events,
  projectRoot,
  onOpenFile,
  onOpenDesign,
  command,
  live = true,
  onReviewChanges,
}: {
  events: readonly EngineEvent[];
  projectRoot?: string | null | undefined;
  display?: ConversationDisplay | undefined;
  onOpenFile: (path: string) => void;
  onOpenDesign?: (() => void) | undefined;
  command?: EngineCommand | undefined;
  live?: boolean | undefined;
  /** Opens the conversation's Changes view from a finished turn's file summary. */
  onReviewChanges?: (() => void) | undefined;
}) {
  const { t } = useDesktopText();
  const rows = activityRows(events);
  if (!rows.some((row) => display.showThinkingLogs || row.kind !== 'reasoning')) return null;
  const steps = (
    <ChatSteps
      live={live}
      showThinking={display.showThinkingLogs}
      events={events}
      projectRoot={projectRoot}
      onOpenFile={onOpenFile}
      onOpenDesign={onOpenDesign}
      command={command}
    />
  );
  // A finished turn says which files it changed, outside its (usually closed) group.
  const changes = live ? null : (
    <TurnChanges files={changedFiles(rows)} onOpenFile={onOpenFile} onReview={onReviewChanges} />
  );
  if (!display.groupToolCalls)
    return (
      <>
        {steps}
        {changes}
      </>
    );
  const summary = turnToolSummary(events);
  const calls = rows.filter((row) => row.kind === 'tool').length;
  const duration = stepsDuration(rows);
  // While the run works, the closed group still says what it is doing right now: the newest
  // call that has not finished, by tool and target.
  const current = live
    ? rows.findLast((row) => row.kind === 'tool' && row.status === 'running')
    : undefined;
  const currentHint = current ? toolInputHint(current.title, current.input) : '';
  return (
    <>
      <LazyDetails
        className="chat-run-activity"
        defaultOpen={live}
        summary={
          <summary>
            <ChevronRight size={14} className="activity-chevron" aria-hidden="true" />
            <strong className="turn-steps">
              {calls
                ? t(calls === 1 ? 'chatSteps.step' : 'chatSteps.steps', { count: calls })
                : t('turn.activity')}
              {duration !== undefined && duration >= MEASURABLE_MS ? (
                <small> · {stepSeconds(duration)}</small>
              ) : null}
            </strong>
            {live ? (
              <LoaderCircle
                size={12}
                className="spin turn-steps-live"
                aria-label={t('runLog.status.running')}
              />
            ) : calls && !summary.failed ? (
              <CheckCircle2 size={12} className="turn-steps-ok" aria-hidden="true" />
            ) : null}
            {summary.failed ? (
              <span className="turn-chip failed">
                <XCircle size={11} />
                {t('turn.failed', { count: summary.failed })}
              </span>
            ) : null}
            {current ? (
              <span className="turn-current" title={currentHint || current.title}>
                <ToolKindIcon name={current.title} size={12} />
                <span className="turn-current-tool">{current.title}</span>
                {currentHint ? <code className="turn-current-hint">{currentHint}</code> : null}
              </span>
            ) : summary.text ? (
              <span className="turn-summary-text" title={summary.text}>
                {summary.text}
              </span>
            ) : null}
          </summary>
        }
      >
        {steps}
      </LazyDetails>
      {changes}
    </>
  );
}
