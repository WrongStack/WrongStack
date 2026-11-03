import { AlertTriangle, Brain, Database, Gauge, RefreshCw, Repeat } from 'lucide-react';
import { useState } from 'react';
import {
  type ContextUsage,
  cacheHitPercent,
  contextPercent,
  contextZone,
  formatTokens,
} from './context-usage';
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
  return (
    <div className="native-usage session-status">
      <span>
        {state.running
          ? state.inputs.length
            ? 'Waiting for you'
            : 'Working'
          : state.connected
            ? 'Ready'
            : 'Connecting'}
      </span>
      <button
        type="button"
        className={`context-meter context-${zone}`}
        disabled={!state.connected}
        onClick={() => setDetails(true)}
        aria-label={`${contextLabel(usage, percent)}. Open context details`}
        title="Context window use of the latest request. Open details, compaction and repair."
      >
        {zone === 'critical' ? <AlertTriangle size={12} /> : <Gauge size={12} />}
        <span className="context-meter-bar" aria-hidden="true">
          <span style={{ width: `${percent ?? 0}%` }} />
        </span>
        <span>{contextLabel(usage, percent)}</span>
      </button>
      {hit !== null && (
        <span
          title={`Latest request: ${usage.cacheRead.toLocaleString()} tokens read from the provider's cache, ${usage.cacheWrite.toLocaleString()} written`}
        >
          <Database size={11} /> Cache {hit}%
        </span>
      )}
      {!!state.memoryContext?.active.length && (
        <button
          type="button"
          title="Memories the memory injector keeps in this conversation's context. Open context details."
          onClick={() => setDetails(true)}
        >
          <Brain size={11} /> Memory {state.memoryContext.active.length}
        </button>
      )}
      {usage.decreasedFrom > 0 && (
        <span className="context-limit-warning" title="The provider rejected a larger request">
          Provider limit {formatTokens(usage.max)} (was {formatTokens(usage.decreasedFrom)})
        </span>
      )}
      {state.running && index !== null && (
        <span>
          <Repeat size={11} /> Iteration {index + 1}
          {limit ? ` of ${limit}` : ''}
        </span>
      )}
      <GitChip command={command} connected={state.connected} />
      {input !== null && <span>{formatTokens(input)} in</span>}
      {output !== null && <span>{formatTokens(output)} out</span>}
      {typeof estimate === 'number' && <span>Estimated ${estimate.toFixed(4)}</span>}
      <button
        type="button"
        title="Refresh engine usage"
        aria-label="Refresh engine usage"
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
function contextLabel(usage: ContextUsage, percent: number | null): string {
  if (percent !== null)
    return `Context ${percent}% · ${formatTokens(usage.tokens)} / ${formatTokens(usage.max)}`;
  if (usage.tokens) return `Context ${formatTokens(usage.tokens)} tokens · window not reported`;
  return 'Context';
}
