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
import { Download, Eye, Pause, Play, Plus, RefreshCw, Save } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AutomationConfiguration, AutomationTemplates } from './AutomationConfiguration';
import { AutomationEnvironmentEditor } from './AutomationEnvironmentEditor';
import { AutomationRunInspector } from './AutomationRunInspector';
import { activeDrafts, automationDraftKey, jobDrafts } from './automation-draft';
import { automationMilliseconds } from './automation-units';
import type { EngineHttp } from './engine-http';
import { emptyEngineState } from './engine-state';
import { Modal } from './Modal';
import { ProfileModelPicker } from './ProfileModelPicker';
import { sameSetting } from './settings-save-model';
import {
  AutomationDraftPersistenceStatus,
  useAutomationDraftPersistence,
} from './useAutomationDraftPersistence';
import './automation-workspace.css';

const fresh = () => ({ ...createAutomationJobInput(), enabled: false });
export function AutomationWorkspace({ http, projectId }: { http: EngineHttp; projectId: string }) {
  const cached = useRef(activeDrafts.get(projectId)).current;
  const [data, setData] = useState<AutomationStateView>({
    jobs: [],
    runs: [],
    workerOnline: false,
  });
  const [selected, setSelected] = useState<AutomationJobRecord | null>(cached?.selected ?? null);
  const [draft, setDraft] = useState<AutomationJobInput>(cached?.draft ?? fresh());
  const [commands, setCommands] = useState(cached?.commands ?? '');
  const [preview, setPreview] = useState<AutomationPreview | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [inspectedRun, setInspectedRun] = useState<string | null>(null);
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
        `Recovered an unsaved automation draft${updatedAt ? ` saved ${new Date(updatedAt).toLocaleString()}` : ''}.`,
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
    setNotice(restored ? 'Recovered this job’s unsaved draft from this window.' : '');
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
      setNotice('The engine saved this automation.');
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
      setNotice('Imported as a disabled automation for local review.');
    });
  return (
    <div className="feature-management automation-workspace">
      <div className="feature-toolbar">
        <span className={`automation-worker ${data.workerOnline ? 'online' : ''}`}>
          {data.workerOnline ? 'Worker online' : 'Worker offline · jobs remain editable'}
        </span>
        <button
          type="button"
          className="button secondary"
          onClick={() => void run(load)}
          disabled={busy}
        >
          <RefreshCw size={13} />
          Refresh
        </button>
        <label className="button secondary feature-import">
          Import
          <input
            type="file"
            accept="application/json,.json"
            aria-label="Import automation"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void importJob(file);
              event.target.value = '';
            }}
          />
        </label>
        <button type="button" className="button primary" disabled={busy} onClick={() => edit(null)}>
          <Plus size={13} />
          New automation
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
          ? 'Unsaved job draft'
          : selected
            ? `Saved revision ${selected.revision ?? 1}`
            : 'New automation'}{' '}
        · Unsaved drafts are kept per job and restored after a restart.{' '}
        <button type="button" className="text-link" disabled={busy} onClick={() => setReload(true)}>
          Discard draft / reload saved
        </button>
      </p>
      {staleBase && (
        <p className="session-error" role="alert">
          This job was saved again (revision {current.revision ?? 1}) after this draft started from
          revision {selected.revision ?? 1}. Saving is refused; copy what you need, then discard the
          draft and reload the saved job.
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
          <section className="feature-record-list" aria-label="Automation jobs">
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
                  {job.enabled ? 'Enabled' : 'Disabled'} ·{' '}
                  {job.schedule
                    ? `${job.schedule.expression} · ${job.schedule.timezone}`
                    : job.intervalMs
                      ? `Every ${job.intervalMs / 60000} minutes`
                      : 'Manual only'}
                </span>
              </button>
            ))}
            {!data.jobs.length && <p className="quiet-state">No automations in this project.</p>}
          </section>
          <section className="automation-runs">
            <h3>Recent runs</h3>
            {data.runs.map((item) => (
              <article key={item.id}>
                <div>
                  <strong>{item.id.slice(0, 8)}</strong>
                  <span className="feature-meta">
                    {item.status} · {item.trigger}
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
                      Cancel run
                    </button>
                  )}
                  <button
                    type="button"
                    className="button secondary"
                    onClick={() => setInspectedRun(item.id)}
                  >
                    Inspect run
                  </button>
                </div>
              </article>
            ))}
            {!data.runs.length && (
              <p className="quiet-state">Queued and completed runs appear here.</p>
            )}
          </section>
        </div>
        <form
          className="feature-editor"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <h3>{selected ? 'Edit automation' : 'Create automation'}</h3>
          {draft.template && (
            <p className="automation-template-label">
              {VERSIONED_AUTOMATION_TEMPLATES.find((item) => item.id === draft.template?.id)
                ?.name ?? draft.template.id}{' '}
              · v{draft.template.version}
            </p>
          )}
          <fieldset className="automation-editor-fields" disabled={busy}>
            <label>
              Name
              <input
                aria-label="Automation name"
                required
                value={draft.name}
                onChange={(event) => update('name', event.target.value)}
              />
            </label>
            <label>
              Runtime image
              <input
                aria-label="Automation image"
                required
                readOnly={!!draft.environment}
                value={draft.image}
                placeholder="wrongstack:latest"
                onChange={(event) => update('image', event.target.value)}
              />
            </label>
            <label>
              Instructions
              <textarea
                aria-label="Automation instructions"
                required
                rows={5}
                value={draft.prompt}
                onChange={(event) => update('prompt', event.target.value)}
              />
            </label>
            <div className="feature-field-grid">
              <label>
                Provider
                <input
                  aria-label="Automation provider"
                  value={draft.provider ?? ''}
                  onChange={(event) => update('provider', event.target.value || undefined)}
                />
              </label>
              <label>
                Model
                <input
                  aria-label="Automation model"
                  value={draft.model ?? ''}
                  onChange={(event) => update('model', event.target.value || undefined)}
                />
              </label>
              <label>
                Timeout (minutes)
                <input
                  aria-label="Automation timeout"
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
                Maximum iterations
                <input
                  aria-label="Automation iterations"
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
                Choose automation model
              </button>
              <button
                type="button"
                className="text-link"
                onClick={() => {
                  update('provider', undefined);
                  update('model', undefined);
                }}
              >
                Inherit model routing
              </button>
            </div>
            <AutomationConfiguration
              key={selected?.id ?? '@new'}
              draft={draft}
              update={update}
              onEditEnvironment={() => setEnvironmentOpen(true)}
            />
            <label>
              Environment variable names
              <input
                aria-label="Automation environment names"
                value={draft.envNames.join(', ')}
                placeholder="Names only, separated by commas"
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
              Schedule
              <select
                aria-label="Automation schedule"
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
                <option value="manual">Manual only</option>
                <option value="interval">Interval</option>
                <option value="cron">Cron schedule</option>
              </select>
            </label>
            {draft.intervalMs && (
              <label>
                Interval (minutes)
                <input
                  aria-label="Automation interval"
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
                  Cron expression
                  <input
                    aria-label="Automation cron"
                    value={draft.schedule.expression}
                    onChange={(event) =>
                      update('schedule', { ...draft.schedule!, expression: event.target.value })
                    }
                  />
                </label>
                <label>
                  Timezone
                  <input
                    aria-label="Automation timezone"
                    value={draft.schedule.timezone}
                    onChange={(event) =>
                      update('schedule', { ...draft.schedule!, timezone: event.target.value })
                    }
                  />
                </label>
              </div>
            )}
            <label>
              Verification commands
              <textarea
                aria-label="Automation verification commands"
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
              Verification timeout (seconds)
              <input
                aria-label="Automation verification timeout"
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
            <label className="feature-checkbox">
              <input
                type="checkbox"
                checked={draft.enabled}
                onChange={(event) => update('enabled', event.target.checked)}
              />
              Enable this automation
            </label>
            <label className="feature-checkbox">
              <input
                type="checkbox"
                checked={draft.yolo}
                onChange={(event) => update('yolo', event.target.checked)}
              />
              Use the engine's YOLO permission mode
            </label>
            {preview && (
              <div className="automation-preview">
                <h4>Launch preview</h4>
                <p>
                  {preview.nextRunTimes.length
                    ? preview.nextRunTimes
                        .map((time) => new Date(time).toLocaleString())
                        .join(' · ')
                    : 'Manual execution'}
                </p>
                {preview.missingReferences.length > 0 && (
                  <p>Missing references: {preview.missingReferences.join(', ')}</p>
                )}
                <details>
                  <summary>Runtime command</summary>
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
                Preview
              </button>
              <button type="submit" className="button primary" disabled={busy}>
                <Save size={13} />
                {busy ? 'Working…' : 'Save automation'}
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
                      setNotice('The engine queued this run.');
                    })
                  }
                >
                  <Play size={13} />
                  Queue run
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
                  <Pause size={13} />
                  {selected.enabled ? 'Disable' : 'Enable'}
                </button>
                <button
                  type="button"
                  className="button secondary"
                  disabled={busy}
                  onClick={() => void exportJob()}
                >
                  <Download size={13} />
                  Export
                </button>
              </div>
            )}
          </fieldset>
        </form>
      </div>
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
          title="Choose automation model"
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
            title="Choose automation model"
            description="This selection updates the job draft. It does not switch any conversation."
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
          title="Reload automation draft"
          onClose={() => {
            if (!busy) setReload(false);
          }}
        >
          <div className="automation-template-review">
            <h2>Reload saved job?</h2>
            <p>
              This discards the current job's unsaved form. Other job drafts remain in this window.
            </p>
            <button
              type="button"
              className="button secondary"
              disabled={busy}
              onClick={() => setReload(false)}
            >
              Keep editing automation
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
              Discard and reload automation
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
