import type { ArchitectureDecision } from '@wrongstack/core/storage';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useAppTranslation } from '@/i18n';
import { invokePortableCommand } from '@/lib/portable-command-rpc';

type RevisionSummary = Pick<
  ArchitectureDecision,
  'revision' | 'status' | 'updatedAt' | 'contentHash' | 'proposedBy' | 'resolvedBy'
>;
interface HistoryPage {
  projectId: string;
  decisionId: string;
  records: RevisionSummary[];
  nextBeforeRevision: number | null;
}

/** Historical records remain separate from the panel's current review target. */
export function ArchitectureDecisionHistory({
  record,
  sessionId,
}: {
  record: ArchitectureDecision;
  sessionId: string;
}) {
  const { t } = useAppTranslation();
  const [open, setOpen] = useState(false);
  const [records, setRecords] = useState<RevisionSummary[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [snapshot, setSnapshot] = useState<ArchitectureDecision | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const epoch = useRef(0);
  const listSequence = useRef(0);
  const detailSequence = useRef(0);
  const requests = useRef(new Set<AbortController>());
  useEffect(() => {
    epoch.current++;
    setOpen(false);
    setRecords([]);
    setNext(null);
    setSnapshot(null);
    setError('');
    setLoading(false);
    setDetailLoading(false);
    return () => {
      epoch.current++;
      for (const request of requests.current) request.abort();
    };
  }, [record.id, record.projectId, record.revision, sessionId]);
  const rpc = useCallback(
    async (args: string) => {
      const controller = new AbortController();
      requests.current.add(controller);
      try {
        const result = await invokePortableCommand('adr', args, {
          sessionId,
          signal: controller.signal,
        });
        if (result.error) throw new Error(result.error);
        return result.message ?? '';
      } finally {
        requests.current.delete(controller);
      }
    },
    [sessionId],
  );

  const load = async (before?: number) => {
    const generation = epoch.current;
    const sequence = ++listSequence.current;
    setLoading(true);
    setError('');
    try {
      const page = JSON.parse(
        await rpc(`history-json ${record.id}${before === undefined ? '' : ` ${before}`}`),
      ) as HistoryPage;
      if (generation !== epoch.current || sequence !== listSequence.current) return;
      if (
        page.projectId !== record.projectId ||
        page.decisionId !== record.id ||
        !Array.isArray(page.records)
      )
        throw new Error(t('activity:adr.history.mismatch'));
      setRecords((old) => (before === undefined ? page.records : [...old, ...page.records]));
      setNext(page.nextBeforeRevision);
    } catch (err) {
      if (generation === epoch.current && sequence === listSequence.current) setError(String(err));
    } finally {
      if (generation === epoch.current && sequence === listSequence.current) setLoading(false);
    }
  };
  const inspect = async (revision: number) => {
    const generation = epoch.current;
    const sequence = ++detailSequence.current;
    setSnapshot(null);
    setDetailLoading(true);
    setError('');
    try {
      const historical = JSON.parse(
        await rpc(`revision-json ${record.id} ${revision}`),
      ) as ArchitectureDecision;
      if (generation !== epoch.current || sequence !== detailSequence.current) return;
      if (
        historical.projectId !== record.projectId ||
        historical.id !== record.id ||
        historical.revision !== revision
      )
        throw new Error(t('activity:adr.history.mismatch'));
      setSnapshot(historical);
    } catch (err) {
      if (generation === epoch.current && sequence === detailSequence.current)
        setError(String(err));
    } finally {
      if (generation === epoch.current && sequence === detailSequence.current)
        setDetailLoading(false);
    }
  };
  const button =
    'rounded-md border border-border px-3 py-2 text-xs hover:bg-muted disabled:opacity-50';
  return (
    <div className="space-y-2 border-t border-border pt-3">
      <button
        type="button"
        className={button}
        aria-expanded={open}
        onClick={() => {
          setOpen(!open);
          if (!open) void load();
        }}
      >
        {t('activity:adr.history.title')}
      </button>
      {open && (
        <div className="space-y-3">
          <button type="button" className={button} disabled={loading} onClick={() => void load()}>
            {t('activity:adr.history.refresh')}
          </button>
          {error && (
            <p role="alert" className="break-words text-sm text-destructive">
              {error}
            </p>
          )}
          {(loading || detailLoading) && (
            <p role="status" className="text-xs">
              {t('activity:adr.history.loading')}
            </p>
          )}
          <ul className="space-y-1">
            {records.map((entry) => (
              <li key={entry.revision}>
                <button
                  type="button"
                  className={`${button} w-full text-left`}
                  aria-pressed={snapshot?.revision === entry.revision}
                  onClick={() => void inspect(entry.revision)}
                >
                  {t('activity:adr.history.revision', { revision: entry.revision })} ·{' '}
                  {t(`activity:adr.status.${entry.status}`)}
                  <span className="block break-words text-muted-foreground">
                    {entry.updatedAt} · {entry.resolvedBy ?? entry.proposedBy}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {next !== null && (
            <button
              type="button"
              className={button}
              disabled={loading}
              onClick={() => void load(next)}
            >
              {t('activity:adr.history.more')}
            </button>
          )}
          {snapshot && (
            <section
              aria-label={t('activity:adr.history.snapshot')}
              className="space-y-2 rounded-md border border-border p-3 text-sm"
            >
              <h4 className="font-semibold">
                {t('activity:adr.history.revision', { revision: snapshot.revision })} ·{' '}
                {snapshot.title} · {t(`activity:adr.status.${snapshot.status}`)}
              </h4>
              <p className="text-xs text-muted-foreground">{t('activity:adr.history.readonly')}</p>
              <p className="break-all text-xs">{snapshot.contentHash}</p>
              {(
                [
                  'context',
                  'decision',
                  'alternatives',
                  'consequences',
                  'constraints',
                  'scope',
                  'revisitWhen',
                ] as const
              ).map((field) => (
                <div key={field}>
                  <h5 className="text-xs font-semibold">{t(`activity:adr.fields.${field}`)}</h5>
                  <p className="whitespace-pre-wrap break-words">
                    {Array.isArray(snapshot[field])
                      ? snapshot[field].join('\n') || '—'
                      : snapshot[field] || '—'}
                  </p>
                </div>
              ))}
              {!!snapshot.checks?.length && (
                <div>
                  <h5 className="text-xs font-semibold">{t('activity:adr.checks.title')}</h5>
                  <pre className="whitespace-pre-wrap break-words text-xs">
                    {JSON.stringify(snapshot.checks, null, 2)}
                  </pre>
                </div>
              )}
              {snapshot.supersedes && (
                <p className="break-all text-xs">
                  {t('activity:adr.fields.supersedes')}: {snapshot.supersedes}
                </p>
              )}
              {snapshot.supersededBy && (
                <p className="break-all text-xs">
                  {t('activity:adr.supersededBy')}: {snapshot.supersededBy}
                </p>
              )}
              <p className="break-words text-xs">
                {t('activity:adr.history.proposedBy')}: {snapshot.proposedBy}
              </p>
              {snapshot.resolvedBy && (
                <p className="break-words text-xs">
                  {t('activity:adr.reviewedBy')}: {snapshot.resolvedBy} ·{' '}
                  {snapshot.resolutionReason}
                </p>
              )}
            </section>
          )}
        </div>
      )}
    </div>
  );
}
