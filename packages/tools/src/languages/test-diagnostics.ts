import {
  normalizeDiagnosticPath,
  normalizeSeverity,
  toPositiveInt,
} from './diagnostic-normalization.js';
import type { LanguageDiagnostic } from './types.js';

/**
 * Failed tests in `dotnet test` console output (VSTest logger):
 *   Failed dntest.UnitTest1.Test1 [75 ms]
 *   Error Message:
 *    Assert.Equal() Failure: Values differ
 *   Stack Trace:
 *      at dntest.UnitTest1.Test1() in D:\…\UnitTest1.cs:line 7
 * The first stack frame with a source location is where the test failed.
 */
export function parseDotnetTestFailures(text: string, root: string): LanguageDiagnostic[] {
  const diagnostics: LanguageDiagnostic[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    // The logger prints the DISPLAY name, which for parameterized tests has
    // spaces: xUnit `Add(a: 1, b: 2)`, MSTest DataRow `Add (1,2)`. `\S+`
    // dropped every parameterized failure.
    const failed = /^\s*Failed (\S.*?) \[[^\]]*\]$/.exec(lines[i]!);
    if (!failed) continue;
    let message = '';
    let location: RegExpExecArray | null = null;
    for (let j = i + 1; j < lines.length && j <= i + 40; j++) {
      const line = lines[j]!;
      if (/^\s*Failed \S.*? \[[^\]]*\]$/.test(line)) break;
      if (!message && /^\s*Error Message:\s*$/.test(line)) {
        message = lines[j + 1]?.trim() ?? '';
        continue;
      }
      location = / in (.+):line (\d+)\s*$/.exec(line);
      if (location) break;
    }
    diagnostics.push({
      severity: 'error',
      code: failed[1]!,
      message: message || 'Test failed',
      ...(location
        ? {
            file: normalizeDiagnosticPath(location[1]!, root),
            range: { start: { line: toPositiveInt(location[2]), column: 1 } },
          }
        : {}),
      source: 'dotnet-test',
    });
  }
  return diagnostics;
}

/**
 * Human `cargo test` output (it has no JSON mode on stable). Two shapes:
 * - a failing test: `thread 'tests::boom' (97428) panicked at src\lib.rs:9:17:`
 *   with the message on the next line (Rust 1.73+), or the older
 *   `thread 'x' panicked at 'msg', src/lib.rs:9:17`;
 * - a compile error: `error[E0308]: mismatched types` then ` --> src\lib.rs:1:34`.
 * The generic `file:line:col:` regex kept the whole "thread '…' panicked at "
 * prefix inside the file path and never matched the ` --> ` form at all.
 */
export function parseCargoTest(text: string, root: string): LanguageDiagnostic[] {
  const diagnostics: LanguageDiagnostic[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const modern = /^thread '([^']*)'(?: \(\d+\))? panicked at (.+?):(\d+):(\d+):$/.exec(line);
    const legacy = modern
      ? null
      : /^thread '([^']*)'(?: \(\d+\))? panicked at '(.*)', (.+?):(\d+):(\d+)$/.exec(line);
    if (modern || legacy) {
      const test = (modern ?? legacy)![1]!;
      const message = modern ? (lines[i + 1]?.trim() ?? '') : legacy![2]!;
      const [file, ln, col] = modern
        ? [modern[2]!, modern[3], modern[4]]
        : [legacy![3]!, legacy![4], legacy![5]];
      diagnostics.push({
        severity: 'error',
        code: test,
        message: message || 'test panicked',
        file: normalizeDiagnosticPath(file, root),
        range: { start: { line: toPositiveInt(ln), column: toPositiveInt(col) } },
        source: 'cargo-test',
      });
      continue;
    }
    const header = /^(error|warning)(?:\[(E\d+)\])?: (.+)$/.exec(line);
    const location = header ? /^\s*--> (.+?):(\d+):(\d+)$/.exec(lines[i + 1] ?? '') : null;
    if (header && location) {
      diagnostics.push({
        severity: normalizeSeverity(header[1]),
        ...(header[2] ? { code: header[2] } : {}),
        message: header[3]!.trim(),
        file: normalizeDiagnosticPath(location[1]!, root),
        range: {
          start: { line: toPositiveInt(location[2]), column: toPositiveInt(location[3]) },
        },
        source: 'rustc',
      });
    }
  }
  return diagnostics;
}

/**
 * pytest's traceback ends each failure with its location — `test_a.py:6:
 * AssertionError` (file:line, NO column) — after the `E   …` lines that say
 * what failed. The generic `file:line:col:` regex matched neither, so a failing
 * run produced zero diagnostics.
 */
export function parsePytest(text: string, root: string): LanguageDiagnostic[] {
  const diagnostics: LanguageDiagnostic[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const location = /^(\S.*?\.py):(\d+): (\w+)$/.exec(lines[i]!);
    if (!location) continue;
    // The `E   ` block above the location (past one blank line) carries the
    // failure text.
    const explanation: string[] = [];
    let j = i - 1;
    while (j >= 0 && lines[j]!.trim() === '') j--;
    for (; j >= 0 && /^E\s/.test(lines[j]!); j--) {
      explanation.unshift(lines[j]!.replace(/^E\s+/, ''));
    }
    diagnostics.push({
      severity: 'error',
      code: location[3]!,
      message: explanation[0] ?? location[3]!,
      file: normalizeDiagnosticPath(location[1]!, root),
      range: { start: { line: toPositiveInt(location[2]), column: 1 } },
      source: 'pytest',
    });
  }
  return diagnostics;
}

/**
 * `deno test` (colour codes already stripped). A failing test is reported as
 * `bad => ./a_test.ts:2:6` followed by `error: Error: expected 3`; a type error
 * from the pre-run check as `TS2322 [ERROR]: <message>` with its location on a
 * later `    at file:///D:/…/b_test.ts:1:7` line. The FAILURES recap repeats
 * the `name => location` header without an `error:` line and is skipped.
 */
export function parseDenoTest(text: string, root: string): LanguageDiagnostic[] {
  const diagnostics: LanguageDiagnostic[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const failure = /^(.+?) => (.+?):(\d+):(\d+)$/.exec(lines[i]!);
    const error = failure ? /^error: (.+)$/.exec(lines[i + 1] ?? '') : null;
    if (failure && error) {
      diagnostics.push({
        severity: 'error',
        code: failure[1]!,
        message: error[1]!,
        file: normalizeDiagnosticPath(failure[2]!, root),
        range: { start: { line: toPositiveInt(failure[3]), column: toPositiveInt(failure[4]) } },
        source: 'deno-test',
      });
      continue;
    }
    const typeError = /^(TS\d+) \[(ERROR|WARNING)\]: (.+)$/.exec(lines[i]!);
    if (!typeError) continue;
    for (let j = i + 1; j < lines.length && j <= i + 6; j++) {
      const at = /^\s+at (file:\/\/\/.+?):(\d+):(\d+)$/.exec(lines[j]!);
      if (!at) continue;
      const rawFile = at[1]!.replace(/^file:\/\/\//, '');
      let file: string;
      try {
        file = decodeURIComponent(rawFile);
      } catch {
        file = rawFile;
      }
      if (!/^[A-Za-z]:/.test(file)) file = `/${file}`;
      diagnostics.push({
        severity: typeError[2] === 'WARNING' ? 'warning' : 'error',
        code: typeError[1]!,
        message: typeError[3]!,
        file: normalizeDiagnosticPath(file, root),
        range: { start: { line: toPositiveInt(at[2]), column: toPositiveInt(at[3]) } },
        source: 'deno',
      });
      break;
    }
  }
  return diagnostics;
}

/**
 * PHPUnit's failure/error list:
 *   1) FooTest::testA
 *   Failed asserting that 3 is identical to 2.
 *
 *   D:\…\tests\FooTest.php:4
 * The first `<file>.php:<line>` line after the numbered header is the test's
 * own frame (the location has no column, so the generic parser missed it).
 */
export function parsePhpUnit(text: string, root: string): LanguageDiagnostic[] {
  const diagnostics: LanguageDiagnostic[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const header = /^\d+\) (.+)$/.exec(lines[i]!);
    if (!header) continue;
    let message = '';
    for (let j = i + 1; j < lines.length && j <= i + 60; j++) {
      const line = lines[j]!;
      if (/^\d+\) /.test(line)) break;
      const location = /^(.+\.php):(\d+)$/.exec(line.trim());
      if (location) {
        diagnostics.push({
          severity: 'error',
          code: header[1]!.trim(),
          message: message || 'Test failed',
          file: normalizeDiagnosticPath(location[1]!, root),
          range: { start: { line: toPositiveInt(location[2]), column: 1 } },
          source: 'phpunit',
        });
        break;
      }
      if (!message && line.trim()) message = line.trim();
    }
  }
  return diagnostics;
}
