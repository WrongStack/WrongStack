import { describe, expect, it } from 'vitest';
import { parseArtifactPresentation } from '../src/artifact-presentation.js';

describe('parseArtifactPresentation trimmed path and kind guard (F2261)', () => {
  it('rejects leading-whitespace absolute paths and null-prototype kind', () => {
    expect(
      parseArtifactPresentation({
        type: 'artifact.presentation',
        version: 2,
        id: 'art-1',
        sessionId: 'sess-1',
        path: '  /etc/passwd',
        title: 'Test',
        kind: 'text',
      }),
    ).toBeNull();

    expect(
      parseArtifactPresentation({
        type: 'artifact.presentation',
        version: 2,
        id: 'art-1',
        sessionId: 'sess-1',
        path: 'docs/readme.md',
        title: 'Test',
        kind: Object.create(null),
      }),
    ).toBeNull();
  });
});
