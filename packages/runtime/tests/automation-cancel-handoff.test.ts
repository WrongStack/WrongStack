import { mkdtemp, realpath, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { expect, it } from 'vitest';
import { AutomationService } from '../src/automation/service.js';
import { AutomationStore } from '../src/automation/store.js';
import { automationCancelHandoff } from './helpers/automation-cancel-handoff.js';

it.each(['queued', 'claim', 'active'] as const)(
  'cancels a local run during the %s phase',
  async (phase) => {
    expect(await automationCancelHandoff(phase)).toEqual({ outcome: 'ok', status: 'cancelled' });
  },
);

it('cancels a run when store.cancel races with tick/claim and allows idempotent cancel', async () => {
  const base = await realpath(os.tmpdir());
  const root = await mkdtemp(path.join(base, 'wrongstack-cancel-race-'));
  try {
    const claimEntered = Promise.withResolvers<void>();
    const allowCancelStore = Promise.withResolvers<void>();
    class RacingStore extends AutomationStore {
      override async cancel(id: string): Promise<void> {
        await claimEntered.promise;
        return super.cancel(id);
      }
      override async claim(...args: Parameters<AutomationStore['claim']>) {
        const res = await super.claim(...args);
        claimEntered.resolve();
        await allowCancelStore.promise;
        return res;
      }
    }
    const store = new RacingStore(path.join(root, 'state'));
    const job = await store.add(
      {
        name: 'race-test',
        projectRoot: root,
        image: 'trusted:1',
        prompt: 'check',
        envNames: [],
        yolo: false,
        enabled: true,
        timeoutMs: 60_000,
      },
      1000,
    );
    const run = await store.enqueue(job.id, 'manual', 'race-delivery', 'default', '', 1000);
    const service = new AutomationService(store, async (options) => {
      const sig = options.signal!;
      if (!sig.aborted) {
        await new Promise<void>((resolve) =>
          sig.addEventListener('abort', () => resolve(), { once: true }),
        );
      }
      return {
        id: options.id!,
        ownerToken: options.ownerToken!,
        exitCode: 0,
        snapshotRevision: 'a'.repeat(40),
        patch: '',
        output: '',
        cleanup: 'removed' as const,
      };
    });

    const cancelPromise = service.cancel(run.id);
    const tickPromise = service.tick(1000);
    await claimEntered.promise;
    allowCancelStore.resolve();

    await expect(cancelPromise).resolves.toBeUndefined();
    await tickPromise;
    await service.idle();
    expect((await store.snapshot()).runs.find((item) => item.id === run.id)?.status).toBe(
      'cancelled',
    );
    await expect(service.cancel(run.id)).resolves.toBeUndefined();
    await service.stop();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
