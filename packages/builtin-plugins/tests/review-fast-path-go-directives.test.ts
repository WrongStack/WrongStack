import { describe, expect, it } from 'vitest';
import { classifyZeroTokenReviewFastPath } from '../src/review-fast-path.js';

function classifyAddedLine(file: string, line: string) {
  return classifyZeroTokenReviewFastPath({
    files: [
      {
        path: file,
        status: 'modified',
        content: '',
        diff: ['@@ -1,1 +1,2 @@', `   1 | +${line}`, '   2 |  package auth'].join('\n'),
      },
    ],
  });
}

describe('classifyZeroTokenReviewFastPath — Go compiler directives are not comments', () => {
  it.each([
    '//go:build ignore',
    '// +build ignore',
    '//go:embed secrets.txt',
    '//go:linkname now time.now',
    '//line gen.go:1',
    '//export GoCallback',
  ])('sends a diff adding %s to the reviewer', (line) => {
    expect(classifyAddedLine('auth.go', line)).toEqual({ eligible: false });
  });

  it('sends a diff removing a build constraint to the reviewer', () => {
    expect(
      classifyZeroTokenReviewFastPath({
        files: [
          {
            path: 'auth.go',
            status: 'modified',
            content: '',
            diff: ['@@ -1,2 +1,1 @@', '     | -//go:build linux', '   1 |  package auth'].join(
              '\n',
            ),
          },
        ],
      }),
    ).toEqual({ eligible: false });
  });

  it('still fast-paths ordinary Go comments', () => {
    expect(classifyAddedLine('auth.go', '// go:build tags are documented here')).toEqual({
      eligible: true,
      reason: 'comments_or_whitespace_only',
    });
    expect(classifyAddedLine('auth.go', '// exported for tests')).toEqual({
      eligible: true,
      reason: 'comments_or_whitespace_only',
    });
  });
});
