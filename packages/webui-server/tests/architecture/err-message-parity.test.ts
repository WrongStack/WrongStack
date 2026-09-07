/**
 * Regression for F4 (TS-007/TS-008): the previous pattern
 * `X instanceof Error ? X.message : String(X)` inlined at every
 * WebSocket error site. Seven WS handlers did this verbatim, and
 * the lone HTTP body (`codemap-handlers.ts:72-74`) forgot the
 * `sanitizeApiError` indirection entirely, so provider-`Authorization`
 * echoes (WS-066) reached the browser. The codebase centralises the
 * conversion in `ws-utils.ts:191-202` (`errMessage`) and the HTTP
 * counterpart `sanitizeApiError(err)`; this test fails if a future
 * site reintroduces the inline form.
 */
import { describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../../..');

describe('F4 / TS-007+TS-008: error-message extraction has a single authority', () => {
  it('has no new `instanceof Error ? …message : String(…)` sites in webui-server/src', () => {
    let output = '';
    try {
      output = execSync(
        [
          'git',
          'grep',
          '-nE',
          '--',
          'instanceof\\s+Error\\s*\\?\\s*[^:]+\\.message\\s*:\\s*String',
        ].join(' '),
        { cwd: REPO_ROOT, encoding: 'utf8' },
      );
    } catch (err) {
      // exit 1 means "no matches" — that is the success path.
      if ((err as { status?: number }).status === 1) {
        expect(output).toBe('');
        return;
      }
      throw err;
    }

    const lines = output.split('\n').filter(Boolean);
    // Filter out lines that are themselves in test files (where the
    // pattern is acceptable as part of the regression) and in
    // comments. `git grep -n` output is `path:line:content`; the path
    // on Windows is `D:\Codebox\…\file.ts`, so the first `:` belongs
    // to the drive letter, not the separator. Use a regex to split.
    const lineRe = /^(.*?):(\d+):(.*)$/;
    const violations: string[] = [];
    for (const line of lines) {
      const m = lineRe.exec(line);
      if (!m) continue;
      const filePath = (m[1] ?? '').replace(/\\/g, '/');
      const content = m[3] ?? '';
      if (filePath.includes('/tests/')) continue;
      if (content.trimStart().startsWith('//') || content.trimStart().startsWith('*')) continue;
      violations.push(line);
    }

    expect(
      violations,
      `Use \`errMessage(err)\` from \`./ws-utils.js\` (or \`sanitizeApiError(err)\` for HTTP bodies) instead of the inline ternary. Violations:\n${violations.join('\n')}`,
    ).toEqual([]);
  });
});
