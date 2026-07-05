import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import autoDocPlugin from '../src/auto-doc';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockApi = {
  tools: { register: vi.fn() },
  config: { extensions: {} },
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  metrics: { counter: vi.fn(), histogram: vi.fn(), gauge: vi.fn() },
};

beforeEach(() => vi.clearAllMocks());

// ── Plugin registration ────────────────────────────────────────────────────────

describe('auto-doc plugin', () => {
  it('registers only auto_doc tool (auto_doc_preview merged into dryRun)', () => {
    autoDocPlugin.setup(mockApi as any);
    const names = mockApi.tools.register.mock.calls.map(([t]: any[]) => t.name);
    expect(names).toContain('auto_doc');
    expect(names).not.toContain('auto_doc_preview');
  });

  it('auto_doc is mutating', () => {
    autoDocPlugin.setup(mockApi as any);
    const tools = Object.fromEntries(
      mockApi.tools.register.mock.calls.map(([t]: any[]) => [t.name, t]),
    );
    expect(tools['auto_doc'].mutating).toBe(true);
  });

  it('tool schema requires files array', () => {
    autoDocPlugin.setup(mockApi as any);
    const tools = Object.fromEntries(
      mockApi.tools.register.mock.calls.map(([t]: any[]) => [t.name, t]),
    );
    expect(tools['auto_doc'].inputSchema.required).toContain('files');
  });

  it('logs info on setup and teardown', () => {
    autoDocPlugin.setup(mockApi as any);
    expect(mockApi.log.info).toHaveBeenCalledWith('auto-doc plugin loaded', expect.any(Object));
    autoDocPlugin.teardown(mockApi as any);
    // H1 audit pattern: teardown now logs a single info line with a
    // structured payload (the final invocation count).
    expect(mockApi.log.info).toHaveBeenCalledWith(
      'auto-doc: teardown complete',
      expect.objectContaining({ invocations: expect.any(Number) }),
    );
  });
});

// ── Input validation ───────────────────────────────────────────────────────────

async function runAutoDocTool(input: Record<string, unknown>) {
  autoDocPlugin.setup(mockApi as any);
  const tool = mockApi.tools.register.mock.calls.find(
    ([t]: any[]) => t.name === 'auto_doc',
  )?.[0] as any;
  return tool.execute(input);
}

describe('runAutoDoc input validation', () => {
  it('rejects non-array files', async () => {
    const result = await runAutoDocTool({ files: 'not-an-array' } as any);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch('must be an array');
  });

  it('rejects empty files array', async () => {
    const result = await runAutoDocTool({ files: [] });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch('empty');
  });
});

// ── Doc generation with real temp files ────────────────────────────────────────

describe('runAutoDoc doc generation', () => {
  let tmpDir: string;
  let originalCwd: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'autodoc-'));
    process.chdir(tmpDir);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('generates TSDoc comments for exported functions', async () => {
    const filePath = path.join(tmpDir, 'sample.ts');
    await fs.writeFile(
      filePath,
      ['export function hello(name: string): string {', `  return \`Hello, \${name}\`;`, '}'].join(
        '\n',
      ),
    );

    const result = await runAutoDocTool({ files: [filePath], dry_run: true });
    expect(result.ok).toBe(true);
    expect(result.changes).toContainEqual(expect.objectContaining({ entity: 'hello' }));
  });

  it('generates TSDoc for exported const arrow functions', async () => {
    const filePath = path.join(tmpDir, 'arrow.ts');
    await fs.writeFile(filePath, 'export const add = (a: number, b: number): number => a + b;\n');

    const result = await runAutoDocTool({ files: [filePath], dry_run: true });
    expect(result.ok).toBe(true);
    expect(result.changes).toContainEqual(expect.objectContaining({ entity: 'add' }));
  });

  it('generates TSDoc for exported classes', async () => {
    const filePath = path.join(tmpDir, 'myclass.ts');
    await fs.writeFile(filePath, 'export class MyClass { }\n');

    const result = await runAutoDocTool({ files: [filePath], dry_run: true });
    expect(result.ok).toBe(true);
    expect(result.changes).toContainEqual(expect.objectContaining({ entity: 'MyClass' }));
  });

  it('generates TSDoc for exported types', async () => {
    const filePath = path.join(tmpDir, 'types.ts');
    await fs.writeFile(filePath, 'export type Foo = { bar: string };\n');

    const result = await runAutoDocTool({ files: [filePath], dry_run: true });
    expect(result.ok).toBe(true);
    expect(result.changes).toContainEqual(expect.objectContaining({ entity: 'Foo' }));
  });

  it('actually writes doc comments when not dry-run', async () => {
    const filePath = path.join(tmpDir, 'write.ts');
    await fs.writeFile(filePath, 'export function greet(msg: string): void { }\n');

    const result = await runAutoDocTool({ files: [filePath], dryRun: false });
    expect(result.ok).toBe(true);

    const content = await fs.readFile(filePath, 'utf-8');
    expect(content).toContain('/**');
    expect(content).toContain('TODO:');
    expect(content).toContain('greet');
  });

  it('respects --style jsdoc', async () => {
    const filePath = path.join(tmpDir, 'jsdoc.ts');
    await fs.writeFile(filePath, 'export function foo(): void { }\n');

    const result = await runAutoDocTool({ files: [filePath], style: 'jsdoc', dry_run: true });
    expect(result.ok).toBe(true);
    expect(result.changes).toContainEqual(expect.objectContaining({ entity: 'foo' }));
  });

  it('logs warning for unreadable files', async () => {
    const result = await runAutoDocTool({ files: ['/nonexistent/file.ts'], dry_run: true });
    expect(result.ok).toBe(true);
    expect(mockApi.log.warn).toHaveBeenCalled();
  });

  it('skips files outside the project directory', async () => {
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'autodoc-out-'));
    const outsideFile = path.join(outsideDir, 'outside.ts');
    await fs.writeFile(outsideFile, 'export function skip(): void {}\n');
    try {
      const result = await runAutoDocTool({ files: [outsideFile], dry_run: true });
      expect(result.ok).toBe(true);
      expect(result.changes).toEqual([]);
      expect(mockApi.log.warn).toHaveBeenCalledWith(
        expect.stringContaining('skipped file outside project directory'),
      );
      // Source must remain untouched.
      expect(await fs.readFile(outsideFile, 'utf-8')).not.toContain('/**');
    } finally {
      await fs.rm(outsideDir, { recursive: true, force: true });
    }
  });
});
