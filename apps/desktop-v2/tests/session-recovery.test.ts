import { describe, expect, it } from 'vitest';
import {
  checkpointBoundaries,
  checkpointMatches,
  recoveryCheckpoints,
  recoveryResult,
  redoResult,
  retryCheckpoint,
  retryPlan,
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
      promptHasAttachments: false,
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

it('retries only the newest prompt, and only when it can be sent again unchanged', () => {
  const point = (promptIndex: number, ts: string) => ({
    promptIndex,
    promptPreview: `prompt ${promptIndex}`,
    ts,
    fileCount: 0,
  });
  expect(retryCheckpoint([])).toBeNull();
  expect(retryCheckpoint([point(0, 'a'), point(1, 'b')])?.ts).toBe('b');
  // After an earlier rewind the index repeats; a rewind to it would take back two prompts.
  expect(retryCheckpoint([point(0, 'a'), point(1, 'b'), point(1, 'c')])).toBeNull();

  const result = (rewind: Record<string, unknown>) =>
    recoveryResult({ rewind: { toPromptIndex: 1, ...rewind } })!;
  expect(retryPlan(result({ promptText: 'Fix it' }))).toEqual({ text: 'Fix it' });
  expect(retryPlan(result({}))).toHaveProperty('reason');
  expect(
    retryPlan(result({ promptText: 'With an image', promptHasAttachments: true })),
  ).toMatchObject({ reason: expect.stringMatching(/attached files or images/) });
  expect(retryPlan(result({ promptText: 'Fix it', errors: ['a.txt: refused'] }))).toMatchObject({
    reason: expect.stringMatching(/not restored/),
  });
});
