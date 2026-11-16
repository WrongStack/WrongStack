import {
  normalizeDiagnosticPath,
  normalizeSeverity,
  parseLinePattern,
  toPositiveInt,
} from './diagnostic-normalization.js';
import type { LanguageDiagnostic } from './types.js';

export function parseTypeScript(text: string, root: string): LanguageDiagnostic[] {
  const diagnostics: LanguageDiagnostic[] = [];
  const regex = /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s*(.+)$/gm;
  for (const match of text.matchAll(regex)) {
    diagnostics.push({
      severity: match[4] === 'warning' ? 'warning' : 'error',
      code: match[5],
      message: match[6]!.trim(),
      file: normalizeDiagnosticPath(match[1]!, root),
      range: { start: { line: toPositiveInt(match[2]), column: toPositiveInt(match[3]) } },
      source: 'typescript',
    });
  }
  return diagnostics;
}

export function parseCargoJson(text: string, root: string): LanguageDiagnostic[] {
  const diagnostics: LanguageDiagnostic[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim().startsWith('{')) continue;
    try {
      const value = JSON.parse(line) as {
        reason?: string;
        message?: {
          level?: string;
          code?: { code?: string };
          message?: string;
          spans?: Array<{
            file_name?: string;
            line_start?: number;
            column_start?: number;
            is_primary?: boolean;
          }>;
        };
      };
      if (value.reason !== 'compiler-message' || !value.message?.message) continue;
      const primary =
        value.message.spans?.find((span) => span.is_primary) ?? value.message.spans?.[0];
      diagnostics.push({
        severity: normalizeSeverity(value.message.level),
        ...(value.message.code?.code ? { code: value.message.code.code } : {}),
        message: value.message.message,
        ...(primary?.file_name ? { file: normalizeDiagnosticPath(primary.file_name, root) } : {}),
        ...(primary?.line_start
          ? { range: { start: { line: primary.line_start, column: primary.column_start ?? 1 } } }
          : {}),
        source: 'rustc',
      });
    } catch {
      // Non-JSON build output is retained as raw output, not fabricated into diagnostics.
    }
  }
  return diagnostics;
}

export function parseGo(text: string, root: string): LanguageDiagnostic[] {
  return parseLinePattern(
    text,
    // `go test` reports a failing assertion as `    a_test.go:7: got 2 want 3`
    // — indented, and without a column (the compiler and vet do give one).
    // A package that does not type-check makes vet prefix its own name
    // (`vet.exe: .\b.go:3:23: …`, `vet: ` on unix) — not part of the path.
    /^\s*(?:vet(?:\.exe)?:\s+)?(.*?\.go):(\d+)(?::(\d+))?:\s*(.+)$/gm,
    root,
    'go',
    // Go itself has no warnings; only a cgo/gcc preamble diagnostic says
    // `warning:` — right after the location. Matching the word anywhere
    // downgraded errors that merely mention it (`undefined: logWarning`).
    (_match, message) => ({ message, severity: /^warning:/i.test(message) ? 'warning' : 'error' }),
  );
}

export function parsePhpLint(text: string, root: string): LanguageDiagnostic[] {
  const diagnostics: LanguageDiagnostic[] = [];
  const regex = /(?:PHP\s+)?(?:Parse|Fatal) error:\s*(.+?)\s+in\s+(.+?)\s+on line\s+(\d+)/gi;
  for (const match of text.matchAll(regex)) {
    diagnostics.push({
      severity: 'error',
      message: match[1]!.trim(),
      file: normalizeDiagnosticPath(match[2]!, root),
      range: { start: { line: toPositiveInt(match[3]), column: 1 } },
      source: 'php',
    });
  }
  return diagnostics;
}

export function parseDotnet(text: string, root: string): LanguageDiagnostic[] {
  const diagnostics: LanguageDiagnostic[] = [];
  // Codes are compiler/analyzer ids (CS1002, IDE0055) — or, from `dotnet
  // format --verify-no-changes`, digit-less WHITESPACE / FINALNEWLINE / CHARSET.
  const regex = /^(.+?)\((\d+),(\d+)\):\s*(error|warning)\s+([A-Z]+\d*):\s*(.+?)(?:\s+\[.+\])?$/gm;
  for (const match of text.matchAll(regex)) {
    diagnostics.push({
      severity: match[4] === 'warning' ? 'warning' : 'error',
      code: match[5],
      message: match[6]!.trim(),
      file: normalizeDiagnosticPath(match[1]!, root),
      range: { start: { line: toPositiveInt(match[2]), column: toPositiveInt(match[3]) } },
      source: 'dotnet',
    });
  }
  return diagnostics;
}

export function parseBiome(text: string, root: string): LanguageDiagnostic[] {
  // `--reporter=github`: one `::<level> title=<rule>,file=…,line=…,col=…::<msg>`
  // per finding — the real message and severity. Biome's default reporter puts
  // both on later lines (`  × Using == may be unsafe…`) under a header that
  // reads `a.js:2:30 lint/… FIXABLE ━━━…`, so the line regex below took the
  // decoration as the message and called every finding a warning.
  const github: LanguageDiagnostic[] = [];
  const githubRegex =
    /^::(error|warning|notice) title=([^,]*),file=(.+?),line=(\d+),endLine=\d+,col=(\d+),endColumn=\d+::(.*)$/gm;
  for (const match of text.matchAll(githubRegex)) {
    github.push({
      severity: match[1] === 'notice' ? 'info' : normalizeSeverity(match[1]),
      ...(match[2] ? { code: match[2] } : {}),
      message: match[6]!.trim(),
      file: normalizeDiagnosticPath(match[3]!, root),
      range: { start: { line: toPositiveInt(match[4]), column: toPositiveInt(match[5]) } },
      source: 'biome',
    });
  }
  if (github.length > 0) return github;
  const diagnostics: LanguageDiagnostic[] = [];
  const regex = /^(.+?):(\d+):(\d+)\s+(lint\/[^\s]+|format)\s+(.+)$/gm;
  for (const match of text.matchAll(regex)) {
    diagnostics.push({
      severity: 'warning',
      code: match[4],
      message: match[5]!.trim(),
      file: normalizeDiagnosticPath(match[1]!, root),
      range: { start: { line: toPositiveInt(match[2]), column: toPositiveInt(match[3]) } },
      source: 'biome',
    });
  }
  return diagnostics;
}

/**
 * `shellcheck --format=json`: ONE JSON array of
 * `{file, line, column, level, code, message}` — the generic line regex never
 * matched it, so every shellcheck finding was dropped. `style` is ShellCheck's
 * lowest level (below `info`).
 */
export function parseShellcheckJson(stdout: string, root: string): LanguageDiagnostic[] {
  const start = stdout.indexOf('[');
  const end = stdout.lastIndexOf(']');
  if (start === -1 || end < start) return [];
  let items: unknown;
  try {
    items = JSON.parse(stdout.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(items)) return [];
  const diagnostics: LanguageDiagnostic[] = [];
  for (const item of items as Array<Record<string, unknown>>) {
    if (typeof item?.['message'] !== 'string') continue;
    const level = typeof item['level'] === 'string' ? item['level'] : undefined;
    diagnostics.push({
      severity: level === 'style' ? 'hint' : normalizeSeverity(level),
      ...(typeof item['code'] === 'number' ? { code: `SC${item['code']}` } : {}),
      message: item['message'],
      ...(typeof item['file'] === 'string'
        ? { file: normalizeDiagnosticPath(item['file'], root) }
        : {}),
      ...(typeof item['line'] === 'number'
        ? {
            range: {
              start: {
                line: toPositiveInt(String(item['line'])),
                column: toPositiveInt(String(item['column'] ?? 1)),
              },
            },
          }
        : {}),
      source: 'shellcheck',
    });
  }
  return diagnostics;
}

/**
 * `python -m py_compile` errors. A traceback-style one:
 *   File "broken.py", line 1  …  SyntaxError: invalid syntax
 * and the one-line form CPython uses for indentation errors:
 *   Sorry: IndentationError: unexpected indent (indent.py, line 2)
 * Neither has the `file:line:col:` shape the generic parser needs.
 */
export function parsePythonCompile(text: string, root: string): LanguageDiagnostic[] {
  const diagnostics: LanguageDiagnostic[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const sorry = /^Sorry: (\w+): (.+) \((.+), line (\d+)\)$/.exec(lines[i]!);
    if (sorry) {
      diagnostics.push({
        severity: 'error',
        code: sorry[1]!,
        message: sorry[2]!,
        file: normalizeDiagnosticPath(sorry[3]!, root),
        range: { start: { line: toPositiveInt(sorry[4]), column: 1 } },
        source: 'python',
      });
      continue;
    }
    const frame = /^\s*File "(.+)", line (\d+)/.exec(lines[i]!);
    if (!frame) continue;
    // The error line follows the source excerpt and caret lines.
    for (let j = i + 1; j < lines.length && j <= i + 4; j++) {
      const error = /^(\w+(?:Error|Exception|Warning)): (.*)$/.exec(lines[j]!);
      if (!error) continue;
      diagnostics.push({
        severity: 'error',
        code: error[1]!,
        message: error[2]!,
        file: normalizeDiagnosticPath(frame[1]!, root),
        range: { start: { line: toPositiveInt(frame[2]), column: 1 } },
        source: 'python',
      });
      break;
    }
  }
  return diagnostics;
}

/**
 * JVM compiler output through Maven or Gradle — none of it has the generic
 * `file:line:col:` shape:
 *   Maven:  [ERROR] /D:/…/App.java:[4,13] incompatible types: …
 *   javac:  D:\…\App.java:4: error: incompatible types: …   (caret line = column)
 */
export function parseJvmCompiler(text: string, root: string): LanguageDiagnostic[] {
  const diagnostics: LanguageDiagnostic[] = [];
  const lines = text.split(/\r?\n/);
  const filePath = (raw: string) => {
    let decoded = raw;
    if (raw.startsWith('file://')) {
      const rest = raw.slice(7);
      try {
        decoded = decodeURIComponent(rest);
      } catch {
        decoded = rest;
      }
    }
    // Maven and file URLs write a Windows path as `/D:/…`.
    return normalizeDiagnosticPath(decoded.replace(/^\/([A-Za-z]:[\\/])/, '$1'), root);
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const maven = /^\[(ERROR|WARNING)\] (.+?\.(?:java|kt|scala|groovy)):\[(\d+),(\d+)\] (.+)$/.exec(
      line,
    );
    if (maven) {
      diagnostics.push({
        severity: maven[1] === 'WARNING' ? 'warning' : 'error',
        message: maven[5]!.trim(),
        file: filePath(maven[2]!),
        range: { start: { line: toPositiveInt(maven[3]), column: toPositiveInt(maven[4]) } },
        source: 'javac',
      });
      continue;
    }
    const javac = /^(.+?\.java):(\d+): (error|warning): (.+)$/.exec(line);
    if (javac) {
      // javac echoes the source line, then a caret under the offending column.
      const caret = lines[i + 2]?.indexOf('^') ?? -1;
      diagnostics.push({
        severity: javac[3] === 'warning' ? 'warning' : 'error',
        message: javac[4]!.trim(),
        file: filePath(javac[1]!),
        range: {
          start: { line: toPositiveInt(javac[2]), column: caret >= 0 ? caret + 1 : 1 },
        },
        source: 'javac',
      });
    }
  }
  return diagnostics;
}

export function parseGeneric(text: string, source: string, root: string): LanguageDiagnostic[] {
  return parseLinePattern(
    text,
    // gcc/clang attach `note:` lines to an error and say `fatal error:` for a
    // missing header; outside the alternation, a note became a second ERROR
    // whose message read "note: …".
    /^(.+?):(\d+):(\d+):\s*(?:(fatal error|error|warning|info|note):\s*)?(.+)$/gm,
    root,
    source,
    (match, fallback) => ({
      severity: normalizeSeverity(match[4] === 'fatal error' ? 'error' : match[4]),
      message: match[5]?.trim() || fallback,
    }),
  );
}
