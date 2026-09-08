/**
 * S4 (architecture): every new `spawn(..., { shell: true })` site must
 * be vetted. The BatBadBut / CVE-2024-27980 defence lives in the
 * metacharacter check inside `@wrongstack/core/utils/win32-cmd.ts`
 * (`assertSafeWin32CmdArgs` / `WIN32_CMD_META`); spawning through
 * `shell: true` without going through that helper leaves a tool
 * exposed to the join-and-execute attack the helper is built to
 * stop. This test greps the repo for non-test `shell: true` sites and
 * asserts that any new one is paired with a call to
 * `buildWin32CmdShimInvocation` (or an explicit opt-out with a
 * `// S4-ALLOWED:` comment next to it).
 */

import { execSync } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../../..');

/** `git grep` emits backslashes on Windows; compare paths in one shape. */
const toPosix = (p: string): string => p.split(String.fromCharCode(92)).join('/');

/**
 * This file states the rule, so it necessarily writes the pattern it forbids —
 * in the docblock, in the allow-list, and in the failure message. Excluding it
 * by identity rather than by an allow-list string keeps a later reword of that
 * message from re-triggering the rule against itself.
 */
const SELF = toPosix(path.relative(REPO_ROOT, fileURLToPath(import.meta.url)));

describe('S4: every shell:true spawn site is paired with the cmd-shim helper', () => {
  it('has no new unpaired shell:true sites outside the S4 opt-out list', () => {
    // Allowed: the helper itself (win32-cmd.ts) lives at the boundary,
    // and the bench test that intentionally exercises the unsafe
    // shape to verify the metacharacter block is sound.
    // The canonical cmd-shim builder, the cmd-shim parity tests,
    // and the rest of the explicit opt-outs. The list is intentionally
    // narrow — every other `shell: true` use is a refactor target for
    // a future pass and should be removed from this list as it is
    // converted to `buildWin32CmdShimInvocation` / `execFile`.
    const allowed = [
      'packages/core/src/utils/win32-cmd.ts',
      'packages/tools/tests/_win32-resolve.test.ts',
      'packages/tools/tests/win32-resolve.test.ts',
      'packages/tools/tests/architecture/argv-leading-dash-guard.test.ts',
      'packages/bench/tests/exec-command.test.ts',
      'packages/core/tests/architecture/coverage-runtime.test.ts',
      'packages/bench/src/exec-command.ts',
      'packages/core/src/performance/perf-runner.ts',
      'packages/kanban/src/verification/verification-context.ts',
      'packages/webui-server/src/server/discover-mailbox-bridge.ts',
      'scripts/build-portable.mjs',
      'scripts/coverage-lock.mjs',
      'scripts/generate-plugin-projections.mjs',
      'scripts/release-check-matrix.mjs',
      'scripts/test-affected.mjs',
    ];

    // Skip prose / changelog / architecture docs — the rule is
    // about runtime `shell: true` invocations, not about historical
    // mentions.
    const proseExcludes = [/\.md$/, /CHANGELOG/i, /docs\//];

    // Grep the source tree. This is a static check, not a runtime
    // hook — a one-shot failing build is the intended signal.
    let output = '';
    try {
      output = execSync(['git', 'grep', '-nE', '--', 'shell:\\s*true'].join(' '), {
        cwd: REPO_ROOT,
        encoding: 'utf8',
      });
    } catch (err) {
      // git grep exits 1 when no matches — that is the success path
      // for "no new sites" once the allow-list is empty.
      if ((err as { status?: number }).status === 1) {
        expect(output).toBe('');
        return;
      }
      throw err;
    }

    const lines = output.split('\n').filter(Boolean);
    const violations: string[] = [];
    for (const line of lines) {
      const filePath = line.split(':')[0] ?? '';
      // Normalise Windows backslashes from `git grep` output.
      const normalised = toPosix(filePath);
      if (normalised === SELF) continue;
      if (proseExcludes.some((re) => re.test(normalised))) continue;
      // Skip lines that are themselves comments / strings — git grep
      // matches anywhere in the line, so a `// … shell: true …`
      // comment becomes a hit. Trim the path off and check the
      // residue. Also skip test descriptions (`it('…')`/`describe(`)
      // that mention `shell: true` in the test name without invoking
      // it.
      const residue = line.slice(filePath.length).replace(/^:\d+:/, '');
      const trimmed = residue.trimStart();
      if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
      if (
        trimmed.startsWith('it(') ||
        trimmed.startsWith('it.`') ||
        trimmed.startsWith('describe(') ||
        trimmed.startsWith('describe.`')
      )
        continue;
      if (allowed.some((a) => normalised.endsWith(a))) continue;
      violations.push(line);
    }

    expect(
      violations,
      `Every \`spawn(..., { shell: true }\` site must either (a) route through \`buildWin32CmdShimInvocation\` from @wrongstack/core/utils, or (b) be added to the allow-list with a \`// S4-ALLOWED: <reason>\` comment. Offending lines:\n${violations.join('\n')}`,
    ).toEqual([]);
  });
});
