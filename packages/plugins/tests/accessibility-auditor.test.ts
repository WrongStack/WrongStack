import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const accessibilityAuditorPlugin = (await import('../src/accessibility-auditor')).default;

interface MockApi {
  tools: { register: ReturnType<typeof vi.fn> };
  config: { extensions: Record<string, unknown> };
  log: {
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };
  metrics: {
    counter: ReturnType<typeof vi.fn>;
  };
  registerHook: ReturnType<typeof vi.fn>;
}

function makeApi(overrides: { extensions?: Record<string, unknown> } = {}): MockApi {
  return {
    tools: { register: vi.fn() },
    config: {
      extensions: {
        'accessibility-auditor': { enabled: true },
        ...(overrides.extensions ?? {}),
      },
    },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    metrics: { counter: vi.fn() },
    registerHook: vi.fn(() => vi.fn()),
  };
}

function getTool(api: MockApi, name: string): (input: unknown) => Promise<unknown> {
  const call = api.tools.register.mock.calls.find((c) => (c[0] as { name: string }).name === name);
  if (!call) throw new Error(`tool ${name} not registered`);
  return (call[0] as { execute: (input: unknown) => Promise<unknown> }).execute;
}

type HookResult = { decision?: string; reason?: string; additionalContext?: string } | undefined;

function getHook(api: MockApi): (input: unknown) => HookResult {
  const call = api.registerHook.mock.calls[0];
  if (!call) throw new Error('hook not registered');
  return (call as unknown[])[2] as (input: unknown) => HookResult;
}

const FIXTURE_DIR = resolve(process.cwd(), '.temp_files/accessibility-auditor-tests');

function writeFixture(name: string, content: string) {
  const p = resolve(FIXTURE_DIR, name);
  writeFileSync(p, content, 'utf-8');
  return p;
}

beforeEach(() => {
  vi.clearAllMocks();
  try {
    rmSync(FIXTURE_DIR, { recursive: true, force: true });
  } catch {
    // ignore
  }
  mkdirSync(FIXTURE_DIR, { recursive: true });
});

afterEach(async () => {
  const api = makeApi();
  await accessibilityAuditorPlugin.teardown?.(api as never);
  try {
    rmSync(FIXTURE_DIR, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

describe('accessibility-auditor plugin', () => {
  it('registers a11y_audit, a11y_status and a PostToolUse write|edit hook', async () => {
    const api = makeApi();
    accessibilityAuditorPlugin.setup(api as never);
    expect(api.tools.register).toHaveBeenCalledTimes(2);
    const names = api.tools.register.mock.calls.map((c) => (c[0] as { name: string }).name);
    expect(names).toContain('a11y_audit');
    expect(names).toContain('a11y_status');
    const [event, matcher] = api.registerHook.mock.calls[0]!;
    expect(event).toBe('PostToolUse');
    expect(matcher).toBe('write|edit');
  });

  it('a11y_audit reports missing alt on images', async () => {
    writeFixture('MissingAlt.tsx', '<div><img src="/a.png" /></div>\n');
    const api = makeApi();
    accessibilityAuditorPlugin.setup(api as never);
    const audit = getTool(api, 'a11y_audit');
    const result = (await audit({ path: FIXTURE_DIR })) as {
      ok: boolean;
      findings: Array<{ rule: string; message: string }>;
    };
    expect(result.ok).toBe(true);
    expect(result.findings.some((f) => f.rule === 'missing-alt')).toBe(true);
  });

  it('a11y_audit reports missing input labels and placeholder warnings', async () => {
    writeFixture('MissingLabel.tsx', '<input type="text" placeholder="Name" />\n');
    const api = makeApi();
    accessibilityAuditorPlugin.setup(api as never);
    const audit = getTool(api, 'a11y_audit');
    const result = (await audit({ path: FIXTURE_DIR })) as {
      ok: boolean;
      findings: Array<{ rule: string }>;
    };
    expect(result.ok).toBe(true);
    expect(result.findings.some((f) => f.rule === 'missing-input-label')).toBe(true);
    expect(result.findings.some((f) => f.rule === 'low-contrast-placeholder')).toBe(true);
  });

  it('a11y_audit recognizes a label associated by for/id', async () => {
    writeFixture(
      'LabeledInput.tsx',
      '<label for="name">Name</label><input id="name" type="text" />\n',
    );
    const api = makeApi();
    accessibilityAuditorPlugin.setup(api as never);
    const audit = getTool(api, 'a11y_audit');
    const result = (await audit({ path: FIXTURE_DIR })) as {
      ok: boolean;
      findings: Array<{ rule: string }>;
    };
    expect(result.ok).toBe(true);
    expect(result.findings.some((f) => f.rule === 'missing-input-label')).toBe(false);
  });

  it('a11y_audit reports missing button text', async () => {
    writeFixture('EmptyButton.tsx', '<button></button>\n<input type="submit" />\n');
    const api = makeApi();
    accessibilityAuditorPlugin.setup(api as never);
    const audit = getTool(api, 'a11y_audit');
    const result = (await audit({ path: FIXTURE_DIR })) as {
      ok: boolean;
      findings: Array<{ rule: string }>;
    };
    expect(result.ok).toBe(true);
    expect(result.findings.filter((f) => f.rule === 'missing-button-text').length).toBe(2);
  });

  it('a11y_audit reports duplicate ids', async () => {
    writeFixture('DuplicateIds.tsx', '<div id="x"></div>\n<span id="x"></span>\n');
    const api = makeApi();
    accessibilityAuditorPlugin.setup(api as never);
    const audit = getTool(api, 'a11y_audit');
    const result = (await audit({ path: FIXTURE_DIR })) as {
      ok: boolean;
      findings: Array<{ rule: string }>;
    };
    expect(result.ok).toBe(true);
    expect(result.findings.some((f) => f.rule === 'duplicate-id')).toBe(true);
  });

  it('a11y_audit skips non-UI files', async () => {
    writeFixture('ignored.md', '<img src="/a.png" />\n');
    const api = makeApi();
    accessibilityAuditorPlugin.setup(api as never);
    const audit = getTool(api, 'a11y_audit');
    const result = (await audit({ path: FIXTURE_DIR })) as {
      ok: boolean;
      fileCount: number;
      findings: unknown[];
    };
    expect(result.ok).toBe(true);
    expect(result.fileCount).toBe(0);
    expect(result.findings).toHaveLength(0);
  });

  it('a11y_audit rejects paths outside the project', async () => {
    const api = makeApi();
    accessibilityAuditorPlugin.setup(api as never);
    const audit = getTool(api, 'a11y_audit');
    const result = (await audit({ path: '../../outside' })) as { ok: boolean; error: string };
    expect(result.ok).toBe(false);
    expect(result.error).toContain('inside the project');
  });

  it('a11y_status reports counters', async () => {
    writeFixture('MissingAlt2.tsx', '<img src="/b.png" />\n');
    const api = makeApi();
    accessibilityAuditorPlugin.setup(api as never);
    const audit = getTool(api, 'a11y_audit');
    const status = getTool(api, 'a11y_status');
    await audit({ path: FIXTURE_DIR });
    const result = (await status({})) as {
      ok: boolean;
      counters: { audits: number; findings: number };
    };
    expect(result.ok).toBe(true);
    expect(result.counters.audits).toBe(1);
    expect(result.counters.findings).toBeGreaterThan(0);
  });

  it('PostToolUse hook injects additionalContext for UI file writes', async () => {
    writeFixture('HookTarget.tsx', '<img src="/c.png" />\n');
    const api = makeApi();
    accessibilityAuditorPlugin.setup(api as never);
    const hook = getHook(api);
    const result = (await hook({
      toolName: 'write',
      toolInput: { path: resolve(FIXTURE_DIR, 'HookTarget.tsx') },
      toolResult: { content: '', isError: false },
    })) as HookResult;
    expect(result?.additionalContext).toContain('missing-alt');
  });

  it('PostToolUse hook skips non-UI files', async () => {
    const api = makeApi();
    accessibilityAuditorPlugin.setup(api as never);
    const hook = getHook(api);
    const result = (await hook({
      toolName: 'write',
      toolInput: { path: 'README.md' },
      toolResult: { content: '', isError: false },
    })) as HookResult;
    expect(result).toBeUndefined();
  });

  it('PostToolUse hook skips errored tool results', async () => {
    const api = makeApi();
    accessibilityAuditorPlugin.setup(api as never);
    const hook = getHook(api);
    const result = (await hook({
      toolName: 'write',
      toolInput: { path: 'src/App.tsx' },
      toolResult: { content: 'error', isError: true },
    })) as HookResult;
    expect(result).toBeUndefined();
  });

  it('treats aria-describedby-only inputs as supplementary, not labeled (issue #369)', async () => {
    writeFixture('Described.tsx', '<input type="text" aria-describedby="desc-id" />\n');
    const api = makeApi();
    accessibilityAuditorPlugin.setup(api as never);
    const result = (await getTool(api, 'a11y_audit')({ path: FIXTURE_DIR })) as {
      findings: Array<{ rule: string }>;
    };
    expect(result.findings.some((f) => f.rule === 'missing-input-label')).toBe(false);
    expect(result.findings.some((f) => f.rule === 'low-contrast-placeholder')).toBe(true);
  });

  it('does not flag decorative img alt="" with role=presentation', async () => {
    writeFixture('Deco.tsx', '<img alt="" role="presentation" src="/dot.png" />\n');
    const api = makeApi();
    accessibilityAuditorPlugin.setup(api as never);
    const result = (await getTool(api, 'a11y_audit')({ path: FIXTURE_DIR })) as {
      findings: Array<{ rule: string }>;
    };
    expect(result.findings.some((f) => f.rule === 'missing-alt')).toBe(false);
  });

  it('notes the single-file limitation when a sibling label file is invisible', async () => {
    writeFixture('Input.tsx', '<input type="email" />\n');
    writeFixture('Label.tsx', '<label htmlFor="email">Email</label>\n');
    const api = makeApi();
    accessibilityAuditorPlugin.setup(api as never);
    const result = (await getTool(
      api,
      'a11y_audit',
    )({
      path: resolve(FIXTURE_DIR, 'Input.tsx'),
    })) as { findings: Array<{ rule: string; note?: string }> };
    const missing = result.findings.find((f) => f.rule === 'missing-input-label');
    expect(missing?.note).toMatch(/sibling/i);
  });

  it('recognizes checkbox + fieldset/legend via aria-labelledby', async () => {
    writeFixture(
      'Group.tsx',
      '<fieldset><legend id="group-id">Opts</legend><input type="checkbox" aria-labelledby="group-id" /></fieldset>\n',
    );
    const api = makeApi();
    accessibilityAuditorPlugin.setup(api as never);
    const result = (await getTool(api, 'a11y_audit')({ path: FIXTURE_DIR })) as {
      findings: Array<{ rule: string }>;
    };
    expect(result.findings.some((f) => f.rule === 'missing-input-label')).toBe(false);
  });

  it('does not flag a button with aria-label and a single-character glyph', async () => {
    writeFixture('Close.tsx', '<button aria-label="Close">×</button>\n');
    const api = makeApi();
    accessibilityAuditorPlugin.setup(api as never);
    const result = (await getTool(api, 'a11y_audit')({ path: FIXTURE_DIR })) as {
      findings: Array<{ rule: string }>;
    };
    expect(result.findings.some((f) => f.rule === 'missing-button-text')).toBe(false);
  });

  it('emits a partial-scan warning when maxFindings stops a directory walk', async () => {
    const dir = resolve(FIXTURE_DIR, 'many');
    mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 12; i++) {
      writeFileSync(resolve(dir, `f${i}.tsx`), `<img src="/${i}.png" />\n`, 'utf-8');
    }
    const api = makeApi({
      extensions: { 'accessibility-auditor': { enabled: true, maxFindings: 5 } },
    });
    accessibilityAuditorPlugin.setup(api as never);
    const result = (await getTool(api, 'a11y_audit')({ path: dir })) as {
      truncated: boolean;
      fileCount: number;
      scannedFiles: number;
      additionalContext?: string;
    };
    expect(result.truncated).toBe(true);
    expect(result.fileCount).toBe(12);
    expect(result.scannedFiles).toBeLessThan(12);
    expect(result.additionalContext).toMatch(/partial scan/i);
    expect(result.additionalContext).toMatch(/files not examined/i);
  });

  it('enabled:false disables tools', async () => {
    const api = makeApi({ extensions: { 'accessibility-auditor': { enabled: false } } });
    accessibilityAuditorPlugin.setup(api as never);
    const audit = getTool(api, 'a11y_audit');
    const result = (await audit({ path: FIXTURE_DIR })) as { ok: boolean; error: string };
    expect(result.ok).toBe(false);
    expect(result.error).toContain('disabled');
  });

  it('severity:block returns a block decision', async () => {
    writeFixture('BlockTarget.tsx', '<img src="/d.png" />\n');
    const api = makeApi({ extensions: { 'accessibility-auditor': { severity: 'block' } } });
    accessibilityAuditorPlugin.setup(api as never);
    const hook = getHook(api);
    const result = (await hook({
      toolName: 'edit',
      toolInput: { path: resolve(FIXTURE_DIR, 'BlockTarget.tsx') },
      toolResult: { content: '', isError: false },
    })) as HookResult;
    expect(result?.decision).toBe('block');
  });

  it('teardown zeros state and logs', async () => {
    const api = makeApi();
    accessibilityAuditorPlugin.setup(api as never);
    accessibilityAuditorPlugin.teardown!(api as never);
    const health = (await accessibilityAuditorPlugin.health!()) as {
      counters: Record<string, number>;
    };
    expect(health.counters['audits']).toBe(0);
    expect(api.log.info).toHaveBeenCalledWith(
      'accessibility-auditor: teardown complete',
      expect.any(Object),
    );
  });
});
