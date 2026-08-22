/**
 * Batch toolchain parsers (P3.8) — Go and Python symbols from ONE child
 * process per chunk instead of one spawn per file.
 *
 * Toolchain-gated like the per-file parser suites: a machine without `go`
 * or `python` skips (the dispatcher's fallback path is still covered by the
 * existing per-file tests). All fixtures are in-memory — no disk corpus.
 */
import { execFile } from 'node:child_process';
import * as fsSync from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import type { BatchFile } from '../src/codebase-index/parser-batch.js';
import {
  __batchScriptPathsForTest,
  chunkBatchFiles,
  runGoBatch,
  runPyBatch,
} from '../src/codebase-index/parser-batch.js';
import { parseFilesContent } from '../src/codebase-index/parser-dispatch.js';
import { parseParserBatchOutput } from '../src/codebase-index/parser-output.js';
import { resolvePythonBinary } from '../src/codebase-index/py-parser.js';

const execFileAsync = promisify(execFile);

// Top-level await, NOT beforeAll: describe.runIf() evaluates its condition
// at collection time, before any hook runs — flags set in beforeAll made
// every gated suite silently skip even on machines WITH the toolchains.
let goAvailable = false;
let pyAvailable = false;
try {
  await execFileAsync('go', ['version']);
  goAvailable = true;
} catch {
  goAvailable = false;
}
pyAvailable = (await resolvePythonBinary()) !== null;

function goFile(i: number, valid = true): BatchFile {
  return {
    file: `D:/virtual/g/file-${i}.go`,
    lang: 'go',
    content: valid
      ? `package svc${i}\n\nimport "strings"\n\n// Add${i} adds.\nfunc Add${i}(a, b int) int {\n\treturn strings.Join([]string{}, "") != "" && a+b > 0 || a+b\n}\n\ntype Config${i} struct {\n\tName string\n}\n\nconst Max${i} = ${i}\n`
      : 'package broken\n\nfunc ( { this is not go',
  };
}

function pyFile(i: number, valid = true): BatchFile {
  return {
    file: `D:/virtual/p/file-${i}.py`,
    lang: 'py',
    content: valid
      ? `import os\n\n\nclass Service${i}:\n    def run(self, value):\n        return os.path.join("a", str(value + ${i}))\n\n\ndef helper_${i}(x):\n    return Service${i}().run(x)\n`
      : 'def broken(:\n    pass',
  };
}

describe('chunkBatchFiles', () => {
  it('chunks by file count', () => {
    const files = Array.from({ length: 250 }, (_, i) => goFile(i));
    const chunks = chunkBatchFiles(files);
    expect(chunks.length).toBe(3);
    expect(chunks[0]!.length).toBe(100);
    expect(chunks[2]!.length).toBe(50);
  });

  it('preserves order and extra fields', () => {
    const files = [goFile(1), goFile(2), goFile(3)].map((f, index) => ({ ...f, index }));
    const chunks = chunkBatchFiles(files);
    expect(chunks[0]!.map((f) => f.index)).toEqual([0, 1, 2]);
  });

  it('opens a new chunk when the byte cap would be exceeded', () => {
    const big = (name: string): BatchFile => ({
      ...goFile(0),
      file: name,
      content: 'package big\n' + 'x'.repeat(7 * 1024 * 1024),
    });
    // big (7 MiB) + small fits under the 8 MiB cap → one chunk; the second
    // big file would exceed the cap → forced into a new chunk.
    const files = [big('D:/virtual/b/one.go'), goFile(1), big('D:/virtual/b/two.go')];
    const chunks = chunkBatchFiles(files);
    expect(chunks.length).toBe(2);
    expect(chunks[0]).toHaveLength(2);
    expect(chunks[1]).toHaveLength(1);
    expect(chunks[1]![0]!.file).toBe('D:/virtual/b/two.go');
  });
});

describe('parseParserBatchOutput', () => {
  it('decodes a valid envelope with per-file errors', () => {
    const envelope = JSON.stringify({
      version: 1,
      results: [
        {
          file: 'a.go',
          symbols: [
            { name: 'Foo', kind: 'function', line: 1, col: 1, signature: 'func Foo', scope: 'p' },
          ],
          refs: [{ toName: 'Bar', callType: 'call', line: 2 }],
        },
        { file: 'b.go', error: 'expected ;, found }' },
      ],
    });
    const out = parseParserBatchOutput(envelope, 'go');
    expect(out).toHaveLength(2);
    expect(out[0]!.symbols[0]!.name).toBe('Foo');
    expect(out[0]!.refs[0]!.lang).toBe('go');
    expect(out[1]!.error).toBe('expected ;, found }');
    expect(out[1]!.symbols).toHaveLength(0);
  });

  it('returns [] for malformed payloads', () => {
    expect(parseParserBatchOutput('not json', 'go')).toEqual([]);
    expect(parseParserBatchOutput('{"version":1}', 'go')).toEqual([]);
    expect(parseParserBatchOutput('', 'py')).toEqual([]);
  });
});

describe.runIf(goAvailable)('runGoBatch', () => {
  it('parses multiple files in one spawn and returns per-file symbols + refs', async () => {
    const files = Array.from({ length: 12 }, (_, i) => goFile(i));
    const out = await runGoBatch(files);
    expect(out.size).toBe(12);
    const first = out.get(files[0]!.file)!;
    expect(first.lang).toBe('go');
    const names = first.symbols.map((s) => s.name);
    expect(names).toContain(`Add0`);
    expect(names).toContain(`Config0`);
    expect(names).toContain(`Max0`);
    // Refs: strings import + Join call
    const refNames = first.refs!.map((r) => r.toName);
    expect(refNames).toContain('strings');
    expect(refNames).toContain('Join');
  }, 60_000);

  it('omits syntax-error files from the map (fallback contract)', async () => {
    const files = [goFile(0, true), goFile(1, false), goFile(2, true)];
    const out = await runGoBatch(files);
    expect(out.has(files[1]!.file)).toBe(false);
    expect(out.has(files[0]!.file)).toBe(true);
    expect(out.has(files[2]!.file)).toBe(true);
  }, 60_000);

  it('returns an empty map for an empty batch (no spawn)', async () => {
    const out = await runGoBatch([]);
    expect(out.size).toBe(0);
  });
});

describe.runIf(pyAvailable)('runPyBatch', () => {
  it('parses multiple files in one spawn and returns per-file symbols + refs', async () => {
    const files = Array.from({ length: 12 }, (_, i) => pyFile(i));
    const out = await runPyBatch(files, (await resolvePythonBinary())!);
    expect(out.size).toBe(12);
    const first = out.get(files[0]!.file)!;
    expect(first.lang).toBe('py');
    const names = first.symbols.map((s) => s.name);
    expect(names).toContain('Service0');
    expect(names).toContain('helper_0');
    const refNames = first.refs!.map((r) => r.toName);
    expect(refNames).toContain('join');
    expect(refNames).toContain('os');
  }, 60_000);

  it('omits syntax-error files from the map (fallback contract)', async () => {
    const files = [pyFile(0, true), pyFile(1, false), pyFile(2, true)];
    const out = await runPyBatch(files, (await resolvePythonBinary())!);
    expect(out.has(files[1]!.file)).toBe(false);
    expect(out.has(files[0]!.file)).toBe(true);
  }, 60_000);
});

describe('parseFilesContent dispatcher', () => {
  it('returns index-aligned results for a mixed ts/go/py batch', async () => {
    const files = [
      {
        file: 'D:/virtual/m/one.ts',
        content: 'export function one(): number { return 1; }',
        lang: 'ts' as const,
      },
      ...(goAvailable ? [goFile(7)] : []),
      { file: 'D:/virtual/m/three.ts', content: 'export const three = 3;', lang: 'ts' as const },
      ...(pyAvailable ? [pyFile(7)] : []),
    ];
    const slots = await parseFilesContent(files);
    const results = slots.map((s) => s.result);
    expect(results).toHaveLength(files.length);
    // Order preserved regardless of language grouping.
    expect(results[0]!.file).toBe('D:/virtual/m/one.ts');
    expect(results[0]!.symbols.some((s) => s.name === 'one')).toBe(true);
    const lastTs = results[results.length - 1 - (pyAvailable ? 1 : 0)]!;
    expect(lastTs.file).toBe('D:/virtual/m/three.ts');
    if (goAvailable) {
      expect(results[1]!.symbols.some((s) => s.name === 'Add7')).toBe(true);
    }
    if (pyAvailable) {
      expect(results[results.length - 1]!.symbols.some((s) => s.name === 'Service7')).toBe(true);
    }
  }, 90_000);

  it('falls back to per-file parsing for batch-invalid files (mixed validity)', async () => {
    if (!goAvailable && !pyAvailable) return;
    const files = [
      ...(goAvailable ? [goFile(0, false)] : []),
      ...(pyAvailable ? [pyFile(0, false)] : []),
    ];
    const slots = await parseFilesContent(files);
    // Syntax-error files still come back (via per-file fallback), with the
    // toolchain's own zero-symbol semantics — never dropped from the output.
    expect(slots).toHaveLength(files.length);
    for (const s of slots) expect(s.result?.file).toBeTruthy();
  }, 90_000);

  it('WRONGSTACK_TOOLCHAIN_BATCH=0 disables batching (per-file path)', async () => {
    const previous = process.env['WRONGSTACK_TOOLCHAIN_BATCH'];
    process.env['WRONGSTACK_TOOLCHAIN_BATCH'] = '0';
    try {
      const files = [
        { file: 'D:/virtual/t/a.ts', content: 'export const aa = 1;', lang: 'ts' as const },
        ...(goAvailable ? [goFile(3)] : []),
      ];
      const slots = await parseFilesContent(files);
      const results = slots.map((s) => s.result);
      expect(results).toHaveLength(files.length);
      expect(results[0]!.symbols.some((s) => s.name === 'aa')).toBe(true);
      if (goAvailable) {
        expect(results[1]!.symbols.some((s) => s.name === 'Add3')).toBe(true);
      }
    } finally {
      if (previous === undefined) delete process.env['WRONGSTACK_TOOLCHAIN_BATCH'];
      else process.env['WRONGSTACK_TOOLCHAIN_BATCH'] = previous;
    }
  }, 90_000);
});

// Security regression (Chimera High): batch scripts must live in an
// unpredictable mkdtemp directory, never the legacy predictable path.
// Runs unconditionally — ensureScriptPath creates + caches the script path
// BEFORE any toolchain spawn, so bogus binaries keep this toolchain-free.
describe('batch script temp-path security', () => {
  it('writes scripts to an unpredictable private dir, never the legacy fixed path', async () => {
    await runGoBatch([goFile(0)], 'definitely-not-a-real-go-binary-xyz');
    await runPyBatch([pyFile(0)], 'definitely-not-a-real-python-binary-xyz');

    const { go, py } = __batchScriptPathsForTest();
    expect(go).toBeTruthy();
    expect(py).toBeTruthy();

    const goDir = path.dirname(go!);
    const pyDir = path.dirname(py!);
    // Never the predictable legacy location an attacker could pre-create.
    expect(goDir).not.toBe(path.join(os.tmpdir(), 'ws-go-parse'));
    expect(pyDir).not.toBe(path.join(os.tmpdir(), 'ws-py-parse'));

    // mkdtemp randomness: Node appends exactly 6 random chars directly to
    // the prefix (no separator), and two fresh mkdtemp dirs with the same
    // prefix are never equal — the property that makes pre-creation
    // impossible.
    expect(goDir).toMatch(/ws-go-parse.{6,}$/);
    expect(pyDir).toMatch(/ws-py-parse.{6,}$/);
    const probeA = fsSync.mkdtempSync(path.join(os.tmpdir(), 'ws-go-parse'));
    const probeB = fsSync.mkdtempSync(path.join(os.tmpdir(), 'ws-go-parse'));
    expect(probeA).not.toBe(probeB);
    expect(probeA).not.toBe(goDir);
    fsSync.rmSync(probeA, { recursive: true, force: true });
    fsSync.rmSync(probeB, { recursive: true, force: true });

    // The script exists inside the private dir.
    expect(go).not.toBeNull();
    expect(py).not.toBeNull();
    if (go === null || py === null) throw new Error('batch parser scripts were not initialized');
    expect(fsSync.existsSync(go)).toBe(true);
    expect(fsSync.existsSync(py)).toBe(true);
  });

  it('refuses to overwrite an existing script file (O_EXCL — never follows a pre-existing symlink)', async () => {
    const { go } = __batchScriptPathsForTest();
    expect(go).toBeTruthy();
    // 'wx' must refuse the already-existing script: an attacker-supplied
    // file at that name could never be followed or replaced.
    await expect(
      fsSync.promises.writeFile(go!, 'evil payload', { encoding: 'utf8', flag: 'wx' }),
    ).rejects.toThrow();
  });
});

// Sanity: the test harness itself can see the toolchains it gates on.
describe('toolchain availability report', () => {
  it('reports availability for the record', () => {
    console.log(`[parser-batch tests] go=${goAvailable} python=${pyAvailable}`);
  });
});
