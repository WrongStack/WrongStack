import { beforeEach, describe, expect, it, vi } from 'vitest';

const fsm = vi.hoisted(() => ({ readFileSync: vi.fn(), writeFileSync: vi.fn() }));
vi.mock('node:fs', async (o) => ({
  ...(await o()),
  readFileSync: fsm.readFileSync,
  writeFileSync: fsm.writeFileSync,
}));

import autoDocPlugin from '../src/auto-doc';

interface Tool {
  name: string;
  execute: (i: Record<string, unknown>) => Promise<Record<string, unknown>>;
}

let log: {
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
};

function setup(
  cfg: Record<string, unknown> = {},
  llm?: { complete: ReturnType<typeof vi.fn> },
): Record<string, Tool> {
  const tools: Record<string, Tool> = {};
  log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const api = {
    tools: {
      register: (t: Tool) => {
        tools[t.name] = t;
      },
    },
    config: { extensions: { 'auto-doc': cfg } },
    log,
    metrics: { counter: vi.fn(), gauge: vi.fn(), histogram: vi.fn() },
    llm,
  };
  autoDocPlugin.setup(api as never);
  return tools;
}

const SOURCE = [
  'export function foo(a: string, b: number): string {',
  '  return a + b;',
  '}',
  'const bar = (x: number): void => {',
  '};',
  'export class MyClass {}',
  'type MyType = {',
  '  a: number;',
  '};',
  'interface MyIface {',
  '  b: string;',
  '}',
  'function noargs() {',
  '}',
].join('\n');

beforeEach(() => {
  fsm.readFileSync.mockReset();
  fsm.writeFileSync.mockReset();
  fsm.readFileSync.mockReturnValue(SOURCE);
});

describe('auto_doc', () => {
  it('rejects non-array and empty files', async () => {
    const tools = setup();
    expect((await tools.auto_doc!.execute({ files: 'x' })).ok).toBe(false);
    expect((await tools.auto_doc!.execute({ files: [] })).ok).toBe(false);
  });

  it('documents all entity kinds and writes the file (tsdoc default)', async () => {
    const tools = setup();
    // force=true documents every entity (bypasses the needsDocComment skip),
    // covering the function/class/type/interface generators in one pass.
    const res = await tools.auto_doc!.execute({ files: ['a.ts'], force: true });
    expect(res.ok).toBe(true);
    expect(res.filesProcessed).toBe(1);
    const changed = (res.changes as Array<{ entity: string }>).map((c) => c.entity);
    expect(changed).toEqual(
      expect.arrayContaining(['foo', 'bar', 'MyClass', 'MyType', 'MyIface', 'noargs']),
    );
    expect(fsm.writeFileSync).toHaveBeenCalledTimes(1);
  });

  it('does not write in dry-run mode', async () => {
    const tools = setup();
    const res = await tools.auto_doc!.execute({ files: ['a.ts'], dry_run: true });
    expect(res.ok).toBe(true);
    expect((res.changes as unknown[]).length).toBeGreaterThan(0);
    expect(fsm.writeFileSync).not.toHaveBeenCalled();
  });

  it('emits jsdoc for every entity kind with includeTypes', async () => {
    const tools = setup({ includeTypes: true });
    // force documents every kind, exercising the jsdoc generator for
    // function/class/type/interface in one pass.
    const res = await tools.auto_doc!.execute({
      files: ['a.ts'],
      style: 'jsdoc',
      force: true,
      dry_run: true,
    });
    expect(res.ok).toBe(true);
    const changed = (res.changes as Array<{ entity: string }>).map((c) => c.entity);
    expect(changed).toEqual(expect.arrayContaining(['foo', 'MyType', 'MyClass', 'MyIface']));
  });

  it('skips entities that already have a doc comment unless force is set', async () => {
    fsm.readFileSync.mockReturnValue(['  /**', '  function documented() {', '  }'].join('\n'));
    const tools = setup();
    const res = await tools.auto_doc!.execute({ files: ['a.ts'], dry_run: true });
    expect((res.changes as unknown[]).length).toBe(0); // already documented → skipped

    const forced = await tools.auto_doc!.execute({ files: ['a.ts'], force: true, dry_run: true });
    expect((forced.changes as unknown[]).length).toBe(1); // force overrides
  });

  it('warns and continues when a file cannot be read', async () => {
    fsm.readFileSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });
    const tools = setup();
    const res = await tools.auto_doc!.execute({ files: ['missing.ts'] });
    expect(res.ok).toBe(true);
    expect(res.filesProcessed).toBe(1);
    expect(log.warn).toHaveBeenCalledWith(expect.stringMatching(/could not read file/));
  });

  it('logs an error when writing the file fails', async () => {
    fsm.writeFileSync.mockImplementation(() => {
      throw new Error('EACCES');
    });
    const tools = setup();
    await tools.auto_doc!.execute({ files: ['a.ts'] });
    expect(log.error).toHaveBeenCalledWith(expect.stringMatching(/error processing/));
  });

  it('emits {type} return annotations in tsdoc with includeTypes', async () => {
    const tools = setup({ includeTypes: true });
    const res = await tools.auto_doc!.execute({ files: ['a.ts'], force: true, dry_run: true });
    expect(res.ok).toBe(true);
    expect((res.changes as Array<{ entity: string }>).some((c) => c.entity === 'foo')).toBe(true);
  });

  it('handles arrow functions with no parameters', async () => {
    fsm.readFileSync.mockReturnValue('const noParams = (): void => {\n};');
    const tools = setup();
    const res = await tools.auto_doc!.execute({ files: ['a.ts'], force: true, dry_run: true });
    expect((res.changes as Array<{ entity: string }>)[0]!.entity).toBe('noParams');
  });

  it('does not write when there are no entities to document', async () => {
    fsm.readFileSync.mockReturnValue('const x = 1;\n// nothing to doc here');
    const tools = setup();
    const res = await tools.auto_doc!.execute({ files: ['a.ts'] });
    expect((res.changes as unknown[]).length).toBe(0);
    expect(fsm.writeFileSync).not.toHaveBeenCalled();
  });
});

describe('auto_doc LLM mode (api.llm)', () => {
  const llmReply = (obj: unknown) => ({
    text: JSON.stringify(obj),
    model: 'claude-haiku-4-5',
    provider: 'anthropic',
    usage: { input: 30, output: 20 },
    stopReason: 'end_turn',
  });

  it('writes LLM prose into doc comments when useLlm is on', async () => {
    fsm.readFileSync.mockReturnValue(
      'export function add(a: number, b: number): number {\n  return a + b;\n}',
    );
    const complete = vi.fn().mockResolvedValue(
      llmReply({
        summary: 'Add two numbers.',
        params: { a: 'first addend', b: 'second addend' },
        returns: 'the sum',
      }),
    );
    const tools = setup({ useLlm: true }, { complete });
    const res = await tools.auto_doc!.execute({ files: ['a.ts'], dry_run: true });
    expect(complete).toHaveBeenCalledTimes(1);
    expect(res.ok).toBe(true);
    const changes = res.changes as Array<{ entity: string; source: string }>;
    expect(changes[0]).toMatchObject({ entity: 'add', source: 'llm' });
    const written = String((res as { llm?: { docs: number } }).llm?.docs);
    expect(written).toBe('1');
  });

  it('per-call use_llm overrides the config flag', async () => {
    fsm.readFileSync.mockReturnValue('export function f(x: string): void {\n}');
    const complete = vi
      .fn()
      .mockResolvedValue(llmReply({ summary: 'Do a thing.', params: { x: 'input' }, returns: '' }));
    const tools = setup({ useLlm: false }, { complete });
    await tools.auto_doc!.execute({ files: ['a.ts'], use_llm: true, dry_run: true });
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it('falls back to the template when the LLM call fails', async () => {
    fsm.readFileSync.mockReturnValue('export function g(y: number): number {\n  return y;\n}');
    const complete = vi.fn().mockRejectedValue(new Error('provider down'));
    const tools = setup({ useLlm: true }, { complete });
    const res = await tools.auto_doc!.execute({ files: ['a.ts'], dry_run: true });
    const changes = res.changes as Array<{ entity: string; source: string }>;
    expect(changes[0]).toMatchObject({ entity: 'g', source: 'template' });
  });

  it('does not call the LLM when useLlm is off', async () => {
    const complete = vi.fn();
    const tools = setup({ useLlm: false }, { complete });
    await tools.auto_doc!.execute({ files: ['a.ts'], force: true, dry_run: true });
    expect(complete).not.toHaveBeenCalled();
  });

  it('respects maxLlmEntities cap (remaining entities use the template)', async () => {
    fsm.readFileSync.mockReturnValue(
      ['export function a(){}', 'export function b(){}', 'export function c(){}'].join('\n'),
    );
    const complete = vi.fn().mockResolvedValue(llmReply({ summary: 's', params: {}, returns: '' }));
    const tools = setup({ useLlm: true, maxLlmEntities: 2 }, { complete });
    const res = await tools.auto_doc!.execute({ files: ['a.ts'], force: true, dry_run: true });
    expect(complete).toHaveBeenCalledTimes(2);
    const sources = (res.changes as Array<{ source: string }>).map((c) => c.source);
    expect(sources.filter((s) => s === 'llm')).toHaveLength(2);
    expect(sources.filter((s) => s === 'template')).toHaveLength(1);
  });

  it('is a no-op path when useLlm is on but api.llm is absent', async () => {
    fsm.readFileSync.mockReturnValue('export function h(){}');
    const tools = setup({ useLlm: true }); // no llm wired
    const res = await tools.auto_doc!.execute({ files: ['a.ts'], force: true, dry_run: true });
    expect((res.changes as Array<{ source: string }>)[0]!.source).toBe('template');
  });
});

describe('teardown', () => {
  it('logs on unload', () => {
    setup();
    const tlog = { info: vi.fn() };
    autoDocPlugin.teardown?.({ log: tlog } as never);
    expect(tlog.info).toHaveBeenCalledWith(
      'auto-doc: teardown complete',
      expect.objectContaining({ invocations: expect.any(Number) }),
    );
  });
});
