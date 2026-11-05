import { CheckCircle2, Circle, Compass, LoaderCircle, Pause, Play } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useDesktopText } from './desktop-i18n';
import type { EngineSend } from './engine-operations';
import { type EngineState, entries, record } from './engine-state';

const text = (value: unknown) => (typeof value === 'string' ? value : '');
const missionIdentity = (mission: Record<string, unknown>) =>
  JSON.stringify([mission['missionId'], mission['setAt'], mission['goal']]);
/** Mission requests, each with its own waiting notice. */
type MissionRequest = 'update' | 'refresh' | 'pause' | 'resume' | 'refine' | 'clear';

/** The persistent project mission is independent from executable phase graphs. */
export function ProjectMission({ state, send }: { state: EngineState; send: EngineSend }) {
  const { t } = useDesktopText();
  const mission = state.results['goal-state.updated'];
  const exists = Boolean(text(mission?.['goal']).trim());
  const identity = missionIdentity(mission ?? {});
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [editIdentity, setEditIdentity] = useState('');
  const [saveAttempt, setSaveAttempt] = useState<{ identity: string; goal: string } | null>(null);
  const [clearIdentity, setClearIdentity] = useState('');
  const [confirm, setConfirm] = useState<'replace' | 'clear' | null>(null);
  const [pending, setPending] = useState('');
  const [error, setError] = useState('');
  const seenError = useRef(state.results['goal-state.error']);
  const refinement = record(state.results['goal-state.refining']);
  // The reviewed mission; the engine refuses writes when goal.json holds another one.
  const missionKey = text(mission?.['missionId']) || text(mission?.['setAt']);
  const refining = Boolean(
    missionKey && refinement['missionId'] === missionKey && refinement['active'] === true,
  );
  useEffect(() => {
    void send('goal-state.get').catch((e) => setError(String(e)));
  }, [send]);
  useEffect(() => {
    if (mission) setPending('');
  }, [mission]);
  useEffect(() => {
    if (
      saveAttempt &&
      identity !== saveAttempt.identity &&
      mission?.['goal'] === saveAttempt.goal
    ) {
      setEditing(false);
      setSaveAttempt(null);
      setDraft('');
    }
  }, [mission, identity, saveAttempt]);
  useEffect(() => {
    const failure = state.results['goal-state.error'];
    if (failure && failure !== seenError.current) {
      setPending('');
      setError(text(failure['message']) || t('mission.failed'));
    }
    seenError.current = failure;
  }, [state.results['goal-state.error']]);
  const request = async (type: string, payload: Record<string, unknown>, kind: MissionRequest) => {
    setError('');
    setPending(t(`mission.requested.${kind}`));
    try {
      await send(type, payload);
    } catch (e) {
      setPending('');
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const beginEdit = () => {
    setDraft(text(mission?.['goal']));
    setEditIdentity(identity);
    setEditing(true);
    setConfirm(null);
    setError('');
  };
  const save = () => {
    if (!draft.trim()) return;
    if (editIdentity !== identity) {
      setConfirm(null);
      setError(t('mission.changedWhileEditing'));
      return;
    }
    if (exists && confirm !== 'replace') {
      setConfirm('replace');
      return;
    }
    setConfirm(null);
    setSaveAttempt({ identity, goal: draft.trim() });
    void request('goal-state.set', { goal: draft.trim(), expectedMission: missionKey }, 'update');
  };
  const progress = mission?.['progress'];
  const deliverables = Array.isArray(mission?.['deliverables']) ? mission['deliverables'] : [];
  const journal = entries(mission?.['journal']).filter(
    (row) => typeof row['iteration'] === 'number',
  );
  return (
    <section className="project-mission" aria-label={t('mission.label')}>
      <div className="project-mission-heading">
        <div className="project-mission-title">
          <Compass size={19} />
          <div>
            <span className="eyebrow">{t('mission.eyebrow')}</span>
            <h2>{t('mission.title')}</h2>
          </div>
        </div>
        <div className="project-mission-actions">
          {!editing && (
            <button type="button" className="button secondary" onClick={beginEdit}>
              {exists ? t('mission.replace') : t('mission.set')}
            </button>
          )}
        </div>
      </div>
      <p className="project-mission-intro">{t('mission.intro')}</p>
      {error && (
        <p className="session-error" role="alert">
          {error}
        </p>
      )}
      {pending && (
        <p className="goal-request" role="status">
          <LoaderCircle size={14} className="spin" /> {pending}
        </p>
      )}
      {editing ? (
        <div className="project-mission-editor">
          <label>
            {t('mission.mission')}
            <textarea
              aria-label={t('mission.mission')}
              value={draft}
              onChange={(event) => {
                setDraft(event.target.value);
                setConfirm(null);
                setSaveAttempt(null);
              }}
              placeholder={t('mission.placeholder')}
            />
          </label>
          {confirm === 'replace' && <p>{t('mission.replaceWarning')}</p>}
          <div className="project-mission-actions">
            <button
              type="button"
              className="button secondary"
              onClick={() => {
                setEditing(false);
                setConfirm(null);
                setSaveAttempt(null);
              }}
            >
              {t('mission.cancel')}
            </button>
            <button
              type="button"
              className="button primary"
              disabled={!draft.trim() || Boolean(pending)}
              onClick={save}
            >
              {confirm === 'replace' ? t('mission.confirmReplace') : t('mission.save')}
            </button>
          </div>
        </div>
      ) : !mission ? (
        <p className="project-mission-empty">{t('mission.loading')}</p>
      ) : !exists ? (
        <p className="project-mission-empty">{t('mission.none')}</p>
      ) : (
        <>
          <div className="project-mission-main">
            <div>
              <span className="project-mission-status">
                {text(mission['goalState'])
                  ? t(`mission.state.${text(mission['goalState'])}`, {
                      defaultValue: text(mission['goalState']),
                    })
                  : t('mission.statusMissing')}
              </span>
              {refining && (
                <span className="goal-request" role="status">
                  {t('mission.refining')}
                </span>
              )}
              <p className="project-mission-goal">{text(mission['goal'])}</p>
            </div>
            <div className="project-mission-actions">
              {mission['goalState'] === 'active' && (
                <button
                  type="button"
                  className="button secondary"
                  disabled={Boolean(pending)}
                  onClick={() =>
                    void request('goal-state.pause', { expectedMission: missionKey }, 'pause')
                  }
                >
                  <Pause size={13} /> {t('mission.pause')}
                </button>
              )}
              {mission['goalState'] === 'paused' && (
                <button
                  type="button"
                  className="button secondary"
                  disabled={Boolean(pending)}
                  onClick={() =>
                    void request('goal-state.resume', { expectedMission: missionKey }, 'resume')
                  }
                >
                  <Play size={13} /> {t('mission.resume')}
                </button>
              )}
              <button
                type="button"
                className="button secondary"
                disabled={refining || Boolean(pending)}
                onClick={() => void request('goal-state.refine', {}, 'refine')}
              >
                {t('mission.refine')}
              </button>
              {confirm === 'clear' ? (
                <>
                  <span>{t('mission.clearAsk')}</span>
                  <button
                    type="button"
                    className="button secondary"
                    onClick={() => {
                      setConfirm(null);
                      if (clearIdentity !== identity) {
                        setError(t('mission.changedBeforeClear'));
                        return;
                      }
                      void request('goal-state.clear', { expectedMission: missionKey }, 'clear');
                    }}
                  >
                    {t('mission.confirmClear')}
                  </button>
                  <button type="button" onClick={() => setConfirm(null)}>
                    {t('mission.cancel')}
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="button secondary"
                  disabled={Boolean(pending)}
                  onClick={() => {
                    setClearIdentity(identity);
                    setConfirm('clear');
                  }}
                >
                  {t('mission.clear')}
                </button>
              )}
            </div>
          </div>
          {text(mission['refinedGoal']) && mission['refinedGoal'] !== mission['goal'] && (
            <div className="project-mission-refined">
              <span className="eyebrow">{t('mission.refinedEyebrow')}</span>
              <p>{text(mission['refinedGoal'])}</p>
            </div>
          )}
          <div className="project-mission-metrics">
            <span>
              {t('mission.progress')}{' '}
              <strong>
                {typeof progress === 'number' && Number.isFinite(progress)
                  ? `${progress}%`
                  : t('mission.notReported')}
              </strong>
            </span>
            <span>
              {t('mission.iterations')}{' '}
              <strong>
                {typeof mission['iterations'] === 'number'
                  ? mission['iterations']
                  : t('mission.notReported')}
              </strong>
            </span>
            {text(mission['lastStatus']) && (
              <span>
                {t('mission.lastStatus')} <strong>{text(mission['lastStatus'])}</strong>
              </span>
            )}
          </div>
          {text(mission['progressNote']) && (
            <p className="project-mission-note">{text(mission['progressNote'])}</p>
          )}
          {(deliverables.length > 0 || journal.length > 0) && (
            <div className="project-mission-columns">
              {deliverables.length > 0 && (
                <div>
                  <h3>{t('mission.deliverables')}</h3>
                  <ul>
                    {deliverables.map((item, index) => {
                      const row = record(item);
                      const value = typeof item === 'string' ? item : text(row['text']);
                      const done =
                        typeof item === 'string'
                          ? /^(?:\[[x✓]\]|✅|\(done\))/i.test(item)
                          : row['status'] === 'done';
                      return value ? (
                        <li key={`${index}-${value}`}>
                          {done ? <CheckCircle2 size={14} /> : <Circle size={14} />}
                          <span>{value}</span>
                        </li>
                      ) : null;
                    })}
                  </ul>
                </div>
              )}
              {journal.length > 0 && (
                <div>
                  <h3>{t('mission.recentActivity')}</h3>
                  <ul>
                    {journal.slice(0, 8).map((item, index) => (
                      <li key={`${String(item['iteration'])}-${index}`}>
                        <span>#{String(item['iteration'])}</span>
                        <span>
                          {text(item['task']) ||
                            text(item['status']) ||
                            text(item['progressNote']) ||
                            t('mission.noDetails')}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}
