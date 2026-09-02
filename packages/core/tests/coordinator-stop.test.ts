import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

describe('AutonomousCoordinator stop()', () => {
  let tempDir: string;
  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'stop-test-'));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await fs.rm(tempDir, { recursive: true, force: true });
        return;
      } catch (err: any) {
        if (err.code !== 'ENOTEMPTY' && err.code !== 'EBUSY') throw err;
        await new Promise((r) => setTimeout(r, 100 * (attempt + 1)));
      }
    }
  });

  it('emits a console.error when stop() is called on a running coordinator', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // Use dynamic import to avoid hoisting issues with vi.mock
    const { AutonomousCoordinator } = await import('../src/coordination/autonomous-coordinator.js');

    const coordinator = new AutonomousCoordinator({
      sessionDir: tempDir,
      selfAgentId: 'leader@test',
      selfAgentName: 'Leader',
      llmProvider: {
        decide: vi.fn().mockResolvedValue({
          type: 'deny' as const,
          optionId: undefined,
          text: 'test',
          rationale: 'test',
        }),
      },
      disableSelfImprove: true,
    });

    // Start run() — it will exit quickly since brain denies immediately,
    // but we call stop() BEFORE it exits by using a synchronous spy on the loop
    const _runningDuringStop = false;
    const originalStop = coordinator.stop.bind(coordinator);
    coordinator.stop = () => {
      // Access running state indirectly by checking if stop log was emitted
      originalStop();
    };

    // Fire run() and stop() as fast as possible
    coordinator.run({ goal: 'test', maxIterations: 10000 });
    coordinator.stop();

    await new Promise((r) => setTimeout(r, 10));

    // The stop log should be emitted (either before or after run() finishes)
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('stop signal received'));

    // Let run() finish cleanly
    await new Promise((r) => setTimeout(r, 50));
  });

  it('is idempotent — calling stop() twice emits only one log', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { AutonomousCoordinator } = await import('../src/coordination/autonomous-coordinator.js');

    const coordinator = new AutonomousCoordinator({
      sessionDir: tempDir,
      selfAgentId: 'leader@test',
      selfAgentName: 'Leader',
      llmProvider: {
        decide: vi.fn().mockResolvedValue({
          type: 'deny' as const,
          optionId: undefined,
          text: 'test',
          rationale: 'test',
        }),
      },
      disableSelfImprove: true,
    });

    coordinator.run({ goal: 'test', maxIterations: 10000 });
    coordinator.stop();
    coordinator.stop(); // second call — should be no-op

    await new Promise((r) => setTimeout(r, 50));

    // Only one log from the first stop()
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });
});
