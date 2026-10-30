import { Server } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { EngineCommand } from './engine-operations';
import { entries, record } from './engine-values';
import './brain-policy.css';

export interface BackgroundService {
  id: string;
  label: string;
  status: string;
  required: boolean;
  detail: string;
  version: string;
  versionMismatch: boolean;
  pid: number;
  lastError: string;
  /** Whether the engine can stop and restart it from here. */
  controllable: boolean;
}

/** Services the engine never stops from a window: its own transport and read-only governance. */
const FIXED_SERVICES = new Set(['webui', 'governance']);

/** The engine's `connections.health_result`. */
export function backgroundServices(value: unknown): {
  overall: string;
  checkedAt: number;
  services: BackgroundService[];
} {
  const report = record(value);
  return {
    overall: typeof report['overall'] === 'string' ? report['overall'] : 'unknown',
    checkedAt: typeof report['checkedAt'] === 'number' ? report['checkedAt'] : 0,
    services: entries(report['services'])
      .filter((service) => typeof service['id'] === 'string')
      .map((service) => {
        const id = String(service['id']);
        return {
          id,
          label: String(service['label'] ?? id),
          status: String(service['status'] ?? 'unknown'),
          required: service['required'] === true,
          detail: typeof service['detail'] === 'string' ? service['detail'] : '',
          version: typeof service['daemonVersion'] === 'string' ? service['daemonVersion'] : '',
          versionMismatch: service['versionMismatch'] === true,
          pid: typeof service['ownerPid'] === 'number' ? service['ownerPid'] : 0,
          lastError: typeof service['lastError'] === 'string' ? service['lastError'] : '',
          controllable: !FIXED_SERVICES.has(id) && service['control'] !== 'none',
        };
      }),
  };
}

/**
 * The project's background services (session catalog, Chronicle, code index, memory, Kanban,
 * mailbox) with their health, and restart or stop for the ones the engine controls. The
 * engine's policy authorizes each action; a stopped service starts again when next needed.
 */
export function BackgroundServices({ command }: { command: EngineCommand }) {
  const [report, setReport] = useState<ReturnType<typeof backgroundServices> | null>(null),
    [busy, setBusy] = useState(''),
    [stopping, setStopping] = useState(''),
    [notice, setNotice] = useState(''),
    [error, setError] = useState('');
  const load = useCallback(async () => {
    setReport(
      backgroundServices(await command('connections.health', {}, ['connections.health_result'])),
    );
  }, [command]);
  useEffect(() => {
    void load().catch((failure) =>
      setError(failure instanceof Error ? failure.message : String(failure)),
    );
  }, [load]);
  const act = async (service: BackgroundService, action: 'restart' | 'shutdown') => {
    setBusy(`${service.id}:${action}`);
    setStopping('');
    setNotice('');
    setError('');
    try {
      const reply = record(
        await command('connections.service_action', { serviceId: service.id, action }, [
          'connections.service_action_result',
        ]),
      );
      setNotice(String(reply['message'] ?? `${service.label}: ${action} done.`));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy('');
      await load().catch(() => {});
    }
  };
  return (
    <section className="brain-decisions" aria-label="Background services">
      <h3>
        <Server size={14} /> Background services
      </h3>
      {report && (
        <p className="field-help">
          Overall: {report.overall}
          {report.checkedAt ? ` · checked ${new Date(report.checkedAt).toLocaleTimeString()}` : ''}.
          A stopped service starts again the next time it is needed.
        </p>
      )}
      {report && (
        <ol className="brain-decision-log">
          {report.services.map((service) => (
            <li key={service.id}>
              <span>
                <strong>{service.label}</strong> · {service.status}
                {service.required ? ' · required' : ''}
                {service.version ? ` · ${service.version}` : ''}
                {service.pid ? ` · pid ${service.pid}` : ''}
              </span>
              {service.versionMismatch && (
                <span>Runs a different release than this engine; restart it to update.</span>
              )}
              {(service.lastError || service.detail) && (
                <span>{service.lastError || service.detail}</span>
              )}
              {service.controllable && (
                <span className="jev-actions">
                  <button
                    type="button"
                    className="button secondary small"
                    disabled={Boolean(busy)}
                    onClick={() => void act(service, 'restart')}
                  >
                    {busy === `${service.id}:restart` ? 'Restarting…' : 'Restart'}
                  </button>
                  {stopping === service.id ? (
                    <>
                      <button
                        type="button"
                        className="button danger small"
                        disabled={Boolean(busy)}
                        onClick={() => void act(service, 'shutdown')}
                      >
                        {busy === `${service.id}:shutdown` ? 'Stopping…' : 'Stop it'}
                      </button>
                      <button
                        type="button"
                        className="button secondary small"
                        onClick={() => setStopping('')}
                      >
                        Keep running
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="button secondary small"
                      disabled={Boolean(busy)}
                      onClick={() => setStopping(service.id)}
                    >
                      Stop…
                    </button>
                  )}
                </span>
              )}
            </li>
          ))}
        </ol>
      )}
      <button
        type="button"
        className="button secondary small"
        disabled={Boolean(busy)}
        onClick={() => void load().catch((failure) => setError(String(failure)))}
      >
        Check again
      </button>
      {notice && <p role="status">{notice}</p>}
      {error && (
        <p role="alert" className="session-error">
          {error}
        </p>
      )}
    </section>
  );
}
