import { useId, useState } from 'react';
import { useDesktopText } from './desktop-i18n';
import { type OrphanEngine, scanOrphanEngines, stopOrphanEngine } from './platform';
import './engine-cleanup.css';

export function EngineCleanup() {
  const { t } = useDesktopText();
  const heading = useId();
  const [processes, setProcesses] = useState<OrphanEngine[] | null>();
  const [busy, setBusy] = useState(false);
  const [confirmPid, setConfirmPid] = useState<number>();
  const [stopped, setStopped] = useState<number>();
  const [error, setError] = useState('');

  async function scan() {
    setBusy(true);
    setError('');
    setStopped(undefined);
    setConfirmPid(undefined);
    setProcesses(undefined);
    try {
      setProcesses(await scanOrphanEngines());
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  }

  async function stop(target: OrphanEngine) {
    setBusy(true);
    setError('');
    setStopped(undefined);
    setConfirmPid(undefined);
    try {
      await stopOrphanEngine(target);
      setStopped(target.pid);
      setProcesses((previous) => previous?.filter((row) => row !== target));
    } catch (reason) {
      setProcesses(undefined);
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="engine-cleanup" aria-labelledby={heading}>
      <header>
        <h2 id={heading}>{t('engineCleanup.title', { defaultValue: 'Background engines' })}</h2>
        <button className="button secondary small" type="button" disabled={busy} onClick={scan}>
          {t('engineCleanup.scan', { defaultValue: 'Scan for orphaned engines' })}
        </button>
      </header>
      <p>
        {t('engineCleanup.description', {
          defaultValue:
            'Find desktop engine processes that are no longer owned by a session host. Active hosts and their engines are left alone.',
        })}
      </p>
      <div role="status">
        {busy && t('engineCleanup.working', { defaultValue: 'Checking engine processes…' })}
        {stopped !== undefined &&
          t('engineCleanup.stopped', { pid: stopped, defaultValue: 'Stopped engine PID {{pid}}.' })}
        {processes === null &&
          t('engineCleanup.unsupported', {
            defaultValue: 'Engine cleanup is currently available on Windows only.',
          })}
        {processes?.length === 0 &&
          stopped === undefined &&
          t('engineCleanup.empty', { defaultValue: 'No confirmed orphaned engines found.' })}
      </div>
      {error && (
        <p role="alert">
          {t('engineCleanup.error', { defaultValue: 'Engine cleanup failed:' })} {error}
        </p>
      )}
      {processes && processes.length > 0 && (
        <ul>
          {processes.map((process) => (
            <li key={`${process.pid}:${process.identity}`}>
              <div>
                <strong>
                  {t('engineCleanup.pid', { pid: process.pid, defaultValue: 'PID {{pid}}' })}
                </strong>
                <code>{process.image}</code>
              </div>
              <button
                className="button secondary small"
                type="button"
                disabled={busy}
                onClick={() =>
                  confirmPid === process.pid ? void stop(process) : setConfirmPid(process.pid)
                }
              >
                {confirmPid === process.pid
                  ? t('engineCleanup.confirm', {
                      pid: process.pid,
                      defaultValue: 'Force stop PID {{pid}}',
                    })
                  : t('engineCleanup.stop', { pid: process.pid, defaultValue: 'Stop PID {{pid}}' })}
              </button>
              {confirmPid === process.pid && (
                <button
                  className="button secondary small"
                  type="button"
                  onClick={() => setConfirmPid(undefined)}
                >
                  {t('shellText.cancel')}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
