import { describe, expect, it } from 'vitest';
import { buildSnapshotToolCalls } from '../src/office/agent-office.js';

const ROCKET = '\u{1F680}';

const receipt = (command: string) => ({
  id: 'r1',
  name: 'bash',
  completedAt: 1_700_000_000_000,
  input: { command },
  ok: true,
});

/**
 * F2657: the Office tool-call summary comes from `compactCommand`, which cuts a
 * terminal command at 69 UTF-16 units with a plain `slice`. The summary is
 * rendered by the WebUI agent-office panel, so a split astral character shows
 * up as a replacement glyph there.
 */
describe('office tool summaries keep valid UTF-16 (F2657)', () => {
  it('drops the orphaned half in a long terminal command', () => {
    const [call] = buildSnapshotToolCalls(
      [receipt(`${'c'.repeat(68)}${ROCKET}tail`)],
      'agent-1',
      'sess-1',
    );

    expect(call?.summary.isWellFormed()).toBe(true);
    expect(call?.summary).toBe(`${'c'.repeat(68)}…`);
  });

  it('keeps a short command unchanged (control)', () => {
    const [call] = buildSnapshotToolCalls([receipt('npm test')], 'agent-1', 'sess-1');

    expect(call?.summary).toBe('npm test');
  });
});
