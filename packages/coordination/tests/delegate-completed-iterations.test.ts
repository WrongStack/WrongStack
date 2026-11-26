import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventBus } from '@wrongstack/contracts/kernel/events';
import type { Tool } from '@wrongstack/contracts/types/tool';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDelegateTool } from '../src/delegate-tool.js';
import { Director } from '../src/director.js';
import { FLEET_ROSTER } from '../src/fleet.js';

const BOUNDARY = {
  scope: 'The named target only — read, verify, report.',
  outOfScope: ['Do not modify any files', 'Do not fix issues you discover'],
};
const ITERATIONS = 3;
const TOOL_EVENTS = 8;

/**
 * F2420: on the aborted / host_timeout / empty-result paths the emitted
 * `delegate.completed.iterations` came from `readSubagentPartial().events`,
 * which counts every JSONL line (tool_use, text, lifecycle markers). Surfaces
 * render that field as "N iterations", so a failed delegation showed a number
 * several times too large. Iterations are counted from `in_flight_start`
 * markers, the same definition the summary builder uses.
 */
describe('delegate.completed iterations on the failure paths (F2420)', () => {
  let tmpRoot: string;
  let runId: string;
  let subagentDir: string;
  let journal: string;
  let journalLines: number;

  beforeEach(async () => {
    tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'delegate-iterations-'));
    runId = 'partial-run';
    subagentDir = path.join(tmpRoot, runId);
    await fsp.mkdir(subagentDir, { recursive: true });

    const lines: string[] = [
      JSON.stringify({ type: 'session_start', ts: '2026-01-01T00:00:00Z' }),
      JSON.stringify({ type: 'user_input', content: 'investigate' }),
    ];
    for (let iteration = 0; iteration < ITERATIONS; iteration++) {
      lines.push(
        JSON.stringify({
          type: 'in_flight_start',
          ts: `2026-01-01T00:00:0${iteration}Z`,
          context: `iteration ${iteration} / max 20`,
        }),
        JSON.stringify({
          type: 'llm_response',
          stopReason: 'tool_use',
          content: [{ type: 'text', text: `step ${iteration}` }],
        }),
      );
      for (let call = 0; call < TOOL_EVENTS; call++) {
        lines.push(JSON.stringify({ type: 'tool_use', name: `tool-${call}` }));
      }
    }
    lines.push(JSON.stringify({ type: 'session_end' }));
    journal = `${lines.join('\n')}\n`;
    journalLines = lines.length;
  });

  afterEach(async () => {
    await fsp.rm(tmpRoot, { recursive: true, force: true });
  });

  async function runTimeout(): Promise<{
    payload: {
      iterations?: number;
      toolCalls?: number;
    };
    result: { partial?: { events?: number; iterationsObserved?: number } };
  }> {
    const bus = new EventBus();
    const completed: Array<{
      iterations?: number;
      toolCalls?: number;
    }> = [];
    bus.on('delegate.completed', (payload) => completed.push(payload));

    const director = new Director({
      sessionId: 'sess_test',
      config: {
        coordinatorId: 'partial-test',
        doneCondition: { type: 'all_tasks_done' },
        maxConcurrent: 1,
      },
      runner: () =>
        new Promise(() => {
          /* never resolves — forces the timeout path */
        }),
    });
    const origSpawn = director.spawn.bind(director);
    director.spawn = async (config, priceLookup) => {
      const id = await origSpawn(config, priceLookup);
      await fsp.writeFile(path.join(subagentDir, `${id}.jsonl`), journal);
      return id;
    };

    const tool: Tool = createDelegateTool({
      host: {
        isDirectorMode: () => true,
        ensureDirector: async () => director,
        promoteToDirector: async () => director,
      },
      roster: FLEET_ROSTER,
      sessionsRoot: tmpRoot,
      directorRunId: runId,
      events: bus,
    });

    const result = (await tool.execute(
      { wait: true, role: 'bug-hunter', task: 'investigate', timeoutMs: 30, ...BOUNDARY },
      null as never,
      { signal: new AbortController().signal } as never,
    )) as { partial?: { events?: number; iterationsObserved?: number } };
    await director.shutdown();
    const payload = completed[0];
    if (!payload) throw new Error('no delegate.completed payload captured');
    return { payload, result };
  }

  it('reports the iteration count, not the journal line count', async () => {
    const { payload, result } = await runTimeout();

    expect(payload.iterations).toBe(ITERATIONS);
    expect(payload.toolCalls).toBe(ITERATIONS * TOOL_EVENTS);
    // `events` keeps its own meaning: every parsed journal line.
    expect(result.partial?.events).toBe(journalLines);
    expect(result.partial?.iterationsObserved).toBe(ITERATIONS);
  });
});
