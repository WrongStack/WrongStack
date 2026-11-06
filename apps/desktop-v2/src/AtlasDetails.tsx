import { Activity, ArrowRight, Brain, FileCode2, ShieldCheck, Users } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useDesktopText } from './desktop-i18n';
import { displayDateTime } from './display-dates';
import type { EngineCommand } from './engine-operations';
import { entries, record, sentenceStart } from './engine-values';
import { fileName } from './file-model';
import type { VisualNode } from './graph-model';
import { fileMemories } from './sage-model';

export function AtlasNodeEvidence({
  node,
  command,
  onOpenMemory,
  onOpenFile,
}: {
  node: VisualNode;
  command: EngineCommand;
  onOpenMemory?: (id: string) => void;
  onOpenFile?: (path: string) => void;
}) {
  const { t, i18n } = useDesktopText();
  const kindLabel = (value: unknown) =>
    typeof value === 'string' && value
      ? t(`atlasDetails.kind_${value}`, { defaultValue: sentenceStart(value, i18n.language) })
      : undefined;
  const [memoryData, setMemoryData] = useState<Record<string, unknown>[]>([]),
    [events, setEvents] = useState<Record<string, unknown>[]>([]),
    [error, setError] = useState(''),
    [activityOpen, setActivityOpen] = useState(false),
    [loading, setLoading] = useState(false);
  const file = typeof node.data['file'] === 'string' ? node.data['file'] : '';
  useEffect(() => {
    let current = true;
    setMemoryData([]);
    setEvents([]);
    setError('');
    if (file)
      void command('memory.sage.forFile', { filePath: file, limit: 30, showSuperseded: false }, [
        'memory.sage.forFile',
      ])
        .then((result) => {
          if (current) setMemoryData(fileMemories(result));
        })
        .catch((error: unknown) => {
          if (current) setError(error instanceof Error ? error.message : String(error));
        });
    return () => {
      current = false;
    };
  }, [file, command]);
  useEffect(() => {
    if (!file || !activityOpen) return;
    let current = true;
    setLoading(true);
    void command(
      'chronicle.query',
      { query: { path: file, resourceKind: 'file', order: 'desc', limit: 50 } },
      ['chronicle.query_result', 'chronicle.error'],
    )
      .then((result) => {
        if (current) {
          if (!result['events'] && result['message']) throw new Error(String(result['message']));
          setEvents(entries(result['events']));
        }
      })
      .catch((e: unknown) => {
        if (current) setError(String(e));
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [file, activityOpen, command]);
  const memories = memoryData.length ? memoryData : entries(node.data['memories']);
  return (
    <div className="atlas-node-evidence">
      {typeof node.data['signature'] === 'string' && (
        <pre className="atlas-symbol-signature">
          <code>{node.data['signature']}</code>
        </pre>
      )}
      <dl className="atlas-node-facts">
        {[
          [t('atlasDetails.kind'), kindLabel(node.data['symbolKind'] ?? node.data['kind'])],
          [t('atlasDetails.subsystem'), node.data['subsystem']],
          [t('atlasDetails.language'), node.data['lang']],
          [t('atlasDetails.scope'), node.data['scope']],
          [
            t('atlasDetails.external'),
            node.data['external'] === true ? t('atlasDetails.yes') : undefined,
          ],
          [
            t('atlasDetails.declaration'),
            typeof node.data['line'] === 'number'
              ? t('atlasDetails.line', { line: node.data['line'] })
              : undefined,
          ],
          [
            t('atlasDetails.conceptSource'),
            record(node.data['crux'])['start']
              ? t('atlasDetails.lines', {
                  start: String(record(node.data['crux'])['start']),
                  end: String(record(node.data['crux'])['end']),
                })
              : undefined,
          ],
          [
            t('atlasDetails.lastModified'),
            typeof node.data['lastModifiedMs'] === 'number'
              ? displayDateTime(node.data['lastModifiedMs'])
              : undefined,
          ],
        ].map(([label, value]) =>
          value !== undefined ? (
            <div key={String(label)}>
              <dt>{String(label)}</dt>
              <dd>{String(value)}</dd>
            </div>
          ) : null,
        )}
      </dl>
      {typeof node.data['rank'] === 'number' && (
        <section className="atlas-centrality">
          <header>
            <strong>{t('atlasDetails.centrality')}</strong>
            <span>{Math.round(node.data['rank'] * 100)}%</span>
          </header>
          <progress aria-label={t('atlasDetails.centrality')} value={node.data['rank']} max={1} />
          <p>{t('atlasDetails.pageRank')}</p>
        </section>
      )}
      {Boolean(node.data['lockOwner'] || node.data['thrashingCount']) && (
        <section className="atlas-trace-alert">
          <h3>
            <ShieldCheck size={13} />
            {t('atlasDetails.trace')}
          </h3>
          {typeof node.data['lockOwner'] === 'string' && (
            <p>{t('atlasDetails.lock', { owner: node.data['lockOwner'] })}</p>
          )}
          {typeof node.data['thrashingCount'] === 'number' && (
            <p>{t('atlasDetails.thrashing', { number: node.data['thrashingCount'] })}</p>
          )}
        </section>
      )}
      {file && onOpenFile && (
        <button type="button" className="button secondary full" onClick={() => onOpenFile(file)}>
          <FileCode2 size={13} />
          {t('atlasDetails.openFile')}
          <ArrowRight size={12} />
        </button>
      )}
      <section className="atlas-institutional-memory">
        <h3>
          <Brain size={14} />
          {t('atlasDetails.sage')} {memories.length > 0 && <span>{memories.length}</span>}
        </h3>
        {memories.map((memory) => (
          <button
            type="button"
            key={String(memory['id'])}
            onClick={() => onOpenMemory?.(String(memory['id']))}
          >
            <span>{String(memory['kind']).replaceAll('_', ' ')}</span>
            <p>{String(memory['text'])}</p>
            {typeof memory['matchedVia'] === 'string' && (
              <small>{memory['matchedVia'].replaceAll('_', ' ')}</small>
            )}
          </button>
        ))}
        {!memories.length && <p>{t('atlasDetails.noSage')}</p>}
      </section>
      {file && (
        <section className="atlas-file-history">
          <button
            type="button"
            className="atlas-history-toggle"
            aria-expanded={activityOpen}
            onClick={() => setActivityOpen(!activityOpen)}
          >
            <Activity size={14} />
            {t('atlasDetails.history')}
            <span>{activityOpen ? '−' : '+'}</span>
          </button>
          {activityOpen &&
            (loading ? (
              <p>{t('atlasDetails.readingJournal')}</p>
            ) : (
              <div>
                {events.map((event, index) => (
                  <article key={String(event['id'] ?? index)}>
                    <strong>
                      {String(
                        event['summary'] ??
                          event['action'] ??
                          event['kind'] ??
                          t('atlasDetails.fileActivity'),
                      )}
                    </strong>
                    <span>
                      <Users size={11} />
                      {String(
                        record(event['actor'])['name'] ??
                          record(event['actor'])['id'] ??
                          event['source'] ??
                          t('atlasDetails.journal'),
                      )}
                    </span>
                    {typeof event['at'] === 'string' && <time>{displayDateTime(event['at'])}</time>}
                  </article>
                ))}
                {!events.length && <p>{t('atlasDetails.noActivity', { file: fileName(file) })}</p>}
              </div>
            ))}
        </section>
      )}
      {error && (
        <p className="atlas-detail-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
