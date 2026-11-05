import { ArrowLeft, ClipboardList, Plus } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDesktopText } from './desktop-i18n';
import type { FormDraftStorage } from './durable-form-draft';
import type { EngineHttp } from './engine-http';
import { entries, record } from './engine-state';
import {
  type RequirementAttachment,
  RequirementEvidence,
  type RequirementResource,
  RequirementResourceAppend,
  RequirementResourceEditor,
} from './RequirementResources';
import './project-requirements.css';
import { RequirementRecordDraftNotice } from './RequirementRecordDraftNotice';
import { RequirementSummary } from './RequirementSummary';
import {
  blankRequirementFields as blankFields,
  hasRequirementDraft,
  type RequirementDraftStorage,
  requirementSubmissionFingerprint,
} from './requirement-draft';
import type { RequirementRecordDraftStorageFactory } from './requirement-record-draft';
import { isVibeIntake, readable, strings, text } from './requirement-values';
import { useRequirementDraft } from './useRequirementDraft';
import { useRequirementRecordDraft } from './useRequirementRecordDraft';

const TYPES = [
  'unspecified',
  'feature',
  'bug_fix',
  'refactor',
  'performance',
  'security',
  'ui_change',
  'api_change',
  'infrastructure',
  'migration',
  'testing',
  'documentation',
  'maintenance',
  'other',
];
const PRIORITIES = ['unspecified', 'low', 'medium', 'high', 'critical'];
const unwrap = (value: unknown) => {
  const item = record(value);
  return record(item['record'] ?? item);
};
type Fields = ReturnType<typeof blankFields>;
const fieldsFor = (item: Record<string, unknown>): Fields => ({
  title: text(item['title']),
  requestType: text(item['requestType']) || 'unspecified',
  priority: text(item['priority']) || 'unspecified',
  businessGoal: text(item['businessGoal']),
  expectedOutcome: text(item['expectedOutcome']),
  scopeNotes: text(item['scopeNotes']),
  targetUsers: strings(item['targetUsers']).join('\n'),
  constraints: strings(item['constraints']).join('\n'),
  providedContext: strings(item['providedContext']).join('\n'),
});
export function requirementFields(fields: Fields) {
  return {
    ...fields,
    targetUsers: fields.targetUsers
      .split('\n')
      .map((item) => item.trim())
      .filter(Boolean),
    constraints: fields.constraints
      .split('\n')
      .map((item) => item.trim())
      .filter(Boolean),
    providedContext: fields.providedContext
      .split('\n')
      .map((item) => item.trim())
      .filter(Boolean),
  };
}

export function ProjectRequirements({
  http,
  onStartSdd,
  draftStorage,
  recordDraftStorage,
  resourceInputStorage,
  refreshKey = 0,
}: {
  http: EngineHttp;
  /** Bumped by the page's Refresh, which reloads the requirements with everything else. */
  refreshKey?: number;
  onStartSdd: (goal: string) => void;
  draftStorage?: RequirementDraftStorage;
  recordDraftStorage?: RequirementRecordDraftStorageFactory;
  resourceInputStorage?: (formKey: string) => FormDraftStorage;
}) {
  const { t } = useDesktopText();
  const named = (group: string, value: unknown) =>
    text(value)
      ? t(`req.${group}.${text(value)}`, { defaultValue: readable(value) })
      : t('req.notReported');
  const draft = useRequirementDraft(draftStorage);
  const newResourceStorage = useMemo(
    () => resourceInputStorage?.('requirement-resource-input:new'),
    [resourceInputStorage],
  );
  const [items, setItems] = useState<Record<string, unknown>[]>([]);
  const [projectId, setProjectId] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('all');
  const [selected, setSelected] = useState('');
  const recordDraft = useRequirementRecordDraft(selected, recordDraftStorage);
  const appendResourceStorage = useMemo(
    () => (selected ? resourceInputStorage?.(`requirement-resource-input:${selected}`) : undefined),
    [resourceInputStorage, selected],
  );
  const [detail, setDetail] = useState<Record<string, unknown> | null>(null);
  const [creating, setCreating] = useState(false);
  const editing = !creating && recordDraft.ready && recordDraft.value.fields !== null;
  const {
    original,
    fields: newFields,
    attachments: newAttachments,
    resources: newResources,
  } = draft.value;
  const setOriginal = (value: string) =>
    draft.update((current) => ({ ...current, original: value }));
  const setNewFields = (value: Fields) =>
    draft.update((current) => ({ ...current, fields: value }));
  const setNewAttachments = (value: RequirementAttachment[]) =>
    draft.update((current) => ({ ...current, attachments: value }));
  const setNewResources = (value: RequirementResource[]) =>
    draft.update((current) => ({ ...current, resources: value }));
  const fields = recordDraft.value.fields ?? blankFields();
  const setFields = (value: Fields) =>
    recordDraft.store?.update((previous) => ({ ...previous, fields: value }));
  const answerTexts = Object.fromEntries(
    Object.entries(recordDraft.value.answers).map(([id, answer]) => [id, answer.text]),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [confirm, setConfirm] = useState<'cancel' | 'archive' | null>(null);
  const [reason, setReason] = useState('');
  const [draftChoice, setDraftChoice] = useState<'saved' | 'local' | null>(null);
  const detailSequence = useRef(0);
  const listSequence = useRef(0);
  const busyRef = useRef(false);
  useEffect(() => {
    if (draft.ready && hasRequirementDraft(draft.value)) setCreating(true);
  }, [draft.ready]);
  const load = useCallback(async () => {
    const seq = ++listSequence.current;
    const response = record(await http('/api/requirement-intakes'));
    if (seq !== listSequence.current) return;
    if (typeof response['projectId'] !== 'string' || !Array.isArray(response['intakes']))
      throw new Error(t('req.noCatalog'));
    setProjectId(response['projectId']);
    setItems(entries(response['intakes']));
    setLoaded(true);
  }, [http]);
  useEffect(() => {
    void load().catch((e) => setError(String(e)));
    return () => {
      listSequence.current++;
      detailSequence.current++;
    };
  }, [load, refreshKey]);
  const select = async (id: string) => {
    if (busyRef.current || creating) return;
    const seq = ++detailSequence.current;
    setSelected(id);
    setDetail(null);
    setError('');
    setNotice('');
    setConfirm(null);
    try {
      const current = unwrap(await http(`/api/requirement-intakes/${encodeURIComponent(id)}`));
      if (seq !== detailSequence.current) return;
      if (current['id'] !== id) throw new Error(t('req.otherRecord'));
      setDetail(current);
    } catch (e) {
      if (seq === detailSequence.current) setError(e instanceof Error ? e.message : String(e));
    }
  };
  const run = async (operation: () => Promise<void>) => {
    if (busyRef.current) return false;
    busyRef.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await operation();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  const appendResource = (input: {
    attachment?: RequirementAttachment;
    relatedResource?: RequirementResource;
  }) =>
    run(async () => {
      if (!detail || typeof detail['version'] !== 'number')
        throw new Error(t('req.reloadForResource'));
      const current = unwrap(
        await http(`/api/requirement-intakes/${encodeURIComponent(selected)}/resources`, 'POST', {
          ...input,
          expectedVersion: detail['version'],
        }),
      );
      if (current['id'] !== selected) throw new Error(t('req.resourceUnconfirmed'));
      setDetail(current);
      setNotice(t('req.resourceSaved'));
      void load().catch((e) => setError(String(e)));
    });
  const decideSuggestion = (id: string, decision: 'accept' | 'reject') =>
    void run(async () => {
      if (!detail || typeof detail['version'] !== 'number')
        throw new Error(t('req.reloadForSuggestion'));
      const current = unwrap(
        await http(
          `/api/requirement-intakes/${encodeURIComponent(selected)}/suggestions/${encodeURIComponent(id)}/${decision}`,
          'POST',
          { expectedVersion: detail['version'] },
        ),
      );
      if (current['id'] !== selected) throw new Error(t('req.suggestionUnconfirmed'));
      setDetail(current);
      setNotice(decision === 'accept' ? t('req.suggestionAccepted') : t('req.suggestionRejected'));
      void load().catch((e) => setError(String(e)));
    });
  const create = () =>
    void run(async () => {
      if (!original.trim() || !projectId) throw new Error(t('req.catalogFirst'));
      const input = {
        projectId,
        originalRequest: original,
        requestedBy: 'desktop',
        ...requirementFields(newFields),
        attachments: newAttachments,
        relatedResources: newResources,
      };
      const fingerprint = requirementSubmissionFingerprint(input);
      const idempotencyKey = await draft.prepare(fingerprint);
      const current = unwrap(
        await http(`/api/projects/${encodeURIComponent(projectId)}/requirement-intakes`, 'POST', {
          ...input,
          idempotencyKey,
        }),
      );
      if (typeof current['id'] !== 'string' || current['originalRequest'] !== original)
        throw new Error(t('req.originalUnconfirmed'));
      setSelected(current['id']);
      setDetail(current);
      let cleared = false;
      try {
        cleared = await draft.clearSubmitted(fingerprint);
      } catch {
        /* The recorded intake is safe; preserve any conflicting draft. */
      }
      setCreating(!cleared);
      setNotice(t('req.draftRecorded'));
      await load();
    });
  const save = () =>
    void run(async () => {
      const store = recordDraft.store;
      const submitted = store?.snapshot().value;
      if (!detail || !store || !submitted?.fields || submitted.expectedVersion === null)
        throw new Error(t('req.reloadForEdit'));
      await store.flush();
      const current = unwrap(
        await http(`/api/requirement-intakes/${encodeURIComponent(selected)}`, 'PATCH', {
          ...requirementFields(submitted.fields),
          expectedVersion: submitted.expectedVersion,
        }),
      );
      if (current['id'] !== selected) throw new Error(t('req.recordUnconfirmed'));
      setDetail(current);
      setNotice(t('req.infoSaved'));
      await store.acknowledgeEdit(submitted);
      await load();
    });
  const transition = (action: 'submit' | 'cancel' | 'archive') =>
    void run(async () => {
      const current = unwrap(
        await http(
          `/api/requirement-intakes/${encodeURIComponent(selected)}/${action}`,
          'POST',
          action === 'cancel' ? { reason } : {},
        ),
      );
      if (current['id'] !== selected) throw new Error(t('req.transitionUnconfirmed'));
      setDetail(current);
      setConfirm(null);
      setNotice(
        action === 'submit'
          ? t('req.submitted')
          : action === 'cancel'
            ? t('req.cancelled')
            : t('req.archived'),
      );
      await load();
    });
  const answer = (question: Record<string, unknown>) =>
    void run(async () => {
      const id = String(question['id']);
      const value = answerTexts[id]?.trim();
      if (!value) return;
      const store = recordDraft.store;
      const submitted = store?.snapshot().value.answers[id];
      if (!store || !submitted) throw new Error(t('req.reloadForAnswer'));
      await store.flush();
      const current = unwrap(
        await http(`/api/requirement-intakes/${encodeURIComponent(selected)}/answers`, 'POST', {
          field: question['field'],
          question: question['question'],
          answer: value,
          expectedVersion: submitted.expectedVersion,
        }),
      );
      if (current['id'] !== selected) throw new Error(t('req.answerUnconfirmed'));
      setDetail(current);
      setNotice(t('req.answerRecorded'));
      await store.acknowledgeAnswer(id, value);
      await load();
    });
  const mutable = detail && ['draft', 'collecting_information'].includes(String(detail['status']));
  const visible = items.filter(
    (item) =>
      (status === 'all' || item['status'] === status) &&
      `${text(item['title'])} ${text(item['originalRequest'])}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  const questions = entries(detail?.['questions']);
  return (
    <section className="project-requirements" aria-label={t('req.label')}>
      <header className="requirements-heading">
        <div>
          <span className="eyebrow">{t('req.eyebrow')}</span>
          <h2>{t('req.title')}</h2>
          <p>{t('req.intro')}</p>
        </div>
        <div className="sdd-actions">
          <button
            type="button"
            className="button primary"
            disabled={!projectId || !draft.ready || busy || editing || creating}
            onClick={() => {
              setCreating(true);
              setDetail(null);
              setSelected('');
              setError('');
              setNotice('');
            }}
          >
            <Plus size={14} /> {t('req.new')}
          </button>
        </div>
      </header>
      {error && (
        <p className="session-error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="requirements-notice" role="status">
          {notice}
        </p>
      )}
      {(hasRequirementDraft(draft.value) || draft.status === 'loading' || draft.error) && (
        <section className="requirement-draft-status" aria-label={t('req.draftStorage')}>
          <p>
            {draft.status === 'loading'
              ? t('req.draft.loading')
              : draft.status === 'saving'
                ? t('req.draft.saving')
                : draft.status === 'conflict'
                  ? t('req.draft.conflict')
                  : draft.status === 'error'
                    ? t('req.draft.error')
                    : t('req.draft.saved')}
          </p>
          {draft.error && (
            <p className="session-error" role="alert">
              {draft.error}
            </p>
          )}
          {!draft.ready && draft.status === 'error' && (
            <button type="button" className="button secondary" onClick={draft.retryLoad}>
              {t('req.retryDraft')}
            </button>
          )}
          {draft.status === 'conflict' && (
            <button
              type="button"
              className="button secondary"
              disabled={draft.resolving}
              onClick={() => {
                setDraftChoice(null);
                void draft.compare();
              }}
            >
              {t('req.compare')}
            </button>
          )}
          {draft.review && (
            <>
              <div className="requirement-draft-comparison">
                <div>
                  <h4>{t('req.localDraft')}</h4>
                  <strong>{draft.value.fields.title || t('req.untitled')}</strong>
                  <textarea
                    aria-label={t('req.localDraftLabel')}
                    readOnly
                    value={draft.value.original}
                  />
                  <small>
                    {t('shellText.reqDraftCounts', {
                      attachments: t('counts.attachmentReferences', {
                        count: draft.value.attachments.length,
                      }),
                      resources: t('counts.relatedResources', {
                        count: draft.value.resources.length,
                      }),
                    })}
                  </small>
                </div>
                <div>
                  <h4>{t('req.savedDraft')}</h4>
                  <strong>{draft.review.draft.fields.title || t('req.untitled')}</strong>
                  <textarea
                    aria-label={t('req.savedDraftLabel')}
                    readOnly
                    value={draft.review.draft.original}
                  />
                  <small>
                    {t('shellText.reqDraftCounts', {
                      attachments: draft.review.draft.attachments.length,
                      resources: draft.review.draft.resources.length,
                    })}
                  </small>
                </div>
              </div>
              <p>{t('req.choiceHelp')}</p>
              <div className="sdd-actions">
                {draftChoice ? (
                  <>
                    <button
                      type="button"
                      className="button primary"
                      disabled={draft.resolving}
                      onClick={() => {
                        void draft.resolve(draftChoice).then(() => {
                          setDraftChoice(null);
                          setCreating(true);
                        });
                      }}
                    >
                      {draftChoice === 'saved'
                        ? t('req.confirmUseSaved')
                        : t('req.confirmKeepLocal')}
                    </button>
                    <button
                      type="button"
                      disabled={draft.resolving}
                      onClick={() => setDraftChoice(null)}
                    >
                      {t('req.cancelChoice')}
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      type="button"
                      className="button secondary"
                      disabled={draft.resolving}
                      onClick={() => setDraftChoice('saved')}
                    >
                      {t('req.useSaved')}
                    </button>
                    <button
                      type="button"
                      className="button secondary"
                      disabled={draft.resolving}
                      onClick={() => setDraftChoice('local')}
                    >
                      {t('req.keepLocal')}
                    </button>
                  </>
                )}
              </div>
            </>
          )}
        </section>
      )}
      {!creating && selected && (
        <RequirementRecordDraftNotice
          key={selected}
          state={recordDraft}
          store={recordDraft.store}
          questions={questions}
        />
      )}
      <div className="requirements-layout">
        <aside className="requirements-list">
          <label>
            {t('req.search')}
            <input
              aria-label={t('req.search')}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          <label>
            {t('req.statusLabel')}
            <select
              aria-label={t('req.statusFilter')}
              value={status}
              onChange={(e) => setStatus(e.target.value)}
            >
              {['all', 'draft', 'collecting_information', 'submitted', 'cancelled', 'archived'].map(
                (value) => (
                  <option key={value} value={value}>
                    {t(`req.status.${value}`)}
                  </option>
                ),
              )}
            </select>
          </label>
          {!loaded ? (
            <p>{t('req.loading')}</p>
          ) : visible.length ? (
            visible.map((item) => (
              <button
                type="button"
                key={String(item['id'])}
                disabled={busy || creating}
                aria-pressed={selected === item['id']}
                onClick={() => void select(String(item['id']))}
              >
                <strong>{text(item['title']) || t('req.untitledRequest')}</strong>
                <span>
                  {named('status', item['status'])} · {named('priority', item['priority'])}
                  {isVibeIntake(item) && ' · VIBE'}
                </span>
              </button>
            ))
          ) : (
            <p>{query || status !== 'all' ? t('req.noMatch') : t('req.none')}</p>
          )}
        </aside>
        <main className="requirements-detail">
          {creating || editing ? (
            <>
              <button
                type="button"
                className="goal-back"
                disabled={busy || (!creating && recordDraft.resolving)}
                onClick={() => {
                  setCreating(false);
                  if (editing) recordDraft.store?.discardEdit();
                }}
              >
                <ArrowLeft size={14} /> {t('req.cancelEditing')}
              </button>
              <h3>{creating ? t('req.new') : t('req.editInfo')}</h3>
              {creating && (
                <label>
                  {t('req.original')}
                  <textarea
                    aria-label={t('req.original')}
                    disabled={busy || !draft.ready || draft.resolving}
                    value={original}
                    onChange={(e) => setOriginal(e.target.value)}
                    placeholder={t('req.originalPlaceholder')}
                  />
                </label>
              )}
              <RequirementFields
                fields={creating ? newFields : fields}
                setFields={creating ? setNewFields : setFields}
                disabled={
                  busy ||
                  (creating
                    ? !draft.ready || draft.resolving
                    : !recordDraft.ready || recordDraft.resolving)
                }
              />
              {creating && (
                <RequirementResourceEditor
                  attachments={newAttachments}
                  resources={newResources}
                  onAttachments={setNewAttachments}
                  onResources={setNewResources}
                  disabled={busy || !draft.ready || draft.resolving}
                  {...(newResourceStorage ? { storage: newResourceStorage } : {})}
                />
              )}
              <div className="sdd-actions">
                <button
                  type="button"
                  className="button primary"
                  disabled={
                    busy ||
                    (!creating &&
                      (!recordDraft.ready ||
                        recordDraft.status === 'conflict' ||
                        recordDraft.resolving ||
                        !mutable)) ||
                    (creating && (!original.trim() || !draft.ready || draft.status === 'conflict'))
                  }
                  onClick={creating ? create : save}
                >
                  {busy ? t('req.saving') : creating ? t('req.saveDraft') : t('req.saveInfo')}
                </button>
              </div>
            </>
          ) : detail ? (
            <>
              <div className="requirements-detail-heading">
                <div>
                  <span className="eyebrow">{named('type', detail['requestType'])}</span>
                  <h3>{text(detail['title']) || t('req.requirement')}</h3>
                  <span className="sdd-chip">{named('status', detail['status'])}</span>
                </div>
                <div className="sdd-actions">
                  <button
                    type="button"
                    className="button secondary"
                    disabled={busy}
                    onClick={() => void select(selected)}
                  >
                    {t('req.reload')}
                  </button>
                  {mutable && (
                    <button
                      type="button"
                      className="button secondary"
                      disabled={
                        busy ||
                        !recordDraft.ready ||
                        recordDraft.resolving ||
                        typeof detail['version'] !== 'number'
                      }
                      onClick={() => {
                        if (typeof detail['version'] === 'number')
                          recordDraft.store?.beginEdit(fieldsFor(detail), detail['version']);
                      }}
                    >
                      {t('req.editInformation')}
                    </button>
                  )}
                  {!['cancelled', 'archived'].includes(String(detail['status'])) && (
                    <button
                      type="button"
                      className="button primary"
                      disabled={busy}
                      onClick={() => onStartSdd(text(detail['originalRequest']))}
                    >
                      {t('req.prepareSdd')}
                    </button>
                  )}
                </div>
              </div>
              <RequirementSummary detail={detail} />
              <RequirementEvidence
                detail={detail}
                busy={busy}
                {...(mutable ? { onDecision: decideSuggestion } : {})}
              />
              {mutable && (
                <RequirementResourceAppend
                  key={selected}
                  disabled={busy}
                  onSave={appendResource}
                  owner={selected}
                  {...(appendResourceStorage ? { storage: appendResourceStorage } : {})}
                />
              )}
              {questions.length > 0 && (
                <section className="requirement-questions">
                  <h4>{t('req.collect')}</h4>
                  {questions.map((question) => (
                    <article key={String(question['id'])}>
                      <strong>{text(question['question'])}</strong>
                      <small>
                        {question['required'] === true ? t('req.required') : t('req.optional')} ·{' '}
                        {named('question', question['status'])}
                      </small>
                      {text(question['answer']) && <p>{text(question['answer'])}</p>}
                      {mutable && (
                        <form
                          onSubmit={(event) => {
                            event.preventDefault();
                            answer(question);
                          }}
                        >
                          <label>
                            {t('req.answer')}
                            <textarea
                              aria-label={t('req.answerLabel', {
                                question: text(question['question']),
                              })}
                              disabled={
                                busy ||
                                !recordDraft.ready ||
                                recordDraft.resolving ||
                                typeof detail['version'] !== 'number'
                              }
                              value={answerTexts[String(question['id'])] ?? ''}
                              onChange={(event) =>
                                typeof detail['version'] === 'number' &&
                                recordDraft.store?.setAnswer(
                                  String(question['id']),
                                  event.target.value,
                                  detail['version'],
                                )
                              }
                            />
                          </label>
                          {recordDraft.value.answers[String(question['id'])] &&
                            recordDraft.value.answers[String(question['id'])]?.expectedVersion !==
                              detail['version'] && (
                              <div className="requirement-answer-version">
                                <p>{t('req.answerStale')}</p>
                                <button
                                  type="button"
                                  className="button secondary"
                                  disabled={
                                    busy ||
                                    recordDraft.resolving ||
                                    recordDraft.status === 'conflict'
                                  }
                                  onClick={() => {
                                    if (typeof detail['version'] === 'number')
                                      recordDraft.store?.rebaseAnswer(
                                        String(question['id']),
                                        detail['version'],
                                      );
                                  }}
                                >
                                  {t('req.useCurrent')}
                                </button>
                              </div>
                            )}
                          <button
                            type="submit"
                            className="button secondary"
                            disabled={
                              busy ||
                              !recordDraft.ready ||
                              recordDraft.resolving ||
                              recordDraft.status === 'conflict' ||
                              !(answerTexts[String(question['id'])] ?? '').trim()
                            }
                          >
                            {t('req.recordAnswer')}
                          </button>
                        </form>
                      )}
                    </article>
                  ))}
                </section>
              )}
              <div className="sdd-actions">
                {mutable && (
                  <>
                    <button
                      type="button"
                      className="button primary"
                      disabled={busy}
                      onClick={() => transition('submit')}
                    >
                      {t('req.submit')}
                    </button>
                    <button
                      type="button"
                      className="button secondary"
                      disabled={busy}
                      onClick={() => setConfirm('cancel')}
                    >
                      {t('req.cancel')}
                    </button>
                  </>
                )}
                {['submitted', 'cancelled'].includes(String(detail['status'])) && (
                  <button
                    type="button"
                    className="button secondary"
                    disabled={busy}
                    onClick={() => setConfirm('archive')}
                  >
                    {t('req.archive')}
                  </button>
                )}
              </div>
              {confirm && (
                <div className="requirement-confirm">
                  <p>{confirm === 'cancel' ? t('req.cancelAsk') : t('req.archiveAsk')}</p>
                  {confirm === 'cancel' && (
                    <label>
                      {t('req.reason')}
                      <input
                        aria-label={t('req.reason')}
                        value={reason}
                        onChange={(e) => setReason(e.target.value)}
                      />
                    </label>
                  )}
                  <div className="sdd-actions">
                    <button
                      type="button"
                      className="button secondary"
                      disabled={busy}
                      onClick={() => setConfirm(null)}
                    >
                      {t('req.keep')}
                    </button>
                    <button
                      type="button"
                      className="button primary"
                      disabled={busy}
                      onClick={() => transition(confirm)}
                    >
                      {confirm === 'cancel' ? t('req.confirmCancel') : t('req.confirmArchive')}
                    </button>
                  </div>
                </div>
              )}
              {entries(detail['history']).length > 0 && (
                <details className="requirement-history">
                  <summary>{t('req.history')}</summary>
                  {entries(detail['history']).map((item, index) => (
                    <article key={index}>
                      <strong>{named('action', item['action'])}</strong>
                      <span>
                        {text(item['actor']) || t('req.unknownActor')}
                        {typeof item['at'] === 'number'
                          ? ` · ${new Date(item['at']).toLocaleString()}`
                          : ''}
                      </span>
                      {Array.isArray(item['fields']) && (
                        <small>{strings(item['fields']).join(', ')}</small>
                      )}
                    </article>
                  ))}
                </details>
              )}
            </>
          ) : (
            <div className="requirements-empty">
              <ClipboardList size={28} />
              <h3>
                {selected
                  ? error
                    ? t('req.loadFailed')
                    : t('req.loadingOne')
                  : t('req.emptyTitle')}
              </h3>
              <p>{t('req.emptyHelp')}</p>
            </div>
          )}
        </main>
      </div>
    </section>
  );
}

function RequirementFields({
  fields,
  setFields,
  disabled,
}: {
  fields: Fields;
  setFields: (fields: Fields) => void;
  disabled: boolean;
}) {
  const { t } = useDesktopText();
  return (
    <div className="requirement-fields">
      <label>
        {t('req.field.title')}
        <input
          aria-label={t('req.field.titleLabel')}
          disabled={disabled}
          value={fields.title}
          onChange={(e) => setFields({ ...fields, title: e.target.value })}
        />
      </label>
      <div className="requirement-pair">
        <label>
          {t('req.field.type')}
          <select
            aria-label={t('req.field.type')}
            disabled={disabled}
            value={fields.requestType}
            onChange={(e) => setFields({ ...fields, requestType: e.target.value })}
          >
            {TYPES.map((value) => (
              <option key={value} value={value}>
                {t(`req.type.${value}`)}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t('req.field.priority')}
          <select
            aria-label={t('req.field.priorityLabel')}
            disabled={disabled}
            value={fields.priority}
            onChange={(e) => setFields({ ...fields, priority: e.target.value })}
          >
            {PRIORITIES.map((value) => (
              <option key={value} value={value}>
                {t(`req.priority.${value}`)}
              </option>
            ))}
          </select>
        </label>
      </div>
      {(
        [
          'businessGoal',
          'expectedOutcome',
          'scopeNotes',
          'targetUsers',
          'constraints',
          'providedContext',
        ] as const
      ).map((key) => {
        const name = t(`req.field.${key}`);
        return (
          <label key={key}>
            {name}
            <textarea
              aria-label={name}
              disabled={disabled}
              value={fields[key]}
              onChange={(e) => setFields({ ...fields, [key]: e.target.value })}
            />
          </label>
        );
      })}
    </div>
  );
}
