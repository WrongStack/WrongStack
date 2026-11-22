import { describe, expect, it } from 'vitest';
import { buildAutomationResult } from '../src/automation/result.js';

// Git's C-quoting (quote_c_style) writes BEL, BS, VT and FF as \a \b \v \f.
// Decoded as bare letters they invented a different file name; decoded as the
// control characters they are, the name is filtered like a TAB name.
describe('automation changed files: Git C-quote escapes', () => {
  const changed = (quoted: string) =>
    buildAutomationResult(
      '',
      [
        'diff --git a/ok.txt b/ok.txt',
        '--- a/ok.txt',
        '+++ b/ok.txt',
        '@@ -1 +1 @@',
        '-a',
        '+b',
        `diff --git "a/${quoted}" "b/${quoted}"`,
        'new file mode 100644',
        'index 0000000..3e75765',
        '--- /dev/null',
        `+++ "b/${quoted}"`,
        '@@ -0,0 +1 @@',
        '+new',
        '',
      ].join('\n'),
      0,
    ).changedFiles;

  it.each(['x\\ay.txt', 'x\\by.txt', 'x\\vy.txt', 'x\\fy.txt'])(
    'never reports a fabricated name for %s',
    (quoted) => {
      expect(changed(quoted)).toEqual(['ok.txt']);
    },
  );
});
