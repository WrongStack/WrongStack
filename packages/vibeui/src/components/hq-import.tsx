'use client';

import { Building2, RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { record, rows, text } from '../lib/session';
import type { SessionController } from '../lib/use-session';

interface HqGranted {
  id: string;
  kind: string;
  baseUrl: string;
}

interface HqView {
  available: boolean;
  enrolled: boolean;
  hqUrl: string;
  fingerprints: string;
  granted: HqGranted[];
  grantedError: string;
}

/** Read an `hq.state` payload; anything missing reads as "not there". */
function readHqState(payload: unknown): HqView & { report: string[]; error: string } {
  const p = record(payload);
  const hq = text(p.hqFingerprint);
  const device = text(p.deviceFingerprint);
  return {
    available: p.available === true,
    enrolled: p.enrolled === true,
    hqUrl: text(p.hqUrl),
    fingerprints: hq || device ? `HQ ${hq} · this machine ${device}` : '',
    granted: rows(p.granted)
      .filter((g) => text(g.id))
      .map((g) => ({
        id: text(g.id),
        kind: text(g.family) || text(g.type),
        baseUrl: text(g.baseUrl),
      })),
    grantedError: text(p.grantedError),
    report: Array.isArray(p.report)
      ? p.report.filter((line): line is string => typeof line === 'string')
      : [],
    error: text(p.error),
  };
}

/** The "(HQ)" mark on a saved provider HQ manages. */
export function HqBadge({ hq }: { hq: boolean }) {
  if (!hq) return null;
  return (
    <span
      className="provider-hq-badge"
      title="Managed by WrongStack HQ: a sync replaces local changes to its keys"
    >
      HQ
    </span>
  );
}

/**
 * "Import from HQ": connect this machine to a WrongStack HQ key vault and take
 * the providers it grants. The host does the work (`hq.*` messages); every
 * answer is a full `hq.state`, and imports also refresh the saved list.
 */
export function HqImportPanel({ controller }: { controller: SessionController }) {
  const { send, subscribe } = controller;
  const [view, setView] = useState<HqView | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ error: boolean; lines: string[] } | null>(null);
  const [hqUrl, setHqUrl] = useState('');
  const [token, setToken] = useState('');

  useEffect(() => {
    const off = subscribe((frame) => {
      if (frame.type !== 'hq.state') return;
      const next = readHqState(frame.payload);
      setBusy(false);
      setView(next);
      if (next.error) setMessage({ error: true, lines: [next.error] });
      else if (next.report.length) setMessage({ error: false, lines: next.report });
      if (next.enrolled) setToken('');
    });
    send('hq.status');
    return off;
  }, [send, subscribe]);

  // A host without an HQ client (or before the first answer) shows nothing.
  if (!view?.available) return null;

  const act = (type: string, payload: Record<string, unknown> = {}) => {
    setMessage(null);
    if (send(type, payload)) setBusy(true);
    else setMessage({ error: true, lines: ['Not connected to the engine.'] });
  };

  return (
    <section className="provider-setup provider-hq" aria-label="Import from HQ">
      <h3>
        <Building2 size={15} aria-hidden="true" />
        Import from HQ
      </h3>
      <p>
        Take the providers your WrongStack HQ grants this machine. Keys arrive sealed to this
        machine; HQ keeps subscription sign-ins renewed.
      </p>
      {message && (
        <p role={message.error ? 'alert' : 'status'} className={message.error ? 'hq-error' : ''}>
          {message.lines.join(' · ')}
        </p>
      )}
      {!view.enrolled ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!hqUrl.trim() || !token.trim() || busy) return;
            act('hq.enroll', { hqUrl: hqUrl.trim(), token: token.trim() });
          }}
        >
          <label htmlFor="hq-url">HQ address</label>
          <input
            id="hq-url"
            placeholder="https://hq.example:8443"
            value={hqUrl}
            onChange={(event) => setHqUrl(event.target.value)}
          />
          <label htmlFor="hq-token">Enrollment code (from System → Providers → Devices)</label>
          <input
            id="hq-token"
            type="password"
            autoComplete="off"
            value={token}
            onChange={(event) => setToken(event.target.value)}
          />
          <button
            type="submit"
            className="primary-button"
            disabled={busy || !hqUrl.trim() || !token.trim()}
          >
            {busy ? 'Connecting…' : 'Connect this machine'}
          </button>
        </form>
      ) : (
        <div className="hq-connected">
          <p>
            Connected to <strong>{view.hqUrl}</strong>
          </p>
          {view.fingerprints && <code>{view.fingerprints}</code>}
          {view.grantedError ? (
            <p role="alert" className="hq-error">
              {view.grantedError}
            </p>
          ) : view.granted.length > 0 ? (
            <ul>
              {view.granted.map((g) => (
                <li key={g.id}>
                  <strong>{g.id}</strong> · {g.kind}
                  {g.baseUrl ? ` · ${g.baseUrl}` : ''}
                </li>
              ))}
            </ul>
          ) : (
            <p>HQ grants this machine no providers yet.</p>
          )}
          <div className="hq-actions">
            <button
              type="button"
              className="primary-button"
              disabled={busy || view.granted.length === 0}
              onClick={() => act('hq.import')}
            >
              Import all
            </button>
            <button
              type="button"
              className="secondary-button"
              disabled={busy}
              onClick={() => act('hq.sync')}
            >
              <RefreshCw size={13} aria-hidden="true" />
              Sync
            </button>
            <button
              type="button"
              className="secondary-button"
              disabled={busy}
              onClick={() => act('hq.unenroll', { removeKeys: false })}
            >
              Disconnect
            </button>
            <button
              type="button"
              className="secondary-button danger-button"
              disabled={busy}
              onClick={() => act('hq.unenroll', { removeKeys: true })}
            >
              Disconnect and remove keys
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
