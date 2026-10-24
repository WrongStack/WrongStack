import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventBus } from '@wrongstack/contracts/kernel';
import { AgentStatusTracker, Director, mailboxSessionTag } from '@wrongstack/core/coordination';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SqliteMailbox } from '../../../core/src/coordination/sqlite-mailbox.js';
import {
  registerCoordinatorLifecycleHandlers,
  registerDirectorSubagentLifecycleBridges,
} from '../../src/fleet/host-director-event-bridges.js';
import { createFleetStatusBroadcaster } from '../../src/fleet/status-broadcast.js';

// Real coordinator → host bridge → session tracker + SQLite presence registry.
// Only the model runner and clock are substituted.
describe('worker retirement preserves owning-session presence and active siblings', () => {
  afterEach(() => vi.useRealTimers());

  it.each([
    { mode: 'completed', sameSession: true },
    { mode: 'completed', sameSession: false },
    { mode: 'terminated', sameSession: true },
    { mode: 'terminated', sameSession: false },
  ] as const)(
    '$mode worker disappears (same-session sibling: $sameSession)',
    async ({ mode, sameSession }) => {
      vi.useFakeTimers();
      const scratchRoot = fileURLToPath(new URL('../../../../.temp_files/', import.meta.url));
      fs.mkdirSync(scratchRoot, { recursive: true });
      const scratch = fs.mkdtempSync(path.join(scratchRoot, 'fleet-presence-'));
      const mailbox = new SqliteMailbox(scratch);
      const events = new EventBus();
      const owner = 'session-owner';
      const siblingOwner = sameSession ? owner : 'session-sibling';
      const director = new Director({
        sessionId: 'session-boot',
        config: {
          coordinatorId: 'presence-test',
          maxConcurrent: 2,
          doneCondition: { type: 'all_tasks_done' },
        },
        subagentIdleTimeoutMs: 300_000,
        runner: async (task, ctx) => {
          if (task.id === 'finished-task') return { result: 'done', iterations: 1, toolCalls: 0 };
          await new Promise<void>((resolve) => {
            if (ctx.signal.aborted) resolve();
            else ctx.signal.addEventListener('abort', () => resolve(), { once: true });
          });
          return { result: 'aborted', iterations: 1, toolCalls: 0 };
        },
      });
      const tracker = new AgentStatusTracker({
        events,
        sessionId: owner,
        registry: { updateAgents: async () => {} },
      });
      tracker.start();
      const disposers = registerDirectorSubagentLifecycleBridges({
        director,
        events,
        sessionFor: (id) => director.coordinator.sessionOf(id),
        onSubagentRemoved: () => {},
      });
      disposers.push(
        registerCoordinatorLifecycleHandlers({
          coordinator: director.coordinator,
          events,
          sessionFor: (id) => director.coordinator.sessionOf(id),
          isShadowTask: () => false,
          onSubagentStopped: () => {},
        }),
      );
      const broadcaster = createFleetStatusBroadcaster({
        events,
        mailboxFactory: () => mailbox,
        sessionTag: () => mailboxSessionTag('session-boot'),
      });
      broadcaster.start();
      try {
        const worker = await director.spawn({ name: 'worker', originSessionId: owner });
        const sibling = await director.spawn({ name: 'sibling', originSessionId: siblingOwner });
        const workerIdentity = `${worker}@${mailboxSessionTag(owner)}`;
        const siblingIdentity = `${sibling}@${mailboxSessionTag(siblingOwner)}`;
        await mailbox.registerAgent({ agentId: workerIdentity, name: 'worker', sessionId: owner });
        await mailbox.registerAgent({
          agentId: siblingIdentity,
          name: 'sibling',
          sessionId: siblingOwner,
        });
        await director.assign({
          id: 'sibling-task',
          description: 'keep working',
          subagentId: sibling,
        });
        expect(director.status().subagents.find((a) => a.id === sibling)?.status).toBe('running');
        expect(tracker.getAgents().some((a) => a.id === worker)).toBe(true);
        if (mode === 'completed') {
          await director.assign({ id: 'finished-task', description: 'finish', subagentId: worker });
          expect((await director.awaitTasks(['finished-task']))[0]?.status).toBe('success');
        } else {
          await director.assign({
            id: 'terminated-task',
            description: 'stop me',
            subagentId: worker,
          });
          await director.terminate(worker);
        }
        await vi.advanceTimersByTimeAsync(1);
        expect(director.status().subagents.some((a) => a.id === worker)).toBe(false);
        expect.soft(tracker.getAgents().some((a) => a.id === worker)).toBe(false);
        const registered = await mailbox.getAgentStatuses();
        expect.soft(registered.some((a) => a.agentId === workerIdentity)).toBe(false);
        expect(registered.find((a) => a.agentId === siblingIdentity)).toMatchObject({
          online: true,
          status: 'running',
        });
        expect(director.status().subagents.find((a) => a.id === sibling)?.status).toBe('running');
        if (sameSession) expect(tracker.getAgents().some((a) => a.id === sibling)).toBe(true);
      } finally {
        await director.terminateAll();
        await vi.advanceTimersByTimeAsync(1);
        await director.shutdown();
        broadcaster.stop();
        for (const dispose of disposers) dispose();
        tracker.stop();
        mailbox.close();
        fs.rmSync(scratch, { recursive: true, force: true });
      }
    },
  );
});
