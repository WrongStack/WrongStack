import { RotateCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useDesktopText } from './desktop-i18n';
import { setDesktopVersion } from './desktop-version';
import { hostInfo, native, restartHost } from './platform';
import './update-notice.css';

/**
 * The session host outlives the window and every update, and it starts engines from its own
 * copy: after an update, conversations keep running on the previous build's engine until the
 * host is replaced. This notice offers that replacement. It stops the conversations
 * gracefully (they resume through Reconnect), starts a host of this build and reloads the
 * windows; nothing happens until the user confirms.
 */
export function HostBuildNotice() {
  const { t } = useDesktopText();
  const [stale, setStale] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!native) return;
    let live = true;
    void hostInfo()
      .then((info) => {
        setDesktopVersion(info.appVersion);
        if (live) setStale(info.stale);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  if (!stale) return null;
  const restart = () => {
    setRestarting(true);
    setError('');
    // Success reloads every window; only a failure comes back here.
    restartHost().catch((reason) => {
      setRestarting(false);
      setConfirming(false);
      setError(String(reason));
    });
  };
  return (
    <div className="update-banner" role="status">
      <RotateCw size={15} aria-hidden="true" />
      <span className="update-banner-text">
        <strong>{t('hostBuild.stale')}</strong>
        <small>{confirming ? t('hostBuild.confirm') : t('hostBuild.explain')}</small>
        {error && (
          <small className="update-banner-error" role="alert">
            {t('hostBuild.failed', { error })}
          </small>
        )}
      </span>
      {confirming ? (
        <>
          <button type="button" className="button small" disabled={restarting} onClick={restart}>
            {restarting ? t('hostBuild.restarting') : t('hostBuild.restartNow')}
          </button>
          <button
            type="button"
            className="button secondary small"
            disabled={restarting}
            onClick={() => setConfirming(false)}
          >
            {t('hostBuild.cancel')}
          </button>
        </>
      ) : (
        <button type="button" className="button small" onClick={() => setConfirming(true)}>
          {t('hostBuild.restart')}
        </button>
      )}
    </div>
  );
}
