import { Server } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useDesktopText } from './desktop-i18n';
import type { EngineCommand } from './engine-operations';
import { entries, record } from './engine-values';
import { healingBusy, type ServiceHealing } from './service-healing';
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
export function BackgroundServices({
  command,
  autoHeals = {},
}: {
  command: EngineCommand;
  autoHeals?: Record<string, ServiceHealing>;
}) {
  const { t } = useDesktopText();
  const status = (value: string) => t(`bgServices.status.${value}`, { defaultValue: value });
  const [report, setReport] = useState<ReturnType<typeof backgroundServices> | null>(null),
    [busy, setBusy] = useState(''),
    [stopping, setStopping] = useState(''),
    [notice, setNotice] = useState(''),
    [error, setError] = useState('');
  const load = useCallback(async () => {
    setReport(
      backgroundServices(
        await command('connections.health', {}, [
          'connections.health_result',
          'connections.health_error',
        ]),
      ),
    );
  }, [command]);
  useEffect(() => {
    void load().catch((failure) =>
      setError(failure instanceof Error ? failure.message : String(failure)),
    );
  }, [load]);
  useEffect(() => {
    const timer = setInterval(() => {
      void load().catch(() => {});
    }, 10000);
    return () => clearInterval(timer);
  }, [load]);
  useEffect(() => {
    if (Object.values(autoHeals).some((value) => value.phase !== 'restarting'))
      void load().catch(() => {});
  }, [autoHeals, load]);
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
      setNotice(
        String(
          reply['message'] ??
            t('bgServices.actionDone', {
              label: service.label,
              action: t(`bgServices.action.${action}`),
            }),
        ),
      );
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy('');
      await load().catch(() => {});
    }
  };
  // As the WebUI's "Restart all": every running service the engine controls. Sleeping
  // on-demand services are left alone; a restart would only start them to stop them again.
  const running =
    report?.services.filter(
      (service) =>
        service.controllable &&
        service.status !== 'offline' &&
        service.status !== 'unavailable' &&
        !healingBusy(autoHeals[service.id], Date.now()),
    ) ?? [];
  const restartAll = async () => {
    setBusy('all:restart');
    setStopping('');
    setNotice('');
    setError('');
    const failed: string[] = [];
    for (const service of running) {
      try {
        await command('connections.service_action', { serviceId: service.id, action: 'restart' }, [
          'connections.service_action_result',
        ]);
      } catch (failure) {
        failed.push(
          `${service.label}: ${failure instanceof Error ? failure.message : String(failure)}`,
        );
      }
    }
    setNotice(
      t('bgServices.restarted', {
        count: running.length,
        done: running.length - failed.length,
      }),
    );
    if (failed.length) setError(failed.join(' · '));
    setBusy('');
    await load().catch(() => {});
  };
  return (
    <section className="brain-decisions" aria-label={t('bgServices.title')}>
      <h3>
        <Server size={14} /> {t('bgServices.title')}
      </h3>
      {report && (
        <p className="field-help">
          {t('bgServices.overall', { status: status(report.overall) })}
          {report.checkedAt
            ? ` · ${t('bgServices.checked', { time: new Date(report.checkedAt).toLocaleTimeString() })}`
            : ''}
          . {t('bgServices.restartNote')}
        </p>
      )}
      {report && (
        <ol className="brain-decision-log">
          {report.services.map((service) => (
            <li key={service.id}>
              <span>
                <strong>{service.label}</strong> · {status(service.status)}
                {service.required ? ` · ${t('bgServices.required')}` : ''}
                {service.version ? ` · ${service.version}` : ''}
                {service.pid ? ` · ${t('bgServices.pid', { pid: service.pid })}` : ''}
              </span>
              {service.versionMismatch && <span>{t('bgServices.mismatch')}</span>}
              {(service.lastError || service.detail) && (
                <span>{service.lastError || service.detail}</span>
              )}
              {autoHeals[service.id] && (
                <p role="status">
                  {t(`serviceHealing.${autoHeals[service.id]!.phase}`)} ·{' '}
                  {autoHeals[service.id]!.message}
                  {autoHeals[service.id]!.phase === 'restarting' &&
                    !healingBusy(autoHeals[service.id], Date.now()) &&
                    ` · ${t('serviceHealing.expired')}`}
                </p>
              )}
              {service.controllable && (
                <span className="jev-actions">
                  <button
                    type="button"
                    className="button secondary small"
                    disabled={Boolean(busy) || healingBusy(autoHeals[service.id], Date.now())}
                    onClick={() => void act(service, 'restart')}
                  >
                    {busy === `${service.id}:restart`
                      ? t('bgServices.restarting')
                      : t('bgServices.restart')}
                  </button>
                  {stopping === service.id ? (
                    <>
                      <button
                        type="button"
                        className="button danger small"
                        disabled={Boolean(busy) || healingBusy(autoHeals[service.id], Date.now())}
                        onClick={() => void act(service, 'shutdown')}
                      >
                        {busy === `${service.id}:shutdown`
                          ? t('bgServices.stopping')
                          : t('bgServices.stopIt')}
                      </button>
                      <button
                        type="button"
                        className="button secondary small"
                        onClick={() => setStopping('')}
                      >
                        {t('bgServices.keepRunning')}
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="button secondary small"
                      disabled={Boolean(busy) || healingBusy(autoHeals[service.id], Date.now())}
                      onClick={() => setStopping(service.id)}
                    >
                      {t('bgServices.stop')}
                    </button>
                  )}
                </span>
              )}
            </li>
          ))}
        </ol>
      )}
      {running.length > 0 && (
        <button
          type="button"
          className="button secondary small"
          disabled={Boolean(busy)}
          onClick={() => void restartAll()}
        >
          {busy === 'all:restart'
            ? t('bgServices.restartingAll')
            : t('bgServices.restartAll', { number: running.length })}
        </button>
      )}
      <button
        type="button"
        className="button secondary small"
        disabled={Boolean(busy)}
        onClick={() => void load().catch((failure) => setError(String(failure)))}
      >
        {t('bgServices.checkAgain')}
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
