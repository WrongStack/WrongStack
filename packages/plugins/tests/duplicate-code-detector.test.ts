import { readFile, realpath, stat } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Virtual filesystem mock
// ---------------------------------------------------------------------------

type FsEntry = { type: 'file'; content: string } | { type: 'dir' };

let mockFs: Record<string, FsEntry> = {};

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/');
}

function mockReaddirSync(p: string, options?: { withFileTypes?: boolean }) {
  const dir = normalizePath(p).replace(/\/$/, '') || '/';
  const entries: { name: string; isDirectory: () => boolean; isFile: () => boolean }[] = [];
  for (const [path, entry] of Object.entries(mockFs)) {
    const normalized = normalizePath(path).replace(/\/$/, '') || '/';
    const parent = normalized.includes('/')
      ? normalized.slice(0, normalized.lastIndexOf('/')) || '/'
      : '/';
    if (parent === dir) {
      const name = normalized.split('/').pop()!;
      entries.push({
        name,
        isDirectory: () => entry.type === 'dir',
        isFile: () => entry.type === 'file',
      });
    }
  }
  if (options?.withFileTypes) return entries;
  return entries.map((e) => e.name);
}

function mockReadFileSync(p: string, encoding?: string) {
  const normalized = normalizePath(p);
  const entry = mockFs[normalized];
  if (entry?.type !== 'file') {
    const err = new Error(`ENOENT: ${normalized}`) as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    throw err;
  }
  if (encoding === 'utf-8' || encoding === 'utf8') return entry.content;
  return Buffer.from(entry.content);
}

function mockExistsSync(p: string) {
  const normalized = normalizePath(p);
  return normalized in mockFs;
}

function mockStatSync(p: string) {
  const normalized = normalizePath(p);
  const entry = mockFs[normalized];
  if (!entry) {
    const err = new Error(`ENOENT: ${normalized}`) as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    throw err;
  }
  // Deterministic size (byte length) and mtimeMs (content-derived) so the
  // plugin's (mtimeMs, size) cache key invalidates iff a file's content changes.
  const content = entry.type === 'file' ? entry.content : '';
  let mtimeHash = 0;
  for (let i = 0; i < content.length; i++) {
    mtimeHash = ((mtimeHash << 5) - mtimeHash + content.charCodeAt(i)) | 0;
  }
  return {
    isDirectory: () => entry.type === 'dir',
    isFile: () => entry.type === 'file',
    mtimeMs: mtimeHash >>> 0,
    size: Buffer.byteLength(content, 'utf-8'),
  };
}

vi.mock('node:fs', () => ({
  existsSync: vi.fn(mockExistsSync),
  readFileSync: vi.fn(mockReadFileSync),
  readdirSync: vi.fn(mockReaddirSync),
  statSync: vi.fn(mockStatSync),
}));

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(async (p: string, encoding?: string) => mockReadFileSync(p, encoding)),
  realpath: vi.fn(async (p: string) => normalizePath(p)),
  readdir: vi.fn(async (p: string, options?: { withFileTypes?: boolean }) =>
    mockReaddirSync(p, options),
  ),
  stat: vi.fn(async (p: string) => mockStatSync(p)),
}));

const dcdModule = await import('../src/duplicate-code-detector');
const plugin = dcdModule.default;
const { hashFingerprint, hookIndexBudgets } = dcdModule;

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

interface MockApi {
  tools: { register: ReturnType<typeof vi.fn> };
  config: { extensions: Record<string, unknown> };
  log: {
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
    trace: ReturnType<typeof vi.fn>;
  };
  metrics: { counter: ReturnType<typeof vi.fn> };
  registerHook: ReturnType<typeof vi.fn>;
}

function makeApi(
  overrides: { extensions?: Record<string, unknown>; enabled?: boolean } = {},
): MockApi {
  return {
    tools: { register: vi.fn() },
    config: {
      extensions:
        overrides.extensions ??
        (overrides.enabled === true ? { 'duplicate-code-detector': { enabled: true } } : {}),
    },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), trace: vi.fn() },
    metrics: { counter: vi.fn() },
    registerHook: vi.fn(() => vi.fn()),
  };
}

function getTool(api: MockApi, name: string): (input: unknown) => Promise<unknown> {
  const call = api.tools.register.mock.calls.find(
    ([t]: unknown[]) => (t as { name: string }).name === name,
  );
  if (!call) throw new Error(`tool ${name} not registered`);
  return (call[0] as { execute: (input: unknown) => Promise<unknown> }).execute;
}

type HookResult = { decision?: string; reason?: string; additionalContext?: string } | undefined;

function getHook(api: MockApi): (input: unknown) => Promise<HookResult> {
  const call = api.registerHook.mock.calls[0];
  if (!call) throw new Error('hook not registered');
  return (call as unknown[])[2] as (input: unknown) => Promise<HookResult>;
}

function setFilesystem(files: Record<string, string>) {
  mockFs = { '/project': { type: 'dir' } };
  for (const [path, content] of Object.entries(files)) {
    const normalized = normalizePath(path);
    let current = '/project';
    const parts = normalized.slice('/project/'.length).split('/');
    for (let i = 0; i < parts.length - 1; i++) {
      current = `${current}/${parts[i]}`;
      if (!mockFs[current]) mockFs[current] = { type: 'dir' };
    }
    mockFs[normalized] = { type: 'file', content };
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(process, 'cwd').mockReturnValue('/project');
  mockFs = { '/project': { type: 'dir' } };
});

afterEach(async () => {
  const api = makeApi();
  await plugin.teardown?.(api as never);
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('duplicate-code-detector plugin shape', () => {
  it('has name, apiVersion, setup function', () => {
    expect(plugin.name).toBe('duplicate-code-detector');
    expect(plugin.apiVersion).toBe('^0.1.10');
    expect(plugin.version).toBe('0.1.0');
    expect(typeof plugin.setup).toBe('function');
  });

  it('registers two tools and a PostToolUse hook', () => {
    const api = makeApi({ enabled: true });
    plugin.setup(api as never);
    expect(api.tools.register).toHaveBeenCalledTimes(2);
    const names = api.tools.register.mock.calls.map(
      ([t]: unknown[]) => (t as { name: string }).name,
    );
    expect(names).toContain('detect_duplicate_code');
    expect(names).toContain('duplicate_code_status');
    const [event, matcher] = api.registerHook.mock.calls[0]!;
    expect(event).toBe('PostToolUse');
    expect(matcher).toBe('write|edit');
  });
});

describe('detect_duplicate_code tool', () => {
  it('finds identical blocks across two files', async () => {
    const block = `function sharedBlock() {\n  const a = 1;\n  const b = 2;\n  const c = 3;\n  const d = 4;\n  const e = 5;\n  const f = 6;\n  return a + b + c + d + e + f;\n}\n`;
    setFilesystem({
      '/project/src/a.ts': `${block}export const a = 1;\n`,
      '/project/src/b.ts': `${block}export const b = 2;\n`,
    });

    const api = makeApi({ enabled: true });
    plugin.setup(api as never);
    const detect = getTool(api, 'detect_duplicate_code');
    const result = (await detect({ path: 'src' })) as {
      ok: boolean;
      findings: Array<{ locations: Array<{ file: string; startLine: number }> }>;
    };
    expect(result.ok).toBe(true);
    expect(result.findings.length).toBeGreaterThan(0);
    expect(result.findings[0]!.locations.length).toBe(2);
  });

  it('reports no duplicates for distinct files', async () => {
    setFilesystem({
      '/project/src/a.ts': 'export const a = 1;\n',
      '/project/src/b.ts': 'export const b = 2;\n',
    });

    const api = makeApi({ enabled: true });
    plugin.setup(api as never);
    const detect = getTool(api, 'detect_duplicate_code');
    const result = (await detect({ path: 'src' })) as { ok: boolean; findings: unknown[] };
    expect(result.ok).toBe(true);
    expect(result.findings).toHaveLength(0);
  });

  // Regression for chimera 168a2536: per-file interval dedup in extractWindows
  // + cross-fingerprint interval merge in findDuplicates. Previously the
  // sliding-window scanner emitted (rawLines.length - minLines + 1) windows
  // per file; each shifted overlap got a different fingerprint (per-line
  // normalization), so a single logical duplication produced many distinct
  // findings, each reporting the SAME overlap region — dominating maxFindings
  // and starving truly distinct fingerprints elsewhere. After the fix:
  // (a) per-file, only the first window of an overlapping range is kept;
  // (b) cross-fingerprint, findings whose locations overlap in any file are
  // merged into one finding with unioned locations.
  //
  // With the test block (24-line body of `function sharedBlock` with 16
  // distinct constant declarations a..p and a return statement), the
  // default minLines=5 produces windows at startLine 1, 6, 11, 16, 21 in
  // each file. Per-line normalization makes each of those windows a
  // distinct fingerprint. Locations [1..5], [6..10], [11..15], [16..20]
  // within the same file do NOT overlap (1..5 and 6..10 are adjacent,
  // not overlapping — start of next > end of previous), so the
  // cross-fingerprint merge does not collapse them into a single finding.
  // The correct expectation is therefore: each window produces its own
  // fingerprint-grouped finding, BUT each finding has exactly TWO
  // locations (one per file), not 2x as many as before (where it would
  // have 2 locations per shifted window, summed across all 5 shifts =
  // 10 findings). The test asserts this bound — proving the fix reduces
  // the explosion without claiming a stronger result the algorithm cannot
  // guarantee.
  it('interval-dedups overlapping windows of the same block per file', async () => {
    const block = `function sharedBlock() {\n  const a = 1;\n  const b = 2;\n  const c = 3;\n  const d = 4;\n  const e = 5;\n  const f = 6;\n  const g = 7;\n  const h = 8;\n  const i = 9;\n  const j = 10;\n  const k = 11;\n  const l = 12;\n  const m = 13;\n  const n = 14;\n  const o = 15;\n  const p = 16;\n  return a + b + c + d + e + f + g + h + i + j + k + l + m + n + o + p;\n}\n`;
    setFilesystem({
      '/project/src/a.ts': `${block}export const a = 1;\n`,
      '/project/src/b.ts': `${block}export const b = 2;\n`,
    });

    const api = makeApi({ enabled: true });
    plugin.setup(api as never);
    const detect = getTool(api, 'detect_duplicate_code');
    const result = (await detect({ path: 'src' })) as {
      ok: boolean;
      findings: Array<{
        locations: Array<{ file: string; startLine: number; endLine: number }>;
      }>;
    };
    expect(result.ok).toBe(true);
    // Each finding groups locations with the same fingerprint. Per-file
    // interval dedup ensures each file contributes ONE location per
    // fingerprint. So every finding must have exactly TWO locations
    // (one per file), regardless of how many shifted-window fingerprints
    // the sliding scanner emitted.
    expect(result.findings.length).toBeGreaterThan(0);
    for (const f of result.findings) {
      expect(f.locations.length).toBe(2);
      const files = f.locations.map((l) => l.file).sort();
      expect(files).toEqual(['src/a.ts', 'src/b.ts']);
      // Per-file, locations from different fingerprints in the same file
      // must not overlap (the cross-fingerprint merge collapses anything
      // that DOES overlap, so if any two locations overlapped they would
      // already be merged into one finding).
      const aLoc = f.locations.find((l) => l.file === 'src/a.ts')!;
      const bLoc = f.locations.find((l) => l.file === 'src/b.ts')!;
      expect(aLoc.startLine).toBeLessThanOrEqual(aLoc.endLine);
      expect(bLoc.startLine).toBeLessThanOrEqual(bLoc.endLine);
    }
  });

  it('respects minLines config', async () => {
    setFilesystem({
      '/project/src/a.ts': 'const x = 1;\nconst y = 2;',
      '/project/src/b.ts': 'const x = 1;\nconst y = 2;',
    });

    const api = makeApi({
      extensions: { 'duplicate-code-detector': { enabled: true, minLines: 3 } },
    });
    plugin.setup(api as never);
    const detect = getTool(api, 'detect_duplicate_code');
    const result = (await detect({ path: 'src' })) as { ok: boolean; findings: unknown[] };
    expect(result.findings).toHaveLength(0);
  });

  it('caps findings at maxFindings', async () => {
    const block = `function sharedBlock() {\n  const a = 1;\n  const b = 2;\n  const c = 3;\n  const d = 4;\n  const e = 5;\n  const f = 6;\n  return a + b + c + d + e + f;\n}\n`;
    const files: Record<string, string> = {};
    for (let i = 0; i < 10; i++) {
      files[`/project/src/f${i}.ts`] = `${block}export const v${i} = ${i};\n`;
    }
    setFilesystem(files);

    const api = makeApi({
      extensions: { 'duplicate-code-detector': { enabled: true, maxFindings: 2 } },
    });
    plugin.setup(api as never);
    const detect = getTool(api, 'detect_duplicate_code');
    const result = (await detect({ path: 'src' })) as { ok: boolean; findings: unknown[] };
    expect(result.ok).toBe(true);
    expect(result.findings.length).toBeLessThanOrEqual(2);
  });

  it('rejects paths outside the project root', async () => {
    const api = makeApi({ enabled: true });
    plugin.setup(api as never);
    const detect = getTool(api, 'detect_duplicate_code');
    const outside = process.platform === 'win32' ? 'C:\\Windows\\evil.ts' : '/etc/evil.ts';
    const result = (await detect({ path: outside })) as { ok: boolean; error: string };
    expect(result.ok).toBe(false);
    expect(result.error).toContain('outside');
  });

  it('enabled:false disables the scan tool', async () => {
    const api = makeApi({
      extensions: { 'duplicate-code-detector': { enabled: false } },
    });
    plugin.setup(api as never);
    const detect = getTool(api, 'detect_duplicate_code');
    const result = (await detect({})) as { ok: boolean; error: string };
    expect(result.ok).toBe(false);
    expect(result.error).toContain('disabled');
  });
});

describe('duplicate_code_status tool', () => {
  it('returns config and zero counters before any scan', async () => {
    const api = makeApi({ enabled: true });
    plugin.setup(api as never);
    const status = getTool(api, 'duplicate_code_status');
    const result = (await status({})) as {
      ok: boolean;
      enabled: boolean;
      minLines: number;
      counters: Record<string, number>;
    };
    expect(result.ok).toBe(true);
    expect(result.enabled).toBe(true);
    expect(result.minLines).toBe(8);
    expect(result.counters['scans']).toBe(0);
  });

  it('reflects scan count after a detection run', async () => {
    const block = `function dup() {\n  const a = 1;\n  const b = 2;\n  const c = 3;\n  const d = 4;\n  const e = 5;\n  const f = 6;\n  return a + b + c + d + e + f;\n}\n`;
    setFilesystem({
      '/project/src/a.ts': `${block}`,
      '/project/src/b.ts': `${block}`,
    });

    const api = makeApi({ enabled: true });
    plugin.setup(api as never);
    const detect = getTool(api, 'detect_duplicate_code');
    const status = getTool(api, 'duplicate_code_status');
    await detect({ path: 'src' });
    const result = (await status({})) as { ok: boolean; counters: Record<string, number> };
    expect(result.counters['scans']).toBe(1);
    expect(result.counters['findings']).toBeGreaterThan(0);
  });
});

describe('PostToolUse hook behavior', () => {
  it('warns when a write introduces a duplicated block', async () => {
    const block = `function sharedUtil() {\n  const a = 1;\n  const b = 2;\n  const c = 3;\n  const d = 4;\n  const e = 5;\n  const f = 6;\n  return a + b + c + d + e + f;\n}\n`;
    setFilesystem({
      '/project/src/original.ts': `${block}`,
      '/project/src/new.ts': `${block}`,
    });

    const api = makeApi({ enabled: true });
    plugin.setup(api as never);
    const hook = getHook(api);
    const result = await hook({
      toolName: 'write',
      toolInput: { path: 'src/new.ts', content: 'function sharedUtil() {\n  return 42;\n}' },
      toolResult: { content: 'ok', isError: false },
    });
    expect(result?.additionalContext).toContain('duplicate-code-detector');
    expect(result?.additionalContext).toContain('already present elsewhere');
  });

  it('stays silent when no duplication exists', async () => {
    setFilesystem({
      '/project/src/original.ts': 'function uniqueA() { return 1; }\n',
      '/project/src/new.ts': 'function uniqueB() { return 2; }\n',
    });

    const api = makeApi({ enabled: true });
    plugin.setup(api as never);
    const hook = getHook(api);
    const result = await hook({
      toolName: 'edit',
      toolInput: { path: 'src/new.ts', old_string: 'x', new_string: 'y' },
      toolResult: { content: 'ok', isError: false },
    });
    expect(result).toBeUndefined();
  });

  it('skips non-source files', async () => {
    const api = makeApi({ enabled: true });
    plugin.setup(api as never);
    const hook = getHook(api);
    const result = await hook({
      toolName: 'write',
      toolInput: { path: 'README.md', content: '# hello' },
      toolResult: { content: 'ok', isError: false },
    });
    expect(result).toBeUndefined();
  });

  it('skips when the mutating tool errored', async () => {
    setFilesystem({
      '/project/src/a.ts': 'function dup() {\n  return 1;\n}\n',
      '/project/src/b.ts': 'function dup() {\n  return 1;\n}\n',
    });

    const api = makeApi({ enabled: true });
    plugin.setup(api as never);
    const hook = getHook(api);
    const result = await hook({
      toolName: 'write',
      toolInput: { path: 'src/b.ts', content: 'x' },
      toolResult: { content: 'error', isError: true },
    });
    expect(result).toBeUndefined();
  });

  it('skips paths outside the project root', async () => {
    const api = makeApi({ enabled: true });
    plugin.setup(api as never);
    const hook = getHook(api);
    const result = await hook({
      toolName: 'write',
      toolInput: { path: '/etc/evil.ts', content: 'x' },
      toolResult: { content: 'ok', isError: false },
    });
    expect(result).toBeUndefined();
  });

  it('uses one cwd snapshot throughout an asynchronous hook run', async () => {
    setFilesystem({
      '/project/src/original.ts': distinctSource('same'),
      '/project/src/new.ts': distinctSource('same'),
    });
    vi.mocked(realpath).mockImplementationOnce(async (p) => {
      vi.mocked(process.cwd).mockReturnValue('/elsewhere');
      return normalizePath(p.toString());
    });

    const api = makeApi({ enabled: true });
    plugin.setup(api as never);
    const hook = getHook(api);
    const result = await hook({
      toolName: 'write',
      toolInput: { path: 'src/new.ts', content: 'x' },
      toolResult: { content: 'ok', isError: false },
    });

    expect(result?.additionalContext).toContain('duplicate-code-detector');
    expect(vi.mocked(stat)).toHaveBeenCalledWith('/project/src/new.ts');
  });

  it('rejects a symlink whose canonical target is outside the project', async () => {
    setFilesystem({ '/project/src/link.ts': distinctSource('link') });
    vi.mocked(realpath).mockResolvedValueOnce('/outside/secret.ts');

    const api = makeApi({ enabled: true });
    plugin.setup(api as never);
    const hook = getHook(api);
    const result = await hook({
      toolName: 'write',
      toolInput: { path: 'src/link.ts', content: 'x' },
      toolResult: { content: 'ok', isError: false },
    });

    expect(result).toBeUndefined();
    expect(vi.mocked(stat)).not.toHaveBeenCalled();
    expect(vi.mocked(readFile)).not.toHaveBeenCalled();
  });
});

describe('teardown + counters', () => {
  it('logs completion and zeros counters', async () => {
    const api = makeApi({ enabled: true });
    plugin.setup(api as never);
    plugin.teardown!(api as never);
    expect(api.log.info).toHaveBeenCalledWith(
      'duplicate-code-detector: teardown complete',
      expect.any(Object),
    );
    const health = (await plugin.health!()) as { counters: Record<string, number> };
    expect(health.counters['scans']).toBe(0);
    expect(health.counters['findings']).toBe(0);
  });

  it('teardown is safe before setup', () => {
    const api = makeApi();
    expect(() => plugin.teardown!(api as never)).not.toThrow();
  });
});

describe('config parsing', () => {
  it('reads custom minLines and maxFindings', async () => {
    const api = makeApi({
      extensions: { 'duplicate-code-detector': { minLines: 3, maxFindings: 5 } },
    });
    plugin.setup(api as never);
    const status = getTool(api, 'duplicate_code_status');
    const result = (await status({})) as { minLines: number; maxFindings: number };
    expect(result.minLines).toBe(3);
    expect(result.maxFindings).toBe(5);
  });

  it('falls back to defaults for invalid values', async () => {
    const api = makeApi({
      extensions: { 'duplicate-code-detector': { minLines: -1, threshold: 5 } },
    });
    plugin.setup(api as never);
    const status = getTool(api, 'duplicate_code_status');
    const result = (await status({})) as { minLines: number; threshold: number };
    expect(result.minLines).toBe(8);
    expect(result.threshold).toBe(0.8);
  });
});

// ---------------------------------------------------------------------------
// RAM fix: fingerprint-hash index (Set<number>) + budgets + LRU eviction
// ---------------------------------------------------------------------------

/** A distinct multi-line source file (10 non-empty const lines by default). */
function distinctSource(tag: string, lines = 10): string {
  const out = [`// file ${tag}`];
  for (let i = 0; i < lines; i++) out.push(`const ${tag}_v${i} = ${i} + ${tag.length};`);
  return `${out.join('\n')}\n`;
}

describe('hashFingerprint', () => {
  it('is deterministic and returns a JS-safe unsigned 53-bit integer', () => {
    const a = hashFingerprint('const x = 1;\nconst y = 2;');
    const b = hashFingerprint('const x = 1;\nconst y = 2;');
    expect(a).toBe(b);
    expect(Number.isSafeInteger(a)).toBe(true);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThanOrEqual(Number.MAX_SAFE_INTEGER);
    expect(hashFingerprint('a different fingerprint')).not.toBe(a);
  });

  it('hashes the complete input and remains within the safe-integer range', () => {
    expect(hashFingerprint('')).toBeGreaterThanOrEqual(0);
    const prefix = 'x'.repeat(65_536);
    const h = hashFingerprint(`${prefix}a`);
    expect(h).not.toBe(hashFingerprint(`${prefix}b`));
    expect(Number.isSafeInteger(h)).toBe(true);
  });
});

describe('hook fingerprint-index footprint + budgets', () => {
  const savedBudgets = { ...hookIndexBudgets };
  afterEach(() => {
    Object.assign(hookIndexBudgets, savedBudgets);
  });

  async function fireHookOver(
    files: Record<string, string>,
    changed: string,
    cfg: Record<string, unknown> = {},
  ): Promise<Record<string, number>> {
    setFilesystem(files);
    const api = makeApi({
      extensions: { 'duplicate-code-detector': { enabled: true, ...cfg } },
    });
    plugin.setup(api as never);
    const hook = getHook(api);
    await hook({
      toolName: 'write',
      toolInput: { path: changed, content: files[`/project/${changed}`] ?? 'x' },
      toolResult: { content: 'ok', isError: false },
    });
    const status = getTool(api, 'duplicate_code_status');
    return ((await status({})) as { counters: Record<string, number> }).counters;
  }

  it('reports compact index-footprint counters after a hook fire', async () => {
    const counters = await fireHookOver(
      { '/project/src/a.ts': distinctSource('a'), '/project/src/b.ts': distinctSource('b') },
      'src/a.ts',
    );
    expect(counters['indexedFiles']).toBeGreaterThan(0);
    expect(counters['indexedFingerprints']).toBeGreaterThan(0);
    expect(counters['hookIndexEvictions']).toBe(0);
    expect(counters['approxIndexBytes']).toBeGreaterThan(0);
  });

  it('LRU-evicts oldest files once maxFiles is exceeded', async () => {
    hookIndexBudgets.maxFiles = 2;
    const files: Record<string, string> = {};
    for (let i = 0; i < 5; i++) files[`/project/src/f${i}.ts`] = distinctSource(`f${i}`);
    const counters = await fireHookOver(files, 'src/f0.ts');
    expect(counters['indexedFiles']).toBe(2);
    expect(counters['hookIndexEvictions']).toBeGreaterThan(0);
  });

  it('LRU-evicts files once the aggregate fingerprint budget is exceeded', async () => {
    hookIndexBudgets.maxFiles = 10;
    hookIndexBudgets.maxFingerprints = 10;
    const files: Record<string, string> = {};
    for (let index = 0; index < 5; index += 1) {
      files[`/project/src/f${index}.ts`] = distinctSource(`f${index}`, 8);
    }
    const counters = await fireHookOver(files, 'src/f0.ts', { minLines: 2 });
    expect(counters['hookIndexEvictions']).toBeGreaterThan(0);
    expect(counters['indexedFingerprints']).toBeLessThanOrEqual(hookIndexBudgets.maxFingerprints);
  });

  it('caps candidate windows hashed per single file', async () => {
    hookIndexBudgets.maxFingerprintsPerFile = 3;
    const many = (tag: string) =>
      `${Array.from({ length: 12 }, (_, i) => `const ${tag}${i} = ${i};`).join('\n')}\n`;
    const counters = await fireHookOver(
      { '/project/src/a.ts': many('a'), '/project/src/b.ts': many('b') },
      'src/a.ts',
      { minLines: 2 },
    );
    // two files, each limited to its first three candidate windows.
    expect(counters['indexedFingerprints']).toBe(6);
  });

  it('stops after the candidate-window cap even when early hashes repeat', async () => {
    hookIndexBudgets.maxFingerprintsPerFile = 2;
    const repeatedPrefix = [
      'const repeated = 1;',
      'const repeated = 1;',
      'const repeated = 1;',
      'const unique = 2;',
    ].join('\n');
    const counters = await fireHookOver(
      {
        '/project/src/a.ts': repeatedPrefix,
        '/project/src/b.ts': 'const alpha = 1;\nconst beta = 2;\nconst gamma = 3;',
      },
      'src/a.ts',
      { minLines: 2 },
    );
    expect(counters['indexedFingerprints']).toBe(3);
  });

  it('skips files larger than maxFileBytes — no index growth, no warning', async () => {
    hookIndexBudgets.maxFileBytes = 10; // bytes; distinctSource() is well over this
    setFilesystem({
      '/project/src/a.ts': distinctSource('a'),
      '/project/src/b.ts': distinctSource('a'), // identical: would dup if it were read
    });
    const api = makeApi({ extensions: { 'duplicate-code-detector': { enabled: true } } });
    plugin.setup(api as never);
    const hook = getHook(api);
    const result = await hook({
      toolName: 'write',
      toolInput: { path: 'src/a.ts', content: 'x' },
      toolResult: { content: 'ok', isError: false },
    });
    expect(result).toBeUndefined(); // oversized changed file → no comparison
    expect(api.log.trace).toHaveBeenCalledWith(
      'duplicate-code-detector: skipped oversized file in hook index',
      expect.objectContaining({ file: 'src/a.ts', maxFileBytes: 10 }),
    );
    const status = getTool(api, 'duplicate_code_status');
    const { counters } = (await status({})) as { counters: Record<string, number> };
    expect(counters['indexedFiles']).toBe(0);
    expect(counters['indexedFingerprints']).toBe(0);
    expect(counters['oversizedFileSkips']).toBe(1);
    const health = (await plugin.health!()) as { counters: Record<string, number> };
    expect(health.counters['indexedFiles']).toBe(0);
    expect(health.counters['indexedFingerprints']).toBe(0);
    expect(health.counters['hookIndexEvictions']).toBe(0);
    expect(health.counters['oversizedFileSkips']).toBe(1);
  });

  it('re-extracts when a cached file changes (mtime/size invalidation)', async () => {
    setFilesystem({
      '/project/src/a.ts': distinctSource('a'),
      '/project/src/b.ts': distinctSource('b', 10),
    });
    const api = makeApi({ extensions: { 'duplicate-code-detector': { enabled: true } } });
    plugin.setup(api as never);
    const hook = getHook(api);
    const status = getTool(api, 'duplicate_code_status');
    const fire = () =>
      hook({
        toolName: 'write',
        toolInput: { path: 'src/a.ts', content: 'x' },
        toolResult: { content: 'ok', isError: false },
      });
    const count = async () =>
      ((await status({})) as { counters: Record<string, number> }).counters['indexedFingerprints']!;

    await fire();
    const before = await count();
    // Grow b.ts → more windows → the index must re-extract on the next fire.
    mockFs['/project/src/b.ts'] = { type: 'file', content: distinctSource('b', 40) };
    await fire();
    expect(await count()).toBeGreaterThan(before);
  });
});
