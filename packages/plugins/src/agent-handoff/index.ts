/**
 * agent-handoff plugin — turns subagent completions into structured
 * handoff notes for the next agent.
 *
 * When a subagent finishes (`subagent.done` event), this plugin extracts
 * its identity, task, result, and any todo context, then posts a compact
 * mailbox message addressed to the parent/leader agent so the next
 * worker or the leader can pick up where it left off.
 *
 * Tools registered:
 * - handoff_note : Manually compose and send a handoff note.
 * - handoff_status : Counters + last handoff id.
 *
 * Events subscribed:
 * - `subagent.done`
 *
 * Config (`config.extensions['agent-handoff']`):
 *
 * ```jsonc
 * {
 *   "enabled": true,
 *   "subjectPrefix": "handoff: ",
 *   "includeResult": true,
 *   "includeTodos": true,
 *   "maxBodyChars": 4000,
 *   "to": "leader"   // default recipient alias
 * }
 * ```
 *
 * @public
 */

import type { Mailbox, MailboxSendInput } from '@wrongstack/core/coordination';
import type { Plugin } from '@wrongstack/core/types';
import { safeJsonStringify } from '../runtime/index.js';

const API_VERSION = '^0.1.10';

// ---------------------------------------------------------------------------
// Module-scope state (H1 audit pattern)
// ---------------------------------------------------------------------------

interface AgentHandoffState {
  invocationCount: number;
  sentCount: number;
  skippedCount: number;
  errorCount: number;
  lastMessageId: string | null;
  lastPayloadHash: string;
  eventUnsubscribers: Array<() => void>;
}

const state: AgentHandoffState = {
  invocationCount: 0,
  sentCount: 0,
  skippedCount: 0,
  errorCount: 0,
  lastMessageId: null,
  lastPayloadHash: '',
  eventUnsubscribers: [],
};

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface AgentHandoffConfig {
  enabled: boolean;
  subjectPrefix: string;
  includeResult: boolean;
  includeTodos: boolean;
  maxBodyChars: number;
  to: string;
}

const DEFAULTS: AgentHandoffConfig = {
  enabled: true,
  subjectPrefix: 'handoff: ',
  includeResult: true,
  includeTodos: true,
  maxBodyChars: 4_000,
  to: 'leader',
};

function readConfig(raw: unknown): AgentHandoffConfig {
  if (!raw || typeof raw !== 'object') return { ...DEFAULTS };
  const r = raw as Record<string, unknown>;
  const rawPrefix = r['subjectPrefix'] ?? r['subject_prefix'] ?? r['prefix'];
  const rawMax = r['maxBodyChars'] ?? r['max_body_chars'] ?? r['maxChars'];
  const rawTo = r['to'] ?? r['recipient'] ?? r['target'];
  return {
    enabled: r['enabled'] !== false,
    subjectPrefix: typeof rawPrefix === 'string' ? rawPrefix : DEFAULTS.subjectPrefix,
    includeResult: (r['includeResult'] ?? r['include_result']) !== false,
    includeTodos: (r['includeTodos'] ?? r['include_todos']) !== false,
    maxBodyChars:
      typeof rawMax === 'number' && rawMax >= 500
        ? rawMax
        : DEFAULTS.maxBodyChars,
    to: typeof rawTo === 'string' ? rawTo : DEFAULTS.to,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + `\n\n[truncated ${s.length - max} chars]` : s;
}

function hashString(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(16);
}

interface HandoffPayload {
  agentId?: string | undefined;
  agentName?: string | undefined;
  task?: string | undefined;
  result?: unknown;
  status?: string | undefined;
  todos?: Array<{ id?: string; status?: string; content?: string }> | undefined;
  summary?: string | undefined;
  [k: string]: unknown;
}

function buildBody(payload: HandoffPayload, cfg: AgentHandoffConfig): string {
  const lines: string[] = [];
  lines.push('# Handoff note');
  if (payload.agentName || payload.agentId) {
    lines.push(`**From:** ${payload.agentName ?? payload.agentId ?? 'unknown'}`);
  }
  if (payload.task) lines.push(`**Task:** ${payload.task}`);
  if (payload.status) lines.push(`**Status:** ${payload.status}`);
  lines.push(`**Time:** ${new Date().toISOString()}`);
  lines.push('');

  if (cfg.includeResult && payload.result !== undefined) {
    lines.push('## Result');
    lines.push('```json');
    // Handoff results come from another agent, so they are arbitrary
    // values — a circular one must degrade to a marker, not throw.
    lines.push(safeJsonStringify(payload.result, 2));
    lines.push('```');
    lines.push('');
  }

  if (payload.summary) {
    lines.push('## Summary');
    lines.push(payload.summary);
    lines.push('');
  }

  if (cfg.includeTodos && Array.isArray(payload.todos) && payload.todos.length > 0) {
    lines.push('## Todos');
    for (const t of payload.todos) {
      const status = t.status ?? 'unknown';
      const content = t.content ?? t.id ?? 'untitled';
      lines.push(`- [${status}] ${content}`);
    }
    lines.push('');
  }

  return truncate(lines.join('\n'), cfg.maxBodyChars);
}

async function sendHandoff(
  cfg: AgentHandoffConfig,
  mailbox: Mailbox,
  payload: HandoffPayload,
): Promise<void> {
  const hash = hashString(
    safeJsonStringify({
      agentId: payload.agentId,
      agentName: payload.agentName,
      task: payload.task,
      status: payload.status,
      summary: payload.summary,
      result: payload.result,
      todos: payload.todos,
    }),
  );
  if (hash === state.lastPayloadHash) {
    state.skippedCount += 1;
    return;
  }

  const body = buildBody(payload, cfg);

  const subject = `${cfg.subjectPrefix}${payload.agentName ?? payload.agentId ?? 'subagent'} — ${payload.status ?? 'done'}`.slice(
    0,
    200,
  );

  const sendInput: MailboxSendInput = {
    from: 'plugin:agent-handoff',
    to: cfg.to,
    type: 'status',
    subject,
    body,
    priority: 'normal',
  };

  const result = (await mailbox.send(sendInput)) as { id?: string } | undefined;
  state.sentCount += 1;
  state.lastMessageId = result?.id ?? null;
  state.lastPayloadHash = hash;
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const plugin: Plugin = {
  name: 'agent-handoff',
  version: '0.1.0',
  description:
    'Listens for subagent.done events and posts structured handoff notes to the project mailbox',
  apiVersion: API_VERSION,
  capabilities: { tools: true, hooks: true },
  defaultConfig: { ...DEFAULTS },
  configSchema: {
    type: 'object',
    properties: {
      enabled: { type: 'boolean', default: true, description: 'Master switch.' },
      subjectPrefix: {
        type: 'string',
        default: DEFAULTS.subjectPrefix,
        description: 'Prepended to handoff message subjects.',
      },
      includeResult: {
        type: 'boolean',
        default: true,
        description: 'Include the subagent result payload in the handoff body.',
      },
      includeTodos: {
        type: 'boolean',
        default: true,
        description: 'Include remaining/completed todos from the subagent.',
      },
      maxBodyChars: {
        type: 'number',
        minimum: 500,
        default: 4_000,
        description: 'Hard cap on handoff body size.',
      },
      to: {
        type: 'string',
        default: 'leader',
        description: 'Default mailbox recipient for handoff notes.',
      },
    },
  },

  setup(api) {
    // Idempotent re-init (H1 audit pattern).
    state.invocationCount = 0;
    state.sentCount = 0;
    state.skippedCount = 0;
    state.errorCount = 0;
    state.lastMessageId = null;
    state.lastPayloadHash = '';
    for (const off of state.eventUnsubscribers) {
      try {
        off();
      } catch {
        // best-effort
      }
    }
    state.eventUnsubscribers = [];

    const cfg = readConfig(api.config.extensions?.['agent-handoff']);
    const mailbox: Mailbox | undefined = api.mailbox;

    if (cfg.enabled && api.onEvent) {
      const offDone = api.onEvent('subagent.done', (payload: unknown) => {
        state.invocationCount += 1;
        if (!mailbox) {
          state.skippedCount += 1;
          return;
        }
        const raw = (payload ?? {}) as Record<string, unknown>;
        // Explicit picks + string coercion: the old `...raw` spread leaked
        // `unknown`-typed values into the string fields, so an object-valued
        // task/status rendered into the note as "[object Object]".
        const asString = (v: unknown): string | undefined => {
          if (v === undefined || v === null) return undefined;
          // String() alone would render object payloads as "[object Object]";
          // JSON-stringify them so the note stays readable.
          return typeof v === 'string' ? v : (safeJsonStringify(v) ?? undefined);
        };
        const rawTodos = raw['todos'];
        const p: HandoffPayload = {
          agentId: asString(raw['agentId']),
          agentName: asString(raw['agentName']),
          task: asString(raw['task']),
          status: asString(raw['status']),
          summary: asString(raw['summary']),
          result: raw['result'] ?? raw['output'] ?? raw['data'] ?? raw['toolResult'],
          todos: Array.isArray(rawTodos)
            ? (rawTodos as Array<{ id?: string; status?: string; content?: string }>)
            : undefined,
        };
        sendHandoff(cfg, mailbox, p).catch((err: unknown) => {
          state.errorCount += 1;
          api.log.warn('agent-handoff: mailbox.send failed', {
            error: err instanceof Error ? err.message : String(err),
          });
        });
      });
      state.eventUnsubscribers.push(offDone);
    }

    // --- handoff_note tool ---
    api.tools.register({
      name: 'handoff_note',
      description:
        'Manually compose and send a handoff note to another agent via the project mailbox.',
      inputSchema: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'Recipient (default: leader).' },
          task: { type: 'string', description: 'Short task description.' },
          summary: { type: 'string', description: 'What the next agent needs to know.' },
          todos: {
            type: 'array',
            items: { type: 'object' },
            description: 'Optional todo list to carry forward.',
          },
          result: { description: 'Optional structured result payload.' },
        },
      },
      permission: 'auto',
      category: 'Coordination',
      mutating: false,
      async execute(input: {
        to?: string | undefined;
        task?: string | undefined;
        summary?: string | undefined;
        todos?: unknown;
        result?: unknown;
      }) {
        if (!cfg.enabled) return { ok: false, error: 'agent-handoff is disabled' };
        if (!mailbox) return { ok: false, error: 'mailbox not available' };
        const raw = input as Record<string, unknown>;
        const summary =
          (typeof raw['summary'] === 'string' ? raw['summary'] : undefined) ??
          (typeof raw['note'] === 'string' ? raw['note'] : undefined) ??
          (typeof raw['message'] === 'string' ? raw['message'] : undefined) ??
          (typeof raw['content'] === 'string' ? raw['content'] : undefined) ??
          (typeof raw['text'] === 'string' ? raw['text'] : undefined) ??
          (typeof raw['body'] === 'string' ? raw['body'] : undefined);

        const task =
          (typeof raw['task'] === 'string' ? raw['task'] : undefined) ??
          (typeof raw['title'] === 'string' ? raw['title'] : undefined) ??
          (typeof raw['subject'] === 'string' ? raw['subject'] : undefined);

        const payload: HandoffPayload = {
          agentName: 'manual',
          task,
          summary,
          result: input.result,
          todos: Array.isArray(input.todos)
            ? input.todos
            : input.todos && typeof input.todos === 'object'
              ? [input.todos as { id?: string; status?: string; content?: string }]
              : undefined,
        };
        const recipient =
          (typeof raw['to'] === 'string' ? raw['to'] : undefined) ??
          (typeof raw['recipient'] === 'string' ? raw['recipient'] : undefined) ??
          (typeof raw['target'] === 'string' ? raw['target'] : undefined) ??
          cfg.to;
        try {
          const body = buildBody(payload, cfg);
          const result = (await mailbox.send({
            from: 'plugin:agent-handoff',
            to: recipient,
            type: 'status',
            subject: `${cfg.subjectPrefix}manual note — ${payload.task ?? 'handoff'}`.slice(0, 200),
            body,
            priority: 'normal',
          } as MailboxSendInput)) as { id?: string };
          state.sentCount += 1;
          state.lastMessageId = result.id ?? null;
          return { ok: true, messageId: result.id, to: recipient };
        } catch (err: unknown) {
          state.errorCount += 1;
          return {
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      },
    });

    // --- handoff_status tool ---
    api.tools.register({
      name: 'handoff_status',
      description: 'Reports agent-handoff counters and the last handoff message id.',
      inputSchema: { type: 'object', properties: {} },
      permission: 'auto',
      category: 'Diagnostics',
      mutating: false,
      async execute() {
        return {
          ok: true,
          enabled: cfg.enabled,
          subjectPrefix: cfg.subjectPrefix,
          includeResult: cfg.includeResult,
          includeTodos: cfg.includeTodos,
          maxBodyChars: cfg.maxBodyChars,
          defaultRecipient: cfg.to,
          mailboxAvailable: Boolean(mailbox),
          counters: {
            invocations: state.invocationCount,
            sent: state.sentCount,
            skipped: state.skippedCount,
            errors: state.errorCount,
          },
          lastMessageId: state.lastMessageId,
        };
      },
    });

    api.log.info('agent-handoff plugin loaded', {
      version: '0.1.0',
      enabled: cfg.enabled,
      mailboxAvailable: Boolean(mailbox),
    });
  },

  teardown(api) {
    for (const off of state.eventUnsubscribers) {
      try {
        off();
      } catch {
        // best-effort
      }
    }
    state.eventUnsubscribers = [];
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
    api.log.info('agent-handoff: teardown complete', { final });
  },

  async health() {
    return {
      ok: true,
      message: `agent-handoff: ${state.invocationCount} event(s), ${state.sentCount} sent, ${state.skippedCount} skipped, ${state.errorCount} error(s)`,
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
