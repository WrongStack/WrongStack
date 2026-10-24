import {
  chunkHqSageRecords,
  compareHqSageRecords,
  type HqPublisher,
  type HqSageRecord,
  type HqSageSnapshotPayload,
  isHqSageRecord,
  MAX_HQ_SAGE_RECORD_BYTES,
} from '@wrongstack/hq';
import { toErrorMessage } from '@wrongstack/core/utils';
import { SageProjectServerConnection } from '@wrongstack/sage';

/** Uses the single SQLite owner over IPC, including writes from MCP and other hosts. */
export function createSageHqSync(projectRoot: string, publisher: HqPublisher, directory?: string) {
  const connection = new SageProjectServerConnection(projectRoot, directory);
  const acknowledged = new Map<string, string>();
  const sent = new Map<string, string>();
  const warned = new Map<string, string>();
  const remote = new Map<string, HqSageRecord>();
  const controller = new AbortController();
  const callOptions = { meta: { clientId: 'hq-sage-sync' }, signal: controller.signal };
  let stopped = false;
  let running: Promise<void> | undefined;
  let lastFailure: string | undefined;
  let lastScanVersion: string | undefined;
  let generation = 0;
  const version = (r: HqSageRecord) => `${r.revision}:${r.changeId}`;

  const synchronize = async (): Promise<void> => {
    const startedGeneration = generation;
    while (remote.size && !stopped && startedGeneration === generation) {
      const batch = chunkHqSageRecords(publisher.project.projectId, remote.values()).next();
      if (batch.done) break;
      const records = batch.value.records;
      for (const r of records) remote.delete(r.id);
      try {
        await connection.call('applyHqSync', { records }, callOptions);
        for (const r of records) {
          if (startedGeneration !== generation) break;
          acknowledged.set(r.id, version(r));
          if (sent.get(r.id) === version(r)) sent.delete(r.id);
        }
      } catch (error) {
        // The new connection replays HQ's authoritative state. An old IPC
        // failure must not repopulate its queue or acknowledge the new HQ.
        if (stopped || startedGeneration !== generation) return;
        for (const r of records) {
          const pending = remote.get(r.id);
          if (!pending || compareHqSageRecords(r, pending) > 0) remote.set(r.id, r);
        }
        throw error;
      }
    }
    const scanVersion = await connection.call('getHqSyncVersion', {}, callOptions);
    if (stopped || startedGeneration !== generation || !publisher.connected) return;
    if (scanVersion === lastScanVersion && sent.size === 0) return;
    let after = '';
    while (!stopped && publisher.connected) {
      const page = await connection.call('listHqSync', { after }, callOptions);
      if (stopped || startedGeneration !== generation || !publisher.connected) return;
      if (!page.length) {
        lastScanVersion = scanVersion;
        return;
      }
      const outgoing = page.filter((r) => {
        if (acknowledged.get(r.id) === version(r)) {
          sent.delete(r.id);
          return false;
        }
        if (isHqSageRecord(r as unknown)) {
          warned.delete(r.id);
          return true;
        }
        if (warned.get(r.id) !== version(r)) {
          process.emitWarning(
            `SAGE memory ${r.id} cannot sync: invalid record or exceeds ${MAX_HQ_SAGE_RECORD_BYTES} bytes. Other memories will continue syncing.`,
            { code: 'WRONGSTACK_HQ_SAGE_RECORD_REJECTED' },
          );
          warned.set(r.id, version(r));
        }
        return false;
      });
      for (const payload of chunkHqSageRecords(publisher.project.projectId, outgoing)) {
        for (const r of payload.records) sent.set(r.id, version(r));
        publisher.publishEvent({
          type: 'sage.snapshot',
          payload,
          maxSummaryLength: MAX_HQ_SAGE_RECORD_BYTES,
        });
      }
      after = page[page.length - 1]!.id;
    }
  };

  const refresh = (): Promise<void> => {
    if (stopped || !publisher.connected) return Promise.resolve();
    if (running) return running;
    running = synchronize()
      .then(() => {
        lastFailure = undefined;
      })
      .catch((error: unknown) => {
        const message = toErrorMessage(error);
        if (!stopped && lastFailure !== message) {
          process.emitWarning(`SAGE HQ sync will retry: ${message}`, {
            code: 'WRONGSTACK_HQ_SAGE_SYNC_FAILED',
          });
          lastFailure = message;
        }
      })
      .finally(() => {
        running = undefined;
      });
    return running;
  };
  const unsubscribe = publisher.onConnected(() => {
    generation++;
    remote.clear();
    acknowledged.clear();
    sent.clear();
    lastScanVersion = undefined;
    void refresh();
  });
  const timer = setInterval(() => void refresh(), 3_000);
  timer.unref?.();
  void refresh();
  return {
    async handleRemote(snapshot: HqSageSnapshotPayload): Promise<void> {
      if (stopped || snapshot.projectId !== publisher.project.projectId) return;
      for (const r of snapshot.records) {
        const pending = remote.get(r.id);
        if (!pending || compareHqSageRecords(r, pending) > 0) remote.set(r.id, r);
      }
      await refresh();
    },
    refresh,
    stop(): void {
      stopped = true;
      controller.abort();
      clearInterval(timer);
      unsubscribe();
      remote.clear();
      acknowledged.clear();
      sent.clear();
      warned.clear();
      connection.close();
      // A cold daemon connection may finish after close(); abort and close that
      // late transport too so retiring an HQ owner cannot leave an IPC lease.
      void running?.finally(() => connection.close());
    },
  };
}
