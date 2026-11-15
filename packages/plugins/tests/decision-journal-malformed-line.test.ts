import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import plugin from '../src/decision-journal/index.js';

const temps: string[] = [];

afterEach(async () => {
  for (const dir of temps.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe('decision-journal malformed JSONL resilience (F366)', () => {
  it('skips corrupt JSONL lines instead of crashing decision_lookup', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'f366-dj-'));
    temps.push(tmp);
    await fs.writeFile(
      path.join(tmp, 'journal.jsonl'),
      `${JSON.stringify({ id: 'd1', files: ['src/index.ts'], supersedes: null })}\nCORRUPT_LINE\n`,
      'utf8',
    );

    let lookupTool:
      | {
          execute: (
            input: Record<string, unknown>,
            ctx: Record<string, unknown>,
          ) => Promise<unknown>;
        }
      | undefined;
    await plugin.setup({
      config: { extensions: {} },
      tools: {
        register: (tool: { name: string }) => {
          if (tool.name === 'decision_lookup') lookupTool = tool as never;
        },
      },
    } as never);

    const res = (await lookupTool!.execute(
      { journal: 'journal.jsonl', files: ['src/index.ts'] },
      { cwd: tmp, workspaceRoot: tmp },
    )) as { decisions: Array<{ id: string }> };

    expect(res.decisions.some((d) => d.id === 'd1')).toBe(true);
  });
});
