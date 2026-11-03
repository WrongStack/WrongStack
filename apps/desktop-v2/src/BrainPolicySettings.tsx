import { Brain, RefreshCw, Save } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { BrainPolicyEvidence } from './BrainPolicyEvidence';
import { BrainRules } from './BrainRules';
import { BrainTargetEditor } from './BrainTargetEditor';
import {
  type BrainDraft,
  brainDraft,
  brainGroups,
  brainMonitorResetPatch,
  brainPatch,
  brainSnapshot,
  brainValue,
} from './brain-policy-model';
import {
  type BrainTargetsDraft,
  brainTargetsDraft,
  brainTargetsPatch,
  mergeBrainPatches,
  verifyBrainTargets,
} from './brain-targets-model';
import type { EngineCommand } from './engine-operations';
import { record } from './engine-values';
import { sameSetting } from './settings-save-model';
import './brain-policy.css';

export function BrainPolicySettings({ command }: { command: EngineCommand }) {
  const policy = useRef<HTMLElement>(null);
  const [snapshot, setSnapshot] = useState<Record<string, unknown> | null>(null);
  const [base, setBase] = useState<BrainDraft>({}),
    [draft, setDraft] = useState<BrainDraft>({});
  const [targetBase, setTargetBase] = useState<BrainTargetsDraft>(() => brainTargetsDraft({}));
  const [targets, setTargets] = useState<BrainTargetsDraft>(() => brainTargetsDraft({}));
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const [resetMonitor, setResetMonitor] = useState(false);
  const generation = useRef(0),
    saving = useRef(false);
  const read = useCallback(
    async () =>
      brainSnapshot(
        await command('brain.config.get', {}, ['brain.config', 'key.operation_result']),
      ),
    [command],
  );
  const accept = (config: Record<string, unknown>) => {
    setResetMonitor(false);
    setSnapshot(config);
    const values = brainDraft(config);
    setBase(values);
    setDraft(values);
    const modelValues = brainTargetsDraft(config);
    setTargetBase(modelValues);
    setTargets(modelValues);
  };
  const reload = useCallback(async () => {
    const current = ++generation.current;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const config = await read();
      if (current === generation.current) accept(config);
    } catch (error) {
      if (current === generation.current)
        setError(error instanceof Error ? error.message : String(error));
    } finally {
      if (current === generation.current) setBusy(false);
    }
  }, [read]);
  useEffect(() => {
    void reload();
    return () => {
      generation.current++;
    };
  }, [reload]);
  const dirty = [
    ...(resetMonitor ? ['monitor reset'] : []),
    ...Object.keys(draft).filter((key) => !sameSetting(draft[key], base[key])),
    ...(['pool', 'strategy', 'voters', 'seats', 'judge'] as const).filter(
      (key) => !sameSetting(targets[key], targetBase[key]),
    ),
  ];
  const change = (key: string, value: string | boolean) => {
    setDraft((current) => ({ ...current, [key]: value }));
    setNotice('');
  };
  const save = async () => {
    if (saving.current) return;
    saving.current = true;
    const current = ++generation.current;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const live = await read();
      const policyDraft = resetMonitor
        ? {
            ...draft,
            ...Object.fromEntries(
              Object.entries(base).filter(([key]) => key.startsWith('monitor.')),
            ),
          }
        : draft;
      const patch = mergeBrainPatches(
        {
          ...brainPatch(base, policyDraft, brainDraft(live), live),
          ...(resetMonitor ? brainMonitorResetPatch(snapshot ?? {}, live) : {}),
        },
        brainTargetsPatch(targetBase, targets, brainTargetsDraft(live)),
      );
      if (!Object.keys(patch).length) {
        if (current === generation.current) {
          accept(live);
          setNotice('Brain policy already matches saved values.');
        }
        return;
      }
      const result = await command('brain.config.set', { patch }, [
        'brain.config',
        'key.operation_result',
      ]);
      if (result['persisted'] !== true)
        throw Error(
          'The Brain policy was not confirmed on disk. Reload its live configuration before retrying.',
        );
      const saved = await read();
      if (resetMonitor && Object.keys(record(saved['monitor'])).length)
        throw Error(
          'Monitor overrides were not cleared. Reload saved Brain values before retrying.',
        );
      verifyBrainTargets(patch, saved);
      for (const field of brainGroups.flatMap((group) => group.fields)) {
        const desired = brainValue(patch, field.key);
        if (
          desired !== undefined &&
          desired !== null &&
          !sameSetting(
            desired,
            field.kind === 'text'
              ? String(brainValue(saved, field.read ?? field.key) ?? '')
              : brainValue(saved, field.read ?? field.key),
          )
        )
          throw Error(
            `${field.label} did not match the saved Brain configuration. Reload before retrying.`,
          );
      }
      if (current === generation.current) {
        accept(saved);
        setNotice('Brain policy saved and verified in this profile runtime.');
      }
    } catch (error) {
      if (current === generation.current)
        setError(error instanceof Error ? error.message : String(error));
    } finally {
      saving.current = false;
      if (current === generation.current) setBusy(false);
    }
  };
  const cache = record(snapshot?.['cache']),
    council = record(snapshot?.['council']);
  return (
    <section className="brain-policy" aria-label="Brain policy settings" ref={policy}>
      <header>
        <div>
          <span className="eyebrow">ACTIVE PROFILE · DECISION POLICY</span>
          <h2>
            <Brain size={24} /> Brain policy
          </h2>
          <p>
            Configure the decision ladder: deterministic rules, heuristics, cache, council, models
            and operator escalation.
          </p>
        </div>
        <button
          type="button"
          className="button secondary"
          disabled={busy}
          onClick={() => void reload()}
        >
          <RefreshCw size={14} />
          {dirty.length ? 'Reload saved Brain values (discard drafts)' : 'Refresh Brain policy'}
        </button>
      </header>
      <p className="brain-scope-note">
        Saved to the active profile and applied to this settings runtime. Other running project and
        conversation runtimes keep their own configuration. Decision histories belong to their
        originating runtimes.
      </p>
      {error && (
        <p role="alert" className="session-error">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="feature-notice">
          {notice}
        </p>
      )}
      {!snapshot ? (
        <p role="status">
          {busy ? 'Reading Brain policy…' : 'Brain configuration is unavailable. Refresh to retry.'}
        </p>
      ) : (
        <>
          <div className="brain-facts">
            <span>
              <strong>{String(cache['hits'] ?? '—')}</strong> cache hits
            </span>
            <span>
              <strong>{String(cache['misses'] ?? '—')}</strong> cache misses
            </span>
            <span>
              <strong>{String(cache['size'] ?? '—')}</strong> cached decisions
            </span>
            <span>
              <strong>{council['enabled'] === true ? 'Active' : 'Inactive'}</strong> effective
              council
            </span>
          </div>
          <BrainRules snapshot={snapshot} />
          <nav className="brain-jump" aria-label="Brain policy groups">
            <span>Jump to section</span>
            {[
              { id: 'models', title: 'Models & council' },
              ...brainGroups.map((group, index) => ({ id: String(index), title: group.title })),
            ].map((group) => (
              <button
                type="button"
                key={group.id}
                onClick={() =>
                  policy.current
                    ?.querySelector<HTMLElement>(`[data-brain-group="${group.id}"]`)
                    ?.scrollIntoView({ block: 'start' })
                }
              >
                {group.title}
              </button>
            ))}
          </nav>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <fieldset disabled={busy} className="brain-policy-fields">
              <div data-brain-group="models">
                <BrainTargetEditor
                  value={targets}
                  snapshot={snapshot}
                  command={command}
                  onChange={(next) => {
                    setTargets(next);
                    setNotice('');
                  }}
                />
              </div>
              {brainGroups.map((group, index) => (
                <article className="brain-policy-card" key={group.title} data-brain-group={index}>
                  <header>
                    <h3>{group.title}</h3>
                    <p>{group.description}</p>
                  </header>
                  {group.title === 'Runtime monitor' && (
                    <div className="brain-monitor-reset">
                      <p>
                        {resetMonitor
                          ? 'Engine defaults are previewed below. Save Brain policy to remove every monitor override, including custom tool matching and additional signal settings.'
                          : Object.keys(record(snapshot['monitor'])).length
                            ? 'This profile has saved monitor overrides. Resetting removes the entire monitor override group; other Brain settings are kept.'
                            : 'This profile inherits the engine monitor defaults.'}
                      </p>
                      <button
                        type="button"
                        className="button secondary small"
                        disabled={
                          !resetMonitor &&
                          !Object.keys(record(snapshot['monitor'])).length &&
                          !Object.keys(draft).some(
                            (key) =>
                              key.startsWith('monitor.') && !sameSetting(draft[key], base[key]),
                          )
                        }
                        onClick={() => {
                          const monitor = resetMonitor ? base : brainDraft({ monitor: {} });
                          setDraft((current) => ({
                            ...current,
                            ...Object.fromEntries(
                              Object.entries(monitor).filter(([key]) => key.startsWith('monitor.')),
                            ),
                          }));
                          setResetMonitor(!resetMonitor);
                          setError('');
                          setNotice('');
                        }}
                      >
                        {resetMonitor
                          ? 'Keep saved monitor overrides'
                          : 'Use inherited monitor defaults'}
                      </button>
                    </div>
                  )}
                  <div className="brain-field-grid">
                    {group.fields.map((field) => (
                      <label
                        htmlFor={`brain-${field.key}`}
                        className={`brain-field ${field.kind === 'toggle' ? 'brain-toggle' : ''}`}
                        key={field.key}
                      >
                        <span>
                          <strong>{field.label}</strong>
                          <small>{field.help}</small>
                        </span>
                        {field.kind === 'toggle' ? (
                          <input
                            id={`brain-${field.key}`}
                            type="checkbox"
                            aria-label={field.label}
                            disabled={resetMonitor && field.key.startsWith('monitor.')}
                            checked={draft[field.key] === true}
                            onChange={(event) => change(field.key, event.target.checked)}
                          />
                        ) : field.kind === 'select' ? (
                          <select
                            id={`brain-${field.key}`}
                            aria-label={field.label}
                            disabled={resetMonitor && field.key.startsWith('monitor.')}
                            required={!field.optional}
                            value={String(draft[field.key] ?? '')}
                            onChange={(event) => change(field.key, event.target.value)}
                          >
                            {field.optional && <option value="">Automatic / inherit</option>}
                            {field.options?.map((value) => (
                              <option key={value} value={value}>
                                {value === 'true'
                                  ? 'Enabled'
                                  : value === 'false'
                                    ? 'Disabled'
                                    : value.replaceAll('-', ' ')}
                              </option>
                            ))}
                          </select>
                        ) : field.kind === 'lines' ? (
                          <textarea
                            id={`brain-${field.key}`}
                            aria-label={field.label}
                            disabled={resetMonitor && field.key.startsWith('monitor.')}
                            rows={5}
                            value={String(draft[field.key] ?? '')}
                            onChange={(event) => change(field.key, event.target.value)}
                          />
                        ) : (
                          <input
                            id={`brain-${field.key}`}
                            type={field.kind === 'text' ? 'text' : 'number'}
                            aria-label={field.label}
                            disabled={resetMonitor && field.key.startsWith('monitor.')}
                            min={field.min}
                            max={field.max}
                            step={field.step ?? 1}
                            required={field.kind === 'number' && !field.optional}
                            value={String(draft[field.key] ?? '')}
                            placeholder={field.optional ? 'Inherit engine default' : undefined}
                            onChange={(event) => change(field.key, event.target.value)}
                          />
                        )}
                      </label>
                    ))}
                  </div>
                </article>
              ))}
            </fieldset>
            <div className="brain-save-bar">
              <span>
                {dirty.length
                  ? `${dirty.length} unsaved Brain changes`
                  : 'Brain policy matches saved values'}
              </span>
              <button
                type="button"
                className="button secondary"
                disabled={busy || !dirty.length}
                onClick={() => {
                  setDraft(base);
                  setResetMonitor(false);
                  setTargets(targetBase);
                  setError('');
                  setNotice('');
                }}
              >
                Discard Brain changes
              </button>
              <button type="submit" className="button primary" disabled={busy || !dirty.length}>
                <Save size={14} />
                {busy ? 'Saving…' : 'Save Brain policy'}
              </button>
            </div>
          </form>
          <BrainPolicyEvidence snapshot={snapshot} />
        </>
      )}
    </section>
  );
}
