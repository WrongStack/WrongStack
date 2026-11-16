import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseJvmCompiler } from '../src/languages/compiler-diagnostics.js';
import {
  diagnosticsForInternalSyntax,
  parseLanguageDiagnostics,
} from '../src/languages/diagnostics.js';
import { parseDenoTest } from '../src/languages/test-diagnostics.js';

const root = path.resolve('fixture');

describe('language diagnostic normalization', () => {
  it('parses TypeScript diagnostics with stable one-based locations', () => {
    const result = parseLanguageDiagnostics(
      'typescript',
      'src/a.ts(2,4): error TS2322: Type string is not assignable\nsrc/a.ts(3,1): warning TS9999: caution',
      '',
      root,
    );
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        severity: 'error',
        code: 'TS2322',
        file: path.join(root, 'src', 'a.ts'),
        range: { start: { line: 2, column: 4 } },
      }),
      expect.objectContaining({ severity: 'warning', code: 'TS9999' }),
    ]);
    expect(result.summary).toMatchObject({ errors: 1, warnings: 1 });
  });

  it('parses Cargo JSON compiler messages and ignores malformed lines', () => {
    const message = JSON.stringify({
      reason: 'compiler-message',
      message: {
        level: 'error',
        code: { code: 'E0308' },
        message: 'mismatched types',
        spans: [{ file_name: 'src/lib.rs', line_start: 8, column_start: 3, is_primary: true }],
      },
    });
    const result = parseLanguageDiagnostics('cargo-json', `${message}\nnot json`, '', root);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        severity: 'error',
        code: 'E0308',
        file: path.join(root, 'src', 'lib.rs'),
        range: { start: { line: 8, column: 3 } },
        source: 'rustc',
      }),
    ]);
  });

  it('parses Go, PHP, and .NET locations', () => {
    expect(
      parseLanguageDiagnostics('go-compiler', 'main.go:4:2: undefined: x', '', root).diagnostics[0],
    ).toMatchObject({ severity: 'error', range: { start: { line: 4, column: 2 } } });
    expect(
      parseLanguageDiagnostics(
        'php-lint',
        '',
        'PHP Parse error: unexpected token in index.php on line 7',
        root,
      ).diagnostics[0],
    ).toMatchObject({ severity: 'error', range: { start: { line: 7, column: 1 } } });
    expect(
      parseLanguageDiagnostics(
        'dotnet-build',
        'Program.cs(5,9): warning CS0168: variable declared but never used [App.csproj]',
        '',
        root,
      ).diagnostics[0],
    ).toMatchObject({ severity: 'warning', code: 'CS0168' });
  });

  it('deduplicates, sorts, and caps diagnostics', () => {
    const lines = Array.from(
      { length: 220 },
      (_, index) => `z-${220 - index}.go:${220 - index}:1: bad ${index}`,
    );
    lines.push(lines[0]!);
    const result = parseLanguageDiagnostics('go-compiler', lines.join('\n'), '', root);
    expect(result.diagnostics).toHaveLength(200);
    expect(result.omitted).toBe(20);
    expect(
      result.diagnostics[0]?.file?.localeCompare(result.diagnostics[1]?.file ?? ''),
    ).toBeLessThanOrEqual(0);
  });

  it('parses TypeScript syntax internally without a subprocess', async () => {
    const target = path.join(root, 'broken.ts');
    const result = await diagnosticsForInternalSyntax('typescript', target, 'const x = ;');
    expect(result.summary.errors).toBeGreaterThan(0);
    expect(result.diagnostics[0]).toMatchObject({ file: target, source: 'typescript-parser' });
  });

  it('handles literal % characters in file:// URIs without throwing URIError', () => {
    const denoOut = [
      'TS2322 [ERROR]: Type string is not assignable to type number.',
      '    at file:///D:/100%_suite/a.ts:12:5',
    ].join('\n');
    const denoDiags = parseDenoTest(denoOut, 'D:/100%_suite');
    expect(denoDiags).toHaveLength(1);
    expect(denoDiags[0]?.file).toBe(path.normalize('D:/100%_suite/a.ts'));

    const jvmOut = '[ERROR] file:///D:/100%_app/App.java:[4,13] incompatible types';
    const jvmDiags = parseJvmCompiler(jvmOut, 'D:/100%_app');
    expect(jvmDiags).toHaveLength(1);
    expect(jvmDiags[0]?.file).toBe(path.normalize('D:/100%_app/App.java'));
  });
});
