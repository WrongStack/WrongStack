import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ContentBlock, TextBlock } from '@wrongstack/core/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sessionsFleetCmd } from '../src/subcommands/handlers/sessions-fleet.js';
import type { SubcommandDeps } from '../src/subcommands/index.js';

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sessions-fleet-'));
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

type TestRenderer = SubcommandDeps['renderer'] & {
  write: ((input: string | TextBlock) => void) & ReturnType<typeof vi.fn>;
  writeError: ((text: string) => void) & ReturnType<typeof vi.fn>;
  writeWarning: ((text: string) => void) & ReturnType<typeof vi.fn>;
  writeInfo: ((text: string) => void) & ReturnType<typeof vi.fn>;
  writeLine: ((text?: string) => void) & ReturnType<typeof vi.fn>;
  writeBlock: ((block: ContentBlock) => void) & ReturnType<typeof vi.fn>;
  writeToolCall: ((name: string, input: unknown) => void) & ReturnType<typeof vi.fn>;
  writeToolResult: ((name: string, content: unknown, isError: boolean) => void) &
    ReturnType<typeof vi.fn>;
  writeDiff: ((unifiedDiff: string) => void) & ReturnType<typeof vi.fn>;
  clear: (() => void) & ReturnType<typeof vi.fn>;
};

type TestDeps = SubcommandDeps & { renderer: TestRenderer };

function renderText(input: string | TextBlock): string {
  return typeof input === 'string' ? input : input.text;
}

function deps(): TestDeps {
  return {
    config: {} as SubcommandDeps['config'],
    renderer: {
      write: vi.fn((input: string | TextBlock) => {
        void renderText(input);
      }),
      writeLine: vi.fn() as never,
      writeBlock: vi.fn((block: ContentBlock) => {
        if (block.type === 'text') void block.text;
      }),
      writeToolCall: vi.fn() as never,
      writeToolResult: vi.fn() as never,
      writeDiff: vi.fn() as never,
      writeError: vi.fn() as never,
      writeWarning: vi.fn() as never,
      writeInfo: vi.fn() as never,
      clear: vi.fn() as never,
    } as never,
    reader: {} as SubcommandDeps['reader'],
    sessionStore: undefined,
    skillLoader: undefined,
    toolRegistry: undefined,
    modelsRegistry: {} as SubcommandDeps['modelsRegistry'],
    paths: { projectSessions: tmp } as unknown as SubcommandDeps['paths'],
    vault: {} as SubcommandDeps['vault'],
    cwd: tmp,
    projectRoot: tmp,
    userHome: tmp,
    flags: {},
  };
}

function joined(spy: { mock: { calls: Array<unknown[]> } }): string {
  return spy.mock.calls.map((c) => String(c[0] ?? '')).join('');
}

describe('sessionsFleetCmd — list mode', () => {
  it('reports "No fleet runs" when no entries exist', async () => {
    const d = deps();
    const code = await sessionsFleetCmd([], d);
    expect(code).toBe(0);
    expect(joined(d.renderer.write)).toContain('No fleet runs');
  });

  it('errors when projectSessions does not exist', async () => {
    const badTmp = path.join(tmp, 'does-not-exist');
    const d = {
      ...deps(),
      paths: { projectSessions: badTmp } as never,
    };
    const code = await sessionsFleetCmd([], d);
    expect(code).toBe(1);
    expect(d.renderer.writeError).toHaveBeenCalled();
  });

  it('lists runs with checkpoint/manifest flags', async () => {
    await fs.mkdir(path.join(tmp, 'run-a'), { recursive: true });
    await fs.writeFile(path.join(tmp, 'run-a', 'fleet.json'), JSON.stringify({}));
    await fs.writeFile(path.join(tmp, 'run-a', 'checkpoint.json'), JSON.stringify({}));
    await fs.mkdir(path.join(tmp, 'run-a', 'subagents'), { recursive: true });
    await fs.writeFile(path.join(tmp, 'run-a', 'subagents', 'one.jsonl'), '');
    await fs.writeFile(path.join(tmp, 'run-a', 'subagents', 'README.md'), 'not jsonl');

    await fs.mkdir(path.join(tmp, 'run-b'), { recursive: true });
    // No fleet.json, no subagents in run-b
    await fs.writeFile(path.join(tmp, 'run-b', 'checkpoint.json'), '{}');

    const d = deps();
    const code = await sessionsFleetCmd([], d);
    expect(code).toBe(0);
    const out = joined(d.renderer.write);
    expect(out).toContain('Fleet Runs');
    expect(out).toContain('run-a');
    expect(out).toContain('run-b');
    expect(out).toContain('1 subagent jsonl');
  });

  it('skips non-directory entries', async () => {
    await fs.writeFile(path.join(tmp, 'just-a-file.txt'), 'data');
    const d = deps();
    const code = await sessionsFleetCmd([], d);
    expect(code).toBe(0);
    expect(joined(d.renderer.write)).toContain('No fleet runs');
  });
});

describe('sessionsFleetCmd — show mode', () => {
  it('errors when runId directory missing', async () => {
    const d = deps();
    const code = await sessionsFleetCmd(['missing-run'], d);
    expect(code).toBe(1);
    expect(d.renderer.writeError).toHaveBeenCalledWith(expect.stringContaining('not found'));
  });

  it('errors when runId is a file, not a directory', async () => {
    await fs.writeFile(path.join(tmp, 'not-a-dir'), 'x');
    const d = deps();
    const code = await sessionsFleetCmd(['not-a-dir'], d);
    expect(code).toBe(1);
    expect(d.renderer.writeError).toHaveBeenCalledWith(expect.stringContaining('Not a directory'));
  });

  it('renders banner with subagent/task counts from manifest', async () => {
    const runDir = path.join(tmp, 'r1');
    await fs.mkdir(runDir, { recursive: true });
    await fs.writeFile(
      path.join(runDir, 'fleet.json'),
      JSON.stringify({
        subagents: [{ id: 's1' }, { id: 's2' }],
        tasks: [
          { id: 't1', status: 'completed' },
          { id: 't2', status: 'pending' },
          { id: 't3', status: 'failed' },
        ],
      }),
    );
    const d = deps();
    const code = await sessionsFleetCmd(['r1'], d);
    expect(code).toBe(0);
    const out = joined(d.renderer.write);
    expect(out).toContain('Fleet Run: r1');
    expect(out).toContain('2 subagent');
    expect(out).toContain('2/3 tasks done'); // completed + failed
  });

  it('shows missing-file markers when manifest/checkpoint absent', async () => {
    await fs.mkdir(path.join(tmp, 'empty'), { recursive: true });
    const d = deps();
    await sessionsFleetCmd(['empty'], d);
    const out = joined(d.renderer.write);
    expect(out).toContain('fleet.json — not found');
    expect(out).toContain('checkpoint.json — not found');
    expect(out).toContain('No subagent transcripts');
    expect(out).toContain('No shared scratchpad');
  });

  it('renders checkpoint details with no-lock state', async () => {
    const runDir = path.join(tmp, 'r2');
    await fs.mkdir(runDir, { recursive: true });
    await fs.writeFile(
      path.join(runDir, 'checkpoint.json'),
      JSON.stringify({
        updatedAt: '2026-05-22T10:00:00Z',
        spawnCount: 5,
        tasks: [
          { taskId: 'task-a', status: 'pending', description: 'Investigate flake' },
          { taskId: 'task-b', status: 'completed', description: null },
        ],
        subagents: [
          { id: 'sub-1', name: 'planner', provider: 'anthropic', model: 'opus', spawnedAt: 'now' },
          { id: 'sub-2', spawnedAt: 'later' },
        ],
      }),
    );
    const d = deps();
    await sessionsFleetCmd(['r2'], d);
    const out = joined(d.renderer.write);
    expect(out).toContain('checkpoint.json — updated 2026-05-22');
    expect(out).toContain('5 spawns');
    expect(out).toContain('no lock (safe to resume)');
    expect(out).toContain('Subagents:');
    expect(out).toContain('sub-1');
    expect(out).toContain('Tasks:');
    expect(out).toContain('Investigate flake');
    expect(out).toContain('(no description)');
  });

  it('reports lock-held when checkpoint has companion .lock', async () => {
    const runDir = path.join(tmp, 'r3');
    await fs.mkdir(runDir, { recursive: true });
    await fs.writeFile(
      path.join(runDir, 'checkpoint.json'),
      JSON.stringify({ updatedAt: 't', spawnCount: 1, tasks: [], subagents: [] }),
    );
    await fs.writeFile(
      path.join(runDir, 'checkpoint.json.lock'),
      JSON.stringify({ pid: 1234, hostname: 'host', startedAt: 'when' }),
    );
    const d = deps();
    await sessionsFleetCmd(['r3'], d);
    const out = joined(d.renderer.write);
    expect(out).toContain('lock held by pid 1234');
    expect(out).toContain('host');
  });

  it('lists subagent transcript files with KB / MB sizes', async () => {
    const runDir = path.join(tmp, 'r4');
    await fs.mkdir(path.join(runDir, 'subagents'), { recursive: true });
    await fs.writeFile(path.join(runDir, 'subagents', 'small.jsonl'), 'x'.repeat(2048));
    await fs.writeFile(path.join(runDir, 'subagents', 'big.jsonl'), 'y'.repeat(2 * 1024 * 1024));
    const d = deps();
    await sessionsFleetCmd(['r4'], d);
    const out = joined(d.renderer.write);
    expect(out).toContain('Subagent transcripts');
    expect(out).toContain('small.jsonl');
    expect(out).toContain('big.jsonl');
    expect(out).toMatch(/2(\.0)?MB/);
  });

  it('reports shared scratchpad file count when present', async () => {
    const runDir = path.join(tmp, 'r5');
    await fs.mkdir(path.join(runDir, 'shared'), { recursive: true });
    await fs.writeFile(path.join(runDir, 'shared', 'a.md'), '');
    await fs.writeFile(path.join(runDir, 'shared', 'b.md'), '');
    const d = deps();
    await sessionsFleetCmd(['r5'], d);
    const out = joined(d.renderer.write);
    expect(out).toContain('Shared scratchpad: 2 file(s)');
  });

  it('survives malformed manifest gracefully', async () => {
    const runDir = path.join(tmp, 'r6');
    await fs.mkdir(runDir, { recursive: true });
    await fs.writeFile(path.join(runDir, 'fleet.json'), '{not json');
    const d = deps();
    const code = await sessionsFleetCmd(['r6'], d);
    expect(code).toBe(0);
    expect(joined(d.renderer.write)).toContain('fleet.json — not found');
  });
});
