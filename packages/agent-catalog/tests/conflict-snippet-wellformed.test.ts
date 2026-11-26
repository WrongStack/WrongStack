import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectLearnedConflicts } from '../src/project-agent-capture.js';

const ROCKET = '\u{1F680}';

/**
 * F2637: `detectLearnedConflicts` reports the first 200 UTF-16 units of each
 * conflicting learned directive with a plain `.slice`. Learned lines come from
 * agent output, and the snippets are rendered by the agent-catalog surface.
 */
describe('learned-conflict snippets keep valid UTF-16 (F2637)', () => {
  let root: string;

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'conflict-snippet-'));
  });

  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  async function writeLearned(role: string, line: string): Promise<void> {
    const dir = path.join(root, '.wrongstack', 'agents', role);
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, 'learned.md'), `${line}\n${role}-only tail\n`);
  }

  it('never ends a snippet on half of a surrogate pair', async () => {
    const shared = `${'x'.repeat(199)}${ROCKET} shared directive text`;
    await writeLearned('alpha', shared);
    await writeLearned('beta', shared);

    const conflicts = detectLearnedConflicts(root);

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.snippetA.isWellFormed()).toBe(true);
    expect(conflicts[0]?.snippetB.isWellFormed()).toBe(true);
    expect(conflicts[0]?.snippetA).toBe('x'.repeat(199));
  });

  it('reports no conflict for unrelated short lines (control)', async () => {
    await writeLearned('alpha', 'short alpha');
    await writeLearned('beta', 'short beta');

    expect(detectLearnedConflicts(root)).toEqual([]);
  });
});
