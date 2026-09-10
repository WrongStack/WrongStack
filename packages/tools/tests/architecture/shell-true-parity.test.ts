/**
 * S4 (architecture): every new spawn site that can turn on a shell must be
 * vetted. The BatBadBut / CVE-2024-27980 defence lives in the metacharacter
 * check inside `@wrongstack/core/utils/win32-cmd.ts`
 * (`assertSafeWin32CmdArgs` / `WIN32_CMD_META`); spawning through a shell
 * without going through that helper leaves a tool exposed to the
 * join-and-execute attack the helper is built to stop.
 *
 * **Why this test is not a plain `shell:\s*true` grep any more.** It was, and
 * that is precisely how WS-SEC-11 reached production: `plug-lsp` wrote the
 * option as object shorthand (`const shell = …; spawn(cmd, args, { …, shell })`),
 * which the literal pattern never saw. A sibling file wrote
 * `shell: isWindowsBatch` and was equally invisible. A guard that only
 * recognises one spelling of the thing it forbids is a guard against that
 * spelling, not against the defect.
 *
 * So the match is now on the *option*, in any spelling, narrowed two ways to
 * stay precise:
 *
 *  1. Values that cannot enable a shell are dropped — a string (`shell: 'bash'`
 *     is a language key, not a spawn option), an array, an object, `undefined`,
 *     `false`, and TypeScript type positions (`shell: boolean`).
 *  2. The file must actually import `child_process`. Without this the repo's
 *     many unrelated `shell:` keys (theme colours, icon maps, parser tables,
 *     CSS variables) drown the signal — 52 candidate lines become 24 real ones.
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
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

/** Only a file that spawns processes can have a spawn option. */
const IMPORTS_CHILD_PROCESS = /from\s+['"](?:node:)?child_process['"]/;

/**
 * A `shell:` whose value is a quoted string, an array, an object literal,
 * `undefined`, `false`, or a type annotation is not an enable-a-shell option.
 * Everything else — `true`, an identifier, a ternary, a member expression —
 * is, and must be vetted.
 */
const INERT_VALUE = /shell:\s*(?:['"`]|\[|\{|undefined\b|false\b|boolean\b|string\b)/;

/** `const shell: BashShell = …` is a declaration, not an option. */
const DECLARATION = /^(?:const|let|var)\s/;

describe('S4: every shell-enabling spawn site is paired with the cmd-shim helper', () => {
  it('has no new unpaired shell spawn sites outside the S4 opt-out list', () => {
    // Every entry is a pre-existing site. The list is intentionally narrow —
    // each is a refactor target for a future pass and should be removed as it
    // is converted to `buildWin32CmdShimInvocation` / `execFile`.
    const allowed = [
      // The helper itself, and the tests that intentionally exercise the
      // unsafe shape to verify the metacharacter block is sound.
      'packages/core/src/utils/win32-cmd.ts',
      'packages/tools/tests/_win32-resolve.test.ts',
      'packages/tools/tests/win32-resolve.test.ts',
      'packages/tools/tests/architecture/argv-leading-dash-guard.test.ts',
      'packages/bench/tests/exec-command.test.ts',
      'packages/core/tests/architecture/coverage-runtime.test.ts',
      'packages/plugins/tests/lint-gate-platform.test.ts',
      'packages/bench/src/exec-command.ts',
      'packages/core/src/performance/perf-runner.ts',
      'packages/kanban/src/verification/verification-context.ts',
      'packages/webui-server/src/server/discover-mailbox-bridge.ts',
      'scripts/build-portable.mjs',
      'scripts/coverage-lock.mjs',
      'scripts/generate-plugin-projections.mjs',
      'scripts/release-check-matrix.mjs',
      'scripts/test-affected.mjs',
      // Surfaced by the widened pattern (2026-09-10). These were always here;
      // the old literal-only grep could not see a shorthand or a computed
      // value. They are recorded rather than swept in one commit — but they
      // are now visible, which they were not before.
      'packages/cli/src/goal-host.ts', // shorthand `shell,` — caller-supplied
      'packages/cli/src/simpleui-dist.ts',
      'packages/techstack/src/advisory/native-audit.ts',
      'packages/webui-server/src/server/frontend-static-serve.ts',
      'packages/tools/src/bash.ts', // pickShell(), not a spawn option
      'scripts/package-desktop.mjs',
      'scripts/publish-workspace.mjs',
    ];

    // Skip prose / changelog / architecture docs — the rule is about runtime
    // spawn invocations, not about historical mentions.
    const proseExcludes = [/\.md$/, /CHANGELOG/i, /docs\//];

    // Grep the source tree. This is a static check, not a runtime hook — a
    // one-shot failing build is the intended signal. Match the option in both
    // spellings: `shell:` with any value, and object shorthand on its own line.
    let output = '';
    try {
      output = execFileSync('git', ['grep', '-nE', '--', '(shell:|^[[:space:]]*shell,$)'], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        maxBuffer: 1 << 26,
      });
    } catch (err) {
      // git grep exits 1 when no matches — that is the success path for "no
      // new sites" once the allow-list is empty.
      if ((err as { status?: number }).status === 1) {
        expect(output).toBe('');
        return;
      }
      throw err;
    }

    const spawnsProcesses = ((): ((rel: string) => boolean) => {
      const cache = new Map<string, boolean>();
      return (rel: string): boolean => {
        const hit = cache.get(rel);
        if (hit !== undefined) return hit;
        let text = '';
        try {
          text = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
        } catch {
          // Deleted or unreadable between grep and read — nothing to vet.
        }
        const value = IMPORTS_CHILD_PROCESS.test(text);
        cache.set(rel, value);
        return value;
      };
    })();

    const lines = output.split('\n').filter(Boolean);
    const violations: string[] = [];
    for (const line of lines) {
      const filePath = line.split(':')[0] ?? '';
      // Normalise Windows backslashes from `git grep` output.
      const normalised = toPosix(filePath);
      if (normalised === SELF) continue;
      if (proseExcludes.some((re) => re.test(normalised))) continue;
      // git grep matches anywhere in the line, so a comment mentioning the
      // option becomes a hit. Trim the path off and check the residue.
      const residue = line.slice(filePath.length).replace(/^:\d+:/, '');
      const trimmed = residue.trimStart();
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;
      // Imports (`import { shell } from 'electron'`) and test descriptions
      // that name the option without invoking it.
      if (/^(?:import|export)\b/.test(trimmed) || /\bfrom\s+['"]/.test(trimmed)) continue;
      if (/^(?:it|describe|test)[.(]/.test(trimmed)) continue;
      if (INERT_VALUE.test(trimmed)) continue;
      if (DECLARATION.test(trimmed)) continue;
      if (!spawnsProcesses(normalised)) continue;
      if (allowed.some((a) => normalised.endsWith(a))) continue;
      violations.push(line);
    }

    expect(
      violations,
      `Every spawn site that can enable a shell must either (a) route through \`buildWin32CmdShimInvocation\` from @wrongstack/core/utils, or (b) be added to the allow-list with a reason. Note this matches object shorthand and computed values, not just the literal — that blind spot is what let WS-SEC-11 through. Offending lines:\n${violations.join('\n')}`,
    ).toEqual([]);
  });

  /**
   * The rule above is only as good as its reach. A pattern change, a `git grep`
   * that silently returns nothing, or a filter that over-excludes would make
   * the assertion vacuously true — the same failure mode the widened pattern
   * was written to fix. Assert the scan still sees the known sites.
   */
  it('still scans a non-empty set of spawn sites', () => {
    const output = execFileSync('git', ['grep', '-lE', '--', '(shell:|^[[:space:]]*shell,$)'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 1 << 26,
    });
    const files = output.split('\n').filter(Boolean).map(toPosix);
    expect(files.length).toBeGreaterThan(20);
    // A canonical shorthand site the old literal-only pattern could not see.
    expect(files).toContain('packages/cli/src/goal-host.ts');
  });
});
