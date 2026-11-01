/**
 * Re-seed a starting HQ server from its data directory: the event ring, alert
 * and command history, the cost series and the machine roster. Every read is
 * best-effort — a missing or unreadable store starts empty.
 *
 * @module hq-server/boot-seed
 */
import type {
  HqAlert,
  HqAlertEngine,
  HqCommandAuditEntry,
  HqCommandAuditLog,
  HqEventEnvelope,
  HqPersistence,
} from '@wrongstack/hq';

export function seedHqServerFromDisk(deps: {
  persistence: HqPersistence;
  eventLog: HqEventEnvelope[];
  maxEventLog: number;
  alertEngine: HqAlertEngine;
  auditLog: HqCommandAuditLog;
}): void {
  const { persistence, eventLog, alertEngine, auditLog } = deps;
  void persistence.eventLog.hydrate().catch(() => undefined);
  void persistence.timeseries.load().catch(() => undefined);
  persistence.eventLog
    .recent(deps.maxEventLog)
    .then((prior) => {
      for (let i = prior.length - 1; i >= 0; i--) eventLog.push(prior[i]!);
    })
    .catch(() => {});
  persistence.alertLog
    .readAll()
    .then((prior) => alertEngine.seed(prior as readonly HqAlert[]))
    .catch(() => {});
  persistence.commandLog
    .readAll()
    .then((prior) => auditLog.seed(prior as readonly HqCommandAuditEntry[]))
    .catch(() => {});
  // Machines seen before this run: they show as offline until they return.
  void persistence.machines.load();
  void persistence.sessionHistory.load();
}
