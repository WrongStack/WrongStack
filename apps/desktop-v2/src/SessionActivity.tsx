import {
  Activity,
  Brain,
  CheckCircle2,
  Clock3,
  FileCode2,
  LoaderCircle,
  RotateCw,
  Wrench,
  XCircle,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import type { EngineEvent } from './engine-state';
import { activityRows } from './session-activity-model';
import { StructuredToolValue } from './ToolApprovalCard';
import { ToolInputView } from './ToolInputView';
import './session-activity.css';

function readableOutput(value: string): unknown {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']'))
  ) {
    try {
      return JSON.parse(trimmed) as unknown;
    } catch {
      /* Plain text remains unchanged. */
    }
  }
  return value;
}
export function SessionActivity({
  events,
  onOpenFile,
  compact = false,
}: {
  events: readonly EngineEvent[];
  onOpenFile: (path: string) => void;
  compact?: boolean;
}) {
  const [filter, setFilter] = useState<'all' | 'tool' | 'reasoning' | 'run'>('all');
  const rows = useMemo(() => activityRows(events), [events]);
  const shown = rows.filter(
    (row) => filter === 'all' || row.kind === filter || (filter === 'run' && row.kind === 'retry'),
  );
  return (
    <section
      className={`session-activity ${compact ? 'session-activity-compact' : ''}`}
      aria-label={compact ? 'Current run activity' : 'Conversation activity'}
    >
      {!compact && (
        <header className="session-activity-header">
          <div>
            <span className="eyebrow">THIS CONVERSATION</span>
            <h2>Run activity</h2>
            <p>Follow tool calls, reasoning and execution results for this session.</p>
          </div>
          <nav aria-label="Activity filters">
            {(['all', 'tool', 'reasoning', 'run'] as const).map((kind) => (
              <button
                type="button"
                key={kind}
                aria-pressed={filter === kind}
                onClick={() => setFilter(kind)}
              >
                {kind === 'all'
                  ? 'All'
                  : kind === 'tool'
                    ? 'Tools'
                    : kind === 'reasoning'
                      ? 'Thinking'
                      : 'Runs'}
              </button>
            ))}
          </nav>
        </header>
      )}
      {!shown.length && (
        <p className="quiet-state">
          {rows.length
            ? 'No activity matches this filter.'
            : 'Tool calls and run events appear here as the agent works.'}
        </p>
      )}
      <div className="activity-list">
        {shown.map((row) => (
          <details key={row.id} className={`activity-entry activity-${row.status}`}>
            <summary>
              <span className="activity-entry-icon">
                {row.kind === 'tool' ? (
                  <Wrench size={15} />
                ) : row.kind === 'reasoning' ? (
                  <Brain size={15} />
                ) : row.kind === 'retry' ? (
                  <RotateCw size={15} />
                ) : (
                  <Activity size={15} />
                )}
              </span>
              <span className="activity-entry-label">
                <strong>{row.title}</strong>
                <small>
                  {row.agent ? `${row.agent} · ` : ''}
                  {row.status === 'running'
                    ? 'In progress'
                    : row.status === 'done'
                      ? 'Completed'
                      : row.status === 'failed'
                        ? 'Failed'
                        : row.status === 'aborted'
                          ? 'Stopped'
                          : row.kind === 'retry'
                            ? 'Retrying'
                            : 'Recorded'}
                </small>
              </span>
              {row.durationMs !== undefined && (
                <small className="activity-metric">
                  <Clock3 size={12} />{' '}
                  {row.kind === 'retry' ? `wait ${row.durationMs} ms` : `${row.durationMs} ms`}
                </small>
              )}
              {row.outputBytes !== undefined && (
                <small className="activity-metric">{row.outputBytes.toLocaleString()} bytes</small>
              )}
              {row.status === 'running' ? (
                <LoaderCircle size={14} className="spin" />
              ) : row.status === 'failed' ? (
                <XCircle size={14} />
              ) : row.status === 'done' ? (
                <CheckCircle2 size={14} />
              ) : null}
            </summary>
            <div className="activity-entry-body">
              {row.input !== undefined && (
                <section className="approval-arguments" aria-label="Tool input">
                  <strong>Input</strong>
                  {row.kind === 'tool' ? (
                    <ToolInputView name={row.title} input={row.input} />
                  ) : (
                    <StructuredToolValue value={row.input} />
                  )}
                </section>
              )}
              {row.progress.length > 0 && (
                <section>
                  <h4>Progress</h4>
                  {row.progress.map((text, i) => (
                    <pre key={i}>{text}</pre>
                  ))}
                </section>
              )}
              {row.output && (
                <section>
                  <h4>
                    {row.kind === 'reasoning'
                      ? 'Thinking'
                      : row.kind === 'retry'
                        ? 'Retry details'
                        : row.outputBytes !== undefined &&
                            row.outputBytes > new TextEncoder().encode(row.output).length
                          ? 'Output preview'
                          : 'Output'}
                  </h4>
                  <div className="approval-arguments">
                    <StructuredToolValue value={readableOutput(row.output)} />
                  </div>
                </section>
              )}
              {row.files.length > 0 && (
                <section>
                  <h4>Files</h4>
                  <div className="activity-files">
                    {row.files.map((file) => (
                      <button type="button" key={file.path} onClick={() => onOpenFile(file.path)}>
                        <FileCode2 size={13} />
                        <span>{file.path}</span>
                        <small>{file.operation}</small>
                      </button>
                    ))}
                  </div>
                </section>
              )}
              {row.sage.length > 0 && (
                <section>
                  <h4>SAGE evidence</h4>
                  <ul>
                    {row.sage.map((memory, i) => (
                      <li key={i}>{memory}</li>
                    ))}
                  </ul>
                </section>
              )}
              {!row.input &&
                !row.output &&
                !row.progress.length &&
                !row.files.length &&
                !row.sage.length && <p>No additional details were reported.</p>}
            </div>
          </details>
        ))}
      </div>
    </section>
  );
}
