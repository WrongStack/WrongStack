/**
 * Binds the HQ notifier to the server: alert transitions, machines going
 * offline or coming back, and approvals/questions left waiting.
 *
 * Kept out of `hq-server.ts` so the server setup only hands over its tables.
 *
 * @module hq-server/notify-wiring
 */
import type {
  HqAlert,
  HqEventEnvelope,
  HqMachineRoster,
  HqNotifySeverity,
  HqSnapshot,
} from '@wrongstack/hq';
import {
  HqHostHealthWatch,
  HqMachineWatch,
  HqNotifier,
  HqPendingRequestWatch,
  hqMachineKey,
} from '@wrongstack/hq';
import type { WebSocket } from '../ws-runtime.js';
import type { ConnectedClient } from './types.js';

export interface HqNotifyRuntime {
  notifier: HqNotifier;
  /** An alert rule started firing. */
  onAlert(alert: HqAlert): void;
  /** A fresh snapshot (the alert tick): machine transitions. */
  onSnapshot(snapshot: HqSnapshot, roster: HqMachineRoster): void;
  /** Every event a client published. */
  onClientEvent(event: HqEventEnvelope, owner: ConnectedClient | undefined): void;
  close(): Promise<void>;
}

const ALERT_SEVERITY: Record<HqAlert['severity'], HqNotifySeverity> = {
  info: 'info',
  warn: 'warn',
  error: 'error',
};

export function createHqNotifyRuntime(
  dataDir: string,
  clients: Map<WebSocket, ConnectedClient>,
): HqNotifyRuntime {
  const notifier = new HqNotifier(dataDir);
  void notifier.load();
  const machines = new HqMachineWatch();
  const hostHealth = new HqHostHealthWatch();
  const requests = new HqPendingRequestWatch({
    delayMs: () => notifier.approvalDelayMs(),
    stillConnected: (clientId) => {
      for (const client of clients.values()) if (client.clientId === clientId) return true;
      return false;
    },
    emit: (note) => notifier.notify(note),
  });

  return {
    notifier,
    onAlert(alert) {
      notifier.notify({
        kind: 'alert',
        severity: ALERT_SEVERITY[alert.severity] ?? 'warn',
        title: `HQ alert: ${alert.ruleId}`,
        body: alert.message,
        // One push per firing episode; a rule that clears and fires again
        // is a new episode.
        dedupeKey: `alert:${alert.ruleId}:${alert.firstFiredAt}`,
        path: '/inbox/alerts/',
      });
    },
    onSnapshot(snapshot, roster) {
      if (!notifier.wants('machine')) return;
      const label = (key: string): string =>
        snapshot.machines?.find(
          (machine) => hqMachineKey(machine.hostname, machine.machineId) === key,
        )?.hostname ??
        snapshot.offlineMachines?.find((machine) => machine.key === key)?.hostname ??
        key.replace(/^(host|mid):/, '');
      for (const note of machines.observe(
        roster.liveKeys(),
        snapshot.offlineMachines ?? [],
        Date.now(),
        label,
      )) {
        notifier.notify(note);
      }
      const seen = new Set<string>();
      const observations = (snapshot.machines ?? []).flatMap((machine) => {
        const key = hqMachineKey(machine.hostname, machine.machineId);
        if (seen.has(key)) return [];
        seen.add(key);
        return [
          { key, label: label(key), health: machine.health, problems: machine.healthProblems },
        ];
      });
      for (const note of hostHealth.observe(observations, Date.now())) notifier.notify(note);
    },
    onClientEvent(event, owner) {
      if (
        event.type !== 'approval.requested' &&
        event.type !== 'approval.resolved' &&
        event.type !== 'user_input.requested' &&
        event.type !== 'user_input.resolved'
      ) {
        return;
      }
      // Resolutions always pass so a timer never outlives its request.
      const requested = event.type.endsWith('.requested');
      if (
        requested &&
        !notifier.wants(event.type.startsWith('approval') ? 'approval' : 'question')
      ) {
        return;
      }
      requests.observe(event, {
        hostname: owner?.hostname || owner?.machineId || 'an unknown machine',
        projectName: owner?.project.projectName || event.projectId,
      });
    },
    async close() {
      requests.close();
      await notifier.drain();
    },
  };
}
