import { describe, expect, it } from 'vitest';
import { makeMutationTestTool } from '../../src/coordination/director-mutation-test-tool.js';
import type * as Host from '../../src/coordination/director-host-contracts.js';
import type { TaskResult, TaskSpec } from '../../src/types/multi-agent.js';

/**
 * In-memory DirectorRepairPort double. Records spawn/assign/await calls so
 * tests can assert the strengthen-loop choreography without an LLM.
 */
function makeFakeDirector(handler: {
  chaos: (plan: MutationTestTaskShape) => string | undefined;
  strengthen?: (survivorIds: string[]) => string | undefined;
}) {
  const tasks = new Map<string, { spec: TaskSpec; resultText?: string }>();
  const spawns: string[] = [];
  const assigns: TaskSpec[] = [];
  let n = 0;

  const resolveTask = (id: string): TaskResult => {
    const entry = tasks.get(id)!;
    const isStrengthen = entry.spec.subagentId === 'repair-sub';
    const text = isStrengthen
      ? handler.strengthen?.(survivorIdsOf(entry.spec.description)) ?? 'strengthened'
      : handler.chaos(parseChaosTask(entry.spec.description));
    return {
      subagentId: entry.spec.subagentId ?? 'unknown-sub',
      taskId: id,
      status: text === undefined ? 'failed' : 'success',
      ...(text === undefined ? {} : { result: text }),
      iterations: 1,
      toolCalls: 1,
      durationMs: 1,
    };
  };

  const director: Host.DirectorRepairPort = {
    async spawn() {
      const id = `sub-${++n}`;
      spawns.push(id);
      return id;
    },
    async assign(task) {
      assigns.push(task);
      tasks.set(task.id, { spec: task });
      return task.id;
    },
    async awaitTasks(ids) {
      return ids.map(resolveTask);
    },
    async awaitTasksAny(ids) {
      return { completed: ids.map(resolveTask), pending: [] };
    },
  };
  return { director, spawns, assigns };
}

interface MutationTestTaskShape {
  mutants: Array<{ id: string; file: string; line: number; kind: string }>;
}
function parseChaosTask(desc: string): MutationTestTaskShape {
  const ids = [...desc.matchAll(/^- ([\w-]+#\d+#\d+) \| ([^|]+):(\d+):(\d+) \| ([\w-]+)/gm)].map(
    (m) => ({ id: m[1]!, file: m[2]!.trim(), line: Number(m[3]), kind: m[5]! }),
  );
  return { mutants: ids };
}
function survivorIdsOf(desc: string): string[] {
  return [...desc.matchAll(/^- ([\w-]+#\d+#\d+) \|/gm)].map((m) => m[1]!);
}

const TARGET_FILE = 'packages/core/tests/coordination/__mutation_fixture__/subject.ts';

describe('makeMutationTestTool', () => {
  it('errors cleanly when no mutable sites exist', async () => {
    const { director } = makeFakeDirector({ chaos: () => '{}' });
    const tool = makeMutationTestTool(director, undefined, { projectRoot: process.cwd() });
    const out = (await tool.execute(
      { targets: ['no/such/file.ts'], testCommand: 'vitest' },
      { projectRoot: process.cwd() } as never,
      { signal: new AbortController().signal },
    )) as Record<string, unknown>;
    expect(out['verdict']).toBe('inconclusive');
    expect(out['error']).toMatch(/No mutable sites/i);
  });

  it('reports killed mutants and passes without repair', async () => {
    const { director, spawns, assigns } = makeFakeDirector({
      chaos: (task) =>
        JSON.stringify({
          summary: 'all killed',
          mutants: task.mutants.map((m) => ({ ...m, status: 'killed', evidence: 'assert failed' })),
        }),
    });
    const tool = makeMutationTestTool(director, undefined, { projectRoot: process.cwd() });
    const out = (await tool.execute(
      { targets: [TARGET_FILE], testCommand: 'pnpm test' },
      { projectRoot: process.cwd() } as never,
      { signal: new AbortController().signal },
    )) as Record<string, unknown>;

    expect(out['verdict']).toBe('pass');
    expect(out['passed']).toBe(true);
    expect(out['mutationScore']).toBe(1);
    expect(out['killed']).toBeGreaterThan(0);
    expect(out['survived']).toBe(0);
    // One chaos spawn; no strengthen tasks without repairSubagentId.
    expect(spawns).toHaveLength(1);
    expect(assigns).toHaveLength(1);
  });

  it('loops strengthen → re-verify on survivors and flags persistent ones as suspected-equivalent', async () => {
    // First chaos pass: everything survives. Re-verify passes: the arith
    // mutant dies after strengthening; the return-null mutant persists.
    let chaosPass = 0;
    const { director, assigns } = makeFakeDirector({
      chaos: (task) => {
        chaosPass++;
        const statusOf = (id: string): 'killed' | 'survived' =>
          chaosPass === 1 || !id.startsWith('arith') ? 'survived' : 'killed';
        return JSON.stringify({
          summary: 'pass done',
          mutants: task.mutants.map((m) => ({ ...m, status: statusOf(m.id), evidence: 'x' })),
        });
      },
      strengthen: (ids) => `strengthened ${ids.length} survivors`,
    });
    const tool = makeMutationTestTool(director, undefined, { projectRoot: process.cwd() });
    const out = (await tool.execute(
      {
        targets: [TARGET_FILE],
        testCommand: 'pnpm test',
        maxPerFile: 2,
        repairSubagentId: 'repair-sub',
      },
      { projectRoot: process.cwd() } as never,
      { signal: new AbortController().signal },
    )) as Record<string, unknown>;

    expect(out['survived']).toBeGreaterThan(0);
    expect(out['strengthenAttempts']).toBeGreaterThan(0);
    expect(out['nextAction']).toMatch(/survivors|strengthen/);
    const equivalent = out['suspectedEquivalent'] as string[];
    expect(equivalent.some((id) => id.startsWith('return-null'))).toBe(true);
    // Assigns: chaos + (strengthen + rerun) per attempt.
    const strengthenAssigns = assigns.filter((a) => a.subagentId === 'repair-sub');
    expect(strengthenAssigns.length).toBeGreaterThan(0);
  });

  it('treats a failed chaos task as skipped mutants, never as kills', async () => {
    const { director } = makeFakeDirector({ chaos: () => undefined });
    const tool = makeMutationTestTool(director, undefined, { projectRoot: process.cwd() });
    const out = (await tool.execute(
      { targets: [TARGET_FILE], testCommand: 'pnpm test' },
      { projectRoot: process.cwd() } as never,
      { signal: new AbortController().signal },
    )) as Record<string, unknown>;
    expect(out['skipped']).toBeGreaterThan(0);
    expect(out['killed']).toBe(0);
    expect(out['verdict']).toBe('inconclusive');
    expect(out['passed']).toBe(false);
  });

  it('plans deterministically — same target, same ids across two calls', async () => {
    const seen: string[][] = [];
    const { director } = makeFakeDirector({
      chaos: (task) => {
        seen.push(task.mutants.map((m) => m.id));
        return JSON.stringify({
          summary: 'ok',
          mutants: task.mutants.map((m) => ({ ...m, status: 'killed' })),
        });
      },
    });
    const tool = makeMutationTestTool(director, undefined, { projectRoot: process.cwd() });
    for (let i = 0; i < 2; i++) {
      await tool.execute(
        { targets: [TARGET_FILE], testCommand: 'pnpm test' },
        { projectRoot: process.cwd() } as never,
        { signal: new AbortController().signal },
      );
    }
    expect(seen[0]).toEqual(seen[1]);
  });
});
