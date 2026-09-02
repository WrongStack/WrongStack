import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs', () => ({
  readFileSync: vi.fn(),
}));

const { readFileSync } = await import('node:fs');
const plugin = (await import('../src/auto-i18n-extractor')).default;

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
        'auto-i18n-extractor': { enabled: true },
        ...(overrides.extensions ?? {}),
      },
    },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    metrics: { counter: vi.fn() },
    registerHook: vi.fn(() => vi.fn()),
  };
}

type HookResult = { decision?: string; reason?: string; additionalContext?: string } | undefined;

function getHook(api: MockApi): (input: unknown) => HookResult {
  const call = api.registerHook.mock.calls[0];
  if (!call) throw new Error('hook not registered');
  return (call as unknown[])[2] as (input: unknown) => HookResult;
}

function getTool(api: MockApi, name: string): (input: unknown) => Promise<unknown> {
  const call = api.tools.register.mock.calls.find((c) => (c[0] as { name: string }).name === name);
  if (!call) throw new Error(`tool ${name} not registered`);
  return (call[0] as { execute: (input: unknown) => Promise<unknown> }).execute;
}

function mockFile(content: string, exists = true) {
  vi.mocked(readFileSync).mockImplementation(((path: string) => {
    if (exists) return content;
    throw new Error(`ENOENT: ${path}`);
  }) as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(readFileSync).mockReset();
});

afterEach(async () => {
  const api = makeApi();
  await plugin.teardown?.(api as never);
});

describe('auto-i18n-extractor plugin', () => {
  it('registers two tools and a PostToolUse write|edit hook', () => {
    const api = makeApi();
    plugin.setup(api as never);
    expect(api.tools.register).toHaveBeenCalledTimes(2);
    const [event, matcher] = api.registerHook.mock.calls[0]!;
    expect(event).toBe('PostToolUse');
    expect(matcher).toBe('write|edit');
  });

  it('i18n_extract returns user-facing strings and key suggestions', async () => {
    mockFile(`export function Button() {
  return <button className="btn" testId="submit-btn" title="Click me">Submit</button>;
}`);
    const api = makeApi();
    plugin.setup(api as never);
    const extract = getTool(api, 'i18n_extract');
    const result = (await extract({ path: 'src/Button.tsx' })) as {
      ok: boolean;
      stringsFound: number;
      strings: Array<{ value: string; keySuggestion: string }>;
    };
    expect(result.ok).toBe(true);
    expect(result.stringsFound).toBe(1);
    expect(result.strings[0]?.value).toBe('Click me');
    expect(result.strings[0]?.keySuggestion).toBe('t.click_me');
  });

  it('i18n_extract filters out excluded attributes', async () => {
    mockFile(`<div className="wrapper" aria-label="Close dialog" data-testid="main" id="x">
  <span title="Save changes">Save changes</span>
</div>`);
    const api = makeApi();
    plugin.setup(api as never);
    const extract = getTool(api, 'i18n_extract');
    const result = (await extract({ path: 'src/Card.tsx' })) as {
      ok: boolean;
      stringsFound: number;
      strings: Array<{ value: string }>;
    };
    // Only the title attribute string literal is extracted; the text node is not a quoted literal.
    expect(result.stringsFound).toBe(1);
    expect(result.strings[0]?.value).toBe('Save changes');
  });

  it('i18n_extract rejects unsupported extensions', async () => {
    mockFile('');
    const api = makeApi();
    plugin.setup(api as never);
    const extract = getTool(api, 'i18n_extract');
    const result = (await extract({ path: 'README.md' })) as { ok: boolean; error: string };
    expect(result.ok).toBe(false);
    expect(result.error).toContain('unsupported extension');
  });

  it('i18n_extract rejects paths outside the project', async () => {
    mockFile('');
    const api = makeApi();
    plugin.setup(api as never);
    const extract = getTool(api, 'i18n_extract');
    const result = (await extract({ path: '../../../etc/passwd' })) as {
      ok: boolean;
      error: string;
    };
    expect(result.ok).toBe(false);
    expect(result.error).toContain('inside the project');
  });

  it('i18n_status reports counters and config', async () => {
    const api = makeApi({ extensions: { 'auto-i18n-extractor': { minLength: 3 } } });
    plugin.setup(api as never);
    const status = getTool(api, 'i18n_status');
    const result = (await status({})) as {
      ok: boolean;
      minLength: number;
      counters: Record<string, number>;
    };
    expect(result.ok).toBe(true);
    expect(result.minLength).toBe(3);
    expect(result.counters['filesScanned']).toBe(0);
  });

  it('PostToolUse hook injects additionalContext on write', async () => {
    mockFile(`export default function Greeting() {
  return <h1 title="Welcome back">Welcome back</h1>;
}`);
    const api = makeApi();
    plugin.setup(api as never);
    const hook = getHook(api);
    const result = (await hook({
      toolName: 'write',
      toolInput: { path: 'src/Greeting.tsx' },
      toolResult: { content: '', isError: false },
    })) as HookResult;
    expect(result?.additionalContext).toContain('Welcome back');
    expect(result?.additionalContext).toContain('t.welcome_back');
  });

  it('PostToolUse hook skips non-target extensions', async () => {
    mockFile('const x = "hello"');
    const api = makeApi();
    plugin.setup(api as never);
    const hook = getHook(api);
    const result = await hook({
      toolName: 'write',
      toolInput: { path: 'src/style.css' },
      toolResult: { content: '', isError: false },
    });
    expect(result).toBeUndefined();
  });

  it('PostToolUse hook skips when tool errored', async () => {
    mockFile('const x = "hello"');
    const api = makeApi();
    plugin.setup(api as never);
    const hook = getHook(api);
    const result = await hook({
      toolName: 'write',
      toolInput: { path: 'src/Page.tsx' },
      toolResult: { content: 'failed', isError: true },
    });
    expect(result).toBeUndefined();
    expect(readFileSync).not.toHaveBeenCalled();
  });

  it('PostToolUse hook skips single-character and non-text strings', async () => {
    mockFile(`const a = "x";
const b = "123";
const c = "#ff0000";
const d = "./image.png";`);
    const api = makeApi();
    plugin.setup(api as never);
    const hook = getHook(api);
    const result = await hook({
      toolName: 'edit',
      toolInput: { path: 'src/Utils.tsx' },
      toolResult: { content: '', isError: false },
    });
    expect(result).toBeUndefined();
  });

  it('enabled:false disables tool and hook', async () => {
    mockFile('const x = "hello world"');
    const api = makeApi({ extensions: { 'auto-i18n-extractor': { enabled: false } } });
    plugin.setup(api as never);
    const extract = getTool(api, 'i18n_extract');
    const result = (await extract({ path: 'src/A.tsx' })) as { ok: boolean; error: string };
    expect(result.ok).toBe(false);

    const hook = getHook(api);
    const hookResult = await hook({
      toolName: 'write',
      toolInput: { path: 'src/A.tsx' },
      toolResult: { content: '', isError: false },
    });
    expect(hookResult).toBeUndefined();
  });

  it('teardown zeros state and unregisters hook', () => {
    const api = makeApi();
    plugin.setup(api as never);
    plugin.teardown!(api as never);
    expect(api.registerHook.mock.results[0]?.value).toHaveBeenCalledTimes(1);
    expect(api.log.info).toHaveBeenCalledWith(
      'auto-i18n-extractor: teardown complete',
      expect.any(Object),
    );
  });

  it('health reflects scan state', async () => {
    mockFile(`export function Page() {
  return <p title="Hello world">Hello world</p>;
}`);
    const api = makeApi();
    plugin.setup(api as never);
    const extract = getTool(api, 'i18n_extract');
    await extract({ path: 'src/Page.tsx' });
    const health = (await plugin.health!()) as { ok: boolean; counters: Record<string, number> };
    expect(health.ok).toBe(true);
    expect(health.counters['stringsFound']).toBe(1);
  });
});
