import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { benchCmd } from '../src/subcommands/handlers/bench.js';
import type { SubcommandDeps } from '../src/subcommands/index.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function setup(): Promise<{ dir: string; transcript: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cli-bench-mine-'));
  tempDirs.push(dir);
  const transcript = path.join(dir, 'session.jsonl');
  const events = [
    { type: 'session_start', id: 'sess-mine' },
    { type: 'user_input', content: 'Update the handler.' },
    { type: 'tool_use', id: 'read-1', name: 'read', input: { path: 'handler.ts' } },
    { type: 'tool_result', id: 'read-1', content: 'legacy handler', isError: false },
    {
      type: 'tool_use',
      id: 'edit-1',
      name: 'edit',
      input: { path: 'handler.ts', newText: 'modern handler' },
    },
    { type: 'tool_call_end', id: 'edit-1', name: 'edit', ok: false },
  ];
  await fs.writeFile(transcript, events.map((event) => JSON.stringify(event)).join('\n'), 'utf8');
  return { dir, transcript };
}

function deps(cwd: string, flags: Record<string, string>): SubcommandDeps {
  return {
    cwd,
    flags,
    renderer: {
      write: vi.fn(),
      writeInfo: vi.fn(),
      writeError: vi.fn(),
    },
  } as unknown as SubcommandDeps;
}

describe('wstack bench mine', () => {
  it('mines a supplied session JSONL into the requested eval corpus', async () => {
    const { dir, transcript } = await setup();
    const d = deps(dir, { transcript: path.basename(transcript), out: 'evals' });

    await expect(benchCmd(['mine'], d)).resolves.toBe(0);
    expect(d.renderer.writeInfo).toHaveBeenCalledWith(
      expect.stringContaining('Mined 1 edit attempt'),
    );
    await expect(
      fs.access(path.join(dir, 'evals', 'trace-eval-drafts.json')),
    ).resolves.toBeUndefined();
  });

  it('requires a source transcript', async () => {
    const { dir } = await setup();
    const d = deps(dir, {});

    await expect(benchCmd(['mine'], d)).resolves.toBe(1);
    expect(d.renderer.writeError).toHaveBeenCalledWith(
      expect.stringContaining('Usage: wstack bench mine'),
    );
  });
});
