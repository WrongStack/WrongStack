import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { TextBlock } from '@wrongstack/core/types';
import { stripAnsi } from '@wrongstack/core/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HINT_COUNT,
  HINT_GROUP_COUNT,
  HINT_GROUP_TITLES,
  printLaunchHints,
} from '../src/launch-hints.js';

function makeRenderer(): { write: (input: string | TextBlock) => void; output: () => string } {
  const write = vi.fn<(input: string | TextBlock) => void>();
  return {
    write,
    output: () =>
      stripAnsi(
        (write as never as { mock: { calls: unknown[][] } }).mock.calls
          .map((c) => String(c[0]))
          .join(''),
      ),
  };
}

describe('printLaunchHints', () => {
  const originalEnv = process.env.WRONGSTACK_NO_HINTS;

  beforeEach(() => {
    delete process.env.WRONGSTACK_NO_HINTS;
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.WRONGSTACK_NO_HINTS;
    else process.env.WRONGSTACK_NO_HINTS = originalEnv;
  });

  it('exposes at least 20 hints across all groups', () => {
    expect(HINT_COUNT).toBeGreaterThanOrEqual(20);
  });

  it('shows ONE category per launch, not the whole list', async () => {
    const r = makeRenderer();
    await printLaunchHints(r, {}, { groupIndex: 0 });
    const out = r.output();
    // Header names the category and its position in the rotation.
    expect(out).toContain(HINT_GROUP_TITLES[0] as string);
    expect(out).toContain(`1/${HINT_GROUP_COUNT}`);
    // Autonomy group is shown…
    expect(out).toContain('/goal');
    // …but a hint unique to a different group is NOT.
    expect(out).not.toContain('/mcp');
    expect(out).toContain('/help');
  });

  it('rotates to a different category on the next index', async () => {
    const r0 = makeRenderer();
    await printLaunchHints(r0, {}, { groupIndex: 0 });
    const r1 = makeRenderer();
    await printLaunchHints(r1, {}, { groupIndex: 1 });
    expect(r0.output()).not.toEqual(r1.output());
    expect(r1.output()).toContain(HINT_GROUP_TITLES[1] as string);
  });

  it('uses current agent and workspace terminology', async () => {
    const outputs: string[] = [];
    for (let groupIndex = 0; groupIndex < HINT_GROUP_COUNT; groupIndex++) {
      const r = makeRenderer();
      await printLaunchHints(r, {}, { groupIndex, termWidth: 160 });
      outputs.push(r.output());
    }

    const allHints = outputs.join('\n');
    expect(allHints).toContain('Agents & fleet');
    expect(allHints).toContain('/delegate [--role=<role>] <task>');
    expect(allHints).toContain('/spawn [-p <provider>] [-m <model>] [-n <name>] <task>');
    expect(allHints).toContain('/agents [list|show <id>|stream on|off]');
    expect(allHints).toContain('/fleet status|usage|kill|log|manifest');
    expect(allHints).toContain('Workspace tools');
    expect(allHints).toContain('wstack usage');
    expect(allHints).not.toContain('--director');
    expect(allHints).not.toContain('Director Mode');
    expect(allHints).not.toContain('Multi-agent / fleet');
    expect(allHints).not.toContain('Daily ops');
    expect(allHints).not.toContain('/usage');
  });

  it.each([80, 50, 30, 20])(
    'wraps every hint group within a %i-column terminal',
    async (termWidth) => {
      for (let groupIndex = 0; groupIndex < HINT_GROUP_COUNT; groupIndex++) {
        const r = makeRenderer();
        await printLaunchHints(r, {}, { groupIndex, termWidth });
        const lines = r.output().split('\n');
        expect(Math.max(...lines.map((line) => [...line].length))).toBeLessThanOrEqual(termWidth);
      }
    },
  );

  it('wraps groupIndex out of range', async () => {
    const r = makeRenderer();
    await printLaunchHints(r, {}, { groupIndex: HINT_GROUP_COUNT });
    // Index N wraps to 0.
    expect(r.output()).toContain(`1/${HINT_GROUP_COUNT}`);
  });

  it('advances a persisted cursor across launches (round-robin)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wstack-hints-'));
    const cursorFile = path.join(dir, 'sub', 'hint-cursor');
    try {
      const seen: string[] = [];
      for (let i = 0; i < HINT_GROUP_COUNT; i++) {
        const r = makeRenderer();
        await printLaunchHints(r, {}, { cursorFile });
        // First non-empty content line after the header carries the title.
        const header = r
          .output()
          .split('\n')
          .find((l) => l.includes(`${i + 1}/${HINT_GROUP_COUNT}`));
        expect(header).toBeTruthy();
        seen.push(header as string);
      }
      // Every launch showed a distinct position in the rotation.
      expect(new Set(seen).size).toBe(HINT_GROUP_COUNT);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skips output when --no-hints is set', async () => {
    const r = makeRenderer();
    await printLaunchHints(r, { 'no-hints': true });
    expect(r.write).not.toHaveBeenCalled();
  });

  it('skips output when WRONGSTACK_NO_HINTS=1 is set', async () => {
    process.env.WRONGSTACK_NO_HINTS = '1';
    const r = makeRenderer();
    await printLaunchHints(r, {});
    expect(r.write).not.toHaveBeenCalled();
  });

  it('treats WRONGSTACK_NO_HINTS=0 / false as not suppressed', async () => {
    process.env.WRONGSTACK_NO_HINTS = '0';
    const r1 = makeRenderer();
    await printLaunchHints(r1, {}, { groupIndex: 0 });
    expect(r1.write).toHaveBeenCalled();

    process.env.WRONGSTACK_NO_HINTS = 'false';
    const r2 = makeRenderer();
    await printLaunchHints(r2, {}, { groupIndex: 0 });
    expect(r2.write).toHaveBeenCalled();
  });

  it('renders hints using random group when no cursorFile or groupIndex specified', async () => {
    const r = makeRenderer();
    await printLaunchHints(r, {});
    expect(r.write).toHaveBeenCalled();
  });
});
