import { Building2, LoaderCircle, RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useDesktopText } from './desktop-i18n';
import { type EngineCommand, EngineReplyError } from './engine-operations';
import { entries } from './engine-values';

interface HqView {
  available: boolean;
  enrolled: boolean;
  hqUrl: string;
  hqFingerprint: string;
  deviceFingerprint: string;
  granted: Array<{ id: string; kind: string; baseUrl: string }>;
  grantedError: string;
  report: string[];
}

const str = (value: unknown) => (typeof value === 'string' ? value : '');

/**
 * An HQ request makes a network round trip (up to 15 s) and then waits for the profile config
 * lock (up to 15 s), so the 15 s default would report "did not acknowledge" just before it
 * answers (#448).
 */
const HQ_REQUEST_TIMEOUT_MS = 45_000;

/** Read an `hq.state` reply; anything missing reads as "not there". */
function readHqView(payload: Record<string, unknown>): HqView {
  return {
    available: payload['available'] === true,
    enrolled: payload['enrolled'] === true,
    hqUrl: str(payload['hqUrl']),
    hqFingerprint: str(payload['hqFingerprint']),
    deviceFingerprint: str(payload['deviceFingerprint']),
    granted: entries(payload['granted'])
      .filter((row) => str(row['id']))
      .map((row) => ({
        id: str(row['id']),
        kind: str(row['family']) || str(row['type']),
        baseUrl: str(row['baseUrl']),
      })),
    grantedError: str(payload['grantedError']),
    report: Array.isArray(payload['report'])
      ? payload['report'].filter((line): line is string => typeof line === 'string')
      : [],
  };
}

/**
 * "Import from HQ", as in the WebUI: connect this machine to a WrongStack HQ key vault and take
 * the provider profiles it grants. The engine does the work (`hq.*`); every answer is a full
 * `hq.state`, and a failed one still carries it beside the error.
 */
export function ProviderHqImport({
  command,
  connected,
  onChanged,
}: {
  command: EngineCommand;
  connected: boolean;
  onChanged: () => void;
}) {
  const { t } = useDesktopText();
  const [view, setView] = useState<HqView | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [hqUrl, setHqUrl] = useState('');
  const [token, setToken] = useState('');

  const run = async (type: string, payload: Record<string, unknown> = {}, changes = false) => {
    setBusy(true);
    if (type !== 'hq.status') setNotice(null);
    try {
      const next = readHqView(
        await command(type, payload, ['hq.state'], { timeoutMs: HQ_REQUEST_TIMEOUT_MS }),
      );
      setView(next);
      if (next.report.length) setNotice({ ok: true, text: next.report.join(' · ') });
      if (next.enrolled) setToken('');
      if (changes) onChanged();
    } catch (error) {
      if (error instanceof EngineReplyError) setView(readHqView(error.details));
      if (type !== 'hq.status' || !(error instanceof EngineReplyError))
        setNotice({ ok: false, text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  };

  // Ask once per connection; `run` is recreated every render.
  useEffect(() => {
    if (connected) void run('hq.status');
  }, [connected]);

  // An engine without an HQ client (or before the first answer) shows nothing.
  if (!view?.available) return null;

  return (
    <section className="provider-hq" aria-label={t('providerSettings.hq.heading')}>
      <h4>
        <Building2 size={14} aria-hidden="true" />
        {t('providerSettings.hq.heading')}
      </h4>
      <p className="provider-hint">{t('providerSettings.hq.body')}</p>
      {notice && (
        <p role={notice.ok ? 'status' : 'alert'} className={notice.ok ? '' : 'provider-hq-error'}>
          {notice.text}
        </p>
      )}
      {!view.enrolled ? (
        <form
          className="provider-wiring-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (!hqUrl.trim() || !token.trim() || busy) return;
            void run('hq.enroll', { hqUrl: hqUrl.trim(), token: token.trim() });
          }}
        >
          <label>
            {t('providerSettings.hq.hqUrl')}
            <input
              value={hqUrl}
              placeholder="https://hq.example:8443"
              onChange={(event) => setHqUrl(event.target.value)}
            />
          </label>
          <label>
            {t('providerSettings.hq.token')}
            <input
              type="password"
              autoComplete="off"
              value={token}
              onChange={(event) => setToken(event.target.value)}
            />
          </label>
          <div className="sdd-actions">
            <button
              type="submit"
              className="button primary"
              disabled={busy || !connected || !hqUrl.trim() || !token.trim()}
            >
              {busy && <LoaderCircle size={14} className="spin" />}
              {t('providerSettings.hq.enroll')}
            </button>
          </div>
        </form>
      ) : (
        <div className="provider-hq-connected">
          <p>{t('providerSettings.hq.connected', { url: view.hqUrl })}</p>
          <code>
            {t('providerSettings.hq.fingerprints', {
              hq: view.hqFingerprint,
              device: view.deviceFingerprint,
            })}
          </code>
          {view.grantedError ? (
            <p role="alert" className="provider-hq-error">
              {view.grantedError}
            </p>
          ) : view.granted.length ? (
            <ul>
              {view.granted.map((profile) => (
                <li key={profile.id}>
                  <strong>{profile.id}</strong> · {profile.kind}
                  {profile.baseUrl ? ` · ${profile.baseUrl}` : ''}
                </li>
              ))}
            </ul>
          ) : (
            <p className="provider-hint">{t('providerSettings.hq.noneGranted')}</p>
          )}
          <div className="sdd-actions">
            <button
              type="button"
              className="button primary"
              disabled={busy || !connected || !view.granted.length}
              onClick={() => void run('hq.import', {}, true)}
            >
              {busy && <LoaderCircle size={14} className="spin" />}
              {t('providerSettings.hq.importAll')}
            </button>
            <button
              type="button"
              className="button secondary"
              disabled={busy || !connected}
              onClick={() => void run('hq.sync', {}, true)}
            >
              <RefreshCw size={13} aria-hidden="true" />
              {t('providerSettings.hq.sync')}
            </button>
            <button
              type="button"
              className="button secondary"
              disabled={busy || !connected}
              onClick={() => void run('hq.unenroll', { removeKeys: false }, true)}
            >
              {t('providerSettings.hq.disconnect')}
            </button>
            <button
              type="button"
              className="button secondary danger"
              disabled={busy || !connected}
              onClick={() => void run('hq.unenroll', { removeKeys: true }, true)}
            >
              {t('providerSettings.hq.disconnectRemove')}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
