import { chunkHqSageRecords, type HqSageSnapshotPayload } from '@wrongstack/hq';
import type { WebSocket } from 'ws';
import { sendGuarded } from './snapshot.js';

/** Pace the initial corpus by socket flushes, keeping large projects below the queue cap. */
export async function sendSageSnapshot(
  ws: WebSocket,
  snapshot: HqSageSnapshotPayload,
): Promise<boolean> {
  for (const part of chunkHqSageRecords(snapshot.projectId, snapshot.records)) {
    const delivered = await new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        ws.removeListener('close', onClose);
        resolve(ok);
      };
      const onClose = () => finish(false);
      const timer = setTimeout(() => {
        finish(false);
        try {
          ws.terminate();
        } catch {
          /* Socket already closed. */
        }
      }, 10_000);
      timer.unref?.();
      ws.once('close', onClose);
      const accepted = sendGuarded(
        ws,
        JSON.stringify({ type: 'hq.sage_snapshot', payload: part }),
        (error) => finish(!error),
      );
      if (!accepted) finish(false);
    });
    if (!delivered) return false;
  }
  return true;
}
