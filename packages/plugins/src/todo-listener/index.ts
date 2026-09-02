/**
 * todo-listener plugin — PostToolUse hook on the `todo` tool that
 * broadcasts a structured status update to the project mailbox.
 *
 * When the agent (or any plugin) calls the built-in `todo` tool, the
 * full todo list is replaced in `ctx.todos`. The hook fires after the
 * tool completes, reads the new state, and posts a compact summary
 * to the project mailbox so that other agents in the same project
 * (terminals, WebUIs, shadow agents) can see what this agent is
 * working on in real time.
 *
 * Use cases:
 *  - Multi-agent fleets where a coordinator should know which
 *    sub-agent is working on which item
 *  - Long-running sessions where a user opens a second terminal and
 *    wants to see the in-progress plan
 *  - Shadow agents that audit progress across the project
 *
 * Config (`config.extensions['todo-listener']`):
 *
 * ```jsonc
 * {
 *   "enabled": false,
 *   "subjectPrefix": "todo: ",
 *   "broadcastOnChange": true,
 *   "cooldownMs": 30000
 * }
 * ```
 *
 * @public
 */
import type { TodoItem } from '@wrongstack/core/agent';
import type { Mailbox, MailboxMessage, MailboxSendInput } from '@wrongstack/core/coordination';
import type { Plugin } from '@wrongstack/core/types';
import { releaseHandle, safeJsonStringify } from '../runtime/index.js';

// ---------------------------------------------------------------------------
// Module-scope state (H1 audit pattern)
// ---------------------------------------------------------------------------

interface ListenerState {
  /** Total PostToolUse invocations for the `todo` tool. */
  invocationCount: number;
  /** Broadcasts that were sent (mailbox.send returned successfully). */
  sentCount: number;
  /** Broadcasts skipped because of cooldown / no-change / disabled. */
  skippedCount: number;
  /** Broadcasts that errored (mailbox.send threw). */
  errorCount: number;
  /** Last successful broadcast's id (for ack/correlation). */
  lastMessageId: string | null;
  /** Hash of the last payload, so identical broadcasts are suppressed. */
  lastPayloadHash: string;
  /** Timestamp of the last broadcast, for cooldown enforcement. */
  lastBroadcastAt: number;
  /** Hook handle for teardown. */
  hookUnregister: null | (() => void);
}

const state: ListenerState = {
  invocationCount: 0,
  sentCount: 0,
  skippedCount: 0,
  errorCount: 0,
  lastMessageId: null,
  lastPayloadHash: '',
  lastBroadcastAt: 0,
  hookUnregister: null,
};

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface TodoListenerConfig {
  enabled: boolean;
  /** Prepended to the broadcast's `subject` (mailbox reads this in the inbox). */
  subjectPrefix: string;
  /**
   * When false, broadcasts on every `todo` call. When true (default),
   * broadcasts only when the payload hash differs from the last one —
   * so re-setting the same list doesn't spam the inbox.
   */
  broadcastOnChange: boolean;
  /** Minimum interval between two consecutive broadcasts (ms). Default 5s. */
  cooldownMs: number;
}

const DEFAULTS: TodoListenerConfig = {
  enabled: false,
  subjectPrefix: 'todo: ',
  broadcastOnChange: true,
  cooldownMs: 30_000,
};

function readConfig(raw: unknown): TodoListenerConfig {
  if (!raw || typeof raw !== 'object') return { ...DEFAULTS };
  const r = raw as Record<string, unknown>;
  return {
    enabled: r['enabled'] === true,
    subjectPrefix:
      typeof r['subjectPrefix'] === 'string' ? r['subjectPrefix'] : DEFAULTS.subjectPrefix,
    broadcastOnChange: r['broadcastOnChange'] !== false,
    cooldownMs:
      typeof r['cooldownMs'] === 'number' && r['cooldownMs'] >= 0
        ? r['cooldownMs']
        : DEFAULTS.cooldownMs,
  };
}

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

/**
 * Cheap stable hash for a list of TodoItem. Not crypto-secure — only used
 * for de-duplication within the same session. Sorts the list by id so
 * re-ordered lists with the same items hash identically.
 */
function hashTodos(todos: TodoItem[]): string {
  const sorted = todos.map((t) => `${t.id}|${t.status}|${t.content ?? ''}`).sort();
  // FNV-1a 32-bit. Good enough for a session-scoped dedupe key.
  let h = 0x811c9dc5;
  const joined = sorted.join('\n');
  for (let i = 0; i < joined.length; i++) {
    h ^= joined.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(16);
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const plugin: Plugin = {
  name: 'todo-listener',
  version: '0.1.0',
  description:
    'PostToolUse hook on `todo` tool — broadcasts a status update to the project mailbox so other agents can see what this one is working on',
  apiVersion: '^0.1.10',
  capabilities: { tools: true, hooks: true },
  defaultConfig: { ...DEFAULTS },
  configSchema: {
    type: 'object',
    properties: {
      enabled: { type: 'boolean', default: false, description: 'Master switch.' },
      subjectPrefix: {
        type: 'string',
        default: DEFAULTS.subjectPrefix,
        description: 'Prepended to the broadcast `subject`. Useful for filtering the inbox.',
      },
      broadcastOnChange: {
        type: 'boolean',
        default: true,
        description: 'When true, identical consecutive payloads are suppressed.',
      },
      cooldownMs: {
        type: 'number',
        minimum: 0,
        default: DEFAULTS.cooldownMs,
        description: 'Minimum interval between consecutive broadcasts (ms).',
      },
    },
  },

  setup(api) {
    // Idempotent re-init (H1 pattern).
    state.invocationCount = 0;
    state.sentCount = 0;
    state.skippedCount = 0;
    state.errorCount = 0;
    state.lastMessageId = null;
    state.lastPayloadHash = '';
    state.lastBroadcastAt = 0;
    state.hookUnregister = releaseHandle(state.hookUnregister);

    const cfg = readConfig(api.config.extensions?.['todo-listener']);
    const mailbox: Mailbox | undefined = api.mailbox;

    const hook = async (input: {
      toolName?: string | undefined;
      toolInput?: unknown;
      toolResult?: { content: string; isError: boolean } | undefined;
    }): Promise<{ additionalContext?: string } | void> => {
      if (!cfg.enabled) return;
      // Only fire on the `todo` tool, not on every PostToolUse.
      if (input.toolName !== 'todo') return;
      // Don't broadcast when the tool itself errored.
      if (input.toolResult?.isError) return;

      state.invocationCount += 1;

      // mailbox is optional — minimal hosts (tests, the LSP server)
      // may not have one. We log a one-shot warning the first time
      // and silently skip thereafter, so the hook never throws.
      if (!mailbox) {
        state.skippedCount += 1;
        api.log.warn(
          'todo-listener: no mailbox available on api — broadcasts disabled. ' +
            'Add `mailbox` to the setupPlugins() call to enable cross-agent visibility.',
        );
        return;
      }

      const inp = input.toolInput as
        | {
            todos?: TodoItem[];
            items?: TodoItem[];
            tasks?: TodoItem[];
            todoList?: TodoItem[];
            list?: TodoItem[];
          }
        | TodoItem[]
        | undefined;
      const todos = Array.isArray(inp)
        ? (inp as TodoItem[])
        : Array.isArray(inp?.todos)
          ? inp.todos
          : Array.isArray(inp?.items)
            ? inp.items
            : Array.isArray(inp?.tasks)
              ? inp.tasks
              : Array.isArray(inp?.todoList)
                ? inp.todoList
                : Array.isArray(inp?.list)
                  ? inp.list
                  : [];
      const inProgress = todos.find((t) => t.status === 'in_progress');
      const pending = todos.filter((t) => t.status === 'pending').length;
      const completed = todos.filter((t) => t.status === 'completed').length;

      const payload = {
        count: todos.length,
        inProgress: inProgress ? { id: inProgress.id, content: inProgress.content } : null,
        pending,
        completed,
        items: todos.map((t) => ({ id: t.id, status: t.status, content: t.content })),
      };

      const hash = hashTodos(todos);

      // Suppress identical consecutive broadcasts.
      if (cfg.broadcastOnChange && hash === state.lastPayloadHash) {
        state.skippedCount += 1;
        return;
      }

      // Cooldown: never broadcast faster than `cooldownMs`. Useful when
      // an agent re-issues the full list on every iteration.
      const now = Date.now();
      if (now - state.lastBroadcastAt < cfg.cooldownMs) {
        state.skippedCount += 1;
        return;
      }

      const subject =
        `${cfg.subjectPrefix}${inProgress ? `working on '${inProgress.content}'` : `${todos.length} item(s)`}`.slice(
          0,
          200,
        );
      // The bus payload is not ours; a circular reference must not turn a
      // status broadcast into a thrown listener.
      const body = safeJsonStringify(payload, 2);

      const sendInput: MailboxSendInput = {
        from: `plugin:todo-listener`,
        to: '*',
        type: 'status',
        subject,
        body,
        priority: 'normal',
      };

      try {
        const result = (await mailbox.send(sendInput)) as MailboxMessage | { id?: string };
        const id = (result as { id?: string }).id ?? null;
        state.sentCount += 1;
        state.lastMessageId = id;
        state.lastPayloadHash = hash;
        state.lastBroadcastAt = now;
        api.log.info(`todo-listener: broadcast todo update`, {
          count: payload.count,
          inProgress: payload.inProgress?.id ?? null,
          messageId: id,
        });
      } catch (err) {
        state.errorCount += 1;
        api.log.warn('todo-listener: mailbox.send failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    };

    state.hookUnregister = api.registerHook('PostToolUse', 'todo', hook as never);

    // --- todo_listener_status tool ---
    api.tools.register({
      name: 'todo_listener_status',
      description:
        'Reports todo-listener state: config + per-session counters (invocations, sent, skipped, errors) and last broadcast id.',
      inputSchema: { type: 'object', properties: {} },
      permission: 'auto',
      category: 'Diagnostics',
      mutating: false,
      async execute() {
        return {
          ok: true,
          enabled: cfg.enabled,
          subjectPrefix: cfg.subjectPrefix,
          broadcastOnChange: cfg.broadcastOnChange,
          cooldownMs: cfg.cooldownMs,
          mailboxAvailable: Boolean(mailbox),
          counters: {
            invocations: state.invocationCount,
            sent: state.sentCount,
            skipped: state.skippedCount,
            errors: state.errorCount,
          },
          lastMessageId: state.lastMessageId,
          lastBroadcastAt:
            state.lastBroadcastAt > 0 ? new Date(state.lastBroadcastAt).toISOString() : null,
        };
      },
    });

    api.log.info('todo-listener plugin loaded', {
      version: '0.1.0',
      enabled: cfg.enabled,
      mailboxAvailable: Boolean(mailbox),
    });
  },

  teardown(api) {
    if (state.hookUnregister) {
      try {
        state.hookUnregister();
      } catch {
        // best-effort
      }
      state.hookUnregister = null;
    }
    const final = {
      invocations: state.invocationCount,
      sent: state.sentCount,
      skipped: state.skippedCount,
      errors: state.errorCount,
    };
    state.invocationCount = 0;
    state.sentCount = 0;
    state.skippedCount = 0;
    state.errorCount = 0;
    state.lastMessageId = null;
    state.lastPayloadHash = '';
    state.lastBroadcastAt = 0;
    api.log.info('todo-listener: teardown complete', { final });
  },

  async health() {
    const base = `todo-listener: ${state.invocationCount} invocation(s), ${state.sentCount} sent, ${state.skippedCount} skipped, ${state.errorCount} error(s)`;
    return {
      ok: true,
      message: state.lastMessageId
        ? `${base}; last broadcast ${state.lastMessageId}`
        : `${base}; no broadcast yet`,
      counters: {
        invocations: state.invocationCount,
        sent: state.sentCount,
        skipped: state.skippedCount,
        errors: state.errorCount,
      },
      lastMessageId: state.lastMessageId,
    };
  },
};

export default plugin;
