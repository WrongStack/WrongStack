/**
 * @wrongstack/plugins — todo-listener plugin tests
 *
 * Covers the PostToolUse hook on the `todo` tool:
 *  - Fires only on the `todo` tool, not on other PostToolUse events
 *  - Skips when the tool itself errored
 *  - Skips when the todo list hasn't changed (broadcastOnChange)
 *  - Skips within cooldown window
 *  - Sends a status broadcast via api.mailbox.send with the right
 *    subject/body shape
 *  - Suppresses when api.mailbox is undefined (graceful no-op)
 *  - H1 audit pattern: teardown + health + idempotent re-init
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import todoListenerPlugin from '../src/todo-listener/index.js';

// ---------------------------------------------------------------------------
// Types + helpers
// ---------------------------------------------------------------------------

interface PluginAPI {
  tools: { register: ReturnType<typeof vi.fn> };
  slashCommands: { register: ReturnType<typeof vi.fn> };
  pipelines: Record<string, { use: (h: unknown) => void }>;
  config: { extensions?: Record<string, unknown> };
  log: {
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };
  metrics: {
    counter: ReturnType<typeof vi.fn>;
    histogram: ReturnType<typeof vi.fn>;
    gauge: ReturnType<typeof vi.fn>;
  };
  session: { append: ReturnType<typeof vi.fn> };
  extensions: { register: ReturnType<typeof vi.fn> };
  registerSystemPromptContributor: ReturnType<typeof vi.fn>;
  registerHook: ReturnType<typeof vi.fn>;
  onEvent: ReturnType<typeof vi.fn>;
  onPattern: ReturnType<typeof vi.fn>;
  emitCustom: ReturnType<typeof vi.fn>;
  onConfigChange: ReturnType<typeof vi.fn>;
  mailbox?: {
    send: ReturnType<typeof vi.fn>;
    query: ReturnType<typeof vi.fn>;
  };
}

function createMockAPI(opts: { withMailbox?: boolean; enabled?: boolean } = {}): PluginAPI {
  return {
    tools: { register: vi.fn() },
    slashCommands: { register: vi.fn() },
    pipelines: {},
    config: { extensions: opts.enabled === true ? { 'todo-listener': { enabled: true } } : {} },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    metrics: { counter: vi.fn(), histogram: vi.fn(), gauge: vi.fn() },
    session: { append: vi.fn().mockResolvedValue(undefined) },
    extensions: { register: vi.fn(() => ({ unregister: vi.fn() })) },
    registerSystemPromptContributor: vi.fn(() => () => {}),
    registerHook: vi.fn(() => () => {}),
    onEvent: vi.fn(() => () => {}),
    onPattern: vi.fn(() => () => {}),
    emitCustom: vi.fn(),
    onConfigChange: vi.fn(() => () => {}),
    ...(opts.withMailbox
      ? { mailbox: { send: vi.fn().mockResolvedValue({ id: 'msg-1' }), query: vi.fn() } }
      : {}),
  };
}

function getHook(api: PluginAPI) {
  const call = vi.mocked(api.registerHook).mock.calls[0];
  if (!call?.[2]) throw new Error('hook not registered');
  return call[2] as (input: {
    toolName?: string | undefined;
    toolInput?: unknown;
    toolResult?: { content: string; isError: boolean } | undefined;
  }) => Promise<unknown>;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('todo-listener plugin', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-30T12:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  describe('plugin contract', () => {
    it('has name, apiVersion, and setup function', () => {
      expect(todoListenerPlugin.name).toBe('todo-listener');
      expect(typeof todoListenerPlugin.apiVersion).toBe('string');
      expect(typeof todoListenerPlugin.setup).toBe('function');
    });

    it('registers one tool and one PostToolUse hook on setup', () => {
      const api = createMockAPI();
      todoListenerPlugin.setup(api as never);
      expect(api.tools.register).toHaveBeenCalledTimes(1);
      const tool = vi.mocked(api.tools.register).mock.calls[0]?.[0] as { name: string };
      expect(tool.name).toBe('todo_listener_status');
      expect(api.registerHook).toHaveBeenCalledTimes(1);
      const call = vi.mocked(api.registerHook).mock.calls[0];
      expect(call?.[0]).toBe('PostToolUse');
      expect(call?.[1]).toBe('todo');
    });

    it('configSchema defines enabled, subjectPrefix, broadcastOnChange, cooldownMs', () => {
      const schema = todoListenerPlugin.configSchema as Record<
        string,
        { properties?: Record<string, unknown> }
      >;
      const props = schema.properties;
      expect(props?.enabled).toBeDefined();
      expect(props?.subjectPrefix).toBeDefined();
      expect(props?.broadcastOnChange).toBeDefined();
      expect(props?.cooldownMs).toBeDefined();
    });

    it('defaultConfig is quiet unless explicitly enabled', () => {
      const defaults = todoListenerPlugin.defaultConfig as Record<string, unknown>;
      expect(defaults.enabled).toBe(false);
      expect(defaults.subjectPrefix).toBe('todo: ');
      expect(defaults.broadcastOnChange).toBe(true);
      expect(defaults.cooldownMs).toBe(30_000);
    });
  });

  // -------------------------------------------------------------------------
  describe('H1 audit pattern', () => {
    it('teardown clears state and logs the unload line', () => {
      const api = createMockAPI({ withMailbox: true, enabled: true });
      todoListenerPlugin.setup(api as never);
      todoListenerPlugin.teardown!(api as never);
      expect(api.log.info).toHaveBeenCalledWith(
        expect.stringContaining('todo-listener: teardown complete'),
        expect.anything(),
      );
    });

    it('health() returns ok with counter info', async () => {
      const api = createMockAPI({ withMailbox: true, enabled: true });
      todoListenerPlugin.setup(api as never);
      const health = await todoListenerPlugin.health!();
      expect(health.ok).toBe(true);
      expect(health.message).toContain('0 invocation');
      expect(health.message).toContain('no broadcast yet');
    });

    it('setup is idempotent: counters reset on re-init', async () => {
      const api = createMockAPI({ withMailbox: true, enabled: true });
      todoListenerPlugin.setup(api as never);
      const hook = getHook(api);
      await hook({
        toolName: 'todo',
        toolInput: { todos: [{ id: '1', content: 'a', status: 'pending' }] },
        toolResult: { content: 'ok', isError: false },
      });
      todoListenerPlugin.teardown!(api as never);
      todoListenerPlugin.setup(api as never);
      const health = await todoListenerPlugin.health!();
      expect(health.message).toContain('0 invocation');
    });
  });

  // -------------------------------------------------------------------------
  describe('hook filtering', () => {
    it('skips when toolName is not `todo`', async () => {
      const api = createMockAPI({ withMailbox: true, enabled: true });
      todoListenerPlugin.setup(api as never);
      const hook = getHook(api);
      const result = await hook({
        toolName: 'write',
        toolInput: { todos: [] },
        toolResult: { content: 'ok', isError: false },
      });
      expect(result).toBeUndefined();
      expect(api.mailbox?.send).not.toHaveBeenCalled();
    });

    it('skips when tool result is an error', async () => {
      const api = createMockAPI({ withMailbox: true, enabled: true });
      todoListenerPlugin.setup(api as never);
      const hook = getHook(api);
      const result = await hook({
        toolName: 'todo',
        toolInput: { todos: [] },
        toolResult: { content: 'permission denied', isError: true },
      });
      expect(result).toBeUndefined();
      expect(api.mailbox?.send).not.toHaveBeenCalled();
    });

    it('skips when api.mailbox is undefined (graceful no-op)', async () => {
      const api = createMockAPI({ withMailbox: false, enabled: true });
      todoListenerPlugin.setup(api as never);
      const hook = getHook(api);
      const result = await hook({
        toolName: 'todo',
        toolInput: { todos: [{ id: '1', content: 'a', status: 'pending' }] },
        toolResult: { content: 'ok', isError: false },
      });
      expect(result).toBeUndefined();
      // Status tool should report mailboxAvailable=false
      const tool = vi.mocked(api.tools.register).mock.calls[0]?.[0] as {
        execute: () => Promise<unknown>;
      };
      const status = (await tool.execute()) as {
        mailboxAvailable: boolean;
        counters: { invocations: number; skipped: number };
      };
      expect(status.mailboxAvailable).toBe(false);
      expect(status.counters.invocations).toBe(1);
      expect(status.counters.skipped).toBe(1);
    });

    it('does not fire by default', async () => {
      const api = createMockAPI({ withMailbox: true });
      todoListenerPlugin.setup(api as never);
      const hook = getHook(api);
      await hook({
        toolName: 'todo',
        toolInput: { todos: [{ id: '1', content: 'a', status: 'pending' }] },
        toolResult: { content: 'ok', isError: false },
      });
      expect(api.mailbox?.send).not.toHaveBeenCalled();
    });

    it('does not fire when enabled=false', async () => {
      const api = createMockAPI({ withMailbox: true, enabled: true });
      api.config.extensions = { 'todo-listener': { enabled: false } };
      todoListenerPlugin.setup(api as never);
      const hook = getHook(api);
      await hook({
        toolName: 'todo',
        toolInput: { todos: [{ id: '1', content: 'a', status: 'pending' }] },
        toolResult: { content: 'ok', isError: false },
      });
      expect(api.mailbox?.send).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  describe('mailbox broadcast', () => {
    it('sends a status message with subject + body on the first call', async () => {
      const api = createMockAPI({ withMailbox: true, enabled: true });
      todoListenerPlugin.setup(api as never);
      const hook = getHook(api);
      await hook({
        toolName: 'todo',
        toolInput: {
          todos: [
            { id: 'a', content: 'write tests', status: 'in_progress' },
            { id: 'b', content: 'review PR', status: 'pending' },
          ],
        },
        toolResult: { content: 'ok', isError: false },
      });
      expect(api.mailbox?.send).toHaveBeenCalledTimes(1);
      const sendArg = vi.mocked(api.mailbox!.send).mock.calls[0]?.[0] as {
        from: string;
        to: string;
        type: string;
        subject: string;
        body: string;
      };
      expect(sendArg.from).toBe('plugin:todo-listener');
      expect(sendArg.to).toBe('*');
      expect(sendArg.type).toBe('status');
      expect(sendArg.subject).toContain("working on 'write tests'");
      expect(JSON.parse(sendArg.body).inProgress.id).toBe('a');
      expect(JSON.parse(sendArg.body).pending).toBe(1);
    });

    it('suppresses identical consecutive payloads (broadcastOnChange)', async () => {
      const api = createMockAPI({ withMailbox: true, enabled: true });
      todoListenerPlugin.setup(api as never);
      const hook = getHook(api);
      const todos = [{ id: 'a', content: 'write tests', status: 'in_progress' as const }];
      await hook({
        toolName: 'todo',
        toolInput: { todos },
        toolResult: { content: 'ok', isError: false },
      });
      await hook({
        toolName: 'todo',
        toolInput: { todos },
        toolResult: { content: 'ok', isError: false },
      });
      expect(api.mailbox?.send).toHaveBeenCalledTimes(1);
    });

    it('still broadcasts when the list changes (different id)', async () => {
      const api = createMockAPI({ withMailbox: true, enabled: true });
      api.config.extensions = { 'todo-listener': { enabled: true, cooldownMs: 0 } };
      todoListenerPlugin.setup(api as never);
      const hook = getHook(api);
      await hook({
        toolName: 'todo',
        toolInput: { todos: [{ id: 'a', content: 'one', status: 'pending' }] },
        toolResult: { content: 'ok', isError: false },
      });
      await hook({
        toolName: 'todo',
        toolInput: { todos: [{ id: 'a', content: 'one (updated)', status: 'pending' }] },
        toolResult: { content: 'ok', isError: false },
      });
      expect(api.mailbox?.send).toHaveBeenCalledTimes(2);
    });

    it('enforces cooldownMs between broadcasts', async () => {
      const api = createMockAPI({ withMailbox: true, enabled: true });
      api.config.extensions = { 'todo-listener': { enabled: true, cooldownMs: 60_000 } };
      todoListenerPlugin.setup(api as never);
      const hook = getHook(api);
      await hook({
        toolName: 'todo',
        toolInput: { todos: [{ id: 'a', content: 'one', status: 'pending' }] },
        toolResult: { content: 'ok', isError: false },
      });
      // Advance the clock by 30s — within the cooldown window
      vi.advanceTimersByTime(30_000);
      await hook({
        toolName: 'todo',
        toolInput: { todos: [{ id: 'a', content: 'one (changed)', status: 'pending' }] },
        toolResult: { content: 'ok', isError: false },
      });
      expect(api.mailbox?.send).toHaveBeenCalledTimes(1);
      // Advance past the cooldown
      vi.advanceTimersByTime(31_000);
      await hook({
        toolName: 'todo',
        toolInput: { todos: [{ id: 'a', content: 'one (changed again)', status: 'pending' }] },
        toolResult: { content: 'ok', isError: false },
      });
      expect(api.mailbox?.send).toHaveBeenCalledTimes(2);
    });

    it('records errorCount when mailbox.send throws', async () => {
      const api = createMockAPI({ withMailbox: true, enabled: true });
      api.mailbox!.send.mockRejectedValue(new Error('mailbox write failed'));
      todoListenerPlugin.setup(api as never);
      const hook = getHook(api);
      await hook({
        toolName: 'todo',
        toolInput: { todos: [{ id: 'a', content: 'one', status: 'pending' }] },
        toolResult: { content: 'ok', isError: false },
      });
      const tool = vi.mocked(api.tools.register).mock.calls[0]?.[0] as {
        execute: () => Promise<unknown>;
      };
      const status = (await tool.execute()) as { counters: { errors: number; sent: number } };
      expect(status.counters.errors).toBe(1);
      expect(status.counters.sent).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  describe('status tool', () => {
    function getStatusTool(api: PluginAPI): { execute: () => Promise<unknown> } {
      const call = vi.mocked(api.tools.register).mock.calls[0];
      if (!call?.[0]) throw new Error('status tool not registered');
      return call[0] as { execute: () => Promise<unknown> };
    }

    it('reports config + counters + mailbox availability', async () => {
      const api = createMockAPI({ withMailbox: true, enabled: true });
      todoListenerPlugin.setup(api as never);
      const tool = getStatusTool(api);
      const status = (await tool.execute()) as {
        enabled: boolean;
        subjectPrefix: string;
        broadcastOnChange: boolean;
        cooldownMs: number;
        mailboxAvailable: boolean;
        counters: { invocations: number; sent: number; skipped: number; errors: number };
      };
      expect(status.enabled).toBe(true);
      expect(status.subjectPrefix).toBe('todo: ');
      expect(status.broadcastOnChange).toBe(true);
      expect(status.cooldownMs).toBe(30_000);
      expect(status.mailboxAvailable).toBe(true);
      expect(status.counters.invocations).toBe(0);
      expect(status.counters.sent).toBe(0);
    });
  });
});
