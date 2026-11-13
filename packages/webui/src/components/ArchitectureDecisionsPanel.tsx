import type {
  ArchitectureDecision,
  ArchitectureDecisionCompliance,
  ArchitectureDecisionContent,
} from '@wrongstack/core/storage';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useArchitectureDecisionInbox } from '@/hooks/useArchitectureDecisionInbox';
import { useAppTranslation } from '@/i18n';
import { invokePortableCommand } from '@/lib/portable-command-rpc';
import { useSessionStore } from '@/stores';
import { ArchitectureDecisionChecksEditor } from './ArchitectureDecisionChecksEditor';
import { ArchitectureDecisionHistory } from './ArchitectureDecisionHistory';

type Summary = Pick<
  ArchitectureDecision,
  'id' | 'title' | 'status' | 'revision' | 'contentHash' | 'updatedAt'
>;
interface Page {
  records: Summary[];
  total: number;
  nextOffset: number | null;
}

export function ArchitectureDecisionsPanel({ sessionId }: { sessionId: string }) {
  const { t } = useAppTranslation();
  const projectRoot = useSessionStore((state) => state.projectRoot);
  const inbox = useArchitectureDecisionInbox(sessionId);
  const [records, setRecords] = useState<Summary[]>([]);
  const [selected, setSelected] = useState<ArchitectureDecision | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [total, setTotal] = useState(0);
  const [notice, setNotice] = useState('');
  const [form, setForm] = useState<ArchitectureDecisionContent | null>(null);
  const [editing, setEditing] = useState<ArchitectureDecision | null>(null);
  const [checkReport, setCheckReport] = useState<ArchitectureDecisionCompliance | null>(null);
  const epoch = useRef(0);
  const listSequence = useRef(0);
  const detailSequence = useRef(0);
  const importInput = useRef<HTMLInputElement>(null);

  const rpc = useCallback(
    async (args: string) => {
      const result = await invokePortableCommand('adr', args, { sessionId });
      if (result.error) throw new Error(result.error);
      return result.message ?? '';
    },
    [sessionId],
  );

  const refresh = useCallback(
    async (offset = 0, automatic = false) => {
      const generation = epoch.current;
      const sequence = ++listSequence.current;
      try {
        const page = JSON.parse(await rpc(`list-json ${offset}`)) as Page;
        if (generation !== epoch.current || sequence !== listSequence.current) return;
        setRecords((old) => (offset ? [...old, ...page.records] : page.records));
        setNextOffset(page.nextOffset);
        setTotal(page.total);
        if (!automatic) setError('');
      } catch (err) {
        if (generation === epoch.current && sequence === listSequence.current)
          setError(String(err));
      } finally {
        if (generation === epoch.current && sequence === listSequence.current) setLoading(false);
      }
    },
    [rpc],
  );

  useEffect(() => {
    epoch.current++;
    setRecords([]);
    setCheckReport(null);
    setSelected(null);
    setForm(null);
    setEditing(null);
    setReason('');
    setNotice('');
    setError('');
    setBusy(false);
    setLoading(true);
    void refresh();
    return () => {
      epoch.current++;
    };
  }, [projectRoot, refresh]);

  useEffect(() => {
    if (inbox.summary?.version) void refresh(0, true);
  }, [inbox.summary?.version, refresh]);

  const show = async (id: string) => {
    setCheckReport(null);
    const generation = epoch.current;
    const sequence = ++detailSequence.current;
    setSelected(null);
    setReason('');
    setForm(null);
    setError('');
    setNotice('');
    try {
      const record = JSON.parse(await rpc(`show-json ${id}`)) as ArchitectureDecision;
      if (generation === epoch.current && sequence === detailSequence.current) setSelected(record);
    } catch (err) {
      if (generation === epoch.current && sequence === detailSequence.current)
        setError(String(err));
    }
  };

  const review = async (action: 'accept' | 'reject' | 'deprecate') => {
    if (!selected || !reason.trim() || busy || selectedStale) return;
    const generation = epoch.current;
    setBusy(true);
    setError('');
    try {
      await rpc(
        `review ${JSON.stringify({ projectId: selected.projectId, id: selected.id, revision: selected.revision, contentHash: selected.contentHash, action, reason: reason.trim() })}`,
      );
      if (generation !== epoch.current) return;
      setSelected(null);
      setReason('');
      setNotice(t('activity:adr.saved'));
      inbox.refresh();
      await refresh();
    } catch (err) {
      if (generation === epoch.current) setError(String(err));
    } finally {
      if (generation === epoch.current) setBusy(false);
    }
  };

  const save = async () => {
    if (!form || busy) return;
    const generation = epoch.current;
    setBusy(true);
    setError('');
    try {
      const proposal = {
        ...form,
        alternatives: form.alternatives.map((value) => value.trim()).filter(Boolean),
        consequences: form.consequences.map((value) => value.trim()).filter(Boolean),
        constraints: form.constraints.map((value) => value.trim()).filter(Boolean),
        scope: form.scope.map((value) => value.trim()).filter(Boolean),
      };
      await rpc(
        editing
          ? `revise ${JSON.stringify({ id: editing.id, revision: editing.revision, contentHash: editing.contentHash, proposal })}`
          : `propose ${JSON.stringify(proposal)}`,
      );
      if (generation !== epoch.current) return;
      setForm(null);
      setEditing(null);
      setSelected(null);
      setNotice(t('activity:adr.proposed'));
      inbox.refresh();
      await refresh();
    } catch (err) {
      if (generation === epoch.current) setError(String(err));
    } finally {
      if (generation === epoch.current) setBusy(false);
    }
  };

  const runChecks = async () => {
    if (!selected || busy) return;
    const generation = epoch.current;
    const detail = detailSequence.current;
    setBusy(true);
    setCheckReport(null);
    setError('');
    try {
      const report = JSON.parse(
        await rpc(`check-json ${selected.id}`),
      ) as ArchitectureDecisionCompliance;
      if (generation === epoch.current && detail === detailSequence.current) setCheckReport(report);
    } catch (err) {
      if (generation === epoch.current) setError(String(err));
    } finally {
      if (generation === epoch.current) setBusy(false);
    }
  };

  const downloadDecision = async (format: 'markdown' | 'json') => {
    if (!selected) return;
    const generation = epoch.current;
    try {
      const text = await rpc(`${format === 'json' ? 'export-json' : 'export'} ${selected.id}`);
      if (generation !== epoch.current) return;
      const url = URL.createObjectURL(
        new Blob([text], {
          type: `${format === 'json' ? 'application/json' : 'text/markdown'};charset=utf-8`,
        }),
      );
      const link = document.createElement('a');
      link.href = url;
      link.download = `${selected.id}.${format === 'json' ? 'adr.json' : 'md'}`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (err) {
      if (generation === epoch.current) setError(String(err));
    }
  };

  const previewImport = async (file: File) => {
    if (busy || form) return;
    const generation = epoch.current;
    detailSequence.current++;
    setBusy(true);
    setError('');
    try {
      // The engine also enforces its own byte/character and content limits.
      if (file.size > 128 * 1024) throw new Error(t('activity:adr.importTooLarge'));
      const bytes = await file.arrayBuffer();
      if (generation !== epoch.current) return;
      if (bytes.byteLength > 128 * 1024) throw new Error(t('activity:adr.importTooLarge'));
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      const proposal = JSON.parse(
        await rpc(`preview-import ${text}`),
      ) as ArchitectureDecisionContent;
      if (generation !== epoch.current) return;
      setForm(proposal);
      setEditing(null);
      setSelected(null);
      setReason('');
      setCheckReport(null);
      setNotice(t('activity:adr.importPreview'));
    } catch (err) {
      if (generation === epoch.current) setError(String(err));
    } finally {
      if (generation === epoch.current) setBusy(false);
    }
  };

  const button =
    'rounded-md border border-border px-3 py-2 text-xs hover:bg-muted disabled:opacity-50';
  const input = 'w-full rounded-md border border-border bg-background px-3 py-2 text-sm';
  const currentSummary = selected ? records.find((record) => record.id === selected.id) : undefined;
  const selectedStale =
    !!selected &&
    !!currentSummary &&
    (selected.revision !== currentSummary.revision ||
      selected.contentHash !== currentSummary.contentHash);
  const openDecisionDraft = (record: ArchitectureDecision, replacement = false) => {
    setEditing(replacement ? null : record);
    setNotice(replacement ? t('activity:adr.replacementHint') : '');
    setForm({
      title: record.title,
      context: record.context,
      decision: record.decision,
      alternatives: record.alternatives,
      consequences: record.consequences,
      constraints: record.constraints,
      scope: record.scope,
      revisitWhen: record.revisitWhen,
      ...(record.checks?.length ? { checks: record.checks } : {}),
      ...((replacement ? record.id : record.supersedes)
        ? { supersedes: replacement ? record.id : record.supersedes }
        : {}),
    });
  };
  const newProposal = () => {
    setEditing(null);
    setSelected(null);
    setNotice('');
    setForm({
      title: '',
      context: '',
      decision: '',
      alternatives: [],
      consequences: [],
      constraints: [],
      scope: [],
      revisitWhen: '',
    });
  };
  return (
    <section className="space-y-4" aria-label={t('activity:adr.title')}>
      <p className="text-xs text-muted-foreground">{t('activity:adr.description')}</p>
      {inbox.summary && inbox.summary.pending > 0 && (
        <p className="text-xs font-medium">
          {t('activity:adr.pendingCount', { count: inbox.summary.pending })}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className={button}
          disabled={busy || loading}
          onClick={() => {
            setLoading(true);
            void refresh();
          }}
        >
          {t('activity:adr.refresh')}
        </button>
        <button type="button" className={button} disabled={busy} onClick={newProposal}>
          {t('activity:adr.new')}
        </button>
        <button
          type="button"
          className={button}
          disabled={busy || !!form}
          onClick={() => importInput.current?.click()}
        >
          {t('activity:adr.import')}
        </button>
        <input
          ref={importInput}
          type="file"
          hidden
          accept="application/json,.json"
          disabled={busy || !!form}
          aria-label={t('activity:adr.importFile')}
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (file) void previewImport(file);
          }}
        />
        <span className="self-center text-xs text-muted-foreground">
          {t('activity:adr.count', { count: total })}
        </span>
      </div>
      {error && (
        <p role="alert" className="break-words text-sm text-destructive">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="text-sm">
          {notice}
        </p>
      )}
      {loading && (
        <p role="status" className="text-xs">
          {t('activity:adr.loading')}
        </p>
      )}
      {!loading && records.length === 0 && (
        <p className="text-sm text-muted-foreground">{t('activity:adr.empty')}</p>
      )}
      <ul className="space-y-2">
        {records.map((record) => (
          <li key={record.id}>
            <button
              type="button"
              disabled={busy}
              onClick={() => void show(record.id)}
              aria-pressed={selected?.id === record.id}
              className="w-full rounded-lg border border-border p-3 text-left hover:bg-muted disabled:opacity-50"
            >
              <span className="block text-sm font-medium">{record.title}</span>
              <span className="text-xs text-muted-foreground">
                {t(`activity:adr.status.${record.status}`)} · r{record.revision}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {nextOffset !== null && (
        <button
          type="button"
          className={button}
          disabled={busy}
          onClick={() => void refresh(nextOffset)}
        >
          {t('activity:adr.more')}
        </button>
      )}
      {selected && (
        <article className="space-y-3 rounded-lg border border-border p-4">
          <h3 className="text-base font-semibold">{selected.title}</h3>
          {selectedStale && (
            <div role="status" className="space-y-2 text-sm">
              <p>{t('activity:adr.staleReview')}</p>
              <button
                type="button"
                className={button}
                disabled={busy}
                onClick={() => void show(selected.id)}
              >
                {t('activity:adr.reloadDecision')}
              </button>
            </div>
          )}
          <p className="break-all text-xs text-muted-foreground">
            {selected.id} · r{selected.revision} · {t(`activity:adr.status.${selected.status}`)}
          </p>
          <p className="text-xs text-muted-foreground">{t('activity:adr.notVerification')}</p>
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
          ).map((key) => (
            <div key={key}>
              <h4 className="text-xs font-semibold">{t(`activity:adr.fields.${key}`)}</h4>
              <p className="whitespace-pre-wrap break-words text-sm">
                {Array.isArray(selected[key])
                  ? selected[key].join('\n') || '—'
                  : selected[key] || '—'}
              </p>
            </div>
          ))}
          {selected.supersedes && (
            <p className="break-all text-xs">
              {t('activity:adr.fields.supersedes')}: {selected.supersedes}
            </p>
          )}
          {!!selected.checks?.length && (
            <div className="space-y-1 text-xs">
              <h4 className="font-semibold">{t('activity:adr.checks.title')}</h4>
              {selected.checks.map((check) => (
                <p className="break-words" key={check.id}>
                  {check.id}: {t(`activity:adr.checks.kinds.${check.kind}`)} · {check.path}
                  {'text' in check
                    ? ` · ${check.text}`
                    : check.kind === 'json_equals'
                      ? ` · ${check.pointer} = ${JSON.stringify(check.value)}`
                      : ''}
                </p>
              ))}
            </div>
          )}
          {selected.status === 'accepted' && (
            <button
              type="button"
              className={button}
              disabled={busy}
              onClick={() => void runChecks()}
            >
              {t('activity:adr.checks.run')}
            </button>
          )}
          {checkReport && (
            <div role="status" className="space-y-1 rounded-md border border-border p-3 text-xs">
              <p className="font-semibold">
                {t('activity:adr.checks.result')}:{' '}
                {t(`activity:adr.checks.status.${checkReport.status}`)}
              </p>
              <p>{checkReport.checkedAt}</p>
              {checkReport.results.map((result, index) => (
                <p key={index} className="break-words">
                  {result.checkId} · {result.path} ·{' '}
                  {t(`activity:adr.checks.status.${result.status}`)}
                  {result.message && (
                    <span className="block text-muted-foreground">{result.message}</span>
                  )}
                </p>
              ))}
            </div>
          )}
          {selected.supersededBy && (
            <p className="break-all text-xs">
              {t('activity:adr.supersededBy')}: {selected.supersededBy}
            </p>
          )}
          {selected.resolvedBy && (
            <p className="break-words text-xs">
              {t('activity:adr.reviewedBy')}: {selected.resolvedBy} · {selected.resolutionReason}
            </p>
          )}
          <ArchitectureDecisionHistory
            key={`${projectRoot}:${sessionId}:${selected.id}`}
            record={selected}
            sessionId={sessionId}
          />
          <button
            type="button"
            className={button}
            onClick={() => void downloadDecision('markdown')}
          >
            {t('activity:adr.export')}
          </button>
          <button
            type="button"
            className={`${button} ml-2`}
            onClick={() => void downloadDecision('json')}
          >
            {t('activity:adr.exportJson')}
          </button>
          {selected.status === 'proposed' && (
            <button
              type="button"
              className={`${button} ml-2`}
              disabled={busy}
              onClick={() => openDecisionDraft(selected)}
            >
              {t('activity:adr.edit')}
            </button>
          )}
          {selected.status === 'accepted' && (
            <button
              type="button"
              className={`${button} ml-2`}
              disabled={busy || selectedStale || !!form}
              onClick={() => openDecisionDraft(selected, true)}
            >
              {t('activity:adr.replace')}
            </button>
          )}
          {(selected.status === 'proposed' || selected.status === 'accepted') && !form && (
            <div className="space-y-2 border-t border-border pt-3">
              <label className="block text-xs">
                {t('activity:adr.reason')}
                <textarea
                  className={`${input} mt-1`}
                  value={reason}
                  maxLength={4000}
                  onChange={(event) => setReason(event.target.value)}
                  disabled={busy}
                />
              </label>
              <div className="flex flex-wrap gap-2">
                {selected.status === 'proposed' ? (
                  <>
                    <button
                      type="button"
                      className={`${button} bg-primary text-primary-foreground`}
                      disabled={busy || selectedStale || !reason.trim()}
                      onClick={() => void review('accept')}
                    >
                      {t('activity:adr.accept')}
                    </button>
                    <button
                      type="button"
                      className={button}
                      disabled={busy || selectedStale || !reason.trim()}
                      onClick={() => void review('reject')}
                    >
                      {t('activity:adr.reject')}
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className={button}
                    disabled={busy || selectedStale || !reason.trim()}
                    onClick={() => void review('deprecate')}
                  >
                    {t('activity:adr.deprecate')}
                  </button>
                )}
              </div>
            </div>
          )}
        </article>
      )}
      {form && (
        <form
          className="space-y-3 rounded-lg border border-border p-4"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <h3 className="text-sm font-semibold">
            {t(editing ? 'activity:adr.edit' : 'activity:adr.new')}
          </h3>
          {(
            [
              'title',
              'context',
              'decision',
              'alternatives',
              'consequences',
              'constraints',
              'scope',
              'revisitWhen',
              'supersedes',
            ] as const
          ).map((key) => (
            <label key={key} className="block space-y-1 text-xs">
              <span>{t(`activity:adr.fields.${key}`)}</span>
              <textarea
                className={input}
                required={key === 'title' || key === 'context' || key === 'decision'}
                disabled={busy}
                rows={key === 'title' || key === 'supersedes' ? 1 : 3}
                value={Array.isArray(form[key]) ? form[key].join('\n') : (form[key] ?? '')}
                onChange={(event) => {
                  const value = event.target.value;
                  setForm({
                    ...form,
                    [key]: Array.isArray(form[key])
                      ? value.split('\n')
                      : key === 'supersedes'
                        ? value || undefined
                        : value,
                  });
                }}
              />
            </label>
          ))}
          <ArchitectureDecisionChecksEditor
            checks={form.checks ?? []}
            disabled={busy}
            onChange={(checks) => setForm({ ...form, checks })}
          />
          <p className="text-xs text-muted-foreground">{t('activity:adr.linesHint')}</p>
          <button type="submit" className={button} disabled={busy}>
            {t('activity:adr.saveProposal')}
          </button>
          <button
            type="button"
            className={`${button} ml-2`}
            disabled={busy}
            onClick={() => {
              setForm(null);
              setEditing(null);
            }}
          >
            {t('activity:adr.cancel')}
          </button>
        </form>
      )}
    </section>
  );
}
