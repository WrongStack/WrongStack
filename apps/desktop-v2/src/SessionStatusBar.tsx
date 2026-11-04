import { AlertTriangle, Brain, Database, Gauge, RefreshCw, Repeat } from 'lucide-react';
import { useState } from 'react';
import {
  type ContextUsage,
  cacheHitPercent,
  contextPercent,
  contextZone,
  formatTokens,
} from './context-usage';
import { useDesktopText } from './desktop-i18n';
import type { EngineCommand } from './engine-operations';
import type { EngineState } from './engine-state';
import { record } from './engine-values';
import { SessionContextPanel } from './SessionContextPanel';
import { inlineUsageEstimate } from './session-usage-model';
import './session-status.css';
import { GitChip } from './GitChip';

const number = (value: unknown) => (typeof value === 'number' ? value : null);

/**
 * The conversation's live status under the chat: how full the context window is, how much of
 * the latest request came from the provider's cache, the running iteration and the session's
 * token and cost totals. The meter opens the context details with compaction and repair.
 */
export function SessionStatusBar({
  state,
  command,
  refresh,
}: {
  state: EngineState;
  command: EngineCommand;
  refresh: () => void;
}) {
  const { t } = useDesktopText();
  const [details, setDetails] = useState(false);
  const usage = state.context;
  const percent = contextPercent(usage);
  const zone = contextZone(percent);
  const hit = cacheHitPercent(usage);
  const stats = state.results['stats.get'];
  const totals = record(stats?.['usage']);
  const input = number(totals['input']) ?? (usage.responses ? usage.totals.input : null);
  const output = number(totals['output']) ?? (usage.responses ? usage.totals.output : null);
  const estimate = inlineUsageEstimate(stats);
  const iteration = record(state.results['iteration.started']);
  const index = number(iteration['index']);
  const limit = number(iteration['maxIterations']);
  const label = contextLabel(usage, percent, t);
  return (
    <div className="native-usage session-status">
      <span>
        {state.running
          ? state.inputs.length
            ? t('statusBar.waiting')
            : t('statusBar.working')
          : state.connected
            ? t('statusBar.ready')
            : t('statusBar.connecting')}
      </span>
      <button
        type="button"
        className={`context-meter context-${zone}`}
        disabled={!state.connected}
        onClick={() => setDetails(true)}
        aria-label={t('statusBar.openDetails', { context: label })}
        title={t('statusBar.meterTitle')}
      >
        {zone === 'critical' ? <AlertTriangle size={12} /> : <Gauge size={12} />}
        <span className="context-meter-bar" aria-hidden="true">
          <span style={{ width: `${percent ?? 0}%` }} />
        </span>
        <span>{label}</span>
      </button>
      {hit !== null && (
        <span
          title={t('statusBar.cacheTitle', {
            read: usage.cacheRead.toLocaleString(),
            written: usage.cacheWrite.toLocaleString(),
          })}
        >
          <Database size={11} /> {t('statusBar.cache', { percent: hit })}
        </span>
      )}
      {!!state.memoryContext?.active.length && (
        <button type="button" title={t('statusBar.memoryTitle')} onClick={() => setDetails(true)}>
          <Brain size={11} /> {t('statusBar.memory', { count: state.memoryContext.active.length })}
        </button>
      )}
      {usage.decreasedFrom > 0 && (
        <span className="context-limit-warning" title={t('statusBar.limitTitle')}>
          {t('statusBar.limit', {
            max: formatTokens(usage.max),
            was: formatTokens(usage.decreasedFrom),
          })}
        </span>
      )}
      {state.running && index !== null && (
        <span>
          <Repeat size={11} />{' '}
          {limit
            ? t('statusBar.iterationOf', { number: index + 1, limit })
            : t('statusBar.iteration', { number: index + 1 })}
        </span>
      )}
      <GitChip command={command} connected={state.connected} />
      {input !== null && <span>{t('statusBar.in', { tokens: formatTokens(input) })}</span>}
      {output !== null && <span>{t('statusBar.out', { tokens: formatTokens(output) })}</span>}
      {typeof estimate === 'number' && (
        <span>{t('statusBar.estimated', { value: estimate.toFixed(4) })}</span>
      )}
      <button
        type="button"
        title={t('statusBar.refresh')}
        aria-label={t('statusBar.refresh')}
        onClick={refresh}
        disabled={!state.connected}
      >
        <RefreshCw size={12} />
      </button>
      {details && (
        <SessionContextPanel
          command={command}
          running={state.running}
          usage={usage}
          onClose={() => setDetails(false)}
          memoryRuns={state.memoryRuns}
          memoryContext={state.memoryContext}
        />
      )}
    </div>
  );
}
function contextLabel(
  usage: ContextUsage,
  percent: number | null,
  t: ReturnType<typeof useDesktopText>['t'],
): string {
  if (percent !== null)
    return t('statusBar.contextPercent', {
      percent,
      tokens: formatTokens(usage.tokens),
      max: formatTokens(usage.max),
    });
  if (usage.tokens) return t('statusBar.contextTokens', { tokens: formatTokens(usage.tokens) });
  return t('statusBar.context');
}
