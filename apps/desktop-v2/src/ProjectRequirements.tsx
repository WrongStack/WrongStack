import { ArrowLeft, ClipboardList, Plus, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
}: {
  http: EngineHttp;
  onStartSdd: (goal: string) => void;
  draftStorage?: RequirementDraftStorage;
  recordDraftStorage?: RequirementRecordDraftStorageFactory;
  resourceInputStorage?: (formKey: string) => FormDraftStorage;
}) {
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
      throw new Error('The engine did not return a project requirement catalog.');
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
  }, [load]);
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
      if (current['id'] !== id)
        throw new Error('The engine returned a different requirement record.');
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
        throw new Error('Reload the requirement before adding a resource.');
      const current = unwrap(
        await http(`/api/requirement-intakes/${encodeURIComponent(selected)}/resources`, 'POST', {
          ...input,
          expectedVersion: detail['version'],
        }),
      );
      if (current['id'] !== selected) throw new Error('The engine did not confirm the resource.');
      setDetail(current);
      setNotice('Supporting resource saved.');
      void load().catch((e) => setError(String(e)));
    });
  const decideSuggestion = (id: string, decision: 'accept' | 'reject') =>
    void run(async () => {
      if (!detail || typeof detail['version'] !== 'number')
        throw new Error('Reload the requirement before deciding on a suggestion.');
      const current = unwrap(
        await http(
          `/api/requirement-intakes/${encodeURIComponent(selected)}/suggestions/${encodeURIComponent(id)}/${decision}`,
          'POST',
          { expectedVersion: detail['version'] },
        ),
      );
      if (current['id'] !== selected)
        throw new Error('The engine did not confirm the suggestion decision.');
      setDetail(current);
      setNotice(`Suggestion ${decision === 'accept' ? 'accepted' : 'rejected'}.`);
      void load().catch((e) => setError(String(e)));
    });
  const create = () =>
    void run(async () => {
      if (!original.trim() || !projectId)
        throw new Error('Enter the request after the project catalog has loaded.');
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
        throw new Error(
          'The engine did not confirm the original requirement text. Your draft has been retained.',
        );
      setSelected(current['id']);
      setDetail(current);
      let cleared = false;
      try {
        cleared = await draft.clearSubmitted(fingerprint);
      } catch {
        /* The recorded intake is safe; preserve any conflicting draft. */
      }
      setCreating(!cleared);
      setNotice('Requirement draft recorded.');
      await load();
    });
  const save = () =>
    void run(async () => {
      const store = recordDraft.store;
      const submitted = store?.snapshot().value;
      if (!detail || !store || !submitted?.fields || submitted.expectedVersion === null)
        throw new Error('Reload the record before editing.');
      await store.flush();
      const current = unwrap(
        await http(`/api/requirement-intakes/${encodeURIComponent(selected)}`, 'PATCH', {
          ...requirementFields(submitted.fields),
          expectedVersion: submitted.expectedVersion,
        }),
      );
      if (current['id'] !== selected) throw new Error('The engine did not confirm this record.');
      setDetail(current);
      setNotice('Requirement information saved.');
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
      if (current['id'] !== selected)
        throw new Error('The engine did not confirm this requirement transition.');
      setDetail(current);
      setConfirm(null);
      setNotice(
        `Requirement ${action === 'submit' ? 'submitted' : action === 'cancel' ? 'cancelled' : 'archived'}.`,
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
      if (!store || !submitted)
        throw new Error('Reload the saved answer draft before recording it.');
      await store.flush();
      const current = unwrap(
        await http(`/api/requirement-intakes/${encodeURIComponent(selected)}/answers`, 'POST', {
          field: question['field'],
          question: question['question'],
          answer: value,
          expectedVersion: submitted.expectedVersion,
        }),
      );
      if (current['id'] !== selected) throw new Error('The engine did not confirm this answer.');
      setDetail(current);
      setNotice('Answer recorded.');
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
    <section className="project-requirements" aria-label="Project requirements">
      <header className="requirements-heading">
        <div>
          <span className="eyebrow">CAPTURE THE REASON FOR CHANGE</span>
          <h2>Requirements</h2>
          <p>Record requests, close information gaps and prepare the SDD interview.</p>
        </div>
        <div className="sdd-actions">
          <button
            type="button"
            className="button secondary"
            disabled={busy}
            onClick={() => void load().catch((e) => setError(String(e)))}
          >
            <RefreshCw size={14} /> Refresh
          </button>
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
            <Plus size={14} /> New requirement
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
        <section className="requirement-draft-status" aria-label="New requirement draft storage">
          <p>
            {draft.status === 'loading'
              ? 'Loading the saved new requirement draft…'
              : draft.status === 'saving'
                ? 'Saving the new requirement draft on this device…'
                : draft.status === 'conflict'
                  ? 'This new requirement draft changed in another window. Your local form is preserved.'
                  : draft.status === 'error'
                    ? 'The new requirement draft could not be saved.'
                    : 'New requirement draft saved on this device.'}
          </p>
          {draft.error && (
            <p className="session-error" role="alert">
              {draft.error}
            </p>
          )}
          {!draft.ready && draft.status === 'error' && (
            <button type="button" className="button secondary" onClick={draft.retryLoad}>
              Retry loading draft
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
              Compare draft versions
            </button>
          )}
          {draft.review && (
            <>
              <div className="requirement-draft-comparison">
                <div>
                  <h4>Local draft</h4>
                  <strong>{draft.value.fields.title || 'Untitled requirement'}</strong>
                  <textarea
                    aria-label="Local requirement draft"
                    readOnly
                    value={draft.value.original}
                  />
                  <small>
                    {draft.value.attachments.length} attachment references ·{' '}
                    {draft.value.resources.length} related resources
                  </small>
                </div>
                <div>
                  <h4>Saved draft</h4>
                  <strong>{draft.review.draft.fields.title || 'Untitled requirement'}</strong>
                  <textarea
                    aria-label="Saved requirement draft"
                    readOnly
                    value={draft.review.draft.original}
                  />
                  <small>
                    {draft.review.draft.attachments.length} attachment references ·{' '}
                    {draft.review.draft.resources.length} related resources
                  </small>
                </div>
              </div>
              <p>
                Choosing a version replaces the complete new requirement form, including its
                information and resource references.
              </p>
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
                      Confirm {draftChoice === 'saved' ? 'use saved draft' : 'keep local draft'}
                    </button>
                    <button
                      type="button"
                      disabled={draft.resolving}
                      onClick={() => setDraftChoice(null)}
                    >
                      Cancel choice
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
                      Use saved draft
                    </button>
                    <button
                      type="button"
                      className="button secondary"
                      disabled={draft.resolving}
                      onClick={() => setDraftChoice('local')}
                    >
                      Keep local draft
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
            Search requirements
            <input
              aria-label="Search requirements"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          <label>
            Status
            <select
              aria-label="Requirement status filter"
              value={status}
              onChange={(e) => setStatus(e.target.value)}
            >
              {['all', 'draft', 'collecting_information', 'submitted', 'cancelled', 'archived'].map(
                (value) => (
                  <option key={value} value={value}>
                    {value.replaceAll('_', ' ')}
                  </option>
                ),
              )}
            </select>
          </label>
          {!loaded ? (
            <p>Loading requirements…</p>
          ) : visible.length ? (
            visible.map((item) => (
              <button
                type="button"
                key={String(item['id'])}
                disabled={busy || creating}
                aria-pressed={selected === item['id']}
                onClick={() => void select(String(item['id']))}
              >
                <strong>{text(item['title']) || 'Untitled request'}</strong>
                <span>
                  {readable(item['status'])} · {readable(item['priority'])}
                  {isVibeIntake(item) && ' · VIBE'}
                </span>
              </button>
            ))
          ) : (
            <p>
              {query || status !== 'all'
                ? 'No matching requirements.'
                : 'No requirements recorded yet.'}
            </p>
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
                <ArrowLeft size={14} /> Cancel editing
              </button>
              <h3>{creating ? 'New requirement' : 'Edit requirement information'}</h3>
              {creating && (
                <label>
                  Original request
                  <textarea
                    aria-label="Original request"
                    disabled={busy || !draft.ready || draft.resolving}
                    value={original}
                    onChange={(e) => setOriginal(e.target.value)}
                    placeholder="Describe the request. This exact text is preserved."
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
                  {busy ? 'Saving…' : creating ? 'Save draft' : 'Save information'}
                </button>
              </div>
            </>
          ) : detail ? (
            <>
              <div className="requirements-detail-heading">
                <div>
                  <span className="eyebrow">{readable(detail['requestType'])}</span>
                  <h3>{text(detail['title']) || 'Requirement'}</h3>
                  <span className="sdd-chip">{readable(detail['status'])}</span>
                </div>
                <div className="sdd-actions">
                  <button
                    type="button"
                    className="button secondary"
                    disabled={busy}
                    onClick={() => void select(selected)}
                  >
                    Reload record
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
                      Edit information
                    </button>
                  )}
                  {!['cancelled', 'archived'].includes(String(detail['status'])) && (
                    <button
                      type="button"
                      className="button primary"
                      disabled={busy}
                      onClick={() => onStartSdd(text(detail['originalRequest']))}
                    >
                      Prepare SDD interview
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
                  <h4>Information to collect</h4>
                  {questions.map((question) => (
                    <article key={String(question['id'])}>
                      <strong>{text(question['question'])}</strong>
                      <small>
                        {question['required'] === true ? 'Required' : 'Optional'} ·{' '}
                        {readable(question['status'])}
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
                            Answer
                            <textarea
                              aria-label={`Answer: ${text(question['question'])}`}
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
                                <p>
                                  This record changed after the answer draft was started. Review the
                                  saved answer above before using the current record version.
                                </p>
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
                                  Use current record version
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
                            Record answer
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
                      Submit requirement
                    </button>
                    <button
                      type="button"
                      className="button secondary"
                      disabled={busy}
                      onClick={() => setConfirm('cancel')}
                    >
                      Cancel requirement
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
                    Archive requirement
                  </button>
                )}
              </div>
              {confirm && (
                <div className="requirement-confirm">
                  <p>
                    {confirm === 'cancel'
                      ? 'Cancel this request? Its content will be retained.'
                      : 'Archive this request? It remains available in the archive filter.'}
                  </p>
                  {confirm === 'cancel' && (
                    <label>
                      Cancellation reason
                      <input
                        aria-label="Cancellation reason"
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
                      Keep requirement
                    </button>
                    <button
                      type="button"
                      className="button primary"
                      disabled={busy}
                      onClick={() => transition(confirm)}
                    >
                      Confirm {confirm}
                    </button>
                  </div>
                </div>
              )}
              {entries(detail['history']).length > 0 && (
                <details className="requirement-history">
                  <summary>Change history</summary>
                  {entries(detail['history']).map((item, index) => (
                    <article key={index}>
                      <strong>{readable(item['action'])}</strong>
                      <span>
                        {text(item['actor']) || 'Unknown actor'}
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
                    ? 'Requirement could not be loaded'
                    : 'Loading requirement…'
                  : 'Make the request clear'}
              </h3>
              <p>
                Select a request or record a new one to collect its intent, constraints and expected
                outcome.
              </p>
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
  return (
    <div className="requirement-fields">
      <label>
        Title
        <input
          aria-label="Requirement title"
          disabled={disabled}
          value={fields.title}
          onChange={(e) => setFields({ ...fields, title: e.target.value })}
        />
      </label>
      <div className="requirement-pair">
        <label>
          Request type
          <select
            aria-label="Request type"
            disabled={disabled}
            value={fields.requestType}
            onChange={(e) => setFields({ ...fields, requestType: e.target.value })}
          >
            {TYPES.map((value) => (
              <option key={value} value={value}>
                {value.replaceAll('_', ' ')}
              </option>
            ))}
          </select>
        </label>
        <label>
          Priority
          <select
            aria-label="Requirement priority"
            disabled={disabled}
            value={fields.priority}
            onChange={(e) => setFields({ ...fields, priority: e.target.value })}
          >
            {PRIORITIES.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
      </div>
      {(
        [
          ['businessGoal', 'Business goal'],
          ['expectedOutcome', 'Expected outcome'],
          ['scopeNotes', 'Scope notes'],
          ['targetUsers', 'Target users, one per line'],
          ['constraints', 'Constraints, one per line'],
          ['providedContext', 'Provided context, one per line'],
        ] as const
      ).map(([key, name]) => (
        <label key={key}>
          {name}
          <textarea
            aria-label={name}
            disabled={disabled}
            value={fields[key]}
            onChange={(e) => setFields({ ...fields, [key]: e.target.value })}
          />
        </label>
      ))}
    </div>
  );
}
