import { describe, expect, it } from 'vitest';
import {
  analyzeFileActivity,
  normalizeTrackedPath,
  pathsReferToSameFile,
  summarizeLineage,
} from '../../src/components/FileActivityDrawer.js';
import type { ChronicleFileLineageRow } from '../../src/types.js';

describe('FileActivityDrawer model', () => {
  it('matches relative and absolute Windows paths for the same file', () => {
    expect(normalizeTrackedPath('.\\src\\Editor.tsx')).toBe('src/editor.tsx');
    expect(
      pathsReferToSameFile(
        'D:\\Codebox\\WrongStack\\packages\\webui\\src\\Editor.tsx',
        'packages/webui/src/Editor.tsx',
      ),
    ).toBe(true);
    expect(pathsReferToSameFile('src/a.ts', 'src/b.ts')).toBe(false);
  });

  it('flags repeated multi-actor mutations as high churn', () => {
    const now = Date.now();
    const records = Array.from({ length: 8 }, (_, index) => ({
      at: now - index * 10_000,
      action: index % 2 === 0 ? 'edit' : 'write',
      actor: index % 3 === 0 ? 'leader' : index % 3 === 1 ? 'worker-a' : 'worker-b',
      sessionId: `session-${index % 2}`,
      taskId: `task-${index % 2}`,
    }));

    expect(analyzeFileActivity(records, now)).toEqual({
      level: 'churn',
      mutationCount: 8,
      sessionCount: 2,
      actorCount: 3,
      taskCount: 2,
    });
  });

  it('ignores stale activity when deriving the current state', () => {
    const now = Date.now();
    expect(
      analyzeFileActivity(
        [
          {
            at: now - 31 * 60_000,
            action: 'write',
            actor: 'worker',
            sessionId: 'session-old',
            taskId: 'task-old',
          },
        ],
        now,
      ),
    ).toEqual({ level: 'quiet', mutationCount: 0, sessionCount: 0, actorCount: 0, taskCount: 0 });
  });

  it('rolls up full-history lineage into distinct-count summary', () => {
    const row = (over: Partial<ChronicleFileLineageRow>): ChronicleFileLineageRow => ({
      path: 'src/app.ts',
      operation: 'update',
      occurredAt: '2026-07-20T10:00:00.000Z',
      sessionId: '',
      agentId: '',
      taskId: '',
      boardId: '',
      runId: '',
      toolName: '',
      providerId: '',
      modelId: '',
      source: 'tool',
      ...over,
    });
    const summary = summarizeLineage([
      row({
        occurredAt: '2026-07-20T10:00:00.000Z',
        sessionId: 's1',
        taskId: 't1',
        boardId: 'b1',
        toolName: 'edit',
        modelId: 'm1',
      }),
      row({
        occurredAt: '2026-07-22T10:00:00.000Z',
        sessionId: 's2',
        taskId: 't1',
        boardId: 'b1',
        toolName: 'write',
        modelId: 'm1',
      }),
      row({
        occurredAt: '2026-07-24T10:00:00.000Z',
        sessionId: 's2',
        taskId: 't2',
        toolName: 'edit',
        modelId: 'm2',
      }),
    ]);
    expect(summary).toMatchObject({
      mutations: 3,
      sessions: 2,
      tasks: 2,
      boards: 1,
      firstAt: '2026-07-20T10:00:00.000Z',
      lastAt: '2026-07-24T10:00:00.000Z',
    });
    expect([...summary.tools].sort()).toEqual(['edit', 'write']);
    expect([...summary.models].sort()).toEqual(['m1', 'm2']);
  });

  it('summarizes empty lineage without touching optional fields', () => {
    expect(summarizeLineage([])).toEqual({
      mutations: 0,
      sessions: 0,
      tasks: 0,
      boards: 0,
      tools: [],
      models: [],
      firstAt: undefined,
      lastAt: undefined,
    });
  });
});
