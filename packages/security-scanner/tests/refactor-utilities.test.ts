import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { gatherFiles, shouldExcludeDir } from '../src/file-gathering.js';
import { extractJsonBlock } from '../src/json-extractor.js';
import { parseNodeDependencies } from '../src/manifest-parser.js';
import { REDACTION_DIAGNOSTIC_RAW, runRedactionDiagnostic } from '../src/redaction-diagnostic.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe('shared file gathering', () => {
  it('filters extensions, hidden directories, and glob-style exclusions', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'security-gather-'));
    temporaryDirectories.push(root);
    const files = {
      'src/index.ts': 'ok',
      'src/index.js': 'skip extension',
      'src/.env': 'ok dotfile',
      'packages/a/generated/unsafe.ts': 'skip glob',
      'generated/root.ts': 'skip root glob',
      '.cache/hidden.ts': 'skip hidden',
    };
    for (const [file, content] of Object.entries(files)) {
      const fullPath = path.join(root, file);
      await fs.mkdir(path.dirname(fullPath), { recursive: true });
      await fs.writeFile(fullPath, content);
    }

    const gathered = await gatherFiles({
      root,
      extensions: ['.ts', '.env'],
      maxDepth: 10,
      excludePatterns: ['**/generated/**'],
      excludeHidden: true,
    });

    expect(gathered.map((file) => path.relative(root, file).replace(/\\/g, '/'))).toEqual([
      'src/.env',
      'src/index.ts',
    ]);
    expect(shouldExcludeDir('dist', 'packages/a/dist', ['dist'])).toBe(true);
    expect(shouldExcludeDir('cache', 'packages/cache', ['packages/*'])).toBe(true);
    expect(shouldExcludeDir('foo1', 'foo1', ['foo?'])).toBe(true);
    expect(shouldExcludeDir('src', 'src', ['', './'])).toBe(false);
  });
});

describe('LLM JSON extraction', () => {
  it('extracts nested JSON from a markdown fence and ignores braces in strings', () => {
    const text =
      'Result:\n```json\n{"outer":{"text":"a } brace"},"items":[1,2]}\n```\ntrailing {noise}';
    expect(extractJsonBlock(text, 'object')).toBe('{"outer":{"text":"a } brace"},"items":[1,2]}');
  });

  it('extracts an array containing nested objects and bracket characters', () => {
    const text = 'prefix [{"value":"]","nested":{"ok":true}}] suffix [not-json]';
    expect(extractJsonBlock(text, 'array')).toBe('[{"value":"]","nested":{"ok":true}}]');
  });

  it('handles escaped quotes and falls back across malformed fenced blocks', () => {
    const valid = String.raw`{"quoted":"a \" brace","ok":true}`;
    const text = ['```json', '{"unfinished": true', '```', `then ${valid}`].join('\n');
    expect(extractJsonBlock(text, 'object')).toBe(valid);
  });

  it('returns null when no balanced container exists', () => {
    expect(extractJsonBlock('prefix { "open": [1, 2]', 'object')).toBeNull();
    expect(extractJsonBlock('plain text', 'array')).toBeNull();
  });

  it('ignores a bracket inside quoted prose and extracts the real array (r3 regression)', () => {
    // Regression (2026-09-02): the start scan ignored string state, so the
    // first bracket of a quoted preamble ("[note]") became the extraction
    // start and the unparseable "[note]" slice was returned even though the
    // real findings array followed — batch-scanner then dropped the whole
    // batch's findings when JSON.parse rejected it.
    const text =
      'Results for "[note]" markers: [{"file":"a.ts","title":"t","description":"d","remediation":"r"}]';
    expect(extractJsonBlock(text, 'array')).toBe(
      '[{"file":"a.ts","title":"t","description":"d","remediation":"r"}]',
    );
  });

  it('ignores a brace inside quoted prose and extracts the real object (r3 regression)', () => {
    const text = 'The config "{mode}" is parsed as: {"ok": true}';
    expect(extractJsonBlock(text, 'object')).toBe('{"ok": true}');
  });
});

describe('Node manifest parsing', () => {
  it('parses and de-duplicates runtime and development dependencies', () => {
    const dependencies = parseNodeDependencies(
      JSON.stringify({
        dependencies: { alpha: '^1.0.0', shared: '^2.0.0' },
        devDependencies: { beta: '~3.0.0', shared: 'workspace:*' },
        optionalDependencies: { optional: '4.0.0' },
      }),
    );
    expect(dependencies).toEqual([
      { name: 'alpha', version: '^1.0.0', isDev: false },
      { name: 'beta', version: '~3.0.0', isDev: true },
      { name: 'optional', version: '4.0.0', isDev: false },
      { name: 'shared', version: '^2.0.0', isDev: false },
    ]);
  });

  it('returns an empty list for malformed manifests', () => {
    expect(parseNodeDependencies('{bad json')).toEqual([]);
  });

  it('ignores non-object manifests and malformed dependency entries', () => {
    expect(parseNodeDependencies('null')).toEqual([]);
    expect(parseNodeDependencies('[]')).toEqual([]);
    expect(
      parseNodeDependencies(
        JSON.stringify({
          devDependencies: null,
          peerDependencies: {
            '': '1.0.0',
            '   ': '1.0.0',
            valid: 123,
          },
          dependencies: { runtime: '2.0.0' },
        }),
      ),
    ).toEqual([{ name: 'runtime', version: '2.0.0', isDev: false }]);
  });
});

describe('redaction diagnostic', () => {
  it('reports only field paths and distinguishes safe text', () => {
    const result = runRedactionDiagnostic();
    expect(result.redactedFields).toContain('$.apiKey');
    expect(result.redactedFields).toContain('$.githubToken');
    expect(result.unchangedFields).toContain('$.normal');
    // Drift-proof leak guard: no raw sample value may cross the diagnostic
    // boundary — the result carries field paths only. Referencing the exported
    // fixture keeps this guard in sync if the fixture ever changes.
    for (const raw of Object.values(REDACTION_DIAGNOSTIC_RAW)) {
      expect(JSON.stringify(result)).not.toContain(raw);
    }
  });

  it('skips non-string primitives and nested containers without recursion errors', () => {
    const result = runRedactionDiagnostic();
    // Numbers, booleans, and undefined values are neither strings nor objects:
    // the walker's non-object guard (redaction-diagnostic.ts:58) skips them.
    expect(result.redactedFields).not.toContain('$.retries');
    expect(result.redactedFields).not.toContain('$.enabled');
    expect(result.redactedFields).not.toContain('$.missing');
    expect(result.unchangedFields).not.toContain('$.retries');
    // Nested containers recurse into their primitive leaves without crashing.
    expect(result.redactedFields).not.toContain('$.nested.port');
    expect(result.redactedFields).not.toContain('$.nested.flags.0');
  });
});
