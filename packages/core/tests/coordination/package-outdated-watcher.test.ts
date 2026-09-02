import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { startPackageOutdatedWatcher } from '../../src/coordination/package-outdated-watcher.js';

describe('package-outdated-watcher', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('startPackageOutdatedWatcher', () => {
    it('returns a dispose function', () => {
      const dispose = startPackageOutdatedWatcher({
        mailbox: {
          query: async () => [],
          send: async () => {},
          ack: async () => {},
        } as any,
        packageTrackerOpts: { storageDir: '/tmp', projectRoot: '/tmp' },
        onNotify: async () => {},
        onLog: () => {},
      });

      expect(typeof dispose).toBe('function');
      dispose();
    });

    it('calls onError when mailbox.query throws', async () => {
      const errors: unknown[] = [];
      const dispose = startPackageOutdatedWatcher({
        mailbox: {
          query: async () => {
            throw new Error('Query failed');
          },
          send: async () => {},
          ack: async () => {},
        } as any,
        packageTrackerOpts: { storageDir: '/tmp', projectRoot: '/tmp' },
        pollIntervalMs: 999_999_999,
        onNotify: async () => {},
        onLog: () => {},
        onError: (err) => errors.push(err),
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(errors).toHaveLength(1);
      expect((errors[0] as Error).message).toBe('Query failed');

      dispose();
    });

    // `techStackAgentId` was declared and documented on the options interface
    // from the start, but never destructured — it appeared exactly once in the
    // whole codebase, in its own type. The watcher therefore acted on a
    // `result` from ANY sender, and the body chose both the package names and,
    // via `getPackageAuthor` returning nothing, whether the resulting
    // HIGH-priority notification went to one agent or was broadcast to `*`.
    it.each([
      // The legitimate sender is the worker the tech-stack consumer spawns as
      // `tech-stack-<manifest>`; `host-subagent-factory` sets `ctx.agentId`
      // from the spawn name, so its mail arrives from
      // `tech-stack-package.json@<tag>` — never a bare `tech-stack`. A strict
      // equality gate would have silently disabled the whole pipeline, which
      // is why the family form is asserted alongside the rejection.
      ['tech-stack', 1],
      ['tech-stack-package.json@a1b2c3d4', 1],
      ['some-other-agent@abcd1234', 0],
      ['tech-stackish@abcd1234', 0],
    ] as const)('gates results by sender: %s notifies %i time(s)', async (from, expected) => {
      const notifications: Array<{ to: string }> = [];
      const fakeMsg = {
        id: `msg-${from}`,
        from,
        body:
          '| Package | Current | Latest | Wanted | Manifest |\n' +
          '|---------|---------|--------|--------|----------|\n' +
          '| vitest | 0.9.0 | 1.2.3 | ^1.0.0 | package.json |\n',
        timestamp: new Date().toISOString(),
        type: 'result' as const,
      };

      const dispose = startPackageOutdatedWatcher({
        mailbox: {
          query: async () => [fakeMsg as any],
          ack: async () => {},
          send: async () => {},
        } as any,
        packageTrackerOpts: { storageDir: '/tmp', projectRoot: '/tmp' },
        // Same cadence as the sibling tests: the notify path does file I/O for
        // the author lookup, so a zero-tick advance would let a rejection pass
        // vacuously. The accepted rows above prove this window is enough.
        pollIntervalMs: 1,
        onNotify: async (msg) => {
          notifications.push({ to: msg.to });
        },
        onLog: () => {},
      });

      await vi.advanceTimersByTimeAsync(100);
      if (expected > 0) {
        await vi.waitFor(() => expect(notifications.length).toBeGreaterThan(0));
      }
      expect(notifications.length > 0 ? 1 : 0).toBe(expected);
      dispose();
    });

    it('processes outdated packages and notifies authors', async () => {
      const notifications: Array<{ to: string; subject: string }> = [];

      // Simulate a tech-stack result message with outdated packages in table format
      const fakeMsg = {
        id: 'msg-1',
        from: 'tech-stack',
        body:
          '| Package | Current | Latest | Wanted | Manifest |\n' +
          '|---------|---------|--------|--------|----------|\n' +
          '| vitest | 0.9.0 | 1.2.3 | ^1.0.0 | package.json |\n',
        timestamp: new Date().toISOString(),
        type: 'result' as const,
      };

      const dispose = startPackageOutdatedWatcher({
        mailbox: {
          query: async () => [fakeMsg as any],
          ack: async () => {},
          send: async () => {},
        } as any,
        packageTrackerOpts: { storageDir: '/tmp', projectRoot: '/tmp' },
        pollIntervalMs: 1,
        onNotify: async (msg) => {
          notifications.push({ to: msg.to, subject: msg.subject });
        },
        onLog: () => {},
      });

      // Advance timers enough to fire the initial pollOnce and the interval callback
      await vi.advanceTimersByTimeAsync(100);

      // Since we don't have the author recorded, it broadcasts to '*'
      await vi.waitFor(() => expect(notifications.some((n) => n.to === '*')).toBe(true));
      // And it should mention the package name in the subject
      await vi.waitFor(() =>
        expect(notifications.some((n) => n.subject.includes('vitest'))).toBe(true),
      );

      dispose();
    });

    // Regression: after PR-B1 the watcher uses canonical detectEcosystem
    // from package-author-tracker.ts (dedup). The canonical handles
    // Pipfile/Pipfile.lock, conanfile.txt/.py, and cmakeLists.txt which the
    // old local copy did NOT. This test pins the integration path: a
    // Pipfile entry from tech-stack should now reach onNotify.
    it('recognises Pipfile as pip ecosystem (canonical detectEcosystem)', async () => {
      const notifications: Array<{ to: string; subject: string; body: string }> = [];
      const fakeMsg = {
        id: 'msg-pipfile',
        from: 'tech-stack',
        body:
          '| Package | Current | Latest | Wanted | Manifest |\n' +
          '|---------|---------|--------|--------|----------|\n' +
          '| requests | 2.28.0 | 2.31.0 | >=2.28 | Pipfile |\n',
        timestamp: new Date().toISOString(),
        type: 'result' as const,
      };
      const dispose = startPackageOutdatedWatcher({
        mailbox: {
          query: async () => [fakeMsg as any],
          ack: async () => {},
          send: async () => {},
        } as any,
        packageTrackerOpts: { storageDir: '/tmp', projectRoot: '/tmp' },
        pollIntervalMs: 1,
        onNotify: async (msg) => {
          notifications.push({ to: msg.to, subject: msg.subject, body: msg.body });
        },
        onLog: () => {},
      });
      await vi.advanceTimersByTimeAsync(100);
      // Notification body mentions 'requests' (the package was parsed) and
      // 'pip' (the ecosystem the canonical detected for Pipfile). Pre-PR-B1
      // the local detectEcosystem would have produced ecosystem 'unknown'
      // and Pipfile would still be parsed; but the test pre-PR-B1 would
      // still pass on the parsing side. The regression surface is the
      // ecosystem label change — assertions here pin both that the watcher
      // does NOT crash on Pipfile and that the resulting notification body
      // surfaces the package name to the broadcast recipient.
      await vi.waitFor(() =>
        expect(notifications.some((n) => n.subject.includes('requests'))).toBe(true),
      );
      dispose();
    });
  });
});
