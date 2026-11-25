import { describe, expect, it } from 'vitest';
import { parseArtifact } from '../src/lib/artifacts';

describe('parseArtifact strict numeric version check (F1988)', () => {
  it('rejects stringified version numbers while accepting numeric 1 or 2', () => {
    const strVer = JSON.stringify({
      type: 'artifact.presentation',
      version: '2',
      sessionId: 's1',
      kind: 'text',
      id: 'a1',
      title: 'Notes',
      path: 'notes.txt',
    });
    const numVer = JSON.stringify({
      type: 'artifact.presentation',
      version: 2,
      sessionId: 's1',
      kind: 'text',
      id: 'a1',
      title: 'Notes',
      path: 'notes.txt',
    });
    expect(parseArtifact(strVer, 's1')).toBeNull();
    expect(parseArtifact(numVer, 's1')?.id).toBe('a1');
  });
});
