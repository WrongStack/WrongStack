import {
  Activity,
  Bot,
  Brain,
  ChevronDown,
  ChevronUp,
  FileCode2,
  FileDiff,
  Info,
  ListTree,
  RefreshCw,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { DesktopCodeAssist } from './DesktopCodeAssist';
import { DiffPreview } from './DiffPreview';
import type { EngineCommand, EngineSend } from './engine-operations';
import type { EngineState } from './engine-state';
import { entries, record } from './engine-values';
import { byteSize, fileLanguage } from './file-model';
import { fileMemories } from './sage-model';

export function FileEvidenceDrawer({
  path,
  content,
  saved,
  size,
  command,
  diff,
  refreshDiff,
  send,
  state,
}: {
  path: string;
  content: string;
  saved: string;
  size?: number;
  command: EngineCommand;
  diff: Record<string, unknown> | null;
  refreshDiff: () => void;
  send: EngineSend;
  state: EngineState;
}) {
  const [tab, setTab] = useState('overview'),
    [height, setHeight] = useState(220),
    [expanded, setExpanded] = useState(true),
    [data, setData] = useState<Record<string, unknown>>({}),
    [loading, setLoading] = useState(false),
    [error, setError] = useState(''),
    [revision, setRevision] = useState(0);
  const drag = useRef<{ y: number; height: number } | null>(null);
  useEffect(() => {
    let active = true;
    setData({});
    setError('');
    setLoading(false);
    if (tab === 'changes') refreshDiff();
    const query =
      tab === 'structure'
        ? ['files.skeleton', { filePath: path }, ['files.skeleton_result']]
        : tab === 'activity'
          ? [
              'chronicle.query',
              { query: { path, resourceKind: 'file', order: 'desc', limit: 60 } },
              ['chronicle.query_result', 'chronicle.error'],
            ]
          : tab === 'memory'
            ? [
                'memory.sage.forFile',
                { filePath: path, showSuperseded: true, limit: 50 },
                ['memory.sage.forFile'],
              ]
            : null;
    if (query) {
      setLoading(true);
      void command(query[0] as string, query[1] as Record<string, unknown>, query[2] as string[])
        .then((reply) => {
          if (active) {
            if (reply['message'] && tab === 'activity' && !reply['events'])
              throw new Error(String(reply['message']));
            setData(reply);
          }
        })
        .catch((error: unknown) => {
          if (active) setError(error instanceof Error ? error.message : String(error));
        })
        .finally(() => {
          if (active) setLoading(false);
        });
    }
    return () => {
      active = false;
    };
  }, [path, tab, revision, command, refreshDiff]);
  return (
    <section
      className="file-evidence-drawer"
      aria-label="File details panel"
      style={{ height: expanded ? height : 38 }}
    >
      <hr
        className="file-drawer-resize"
        aria-label="Resize file details"
        aria-orientation="horizontal"
        aria-valuenow={height}
        aria-valuemin={120}
        aria-valuemax={440}
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
            event.preventDefault();
            setHeight((h) =>
              Math.max(120, Math.min(440, h + (event.key === 'ArrowUp' ? 20 : -20))),
            );
          }
        }}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = { y: event.clientY, height };
          setExpanded(true);
        }}
        onPointerMove={(event) => {
          if (drag.current)
            setHeight(
              Math.max(120, Math.min(440, drag.current.height + drag.current.y - event.clientY)),
            );
        }}
        onPointerUp={() => {
          drag.current = null;
        }}
        onPointerCancel={() => {
          drag.current = null;
        }}
      />
      <header className="file-drawer-header">
        <nav aria-label="File details sections">
          {[
            { id: 'overview', title: 'Overview', Icon: Info },
            { id: 'changes', title: 'Changes', Icon: FileDiff },
            { id: 'structure', title: 'Structure', Icon: ListTree },
            { id: 'activity', title: 'Activity', Icon: Activity },
            { id: 'memory', title: 'Memory', Icon: Brain },
            { id: 'assist', title: 'Ask AI', Icon: Bot },
          ].map(({ id, title, Icon }) => (
            <button
              type="button"
              key={id}
              aria-current={tab === id ? 'page' : undefined}
              onClick={() => {
                setTab(id);
                setExpanded(true);
              }}
            >
              <Icon size={13} />
              {title}
            </button>
          ))}
        </nav>
        <button
          type="button"
          className="icon-button"
          aria-label="Refresh file evidence"
          onClick={() => setRevision((r) => r + 1)}
        >
          <RefreshCw size={13} />
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label={expanded ? 'Collapse file details' : 'Expand file details'}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
        </button>
      </header>
      {expanded && (
        <div className="file-drawer-content">
          {loading ? (
            <p className="file-quiet-state">Reading {tab} for this file…</p>
          ) : error ? (
            <p className="session-error" role="alert">
              {error}
            </p>
          ) : tab === 'assist' ? (
            <DesktopCodeAssist
              key={path}
              filePath={path}
              send={send}
              command={command}
              state={state}
              onEdited={refreshDiff}
            />
          ) : tab === 'overview' ? (
            <div className="file-overview-details">
              <div className="file-overview-path">
                <FileCode2 size={24} />
                <strong>{path}</strong>
                <small>
                  Project file · {content !== saved ? 'Unsaved changes' : 'Saved on disk'}
                </small>
              </div>
              <dl>
                <div>
                  <dt>Language</dt>
                  <dd>{fileLanguage(path)}</dd>
                </div>
                <div>
                  <dt>Size on disk</dt>
                  <dd>{size === undefined ? 'Not reported' : byteSize(size)}</dd>
                </div>
                <div>
                  <dt>Lines</dt>
                  <dd>{content.split('\n').length}</dd>
                </div>
                <div>
                  <dt>Encoding</dt>
                  <dd>UTF-8</dd>
                </div>
              </dl>
            </div>
          ) : tab === 'changes' ? (
            diff?.['binary'] || diff?.['tooLarge'] ? (
              <p className="file-quiet-state">
                {diff['binary']
                  ? 'Binary file — a text diff is unavailable.'
                  : 'File exceeds the diff preview limit.'}
              </p>
            ) : diff?.['error'] ? (
              <p className="session-error">{String(diff['error'])}</p>
            ) : diff ? (
              <DiffPreview before={String(diff['oldText'] ?? '')} after={content} path={path} />
            ) : (
              <p className="file-quiet-state">Reading repository changes…</p>
            )
          ) : tab === 'structure' ? (
            <div className="file-structure">
              <span>
                {String(data['lang'] ?? fileLanguage(path))} · extracted from the actual source
              </span>
              <pre>
                {String(data['skeleton'] ?? 'No structural outline was returned for this file.')}
              </pre>
            </div>
          ) : tab === 'memory' ? (
            <div className="file-related-memories">
              <p className="file-evidence-caption">
                SAGE knowledge anchored to this file, its symbols, or its containing directory.
              </p>
              {fileMemories(data).map((memory) => (
                <article key={String(memory['id'])}>
                  <span>
                    {String(memory['kind'])} ·{' '}
                    {String(memory['matchedVia'] ?? '').replaceAll('_', ' ')}
                  </span>
                  <p>{String(memory['text'])}</p>
                </article>
              ))}
              {!fileMemories(data).length && (
                <p className="file-quiet-state">No project memories match this file path.</p>
              )}
            </div>
          ) : (
            <div className="file-event-list">
              {entries(data['events']).map((event, index) => {
                const actor = record(event['actor']),
                  resource = record(event['resource']);
                return (
                  <article key={String(event['id'] ?? index)}>
                    <span className="file-event-dot" />
                    <div>
                      <strong>
                        {String(
                          event['summary'] ?? event['action'] ?? event['kind'] ?? 'File activity',
                        )}
                      </strong>
                      <p>
                        {String(
                          actor['name'] ?? actor['id'] ?? event['source'] ?? 'Project activity',
                        )}{' '}
                        · {String(resource['path'] ?? path)}
                      </p>
                    </div>
                    {typeof event['at'] === 'string' && (
                      <time>{new Date(event['at']).toLocaleString()}</time>
                    )}
                  </article>
                );
              })}
              {!entries(data['events']).length && (
                <p className="file-quiet-state">No recorded activity for this file.</p>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
