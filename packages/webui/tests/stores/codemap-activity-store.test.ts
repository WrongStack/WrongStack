import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  extractActivitiesFromMessage,
  type FileActivity,
  useCodemapActivityStore,
} from '../../src/stores/codemap-activity-store';
import type { WSServerMessage } from '../../src/types';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeActivity(filePath: string, type: FileActivity['type'], ts = Date.now()): FileActivity {
  return {
    filePath,
    type,
    toolName: 'test-tool',
    summary: 'test summary',
    timestamp: ts,
  };
}

function makeMsg(type: string, payload: Record<string, unknown>): WSServerMessage {
  return {
    type: type as WSServerMessage['type'],
    payload,
  } as WSServerMessage;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('codemap-activity-store', () => {
  beforeEach(() => {
    useCodemapActivityStore.getState().clear();
  });

  // ── recordActivity ──────────────────────────────────────────────────────────

  describe('recordActivity', () => {
    it('records a single activity in history with newest-first ordering', () => {
      const store = useCodemapActivityStore.getState();
      store.recordActivity(makeActivity('src/foo.ts', 'read', 1000));
      store.recordActivity(makeActivity('src/foo.ts', 'write', 2000));

      const history = store.getActivityForFile('src/foo.ts');
      expect(history).toHaveLength(2);
      expect(history[0]!.timestamp).toBe(2000);
      expect(history[1]!.timestamp).toBe(1000);
    });

    it('increments totalCount on each record', () => {
      const store = useCodemapActivityStore.getState();
      expect(store.totalCount).toBe(0);
      store.recordActivity(makeActivity('a.ts', 'read'));
      store.recordActivity(makeActivity('b.ts', 'write'));
      expect(useCodemapActivityStore.getState().totalCount).toBe(2);
    });

    it('sets a pulse for the active file', () => {
      const store = useCodemapActivityStore.getState();
      store.recordActivity(makeActivity('src/bar.ts', 'edit'));
      const pulsing = store.getPulsingFiles();
      expect(pulsing.has('src/bar.ts')).toBe(true);
    });

    it('caps per-file history at MAX_HISTORY_PER_FILE (200)', () => {
      const store = useCodemapActivityStore.getState();
      for (let i = 0; i < 250; i++) {
        store.recordActivity(makeActivity('cap.ts', 'read', i));
      }
      const history = store.getActivityForFile('cap.ts');
      expect(history).toHaveLength(200);
      // Newest 200 should be kept (timestamps 50..249)
      expect(history[0]!.timestamp).toBe(249);
      expect(history[199]!.timestamp).toBe(50);
    });

    it('isolates per-file history — recording file A does not affect file B', () => {
      const store = useCodemapActivityStore.getState();
      store.recordActivity(makeActivity('a.ts', 'read'));
      store.recordActivity(makeActivity('a.ts', 'write'));
      store.recordActivity(makeActivity('b.ts', 'edit'));

      expect(store.getActivityForFile('a.ts')).toHaveLength(2);
      expect(store.getActivityForFile('b.ts')).toHaveLength(1);
    });

    it('does not mutate the previous state Map (immutability)', () => {
      const store = useCodemapActivityStore.getState();
      store.recordActivity(makeActivity('immutable.ts', 'read'));
      const stateBefore = useCodemapActivityStore.getState();
      const historyBefore = stateBefore.history;
      store.recordActivity(makeActivity('immutable.ts', 'write'));
      const stateAfter = useCodemapActivityStore.getState();

      // The old Map must be unchanged — the store should have created a new Map
      expect(stateAfter.history).not.toBe(historyBefore);
      expect(historyBefore.get('immutable.ts')).toHaveLength(1);
      expect(stateAfter.history.get('immutable.ts')).toHaveLength(2);
    });
  });

  // ── _sweep immutability ─────────────────────────────────────────────────────

  describe('_sweep (pulse expiry immutability)', () => {
    it('does not mutate the live pulses Map in place', () => {
      const store = useCodemapActivityStore.getState();
      store.recordActivity(makeActivity('sweep.ts', 'read'));
      const pulsesBefore = useCodemapActivityStore.getState().pulses;

      // Force expiry by backdating all pulses
      vi.useFakeTimers();
      vi.advanceTimersByTime(10_000);

      store._sweep();

      const pulsesAfter = useCodemapActivityStore.getState().pulses;

      // The old Map should still contain the entry (was not mutated)
      expect(pulsesBefore.has('sweep.ts')).toBe(true);
      // The new Map should have removed it
      expect(pulsesAfter.has('sweep.ts')).toBe(false);
      expect(pulsesAfter).not.toBe(pulsesBefore);

      vi.useRealTimers();
    });

    it('clears expired pulses and keeps active ones', () => {
      const store = useCodemapActivityStore.getState();
      vi.useFakeTimers();
      const t0 = Date.now();

      store.recordActivity(makeActivity('old.ts', 'read', t0));
      vi.advanceTimersByTime(10_000); // 10s later — old.ts pulse expired

      store.recordActivity(makeActivity('new.ts', 'read')); // fresh pulse
      store._sweep();

      const pulsing = store.getPulsingFiles();
      expect(pulsing.has('old.ts')).toBe(false);
      expect(pulsing.has('new.ts')).toBe(true);

      vi.useRealTimers();
    });

    it('is a no-op when no pulses are expired', () => {
      const store = useCodemapActivityStore.getState();
      store.recordActivity(makeActivity('alive.ts', 'read'));
      const stateBefore = useCodemapActivityStore.getState();
      store._sweep();
      const stateAfter = useCodemapActivityStore.getState();

      // No change — should not even call set()
      expect(stateAfter.pulses).toBe(stateBefore.pulses);
    });
  });

  // ── extractActivitiesFromMessage ────────────────────────────────────────────

  describe('extractActivitiesFromMessage', () => {
    it('extracts attributed tool lifecycle targets with line metadata', () => {
      const activities = extractActivitiesFromMessage(
        makeMsg('tool.started', {
          id: 'tool-1',
          name: 'read',
          input: { path: 'ignored-relative-path.ts' },
          sessionId: 'session-1',
          traceId: 'trace-1',
          agentId: 'agent-1',
          agentName: 'RESEARCHER',
          fileTargets: [
            {
              filePath: 'D:\\repo\\src\\agent.ts',
              operation: 'read',
              line: 42,
              endLine: 64,
            },
          ],
        }),
      );

      expect(activities).toEqual([
        expect.objectContaining({
          toolUseId: 'tool-1',
          filePath: 'D:\\repo\\src\\agent.ts',
          type: 'read',
          status: 'active',
          sessionId: 'session-1',
          traceId: 'trace-1',
          agentId: 'agent-1',
          agentName: 'RESEARCHER',
          line: 42,
          endLine: 64,
          attribution: 'exact',
        }),
      ]);
    });

    it('keeps pathless tools visible as live execute operations', () => {
      const activities = extractActivitiesFromMessage(
        makeMsg('tool.started', {
          id: 'shell-1',
          name: 'bash',
          input: { command: 'pnpm test' },
          sessionId: 'session-1',
          agentId: 'agent-1',
          agentName: 'BUILDER',
          fileTargets: [],
        }),
      );

      expect(activities).toEqual([
        expect.objectContaining({
          filePath: '(tool:bash)',
          type: 'execute',
          toolName: 'bash',
          status: 'active',
        }),
      ]);
    });

    it('extracts dedicated subagent CodeMap lifecycle without chat coupling', () => {
      const activities = extractActivitiesFromMessage(
        makeMsg('codemap.tool_started', {
          id: 'sub-tool-1',
          name: 'edit',
          input: { path: 'D:/repo/src/subagent.ts' },
          fileTargets: [{ filePath: 'D:/repo/src/subagent.ts', operation: 'edit' }],
          sessionId: 'subagent-session',
          parentSessionId: 'leader-session',
          traceId: 'trace-sub',
          agentId: 'worker-7',
          agentName: 'IMPLEMENTER-7',
        }),
      );

      expect(activities).toEqual([
        expect.objectContaining({
          toolUseId: 'sub-tool-1',
          filePath: 'D:/repo/src/subagent.ts',
          status: 'active',
          sessionId: 'subagent-session',
          traceId: 'trace-sub',
          agentId: 'worker-7',
          agentName: 'IMPLEMENTER-7',
        }),
      ]);
    });

    it('builds a compact change lens for edit and patch operations', () => {
      const edit = extractActivitiesFromMessage(
        makeMsg('tool.started', {
          id: 'edit-change',
          name: 'edit',
          input: {
            path: 'D:/repo/src/change.ts',
            old_string: 'function oldName() {\n  return false;\n}',
            new_string: 'function newName() {\n  return true;\n}',
          },
          fileTargets: [{ filePath: 'D:/repo/src/change.ts', operation: 'edit' }],
        }),
      )[0]!;
      expect(edit.change).toEqual(
        expect.objectContaining({
          added: 3,
          removed: 3,
          before: expect.any(String),
          after: expect.any(String),
        }),
      );
      expect(edit.summary).toContain('→');

      const patch = extractActivitiesFromMessage(
        makeMsg('tool.started', {
          id: 'patch-change',
          name: 'apply_patch',
          input: { patch: '@@\n-old line\n+new line\n+second line' },
          fileTargets: [{ filePath: 'D:/repo/src/change.ts', operation: 'edit' }],
        }),
      )[0]!;
      expect(patch.change).toEqual(
        expect.objectContaining({ added: 2, removed: 1, before: 'old line', after: 'new line' }),
      );
      expect(patch.summary).toBe('apply_patch +2 −1');
    });

    it('counts adjacent header-shaped content inside a hunk', () => {
      // A removed `--- rule one` followed by an added `+++ rule two` INSIDE the
      // hunk body is content, not the file header — the same rule core's
      // countUnifiedDiffLines enforces (see unified-diff-count.test.ts).
      const patch = [
        '--- a/notes.md',
        '+++ b/notes.md',
        '@@ -1,3 +1,3 @@',
        ' keep',
        '--- rule one',
        '+++ rule two',
        ' tail',
      ].join('\n');
      const activity = extractActivitiesFromMessage(
        makeMsg('tool.started', {
          id: 'patch-inhunk',
          name: 'patch',
          input: { patch },
          fileTargets: [{ filePath: 'notes.md', operation: 'edit' }],
        }),
      )[0]!;
      expect(activity.change).toEqual(
        expect.objectContaining({
          added: 1,
          removed: 1,
          before: '-- rule one',
          after: '++ rule two',
        }),
      );
      expect(activity.summary).toBe('patch +1 −1');
    });

    it('still skips the next file header after a hunk in a multi-file patch', () => {
      const patch = [
        '--- a/one.txt',
        '+++ b/one.txt',
        '@@ -1 +1 @@',
        '-old',
        '+new',
        '--- a/two.txt',
        '+++ b/two.txt',
        '@@ -1 +1 @@',
        '-x',
        '+y',
      ].join('\n');
      const activity = extractActivitiesFromMessage(
        makeMsg('tool.started', {
          id: 'patch-multi',
          name: 'patch',
          input: { patch },
          fileTargets: [{ filePath: 'one.txt', operation: 'edit' }],
        }),
      )[0]!;
      expect(activity.change).toEqual(expect.objectContaining({ added: 2, removed: 2 }));
    });

    it('extracts file paths from provider.response tool_use blocks', () => {
      const msg = makeMsg('provider.response', {
        blocks: [
          {
            type: 'tool_use',
            name: 'read',
            input: { path: 'packages/core/src/index.ts' },
          },
          {
            type: 'tool_use',
            name: 'edit',
            input: { path: 'packages/webui/src/App.tsx' },
          },
        ],
      });
      const activities = extractActivitiesFromMessage(msg);
      expect(activities).toHaveLength(2);
      expect(activities[0]!.filePath).toBe('packages/core/src/index.ts');
      expect(activities[0]!.type).toBe('read');
      expect(activities[1]!.filePath).toBe('packages/webui/src/App.tsx');
      expect(activities[1]!.type).toBe('edit');
    });

    it('skips non-tool_use blocks and unmapped tool names', () => {
      const msg = makeMsg('provider.response', {
        blocks: [
          { type: 'text', text: 'hello' },
          { type: 'tool_use', name: 'unknown_tool', input: { path: 'x.ts' } },
          { type: 'tool_use', name: 'grep', input: { pattern: 'foo' } },
        ],
      });
      const activities = extractActivitiesFromMessage(msg);
      // Only grep (mapped to 'search') should produce an activity — but it has
      // no file path and type 'search', so it goes to '(global)'
      expect(activities).toHaveLength(1);
      expect(activities[0]!.filePath).toBe('(global)');
      expect(activities[0]!.type).toBe('search');
    });

    it('returns empty array for non-array blocks', () => {
      const msg = makeMsg('provider.response', { blocks: 'not-an-array' });
      expect(extractActivitiesFromMessage(msg)).toEqual([]);
    });

    it('returns empty array when blocks is missing', () => {
      const msg = makeMsg('provider.response', {});
      expect(extractActivitiesFromMessage(msg)).toEqual([]);
    });

    it('extracts from file.saved messages', () => {
      const msg = makeMsg('file.saved', { filePath: 'src/saved.ts' });
      const activities = extractActivitiesFromMessage(msg);
      expect(activities).toHaveLength(1);
      expect(activities[0]!.filePath).toBe('src/saved.ts');
      expect(activities[0]!.type).toBe('write');
    });

    it('returns empty for file.saved without filePath', () => {
      const msg = makeMsg('file.saved', {});
      expect(extractActivitiesFromMessage(msg)).toEqual([]);
    });

    it('extracts from memory.event messages', () => {
      const msg = makeMsg('memory.event', { event: 'memory.staled', memoryId: 'mem-123' });
      const activities = extractActivitiesFromMessage(msg);
      expect(activities).toHaveLength(1);
      expect(activities[0]!.filePath).toBe('(memory)');
      expect(activities[0]!.type).toBe('memory');
      expect(activities[0]!.toolName).toBe('memory.memory.staled');
    });

    it('returns empty for memory.event without event field', () => {
      const msg = makeMsg('memory.event', {});
      expect(extractActivitiesFromMessage(msg)).toEqual([]);
    });

    it('returns empty array for unhandled message types', () => {
      const msg = makeMsg('session.start', { foo: 'bar' });
      expect(extractActivitiesFromMessage(msg)).toEqual([]);
    });

    it('maps multiple paths from a single tool_use (files field)', () => {
      const msg = makeMsg('provider.response', {
        blocks: [
          {
            type: 'tool_use',
            name: 'read',
            input: { path: 'a.ts', file: 'b.ts', files: 'c.ts' },
          },
        ],
      });
      const activities = extractActivitiesFromMessage(msg);
      expect(activities).toHaveLength(3);
      expect(activities.map((a) => a.filePath).sort()).toEqual(['a.ts', 'b.ts', 'c.ts']);
    });
  });

  describe('live tool lifecycle and filesystem correlation', () => {
    it('tracks active agent presence and completes the operation in-place', () => {
      const started = extractActivitiesFromMessage(
        makeMsg('tool.started', {
          id: 'tool-2',
          name: 'edit',
          input: { path: 'D:/repo/src/live.ts' },
          fileTargets: [{ filePath: 'D:/repo/src/live.ts', operation: 'edit' }],
          sessionId: 'session-2',
          agentId: 'agent-2',
          agentName: 'IMPLEMENTER',
        }),
      );
      useCodemapActivityStore.getState().startActivities(started);

      let state = useCodemapActivityStore.getState();
      expect(state.getActiveOperations()).toHaveLength(1);
      expect(state.getAgentPresences()).toEqual([
        expect.objectContaining({
          agentId: 'agent-2',
          agentName: 'IMPLEMENTER',
          sessionId: 'session-2',
        }),
      ]);

      state.finishTool('tool-2', {
        timestamp: started[0]!.timestamp + 25,
        durationMs: 25,
        ok: true,
      });
      state = useCodemapActivityStore.getState();
      expect(state.getActiveOperations()).toHaveLength(0);
      expect(state.getActivityForFile('D:/repo/src/live.ts')[0]).toEqual(
        expect.objectContaining({ status: 'completed', durationMs: 25, ok: true }),
      );
    });

    it('confirms an exact tool target without duplicating its history event', () => {
      const started = extractActivitiesFromMessage(
        makeMsg('tool.started', {
          id: 'tool-3',
          name: 'write',
          input: {},
          fileTargets: [{ filePath: 'D:/repo/src/exact.ts', operation: 'write' }],
          sessionId: 'session-3',
          agentId: 'agent-3',
        }),
      );
      const store = useCodemapActivityStore.getState();
      store.startActivities(started);
      store.recordFileEvent({
        ...makeActivity('D:/repo/src/exact.ts', 'write', started[0]!.timestamp + 10),
        source: 'watcher',
      });

      const history = useCodemapActivityStore.getState().getActivityForFile('D:/repo/src/exact.ts');
      expect(history).toHaveLength(1);
      expect(history[0]?.watcherConfirmed).toBe(true);
      expect(
        useCodemapActivityStore.getState().getActiveForFile('D:/repo/src/exact.ts')[0]
          ?.watcherConfirmed,
      ).toBe(true);
    });

    it('does not overwrite earlier completed history entries when a reused toolUseId finishes again', () => {
      const store = useCodemapActivityStore.getState();
      store.startActivities([
        {
          ...makeActivity('D:/repo/src/reuse.ts', 'write', 1_000),
          id: 'reuse-1',
          toolUseId: 'tool-reuse',
          status: 'active',
          agentId: 'agent-3',
        },
      ]);
      store.finishTool('tool-reuse', { timestamp: 1_040, durationMs: 40, ok: true });
      store.startActivities([
        {
          ...makeActivity('D:/repo/src/reuse.ts', 'write', 1_100),
          id: 'reuse-2',
          toolUseId: 'tool-reuse',
          status: 'active',
          agentId: 'agent-3',
        },
      ]);
      store.finishTool('tool-reuse', { timestamp: 1_300, durationMs: 200, ok: false });

      const history = useCodemapActivityStore.getState().getActivityForFile('D:/repo/src/reuse.ts');
      expect(history).toHaveLength(2);
      expect(history[0]).toMatchObject({
        id: 'reuse-2',
        status: 'failed',
        ok: false,
        durationMs: 200,
      });
      expect(history[1]).toMatchObject({
        id: 'reuse-1',
        status: 'completed',
        ok: true,
        durationMs: 40,
      });
    });

    it('correlates a watcher touch to the only active pathless tool', () => {
      const started = extractActivitiesFromMessage(
        makeMsg('tool.started', {
          id: 'shell-2',
          name: 'bash',
          input: { command: 'generate files' },
          fileTargets: [],
          sessionId: 'session-shell',
          agentId: 'builder-1',
          agentName: 'BUILDER',
        }),
      );
      const store = useCodemapActivityStore.getState();
      store.startActivities(started);
      store.recordFileEvent({
        ...makeActivity('D:/repo/src/generated.ts', 'write', started[0]!.timestamp + 20),
        source: 'watcher',
      });

      const correlated = useCodemapActivityStore
        .getState()
        .getActivityForFile('D:/repo/src/generated.ts')[0];
      expect(correlated).toEqual(
        expect.objectContaining({
          toolUseId: 'shell-2',
          agentId: 'builder-1',
          agentName: 'BUILDER',
          attribution: 'correlated',
          watcherConfirmed: true,
          status: 'active',
        }),
      );
      expect(useCodemapActivityStore.getState().getActiveOperations()).toHaveLength(2);
    });

    it('attaches deterministic file_changed progress to its exact active tool id', () => {
      const store = useCodemapActivityStore.getState();
      store.startActivities(
        extractActivitiesFromMessage(
          makeMsg('tool.started', {
            id: 'generator-1',
            name: 'generator',
            input: {},
            fileTargets: [],
            sessionId: 'generator-session',
            agentId: 'generator-agent',
            agentName: 'GENERATOR',
          }),
        ),
      );
      const progress = extractActivitiesFromMessage(
        makeMsg('tool.progress', {
          id: 'generator-1',
          name: 'generator',
          sessionId: 'generator-session',
          traceId: 'generator-trace',
          agentId: 'generator-agent',
          agentName: 'GENERATOR',
          event: {
            type: 'file_changed',
            path: 'D:/repo/src/generated-by-progress.ts',
            operation: 'write',
            line: 8,
          },
        }),
      );
      expect(progress).toEqual([
        expect.objectContaining({
          toolUseId: 'generator-1',
          filePath: 'D:/repo/src/generated-by-progress.ts',
          type: 'write',
          source: 'deterministic',
          line: 8,
        }),
      ]);
      store.recordFileEvent(progress[0]!);

      expect(useCodemapActivityStore.getState().getActiveOperations()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            toolUseId: 'generator-1',
            filePath: 'D:/repo/src/generated-by-progress.ts',
            agentId: 'generator-agent',
            attribution: 'exact',
          }),
        ]),
      );
    });

    it('keeps unmatched filesystem events explicitly external', () => {
      useCodemapActivityStore.getState().recordFileEvent({
        ...makeActivity('D:/repo/src/external.ts', 'delete'),
        source: 'watcher',
      });
      expect(
        useCodemapActivityStore.getState().getActivityForFile('D:/repo/src/external.ts')[0],
      ).toEqual(expect.objectContaining({ attribution: 'external' }));
    });

    it('resolves the active operation to an indexed symbol', () => {
      const store = useCodemapActivityStore.getState();
      store.startActivities([
        {
          ...makeActivity('D:/repo/src/symbol.ts', 'read'),
          id: 'symbol-op',
          toolUseId: 'tool-symbol',
          status: 'active',
        },
      ]);
      store.resolveActivitySymbol('tool-symbol', 'D:/repo/src/symbol.ts', {
        id: 'sym:42',
        name: 'runAgent',
        kind: 'function',
        line: 42,
      });
      expect(useCodemapActivityStore.getState().getActiveOperations()[0]?.symbol).toEqual({
        id: 'sym:42',
        name: 'runAgent',
        kind: 'function',
        line: 42,
      });
    });

    it('expires orphaned active tools so the live HUD cannot remain stuck forever', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-07-16T12:00:00Z'));
      const store = useCodemapActivityStore.getState();
      store.startActivities([
        {
          ...makeActivity('D:/repo/src/orphan.ts', 'edit'),
          id: 'orphan:0',
          toolUseId: 'orphan',
          status: 'active',
          agentId: 'worker-orphan',
        },
      ]);

      vi.advanceTimersByTime(30 * 60_000 + 1);
      store._sweep();

      const state = useCodemapActivityStore.getState();
      expect(state.getActiveOperations()).toHaveLength(0);
      expect(state.getActivityForFile('D:/repo/src/orphan.ts')[0]).toEqual(
        expect.objectContaining({ status: 'failed', ok: false }),
      );
      expect(state.getActivityForFile('D:/repo/src/orphan.ts')[0]?.summary).toContain(
        'telemetry timeout',
      );
      vi.useRealTimers();
    });
  });

  // ── clear ───────────────────────────────────────────────────────────────────

  describe('clear', () => {
    it('resets all state to empty', () => {
      const store = useCodemapActivityStore.getState();
      store.recordActivity(makeActivity('clear.ts', 'read'));
      store.recordActivity(makeActivity('other.ts', 'write'));
      expect(useCodemapActivityStore.getState().totalCount).toBe(2);

      store.clear();

      const after = useCodemapActivityStore.getState();
      expect(after.history.size).toBe(0);
      expect(after.pulses.size).toBe(0);
      expect(after.activeOperations.size).toBe(0);
      expect(after.totalCount).toBe(0);
    });
  });

  // ── getPulseType ────────────────────────────────────────────────────────────

  describe('getPulseType', () => {
    it('returns the most recent activity type for a pulsing file', () => {
      const store = useCodemapActivityStore.getState();
      store.recordActivity(makeActivity('pulse.ts', 'read', 1000));
      store.recordActivity(makeActivity('pulse.ts', 'write', 2000));

      expect(store.getPulseType('pulse.ts')).toBe('write');
    });

    it('returns undefined for a non-pulsing file', () => {
      const store = useCodemapActivityStore.getState();
      expect(store.getPulseType('nonexistent.ts')).toBeUndefined();
    });
  });
});
