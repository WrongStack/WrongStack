import { describe, expect, it } from 'vitest';
import {
  checkpointBoundaries,
  checkpointMatches,
  recoveryCheckpoints,
  recoveryResult,
  redoResult,
} from '../src/session-recovery-model';

describe('recorded recovery evidence', () => {
  it('shows the actual first rewind boundary when a prompt index is reused', () => {
    const first = { promptIndex: 0, promptPreview: 'Original boundary', ts: 'first', fileCount: 2 };
    const current = { ...first, promptPreview: 'Reused index', ts: 'later' };
    expect(checkpointBoundaries([first, current])).toEqual([first]);
  });
  it('rejects malformed checkpoint targets and detects changes in the reviewed selection', () => {
    const points = recoveryCheckpoints([
      { promptIndex: 0, promptPreview: 'First', fileCount: 2 },
      { promptIndex: -1 },
      { promptIndex: 1.5 },
      {},
    ]);
    expect(points).toEqual([{ promptIndex: 0, promptPreview: 'First', ts: '', fileCount: 2 }]);
    expect(
      checkpointMatches(points, [
        ...points,
        { promptIndex: 1, promptPreview: 'Later', ts: '', fileCount: 0 },
      ]),
    ).toBe(false);
    expect(checkpointMatches(points, recoveryCheckpoints(points))).toBe(true);
  });
  it('does not turn partial restoration into a clean success or fabricate missing counters', () => {
    expect(recoveryResult({ success: true })).toBeNull();
    expect(
      recoveryResult({
        rewind: { toPromptIndex: 0, revertedFiles: ['kept.txt'], errors: ['outside.txt: refused'] },
      }),
    ).toEqual({
      checkpoint: 0,
      files: ['kept.txt'],
      errors: ['outside.txt: refused'],
      removedEvents: null,
      messageCount: null,
      promptText: '',
    });
    expect(
      recoveryResult({ rewind: { toPromptIndex: 1, promptText: 'Whole prompt' } })?.promptText,
    ).toBe('Whole prompt');
  });
});

it('reads a redone rewind only from the engine result', () => {
  expect(redoResult({ success: true })).toBeNull();
  expect(
    redoResult({ redo: { toPromptIndex: 2, reappliedFiles: ['/p/a.ts'], messageCount: 7 } }),
  ).toEqual({ checkpoint: 2, files: ['/p/a.ts'], messageCount: 7 });
});
