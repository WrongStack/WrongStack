/**
 * Batch 4 supplementary tests — targeting uncovered functions, branches,
 * and lifecycle edge cases across:
 * - factories
 * - plugin-stack-observer
 * - session-recap
 * - knowledge-graph
 * - config-validator
 * - type-gate
 * - notify-hub
 * - process-guard
 * - agent-handoff
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => vi.clearAllMocks());

function makeApi(extra: Record<string, unknown> = {}) {
  const registeredTools = new Map<
    string,
    { name: string; execute: (input: unknown) => Promise<unknown> }
  >();
  const registeredHooks: Array<{
    hookName: string;
    matcher?: string;
    fn: (...args: unknown[]) => unknown;
  }> = [];

  const api = {
    tools: {
      register: vi.fn((tool: { name: string; execute: (input: unknown) => Promise<unknown> }) => {
        registeredTools.set(tool.name, tool);
      }),
      unregister: vi.fn((name: string) => {
        registeredTools.delete(name);
      }),
      get: (name: string) => registeredTools.get(name)?.execute,
    },
    config: { extensions: {} as Record<string, unknown> },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    metrics: { counter: vi.fn(), histogram: vi.fn(), gauge: vi.fn() },
    registerHook: vi.fn(
      (hookName: string, matcher: string | undefined, fn: (...args: unknown[]) => unknown) => {
        registeredHooks.push({ hookName, matcher, fn });
        return vi.fn();
      },
    ),
    onEvent: vi.fn(() => vi.fn()),
    onPattern: vi.fn(() => vi.fn()),
    registerSystemPromptContributor: vi.fn(() => vi.fn()),
    emitCustom: vi.fn(),
    session: { append: vi.fn().mockResolvedValue(undefined) },
    llm: undefined as unknown,
    mailbox: undefined as unknown,
    notifier: {
      registerChannel: vi.fn(),
      unregisterChannel: vi.fn(),
      send: vi.fn().mockResolvedValue({ ok: true }),
    },
    extensions: { register: vi.fn(() => vi.fn()) },
    slashCommands: { register: vi.fn() },
    onConfigChange: vi.fn(() => vi.fn()),
    getHook: (hookName: string) => registeredHooks.find((h) => h.hookName === hookName)?.fn,
    ...extra,
  };
  return api;
}

// ---------------------------------------------------------------------------
// 1. factories
// ---------------------------------------------------------------------------
describe('factories/index.ts', () => {
  it('OFFICIAL_PLUGIN_FACTORIES can be invoked and loads plugins', async () => {
    const { OFFICIAL_PLUGIN_FACTORIES, OFFICIAL_PLUGIN_SPECIFIERS } = await import(
      '../src/factories/index.js'
    );
    expect(OFFICIAL_PLUGIN_FACTORIES.length).toBe(OFFICIAL_PLUGIN_SPECIFIERS.length);
    expect(OFFICIAL_PLUGIN_FACTORIES.length).toBeGreaterThan(0);
    // Invoke a couple factories to cover line 74
    const plugin0 = await OFFICIAL_PLUGIN_FACTORIES[0]!();
    expect(plugin0).toBeDefined();
    expect(plugin0.name).toBe('agent-handoff');
    const plugin1 = await OFFICIAL_PLUGIN_FACTORIES[1]!();
    expect(plugin1).toBeDefined();
    expect(plugin1.name).toBe('cost-tracker');
  });
});

// ---------------------------------------------------------------------------
// 2. plugin-stack-observer
// ---------------------------------------------------------------------------
describe('plugin-stack-observer', () => {
  it('handles full lifecycle: loaded events, prompt contribution, status tool, health, teardown', async () => {
    const plugin = (await import('../src/plugin-stack-observer/index.js')).default;
    let patternCb: ((eventName: string, payload: unknown) => void) | null = null;
    let promptCb: (() => Promise<unknown[]>) | null = null;

    const api = makeApi({
      config: {
        extensions: {
          'plugin-stack-observer': {
            enabled: true,
            injectIntoSystemPrompt: true,
          },
        },
      },
      onPattern: vi.fn((pattern: string, cb: (eventName: string, payload: unknown) => void) => {
        if (pattern === 'provider.wrap:loaded') patternCb = cb;
        return vi.fn();
      }),
      registerSystemPromptContributor: vi.fn((cb: () => Promise<unknown[]>) => {
        promptCb = cb;
        return vi.fn();
      }),
    });

    plugin.setup(api as never);
    expect(patternCb).not.toBeNull();
    expect(promptCb).not.toBeNull();

    // Contributor with 0 wraps returns empty
    const emptyPrompt = await promptCb!();
    expect(emptyPrompt).toEqual([]);

    // Trigger pattern with invalid payload
    patternCb!('provider.wrap:loaded', null);
    patternCb!('provider.wrap:loaded', { plugin: '' });

    // Trigger pattern with valid payload
    patternCb!('provider.wrap:loaded', {
      plugin: 'llm-cache',
      kind: 'cache',
      wraps: ['complete'],
    });

    // Duplicate plugin should update existing
    patternCb!('provider.wrap:loaded', {
      plugin: 'llm-cache',
      kind: 'cache-v2',
      wraps: ['complete', 'stream'],
    });

    // Add another wrap
    patternCb!('provider.wrap:loaded', {
      plugin: 'prompt-firewall',
      kind: 'guard',
      wraps: 'not-array', // non-array wraps branch
    });

    // Contributor with >0 wraps returns TextBlock
    const populatedPrompt = (await promptCb!()) as Array<{ type: string; text: string }>;
    expect(populatedPrompt.length).toBe(1);
    expect(populatedPrompt[0]!.text).toContain('llm-cache');
    expect(populatedPrompt[0]!.text).toContain('prompt-firewall');

    // Status tool
    const statusTool = api.tools.get('plugin_stack_status');
    expect(statusTool).toBeDefined();
    const status = (await statusTool!({})) as Record<string, unknown>;
    expect(status.ok).toBe(true);
    expect(status.wrapCount).toBe(2);

    // Health
    const health = (await plugin.health!()) as { ok: boolean; message: string; wrapCount: number };
    expect(health.ok).toBe(true);
    expect(health.wrapCount).toBe(2);
    expect(health.message).toContain('llm-cache');

    // Teardown
    plugin.teardown!(api as never);

    // Health after teardown
    const healthAfter = (await plugin.health!()) as { ok: boolean; message: string };
    expect(healthAfter.message).toContain('no wraps active');

    // Setup with enabled=false
    const apiDisabled = makeApi({
      config: {
        extensions: {
          'plugin-stack-observer': { enabled: false },
        },
      },
    });
    plugin.setup(apiDisabled as never);
    expect(apiDisabled.log.info).toHaveBeenCalledWith('plugin-stack-observer loaded (disabled)');
  });
});

// ---------------------------------------------------------------------------
// 3. session-recap
// ---------------------------------------------------------------------------
describe('session-recap', () => {
  const tempDir = join(tmpdir(), `session-recap-test-${Date.now()}`);

  beforeEach(() => {
    if (!existsSync(tempDir)) mkdirSync(tempDir, { recursive: true });
  });

  afterAll(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it('accumulates metrics, calls stop hook with transcript tail & AI summary, handles errors', async () => {
    const plugin = (await import('../src/session-recap/index.js')).default;

    // Create a mock transcript file
    const transcriptFile = join(tempDir, 'transcript.jsonl');
    const events = [
      JSON.stringify({
        type: 'user',
        role: 'user',
        content: 'hello world',
        ts: '2026-01-01T00:00:00Z',
      }),
      JSON.stringify({
        type: 'assistant',
        role: 'assistant',
        content: 'response text',
        ts: '2026-01-01T00:00:01Z',
      }),
      'invalid json line here',
      JSON.stringify({ type: 'stop', role: 'system', content: 'done', ts: '2026-01-01T00:00:02Z' }),
    ];
    writeFileSync(transcriptFile, events.join('\n') + '\n', 'utf-8');

    const eventHandlers: Record<string, (payload: unknown) => void> = {};
    const patternHandlers: Record<string, (event: string, payload: unknown) => void> = {};

    const mailboxMock = {
      send: vi.fn().mockResolvedValue({ id: 'msg-123' }),
    };

    const llmMock = {
      complete: vi
        .fn()
        .mockResolvedValue({ text: 'The agent accomplished all tasks successfully.' }),
    };

    const api = makeApi({
      mailbox: mailboxMock,
      llm: llmMock,
      config: {
        extensions: {
          'session-recap': {
            enabled: true,
            aiSummary: true,
            includeTranscriptTail: 3,
            maxBodyChars: 1000,
          },
        },
      },
      session: {
        transcriptPath: transcriptFile,
        append: vi.fn(),
      },
      onEvent: vi.fn((event: string, cb: (payload: unknown) => void) => {
        eventHandlers[event] = cb;
        return vi.fn();
      }),
      onPattern: vi.fn((pattern: string, cb: (event: string, payload: unknown) => void) => {
        patternHandlers[pattern] = cb;
        return vi.fn();
      }),
    });

    plugin.setup(api as never);

    // Fire usage events
    const usageHandler = eventHandlers['provider.response'];
    expect(usageHandler).toBeDefined();
    usageHandler!({
      model: 'gemini-pro',
      usage: { input: 100, output: 50 },
    });
    usageHandler!({
      model: 'gemini-pro',
      usage: { inputTokens: 50, outputTokens: 25 },
    });
    usageHandler!({
      model: 'claude-3',
      usage: { promptTokens: 200, completionTokens: 100 },
    });
    usageHandler!({
      model: 'claude-3',
      usage: { prompt_tokens: 150, completion_tokens: 75 },
    });

    // Fire tool events
    const toolPattern = patternHandlers['tool.*'];
    expect(toolPattern).toBeDefined();
    toolPattern!('tool.started', { tool: 'git_autocommit' });
    toolPattern!('tool.started', { name: 'read_file' });

    const resultPattern = patternHandlers['tool.result'];
    expect(resultPattern).toBeDefined();
    resultPattern!('tool.result', { tool: 'git_autocommit', isError: false });

    // Status tool
    const statusTool = api.tools.get('session_recap_status');
    expect(statusTool).toBeDefined();
    const status = (await statusTool!({})) as Record<string, unknown>;
    expect(status.ok).toBe(true);
    expect(status.mailboxAvailable).toBe(true);
    expect(status.aiSummary).toBe(true);

    // Health
    const health = (await plugin.health!()) as { ok: boolean; message: string };
    expect(health.ok).toBe(true);

    // Stop hook execution
    const stopHook = api.getHook('Stop');
    expect(stopHook).toBeDefined();
    await stopHook!({ cwd: '/test', sessionId: 'sess-1' });

    expect(mailboxMock.send).toHaveBeenCalledTimes(1);
    expect(llmMock.complete).toHaveBeenCalledTimes(1);

    // Stop hook with failing mailbox
    mailboxMock.send.mockRejectedValueOnce(new Error('Network offline'));
    await stopHook!({ cwd: '/test', sessionId: 'sess-2' });

    // Stop hook with failing LLM
    llmMock.complete.mockRejectedValueOnce(new Error('Rate limited'));
    await stopHook!({ cwd: '/test', sessionId: 'sess-3' });

    // Teardown
    plugin.teardown!(api as never);

    // Setup with no mailbox (skips recap)
    const apiNoMailbox = makeApi({
      config: { extensions: { 'session-recap': { enabled: true } } },
    });
    plugin.setup(apiNoMailbox as never);
    const stopHookNoMailbox = apiNoMailbox.getHook('Stop');
    await stopHookNoMailbox!({});
    expect(apiNoMailbox.log.warn).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 4. knowledge-graph
// ---------------------------------------------------------------------------
describe('knowledge-graph', () => {
  it('covers facts management, querying, contributor, remove, status, health, teardown', async () => {
    const plugin = (await import('../src/knowledge-graph/index.js')).default;
    let promptCb: (() => Promise<unknown[]>) | null = null;

    const api = makeApi({
      config: {
        extensions: {
          'knowledge-graph': {
            enabled: true,
            filePath: '',
            contributeToSystemPrompt: true,
          },
        },
      },
      registerSystemPromptContributor: vi.fn((cb: () => Promise<unknown[]>) => {
        promptCb = cb;
        return vi.fn();
      }),
    });

    plugin.teardown!(api as never);
    plugin.setup(api as never);

    // Empty contributor returns []
    expect(promptCb).not.toBeNull();
    expect(await promptCb!()).toEqual([]);

    const addTool = api.tools.get('kg_add_fact')!;
    const queryTool = api.tools.get('kg_query')!;
    const removeTool = api.tools.get('kg_remove_fact')!;
    const statusTool = api.tools.get('kg_status')!;

    // Add facts
    const add1 = (await addTool({
      subject: 'api-service',
      relation: 'depends_on',
      object: 'postgres-db',
      confidence: 'high',
      source: 'docker-compose.yml',
    })) as Record<string, unknown>;
    expect(add1.ok).toBe(true);

    const add2 = (await addTool({
      subject: 'web-frontend',
      relation: 'calls',
      object: 'api-service',
      confidence: 'low',
    })) as Record<string, unknown>;
    expect(add2.ok).toBe(true);

    // Contributor now returns text block
    const promptContrib = (await promptCb!()) as Array<{ type: string; text: string }>;
    expect(promptContrib.length).toBe(1);
    expect(promptContrib[0]!.text).toContain('api-service');

    // Query with various filters
    const q1 = (await queryTool({ query: 'postgres' })) as { returned: number };
    expect(q1.returned).toBe(1);

    const q2 = (await queryTool({ subject: 'web-frontend', confidence: 'low' })) as {
      returned: number;
    };
    expect(q2.returned).toBe(1);

    const q3 = (await queryTool({ relation: 'depends_on', object: 'postgres-db' })) as {
      returned: number;
    };
    expect(q3.returned).toBe(1);

    const q4 = (await queryTool({ limit: 1 })) as { returned: number };
    expect(q4.returned).toBe(1);

    // Remove fact
    const remNotFound = (await removeTool({ id: 'kg-999' })) as { ok: boolean };
    expect(remNotFound.ok).toBe(false);

    const remOk = (await removeTool({ id: '1' })) as { ok: boolean; removed: number };
    expect(remOk.ok).toBe(true);
    expect(remOk.removed).toBe(1);

    // Status
    const status = (await statusTool({})) as Record<string, unknown>;
    expect(status.ok).toBe(true);
    expect(status.totalFacts).toBe(1);

    // Health
    const health = (await plugin.health!()) as { ok: boolean; message: string };
    expect(health.ok).toBe(true);

    // Teardown
    plugin.teardown!(api as never);

    // Setup disabled
    const apiDisabled = makeApi({
      config: { extensions: { 'knowledge-graph': { enabled: false } } },
    });
    plugin.setup(apiDisabled as never);
    const addDisabled = (await apiDisabled.tools.get('kg_add_fact')!({})) as {
      ok: boolean;
      error: string;
    };
    expect(addDisabled.ok).toBe(false);
    expect(addDisabled.error).toContain('disabled');
    const queryDisabled = (await apiDisabled.tools.get('kg_query')!({})) as {
      ok: boolean;
      error: string;
    };
    expect(queryDisabled.ok).toBe(false);
    const removeDisabled = (await apiDisabled.tools.get('kg_remove_fact')!({ id: '1' })) as {
      ok: boolean;
      error: string;
    };
    expect(removeDisabled.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 5. config-validator
// ---------------------------------------------------------------------------
describe('config-validator', () => {
  it('covers validateJson, validateYaml, validateToml, validateFile, and hook execution', async () => {
    const {
      validateJson,
      validateYaml,
      validateToml,
      validateFile,
      default: plugin,
    } = await import('../src/config-validator/index.js');

    // validateJson package.json checks
    const badPkg = JSON.stringify({
      version: 123,
      dependencies: 'not-an-object',
      devDependencies: null,
    });
    const pkgProblems = validateJson(badPkg, false, 'package.json');
    expect(pkgProblems.length).toBeGreaterThanOrEqual(3);
    expect(pkgProblems.some((p) => p.includes('"name" is missing'))).toBe(true);
    expect(pkgProblems.some((p) => p.includes('"version" is not a string'))).toBe(true);
    expect(pkgProblems.some((p) => p.includes('must be an object'))).toBe(true);

    // validateJson parse errors
    const parseError = validateJson('{ bad: 1 }', false, 'config.json');
    expect(parseError.length).toBe(1);
    expect(parseError[0]).toContain('JSON parse error');

    // validateJsonc comments stripping
    const jsoncText = `{\n  // line comment\n  /* block comment */\n  "key": "value",\n}`;
    const jsoncProblems = validateJson(jsoncText, true, 'config.jsonc');
    expect(jsoncProblems).toEqual([]);

    // validateYaml tabs, separator, duplicates, quotes
    const yamlWithTabs = 'root:\n\tchild: 1';
    expect(validateYaml(yamlWithTabs).some((p) => p.includes('tab character'))).toBe(true);

    const yamlWithDupes = `
---
a: 1
a: 2
- item1
- item2
str: "unclosed string
`;
    const yamlProblems = validateYaml(yamlWithDupes);
    expect(yamlProblems.some((p) => p.includes('duplicate key'))).toBe(true);
    expect(yamlProblems.some((p) => p.includes('unclosed double quote'))).toBe(true);

    // validateToml duplicate table and keys
    const tomlText = `
[table]
key = 1
key = 2
[table]
other = 3
[[array_table]]
key = "a"
[[array_table]]
key = "b"
`;
    const tomlProblems = validateToml(tomlText);
    expect(tomlProblems.some((p) => p.includes('duplicate key'))).toBe(true);
    expect(tomlProblems.some((p) => p.includes('duplicate table'))).toBe(true);

    // validateFile unknown extension
    expect(validateFile('unknown.txt', 'hello')).toEqual([]);

    // Hook execution
    const api = makeApi();
    plugin.setup(api as never);

    const hook = api.getHook('PostToolUse');
    expect(hook).toBeDefined();

    // Hook returns undefined when toolResult is error
    expect(hook!({ toolResult: { isError: true } })).toBeUndefined();

    // Hook returns undefined when no path
    expect(hook!({ toolInput: {} })).toBeUndefined();

    // Status tool
    const statusTool = api.tools.get('config_validator_status')!;
    const status = (await statusTool({})) as Record<string, unknown>;
    expect(status.ok).toBe(true);

    // Health
    const health = (await plugin.health!()) as { ok: boolean };
    expect(health.ok).toBe(true);

    // Teardown
    plugin.teardown!(api as never);
  });
});

// ---------------------------------------------------------------------------
// 6. type-gate
// ---------------------------------------------------------------------------
describe('type-gate', () => {
  it('covers status, health variations, PostToolUse branches, teardown', async () => {
    const plugin = (await import('../src/type-gate/index.js')).default;
    const api = makeApi({
      config: {
        extensions: {
          'type-gate': {
            enabled: true,
            failSeverity: 'block',
          },
        },
      },
    });

    plugin.setup(api as never);

    const hook = api.getHook('PostToolUse');
    expect(hook).toBeDefined();

    // Skip if toolResult errored
    expect(await hook!({ toolResult: { isError: true } })).toBeUndefined();

    // Skip if no path
    expect(await hook!({ toolInput: {} })).toBeUndefined();

    // Skip if not source extension
    expect(await hook!({ toolInput: { path: 'style.css' } })).toBeUndefined();

    // Status tool
    const statusTool = api.tools.get('type_gate_status')!;
    const status = (await statusTool({})) as Record<string, unknown>;
    expect(status.ok).toBe(true);
    expect(status.failSeverity).toBe('block');

    // Health
    const healthNull = (await plugin.health!()) as { ok: boolean; message: string };
    expect(healthNull.ok).toBe(true);
    expect(healthNull.message).toContain('invocation(s)');

    // Teardown
    plugin.teardown!(api as never);
  });
});

// ---------------------------------------------------------------------------
// 7. notify-hub
// ---------------------------------------------------------------------------
describe('notify-hub', () => {
  it('covers notify_send tool, notify_hub_status, health, teardown', async () => {
    const plugin = (await import('../src/notify-hub/index.js')).default;
    const api = makeApi({
      config: {
        extensions: {
          'notify-hub': {
            enabled: true,
            webhookUrl: 'https://example.com/webhook',
          },
        },
      },
    });

    await plugin.setup(api as never);

    const sendTool = api.tools.get('notify_send')!;
    const statusTool = api.tools.get('notify_hub_status')!;

    // Send notification
    const res1 = (await sendTool({
      title: 'Build finished',
      message: 'All tests passed',
      level: 'critical',
    })) as Record<string, unknown>;
    expect(res1).toHaveProperty('circuitOpen');

    // Status
    const status = (await statusTool({})) as Record<string, unknown>;
    expect(status.ok).toBe(true);
    expect(status.webhookConfigured).toBe(true);

    // Health
    const health = (await plugin.health!()) as { ok: boolean };
    expect(health.ok).toBe(true);

    // Teardown
    plugin.teardown!(api as never);

    // Health when idle (no channel)
    const healthIdle = (await plugin.health!()) as { ok: boolean; message: string };
    expect(healthIdle.message).toContain('idle');
  });
});

// ---------------------------------------------------------------------------
// 8. process-guard
// ---------------------------------------------------------------------------
describe('process-guard', () => {
  it('covers mode=off, kill detection hook, status tool, health, teardown', async () => {
    const plugin = (await import('../src/process-guard/index.js')).default;

    // Mode=off
    const apiOff = makeApi({
      config: {
        extensions: {
          'process-guard': { mode: 'off' },
        },
      },
    });
    plugin.setup(apiOff as never);
    expect(apiOff.log.info).toHaveBeenCalledWith(
      expect.stringContaining('mode=off — protection disabled'),
    );

    // Mode=block
    const apiBlock = makeApi({
      config: {
        extensions: {
          'process-guard': { mode: 'block' },
        },
      },
    });
    plugin.setup(apiBlock as never);

    const hook = apiBlock.getHook('PreToolUse');
    expect(hook).toBeDefined();

    // Ignore non-bash/exec
    hook!({ toolName: 'read_file' });

    // Ignore empty command
    hook!({ toolName: 'bash', toolInput: {} });

    // Ignore non-kill command
    hook!({ toolName: 'bash', toolInput: { command: 'echo hello' } });

    // Match kill command
    hook!({ toolName: 'bash', toolInput: { command: 'taskkill /F /IM node.exe' } });

    // Status tool
    const statusTool = apiBlock.tools.get('process_guard_status')!;
    const status = (await statusTool({})) as Record<string, unknown>;
    expect(status.ok).toBe(true);
    expect(status.counters).toMatchObject({ detections: 1 });

    // Health with detection
    const health = (await plugin.health!()) as { ok: boolean; message: string };
    expect(health.message).toContain('last detection');

    // Teardown
    plugin.teardown!(apiBlock as never);

    // Setup fresh to clear lastDetection
    const apiClean = makeApi();
    plugin.setup(apiClean as never);
    const healthClean = (await plugin.health!()) as { ok: boolean; message: string };
    expect(healthClean.message).toContain('invocation(s)');
  });
});

// ---------------------------------------------------------------------------
// 9. agent-handoff
// ---------------------------------------------------------------------------
describe('agent-handoff', () => {
  it('covers handoff_note tool, handoff_status, health, teardown', async () => {
    const plugin = (await import('../src/agent-handoff/index.js')).default;
    const mailboxMock = {
      send: vi.fn().mockResolvedValue({ id: 'msg-456' }),
    };

    const api = makeApi({
      mailbox: mailboxMock,
      config: {
        extensions: {
          'agent-handoff': { enabled: true },
        },
      },
    });

    plugin.setup(api as never);

    const noteTool = api.tools.get('handoff_note')!;
    const statusTool = api.tools.get('handoff_status')!;

    // Send note
    const res = (await noteTool({
      task: 'implement feature X',
      result: 'completed all unit tests',
    })) as Record<string, unknown>;
    expect(res.ok).toBe(true);
    expect(res.messageId).toBe('msg-456');

    // Error sending note
    mailboxMock.send.mockRejectedValueOnce(new Error('Recipient offline'));
    const errRes = (await noteTool({
      task: 'failing task',
    })) as Record<string, unknown>;
    expect(errRes.ok).toBe(false);
    expect(errRes.error).toContain('Recipient offline');

    // Status
    const status = (await statusTool({})) as Record<string, unknown>;
    expect(status.ok).toBe(true);
    expect(status.mailboxAvailable).toBe(true);

    // Health
    const health = (await plugin.health!()) as { ok: boolean };
    expect(health.ok).toBe(true);

    // Teardown
    plugin.teardown!(api as never);

    // Without mailbox
    const apiNoMb = makeApi();
    plugin.setup(apiNoMb as never);
    const noMbRes = (await apiNoMb.tools.get('handoff_note')!({})) as Record<string, unknown>;
    expect(noMbRes.ok).toBe(false);
    expect(noMbRes.error).toContain('mailbox not available');
  });
});
