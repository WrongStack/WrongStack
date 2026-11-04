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
import { useDesktopText } from './desktop-i18n';
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
  const { t } = useDesktopText();
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
      aria-label={t('evidence.label')}
      style={{ height: expanded ? height : 38 }}
    >
      <hr
        className="file-drawer-resize"
        aria-label={t('evidence.resize')}
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
        <nav aria-label={t('evidence.sections')}>
          {[
            { id: 'overview', Icon: Info },
            { id: 'changes', Icon: FileDiff },
            { id: 'structure', Icon: ListTree },
            { id: 'activity', Icon: Activity },
            { id: 'memory', Icon: Brain },
            { id: 'assist', Icon: Bot },
          ].map(({ id, Icon }) => (
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
              {t(`evidence.tab.${id}`)}
            </button>
          ))}
        </nav>
        <button
          type="button"
          className="icon-button"
          aria-label={t('evidence.refresh')}
          onClick={() => setRevision((r) => r + 1)}
        >
          <RefreshCw size={13} />
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label={expanded ? t('evidence.collapse') : t('evidence.expand')}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
        </button>
      </header>
      {expanded && (
        <div className="file-drawer-content">
          {loading ? (
            <p className="file-quiet-state">{t(`evidence.reading.${tab}`)}</p>
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
                  {t('evidence.projectFile')} ·{' '}
                  {content !== saved ? t('evidence.unsaved') : t('evidence.saved')}
                </small>
              </div>
              <dl>
                <div>
                  <dt>{t('evidence.language')}</dt>
                  <dd>{fileLanguage(path)}</dd>
                </div>
                <div>
                  <dt>{t('evidence.size')}</dt>
                  <dd>{size === undefined ? t('evidence.notReported') : byteSize(size)}</dd>
                </div>
                <div>
                  <dt>{t('evidence.lines')}</dt>
                  <dd>{content.split('\n').length}</dd>
                </div>
                <div>
                  <dt>{t('evidence.encoding')}</dt>
                  <dd>UTF-8</dd>
                </div>
              </dl>
            </div>
          ) : tab === 'changes' ? (
            diff?.['binary'] || diff?.['tooLarge'] ? (
              <p className="file-quiet-state">
                {diff['binary'] ? t('evidence.binary') : t('evidence.tooLarge')}
              </p>
            ) : diff?.['error'] ? (
              <p className="session-error">{String(diff['error'])}</p>
            ) : diff ? (
              <DiffPreview before={String(diff['oldText'] ?? '')} after={content} path={path} />
            ) : (
              <p className="file-quiet-state">{t('evidence.readingChanges')}</p>
            )
          ) : tab === 'structure' ? (
            <div className="file-structure">
              <span>
                {t('evidence.extracted', { lang: String(data['lang'] ?? fileLanguage(path)) })}
              </span>
              <pre>{String(data['skeleton'] ?? t('evidence.noOutline'))}</pre>
            </div>
          ) : tab === 'memory' ? (
            <div className="file-related-memories">
              <p className="file-evidence-caption">{t('evidence.memoryCaption')}</p>
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
                <p className="file-quiet-state">{t('evidence.noMemory')}</p>
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
                          event['summary'] ??
                            event['action'] ??
                            event['kind'] ??
                            t('evidence.fileActivity'),
                        )}
                      </strong>
                      <p>
                        {String(
                          actor['name'] ??
                            actor['id'] ??
                            event['source'] ??
                            t('evidence.projectActivity'),
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
                <p className="file-quiet-state">{t('evidence.noActivity')}</p>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
