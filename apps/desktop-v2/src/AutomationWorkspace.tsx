import {
  type AutomationJobInput,
  type AutomationJobRecord,
  type AutomationPreview,
  type AutomationStateView,
  createAutomationJobInput,
  editableAutomationJob,
  formatAutomationCommands,
  parseAutomationCommands,
  VERSIONED_AUTOMATION_TEMPLATES,
} from '@wrongstack/webui-protocol';
import { Download, Eye, Pause, Play, Plus, RefreshCw, Save, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Trans } from 'react-i18next';
import { AutomationConfiguration, AutomationTemplates } from './AutomationConfiguration';
import { AutomationEnvironmentEditor } from './AutomationEnvironmentEditor';
import { AutomationRunComparison } from './AutomationRunComparison';
import { AutomationRunInspector } from './AutomationRunInspector';
import { activeDrafts, automationDraftKey, jobDrafts } from './automation-draft';
import { automationMilliseconds } from './automation-units';
import { useDesktopText } from './desktop-i18n';
import type { EngineHttp } from './engine-http';
import { emptyEngineState } from './engine-state';
import { Modal } from './Modal';
import { ProfileModelPicker } from './ProfileModelPicker';
import { sameSetting } from './settings-save-model';
import { surfaceI18n } from './surface-i18n';
import { TimeZoneInput } from './TimeZoneInput';
import {
  AutomationDraftPersistenceStatus,
  useAutomationDraftPersistence,
} from './useAutomationDraftPersistence';
import './automation-workspace.css';
import { displayDateTime } from './display-dates';

const fresh = () => ({ ...createAutomationJobInput(), enabled: false });
export function AutomationWorkspace({ http, projectId }: { http: EngineHttp; projectId: string }) {
  const { t } = useDesktopText();
  const cached = useRef(activeDrafts.get(projectId)).current;
  const [data, setData] = useState<AutomationStateView>({
    jobs: [],
    runs: [],
    workerOnline: false,
  });
  const [selected, setSelected] = useState<AutomationJobRecord | null>(cached?.selected ?? null);
  const [deleting, setDeleting] = useState<AutomationJobRecord | null>(null);
  const [draft, setDraft] = useState<AutomationJobInput>(cached?.draft ?? fresh());
  const [commands, setCommands] = useState(cached?.commands ?? '');
  const [preview, setPreview] = useState<AutomationPreview | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [inspectedRun, setInspectedRun] = useState<string | null>(null);
  // Two picked runs, in pick order, compared from their recorded results.
  const [compared, setCompared] = useState<string[]>([]),
    [comparing, setComparing] = useState(false);
  const comparedRuns = compared
    .map((id) => data.runs.find((run) => run.id === id))
    .filter((run) => run !== undefined);
  const [modelPicker, setModelPicker] = useState(false),
    [environmentOpen, setEnvironmentOpen] = useState(false),
    [modelBusy, setModelBusy] = useState(false),
    [reload, setReload] = useState(false);
  const alive = useRef(true),
    working = useRef(false),
    previewSequence = useRef(0),
    loadSequence = useRef(0);
  const draftKey = (id?: string) => automationDraftKey(projectId, id);
  const dirty =
    !sameSetting(draft, selected ? editableAutomationJob(selected) : fresh()) ||
    commands !== formatAutomationCommands(selected?.verification?.commands ?? []);
  useEffect(() => {
    const snapshot = { selected, draft, commands };
    activeDrafts.set(projectId, snapshot);
    if (dirty) jobDrafts.set(draftKey(selected?.id), snapshot);
    else jobDrafts.delete(draftKey(selected?.id));
  }, [projectId, selected, draft, commands, dirty]);
  const persisted = useAutomationDraftPersistence({
    projectId,
    activeId: selected?.id,
    restore: (saved, updatedAt) => {
      setSelected(saved.selected);
      setDraft(saved.draft);
      setCommands(saved.commands);
      setPreview(null);
      setNotice(
        updatedAt
          ? t('automation.recoveredAt', { time: displayDateTime(updatedAt) })
          : t('automation.recovered'),
      );
    },
  });
  const current = selected && data.jobs.find((job) => job.id === selected.id);
  const staleBase = dirty && current && (current.revision ?? 1) !== (selected.revision ?? 1);
  const load = useCallback(async () => {
    const sequence = ++loadSequence.current;
    const next = (await http('/api/automation/state')) as AutomationStateView;
    if (alive.current && sequence === loadSequence.current) setData(next);
    return next;
  }, [http]);
  useEffect(() => {
    alive.current = true;
    void load().catch((error: unknown) =>
      setError(String(error instanceof Error ? error.message : error)),
    );
    const timer = setInterval(() => {
      void load().catch(() => {});
    }, 5000);
    return () => {
      alive.current = false;
      previewSequence.current++;
      loadSequence.current++;
      clearInterval(timer);
    };
  }, [load]);
  const run = async (action: () => Promise<unknown>) => {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await action();
      await load();
    } catch (error) {
      if (alive.current) setError(error instanceof Error ? error.message : String(error));
    } finally {
      working.current = false;
      if (alive.current) setBusy(false);
    }
  };
  const edit = (job: AutomationJobRecord | null, discard = false) => {
    if (discard) jobDrafts.delete(draftKey(job?.id));
    const restored = discard ? undefined : jobDrafts.get(draftKey(job?.id));
    previewSequence.current++;
    setSelected(restored?.selected ?? job);
    setDraft(restored?.draft ?? (job ? editableAutomationJob(job) : fresh()));
    setCommands(restored?.commands ?? formatAutomationCommands(job?.verification?.commands ?? []));
    setPreview(null);
    setNotice(restored ? t('automation.recoveredJob') : '');
  };
  const spec = (): AutomationJobInput => ({
    ...draft,
    ...(commands.trim()
      ? {
          verification: {
            commands: parseAutomationCommands(commands),
            timeoutMs: draft.verification?.timeoutMs ?? 120000,
          },
        }
      : { verification: undefined }),
  });
  const update = <K extends keyof AutomationJobInput>(key: K, value: AutomationJobInput[K]) => {
    previewSequence.current++;
    setDraft((draft) => ({ ...draft, [key]: value }));
    setPreview(null);
  };
  const save = () =>
    run(async () => {
      const saved = (await http(
        selected ? `/api/automation/jobs/${selected.id}` : '/api/automation/jobs',
        selected ? 'PUT' : 'POST',
        { spec: spec(), ...(selected ? { expectedRevision: selected.revision ?? 1 } : {}) },
      )) as AutomationJobRecord;
      if (!alive.current) return;
      jobDrafts.delete(draftKey(selected?.id));
      edit(saved, true);
      setNotice(t('automation.savedNotice'));
    });
  const exportJob = () =>
    run(async () => {
      if (!selected) return;
      const doc = await http(`/api/automation/jobs/${selected.id}/export`);
      const link = document.createElement('a');
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' }),
      );
      link.href = url;
      link.download = `${selected.name.replace(/[^a-z0-9-]/gi, '-')}.automation.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
  const importJob = async (file: File) =>
    run(async () => {
      const document: unknown = JSON.parse(await file.text());
      const saved = (await http('/api/automation/import', 'POST', {
        document,
      })) as AutomationJobRecord;
      if (!alive.current) return;
      edit(saved, true);
      setNotice(t('automation.imported'));
    });
  return (
    <div className="feature-management automation-workspace">
      <div className="feature-toolbar">
        <span className={`automation-worker ${data.workerOnline ? 'online' : ''}`}>
          {data.workerOnline ? t('automation.workerOnline') : t('automation.workerOffline')}
        </span>
        <button
          type="button"
          className="button secondary"
          onClick={() => void run(load)}
          disabled={busy}
        >
          <RefreshCw size={13} />
          {t('automation.refresh')}
        </button>
        <label className="button secondary feature-import">
          {t('automation.import')}
          <input
            type="file"
            accept="application/json,.json"
            aria-label={t('automation.importLabel')}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void importJob(file);
              event.target.value = '';
            }}
          />
        </label>
        <button type="button" className="button primary" disabled={busy} onClick={() => edit(null)}>
          <Plus size={13} />
          {t('automation.new')}
        </button>
      </div>
      {error && (
        <p className="session-error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="feature-notice" role="status">
          {notice}
        </p>
      )}
      <p className="automation-draft-status" role="status">
        {dirty
          ? t('automation.unsavedDraft')
          : selected
            ? t('automation.savedRevision', { revision: selected.revision ?? 1 })
            : t('automation.new')}{' '}
        · {t('automation.keptNote')}{' '}
        <button type="button" className="text-link" disabled={busy} onClick={() => setReload(true)}>
          {t('automation.discardReload')}
        </button>
      </p>
      {staleBase && (
        <p className="session-error" role="alert">
          {t('automation.stale', {
            current: current.revision ?? 1,
            base: selected.revision ?? 1,
          })}
        </p>
      )}
      <AutomationDraftPersistenceStatus {...persisted} />
      <AutomationTemplates
        disabled={busy}
        onApply={(id) => {
          const item = VERSIONED_AUTOMATION_TEMPLATES.find((entry) => entry.id === id);
          if (item) {
            update('name', item.name);
            update('prompt', item.prompt);
            update('template', { id: item.id, version: item.version });
          }
        }}
      />
      <div className="feature-split">
        <div>
          <section className="feature-record-list" aria-label={t('automation.jobsLabel')}>
            {data.jobs.map((job) => (
              <button
                type="button"
                key={job.id}
                disabled={busy}
                className={selected?.id === job.id ? 'selected-record' : ''}
                onClick={() => edit(job)}
              >
                <strong>{job.name}</strong>
                <p>{job.prompt}</p>
                <span className="feature-meta">
                  {job.enabled ? t('automation.enabled') : t('automation.disabled')} ·{' '}
                  {job.schedule
                    ? `${job.schedule.expression} · ${job.schedule.timezone}`
                    : job.intervalMs
                      ? t('automation.everyMinutes', { count: job.intervalMs / 60000 })
                      : t('automation.manualOnly')}
                </span>
              </button>
            ))}
            {!data.jobs.length && <p className="quiet-state">{t('automation.noJobs')}</p>}
          </section>
          <section className="automation-runs">
            <h3>{t('automation.recentRuns')}</h3>
            {data.runs.length > 1 && (
              <button
                type="button"
                className="button secondary small"
                disabled={comparedRuns.length !== 2}
                onClick={() => setComparing(true)}
              >
                {comparedRuns.length === 2
                  ? t('automation.compareTwo')
                  : t('automation.comparePick')}
              </button>
            )}
            {data.runs.map((item) => (
              <article key={item.id}>
                <div>
                  {data.runs.length > 1 && (
                    <input
                      type="checkbox"
                      aria-label={t('automation.pickRun', { id: item.id.slice(0, 8) })}
                      checked={compared.includes(item.id)}
                      onChange={(event) =>
                        setCompared((current) =>
                          event.target.checked
                            ? [...current.filter((id) => id !== item.id), item.id].slice(-2)
                            : current.filter((id) => id !== item.id),
                        )
                      }
                    />
                  )}
                  <strong>{item.id.slice(0, 8)}</strong>
                  <span className="feature-meta">
                    {t(`automation.runStatus.${item.status}`, { defaultValue: item.status })} ·{' '}
                    {t(`automation.trigger.${item.trigger}`, { defaultValue: item.trigger })}
                  </span>
                </div>
                {item.error && <p>{item.error}</p>}
                <div className="feature-actions">
                  {['queued', 'running'].includes(item.status) && (
                    <button
                      type="button"
                      className="button secondary"
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          await http(`/api/automation/runs/${item.id}/cancel`, 'POST', {});
                        })
                      }
                    >
                      {t('automation.cancelRun')}
                    </button>
                  )}
                  <button
                    type="button"
                    className="button secondary"
                    onClick={() => setInspectedRun(item.id)}
                  >
                    {t('automation.inspectRun')}
                  </button>
                </div>
              </article>
            ))}
            {!data.runs.length && <p className="quiet-state">{t('automation.noRuns')}</p>}
          </section>
        </div>
        <form
          className="feature-editor"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <h3>{selected ? t('automation.editTitle') : t('automation.createTitle')}</h3>
          {draft.template && (
            <p className="automation-template-label">
              {t(`autoConfig.templateName.${draft.template.id}`, {
                defaultValue:
                  VERSIONED_AUTOMATION_TEMPLATES.find((item) => item.id === draft.template?.id)
                    ?.name ?? draft.template.id,
              })}{' '}
              · v{draft.template.version}
            </p>
          )}
          <fieldset className="automation-editor-fields" disabled={busy}>
            <label>
              {t('automation.name')}
              <input
                aria-label={t('automation.nameLabel')}
                required
                value={draft.name}
                onChange={(event) => update('name', event.target.value)}
              />
            </label>
            <label>
              {t('automation.image')}
              <input
                aria-label={t('automation.imageLabel')}
                required
                readOnly={!!draft.environment}
                value={draft.image}
                placeholder="wrongstack:latest"
                onChange={(event) => update('image', event.target.value)}
              />
            </label>
            <label>
              {t('automation.instructions')}
              <textarea
                aria-label={t('automation.instructionsLabel')}
                required
                rows={5}
                value={draft.prompt}
                onChange={(event) => update('prompt', event.target.value)}
              />
            </label>
            <div className="feature-field-grid">
              <label>
                {t('automation.provider')}
                <input
                  aria-label={t('automation.providerLabel')}
                  value={draft.provider ?? ''}
                  onChange={(event) => update('provider', event.target.value || undefined)}
                />
              </label>
              <label>
                {t('automation.model')}
                <input
                  aria-label={t('automation.modelLabel')}
                  value={draft.model ?? ''}
                  onChange={(event) => update('model', event.target.value || undefined)}
                />
              </label>
              <label>
                {t('automation.timeout')}
                <input
                  aria-label={t('automation.timeoutLabel')}
                  type="number"
                  min={1}
                  max={1440}
                  value={draft.timeoutMs / 60000}
                  onChange={(event) =>
                    update('timeoutMs', automationMilliseconds(event.target.value, 60000))
                  }
                />
              </label>
              <label>
                {t('automation.iterations')}
                <input
                  aria-label={t('automation.iterationsLabel')}
                  type="number"
                  min={1}
                  max={1000}
                  value={draft.maxIterations ?? 40}
                  onChange={(event) => update('maxIterations', Number(event.target.value))}
                />
              </label>
            </div>
            <div className="feature-actions">
              <button
                type="button"
                className="button secondary"
                onClick={() => setModelPicker(true)}
              >
                {t('automation.chooseModel')}
              </button>
              <button
                type="button"
                className="text-link"
                onClick={() => {
                  update('provider', undefined);
                  update('model', undefined);
                }}
              >
                {t('automation.inheritModel')}
              </button>
            </div>
            <AutomationConfiguration
              key={selected?.id ?? '@new'}
              draft={draft}
              update={update}
              onEditEnvironment={() => setEnvironmentOpen(true)}
            />
            <label>
              {t('automation.envNames')}
              <input
                aria-label={t('automation.envNamesLabel')}
                value={draft.envNames.join(', ')}
                placeholder={t('automation.envNamesPlaceholder')}
                onChange={(event) =>
                  update(
                    'envNames',
                    event.target.value
                      .split(',')
                      .map((name) => name.trim())
                      .filter(Boolean),
                  )
                }
              />
            </label>
            <label>
              {t('automation.schedule')}
              <select
                aria-label={t('automation.scheduleLabel')}
                value={draft.schedule ? 'cron' : draft.intervalMs ? 'interval' : 'manual'}
                onChange={(event) => {
                  previewSequence.current++;
                  setPreview(null);
                  const kind = event.target.value;
                  setDraft((draft) => ({
                    ...draft,
                    schedule:
                      kind === 'cron'
                        ? {
                            type: 'cron',
                            expression: '0 9 * * *',
                            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
                          }
                        : undefined,
                    intervalMs: kind === 'interval' ? 3600000 : undefined,
                  }));
                }}
              >
                <option value="manual">{t('automation.manualOnly')}</option>
                <option value="interval">{t('automation.scheduleInterval')}</option>
                <option value="cron">{t('automation.scheduleCron')}</option>
              </select>
            </label>
            {draft.intervalMs && (
              <label>
                {t('automation.interval')}
                <input
                  aria-label={t('automation.intervalLabel')}
                  type="number"
                  min={1}
                  value={draft.intervalMs / 60000}
                  onChange={(event) =>
                    update('intervalMs', automationMilliseconds(event.target.value, 60000))
                  }
                />
              </label>
            )}
            {draft.schedule && (
              <div className="feature-field-grid">
                <label>
                  {t('automation.cron')}
                  <input
                    aria-label={t('automation.cronLabel')}
                    value={draft.schedule.expression}
                    onChange={(event) =>
                      update('schedule', { ...draft.schedule!, expression: event.target.value })
                    }
                  />
                </label>
                <TimeZoneInput
                  label={t('automation.timezone')}
                  aria-label={t('automation.timezoneLabel')}
                  value={draft.schedule.timezone}
                  onChange={(event) =>
                    update('schedule', { ...draft.schedule!, timezone: event.target.value })
                  }
                />
              </div>
            )}
            <label>
              {t('automation.verifyCommands')}
              <textarea
                aria-label={t('automation.verifyCommandsLabel')}
                rows={3}
                value={commands}
                onChange={(event) => {
                  previewSequence.current++;
                  setPreview(null);
                  setCommands(event.target.value);
                }}
                placeholder={'bun run typecheck\nbun run test'}
              />
            </label>
            <label>
              {t('automation.verifyTimeout')}
              <input
                aria-label={t('automation.verifyTimeoutLabel')}
                type="number"
                min={1}
                max={3600}
                value={(draft.verification?.timeoutMs ?? 120000) / 1000}
                onChange={(event) =>
                  update('verification', {
                    commands: draft.verification?.commands ?? [],
                    timeoutMs: automationMilliseconds(event.target.value, 1000),
                  })
                }
              />
            </label>
            {!selected && (
              <label className="feature-checkbox">
                <input
                  type="checkbox"
                  checked={draft.enabled}
                  onChange={(event) => update('enabled', event.target.checked)}
                />
                {t('automation.enable')}
              </label>
            )}
            <label className="feature-checkbox">
              <input
                type="checkbox"
                checked={draft.yolo}
                onChange={(event) => update('yolo', event.target.checked)}
              />
              {t('automation.yolo')}
            </label>
            {preview && (
              <div className="automation-preview">
                <h4>{t('automation.launchPreview')}</h4>
                <p>
                  {preview.nextRunTimes.length
                    ? preview.nextRunTimes.map((time) => displayDateTime(time)).join(' · ')
                    : t('automation.manualExecution')}
                </p>
                {preview.missingReferences.length > 0 && (
                  <p>
                    {t('automation.missingRefs', { refs: preview.missingReferences.join(', ') })}
                  </p>
                )}
                <details>
                  <summary>{t('automation.runtimeCommand')}</summary>
                  <pre>{preview.args.join(' ')}</pre>
                </details>
              </div>
            )}
            <div className="feature-actions">
              <button
                type="button"
                className="button secondary"
                disabled={busy || !draft.name || !draft.image || !draft.prompt}
                onClick={() =>
                  void run(async () => {
                    const sequence = ++previewSequence.current;
                    const result = (await http('/api/automation/preview', 'POST', {
                      spec: spec(),
                    })) as AutomationPreview;
                    if (alive.current && sequence === previewSequence.current) setPreview(result);
                  })
                }
              >
                <Eye size={13} />
                {t('automation.preview')}
              </button>
              <button type="submit" className="button primary" disabled={busy}>
                <Save size={13} />
                {busy ? t('automation.working') : t('automation.save')}
              </button>
            </div>
            {selected && (
              <div className="feature-actions">
                <button
                  type="button"
                  className="button secondary"
                  disabled={busy || dirty}
                  onClick={() =>
                    void run(async () => {
                      await http(`/api/automation/jobs/${selected.id}/run`, 'POST', {
                        expectedRevision: selected.revision ?? 1,
                      });
                      setNotice(t('automation.queuedNotice'));
                    })
                  }
                >
                  <Play size={13} />
                  {t('automation.queueRun')}
                </button>
                <button
                  type="button"
                  className="button secondary"
                  disabled={busy || dirty}
                  onClick={() =>
                    void run(async () => {
                      await http(`/api/automation/jobs/${selected.id}/enabled`, 'POST', {
                        enabled: !selected.enabled,
                        expectedRevision: selected.revision ?? 1,
                      });
                      const latest = (await http('/api/automation/state')) as AutomationStateView;
                      setData(latest);
                      const updated = latest.jobs.find((job) => job.id === selected.id);
                      if (updated && alive.current) edit(updated, true);
                    })
                  }
                >
                  {selected.enabled ? <Pause size={13} /> : <Play size={13} />}
                  {selected.enabled ? t('automation.disable') : t('automation.enableButton')}
                </button>
                <button
                  type="button"
                  className="button secondary"
                  disabled={busy}
                  onClick={() => void exportJob()}
                >
                  <Download size={13} />
                  {t('automation.export')}
                </button>
                <button
                  type="button"
                  className="button secondary danger"
                  disabled={busy || dirty}
                  onClick={() => setDeleting(selected)}
                >
                  <Trash2 size={13} />
                  {t('automation.delete')}
                </button>
              </div>
            )}
          </fieldset>
        </form>
      </div>
      {deleting && (
        <Modal title={t('automation.deleteTitle')} onClose={() => setDeleting(null)}>
          <section className="automation-delete" aria-label={t('automation.deleteTitle')}>
            <p>
              <Trans
                i18n={surfaceI18n}
                ns="desktop"
                i18nKey="automation.deleteBody"
                values={{ name: deleting.name }}
                components={{ strong: <strong /> }}
              />
            </p>
            <div className="feature-actions">
              <button
                type="button"
                className="button secondary"
                disabled={busy}
                onClick={() => setDeleting(null)}
              >
                {t('automation.keepIt')}
              </button>
              <button
                type="button"
                className="button primary danger"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    const target = deleting;
                    const result = (await http(
                      `/api/automation/jobs/${target.id}?expectedRevision=${target.revision ?? 1}`,
                      'DELETE',
                    )) as { removedRuns?: unknown };
                    if (!alive.current) return;
                    setDeleting(null);
                    jobDrafts.delete(draftKey(target.id));
                    edit(null, true);
                    setNotice(
                      typeof result?.removedRuns === 'number'
                        ? t('automation.deletedRuns', {
                            count: result.removedRuns,
                            name: target.name,
                          })
                        : t('automation.deleted', { name: target.name }),
                    );
                  })
                }
              >
                {t('automation.deleteTitle')}
              </button>
            </div>
          </section>
        </Modal>
      )}
      {comparing && comparedRuns.length === 2 && (
        <AutomationRunComparison
          left={comparedRuns[0]!}
          right={comparedRuns[1]!}
          onClose={() => setComparing(false)}
        />
      )}
      {inspectedRun && data.runs.some((run) => run.id === inspectedRun) && (
        <AutomationRunInspector
          key={inspectedRun}
          run={data.runs.find((run) => run.id === inspectedRun)!}
          http={http}
          onClose={() => setInspectedRun(null)}
        />
      )}
      {modelPicker && (
        <Modal
          title={t('automation.chooseModel')}
          onClose={() => {
            if (!modelBusy) setModelPicker(false);
          }}
        >
          <ProfileModelPicker
            session={{
              ...emptyEngineState,
              provider: draft.provider ?? '',
              model: draft.model ?? '',
            }}
            title={t('automation.chooseModel')}
            description={t('automation.modelHelp')}
            onPick={(provider, model) => {
              update('provider', provider);
              update('model', model);
            }}
            onClose={() => {
              if (!modelBusy) setModelPicker(false);
            }}
            onBusy={setModelBusy}
          />
        </Modal>
      )}
      {environmentOpen && (
        <AutomationEnvironmentEditor
          {...(draft.environment ? { value: draft.environment } : {})}
          image={draft.image}
          projectId={projectId}
          jobId={selected?.id}
          onClose={() => setEnvironmentOpen(false)}
          onApply={(profile) => {
            update('environment', profile);
            update('image', profile.image);
          }}
        />
      )}
      {reload && (
        <Modal
          title={t('automation.reloadTitle')}
          onClose={() => {
            if (!busy) setReload(false);
          }}
        >
          <div className="automation-template-review">
            <h2>{t('automation.reloadAsk')}</h2>
            <p>{t('automation.reloadHelp')}</p>
            <button
              type="button"
              className="button secondary"
              disabled={busy}
              onClick={() => setReload(false)}
            >
              {t('automation.keepEditing')}
            </button>
            <button
              type="button"
              className="button primary"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const latest = await load();
                  if (!alive.current) return;
                  jobDrafts.delete(draftKey(selected?.id));
                  edit(latest.jobs.find((job) => job.id === selected?.id) ?? null, true);
                  setReload(false);
                })
              }
            >
              {t('automation.discardReloadConfirm')}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
