import { Check, Download, RefreshCw, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useDesktopText } from './desktop-i18n';
import { checkForUpdate, installUpdate, native, openExternal } from './platform';
import {
  CHECK_INTERVAL_MS,
  noticeFor,
  readUpdatePrefs,
  subscribeUpdatePrefs,
  type UpdatePrefs,
  type UpdateStatus,
  writeUpdatePrefs,
} from './update-notice';
import './update-notice.css';

const storage = (): Storage | undefined => {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
};

function useUpdatePrefs(): [UpdatePrefs, (prefs: UpdatePrefs) => void] {
  const [prefs, setPrefs] = useState(() => readUpdatePrefs(storage()));
  useEffect(() => subscribeUpdatePrefs(setPrefs), []);
  return [prefs, useCallback((next: UpdatePrefs) => writeUpdatePrefs(storage(), next), [])];
}

/**
 * Offers a newer WrongStack Desktop: Install & restart where this build installs it itself
 * (Windows, macOS), a download link otherwise. Checks at launch and every six hours unless the
 * user turned checks off in Appearance. Conversations keep running in the session host while
 * the application restarts.
 */
export function UpdateNotice() {
  const { t } = useDesktopText();
  const [prefs, setPrefs] = useUpdatePrefs();
  const [status, setStatus] = useState<UpdateStatus>();
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!native || !prefs.enabled) return;
    let live = true;
    const check = () =>
      void checkForUpdate()
        .then((next) => live && setStatus(next))
        .catch(() => {});
    check();
    const timer = setInterval(check, CHECK_INTERVAL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
    // Every change of the choices asks again: a "Check now" in Appearance has just refreshed
    // the native answer, which serves this from its cache.
  }, [prefs]);
  const notice = noticeFor(status, prefs);
  if (!notice) return null;
  const install = () => {
    setInstalling(true);
    setError('');
    installUpdate().catch((reason) => {
      setInstalling(false);
      setError(String(reason));
    });
  };
  return (
    <div className="update-banner" role="status">
      <Download size={15} aria-hidden="true" />
      <span className="update-banner-text">
        <strong>{t('updates.available', { version: notice.version })}</strong>
        {notice.canInstall && <small>{t('updates.keepsRunning')}</small>}
        {error && (
          <small className="update-banner-error" role="alert">
            {t('updates.failed', { error })}
          </small>
        )}
      </span>
      {notice.canInstall ? (
        <button type="button" className="button small" disabled={installing} onClick={install}>
          {installing ? t('updates.installing') : t('updates.install')}
        </button>
      ) : (
        <button
          type="button"
          className="button small"
          onClick={() => void openExternal(notice.releaseUrl).catch(() => {})}
        >
          {t('updates.download')}
        </button>
      )}
      {notice.canInstall && (
        <button
          type="button"
          className="button secondary small"
          onClick={() => void openExternal(notice.releaseUrl).catch(() => {})}
        >
          {t('updates.notes')}
        </button>
      )}
      <button
        type="button"
        className="icon-button"
        disabled={installing}
        title={t('updates.later')}
        aria-label={t('updates.later')}
        onClick={() => setPrefs({ ...prefs, dismissed: notice.version })}
      >
        <X size={15} />
      </button>
    </div>
  );
}

/** Appearance section: turn update checks on or off, or check now. */
export function UpdateSettings() {
  const { t } = useDesktopText();
  const [prefs, setPrefs] = useUpdatePrefs();
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState('');
  const checkNow = () => {
    setChecking(true);
    setResult('');
    checkForUpdate(true)
      .then((status) => {
        if (status.version) {
          // A version put off earlier is offered again when asked for explicitly.
          setPrefs({ enabled: prefs.enabled });
          setResult(t('updates.settings.found', { version: status.version }));
        } else setResult(t('updates.settings.upToDate', { version: status.current }));
      })
      .catch((reason) => setResult(String(reason)))
      .finally(() => setChecking(false));
  };
  return (
    <div className="appearance-section">
      <div>
        <h3>{t('updates.settings.title')}</h3>
        <p>{t('updates.settings.body')}</p>
      </div>
      <fieldset className="appearance-modes" aria-label={t('updates.settings.label')}>
        {(
          [
            { enabled: true, label: t('updates.settings.on') },
            { enabled: false, label: t('updates.settings.off') },
          ] as const
        ).map(({ enabled, label }) => (
          <button
            type="button"
            key={label}
            aria-pressed={prefs.enabled === enabled}
            onClick={() => setPrefs({ ...prefs, enabled })}
          >
            <span>{label}</span>
            {prefs.enabled === enabled && <Check size={13} />}
          </button>
        ))}
      </fieldset>
      {native && (
        <div className="update-settings-check">
          <button
            type="button"
            className="button secondary small"
            disabled={checking}
            onClick={checkNow}
          >
            <RefreshCw size={13} />
            {checking ? t('updates.settings.checking') : t('updates.settings.checkNow')}
          </button>
          {result && <small role="status">{result}</small>}
        </div>
      )}
    </div>
  );
}
