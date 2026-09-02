/**
 * Shared mutation fixture for mailbox HTTP validators.
 *
 * Defines per-route valid bodies and one-field mutation cases so
 * host mutation suites iterate over the same contract.
 *
 * The bridge suite (`mailbox-bridge-mutation.test.ts`) already imports
 * this fixture (commit d6765457). Adding a new `MutationCase` to a
 * `RouteDef` here automatically covers the bridge.
 *
 * The HQ gateway suite (`hq-mailbox-mutation.test.ts`) can be
 * migrated once the gateway's project-resolution approach supports
 * direct route dispatch (currently it resolves projectId server-side
 * via SessionRegistry, which is incompatible with this fixture's
 * direct dispatch pattern). See the HQ suite for the interface:
 * import { addRouteMutationTests, type PostFn, SEND_DEF, ... } from
 * '../../core/tests/coordination/mailbox-mutation-fixtures.js';
 * const hqPost: PostFn = async (route, body, headers) => { ... };
 * addRouteMutationTests([SEND_DEF, ...], hqPost);
 *
 * Each host provides its own `post` callback so harness differences
 * (subprocess URL vs in-process gateway URL, auth headers, cleanup)
 * stay in the host file.
 */

import { describe, expect, it } from 'vitest';

// ── Types ────────────────────────────────────────────────────────────────

export interface MutationCase {
  rejectContains: string;
  mutate: (body: Record<string, unknown>) => void;
}

export interface RouteDef {
  route: string;
  validBody: Record<string, unknown>;
  cases: MutationCase[];
}

export type PostFn = (
  route: string,
  body: unknown,
  headers?: Record<string, string>,
) => Promise<{ status: number; json: unknown }>;

// ── Route definitions ────────────────────────────────────────────────────

export const SEND_DEF: RouteDef = {
  route: '/mailbox/send',
  validBody: { from: 'ext-sender', to: 'recv', type: 'note', subject: 's', body: 'b' },
  cases: [
    {
      rejectContains: '"from"',
      mutate: (b) => {
        delete b['from'];
      },
    },
    {
      rejectContains: '"type"',
      mutate: (b) => {
        b['type'] = 'invalid-type';
      },
    },
    {
      rejectContains: 'priority',
      mutate: (b) => {
        b['priority'] = 'unknown-prio';
      },
    },
    {
      rejectContains: 'ttlMs',
      mutate: (b) => {
        b['ttlMs'] = 0;
      },
    },
    {
      rejectContains: 'ttlMs',
      mutate: (b) => {
        b['ttlMs'] = -1;
      },
    },
    {
      rejectContains: 'ttlMs',
      mutate: (b) => {
        b['ttlMs'] = 1.5;
      },
    },
    {
      rejectContains: '"from"',
      mutate: (b) => {
        b['from'] = 'leader';
      },
    },
  ],
};

export const QUERY_DEF: RouteDef = {
  route: '/mailbox/query',
  validBody: { to: 'leader', limit: 5 },
  cases: [
    {
      rejectContains: 'limit',
      mutate: (b) => {
        b['limit'] = 0;
      },
    },
    {
      rejectContains: 'limit',
      mutate: (b) => {
        b['limit'] = -1;
      },
    },
    {
      rejectContains: 'limit',
      mutate: (b) => {
        b['limit'] = 1.5;
      },
    },
    {
      rejectContains: 'limit',
      mutate: (b) => {
        b['limit'] = 'ten';
      },
    },
    {
      rejectContains: 'minPriority',
      mutate: (b) => {
        b['minPriority'] = 'unknown-prio';
      },
    },
    {
      rejectContains: 'incompleteOnly',
      mutate: (b) => {
        b['incompleteOnly'] = 'yes';
      },
    },
  ],
};

export const CHECK_DEF: RouteDef = {
  route: '/mailbox/check',
  validBody: { agentId: 'ext-checker' },
  cases: [
    {
      rejectContains: '"agentId"',
      mutate: (b) => {
        delete b['agentId'];
      },
    },
    {
      rejectContains: 'limit',
      mutate: (b) => {
        b['limit'] = 0;
      },
    },
    {
      rejectContains: 'limit',
      mutate: (b) => {
        b['limit'] = -1;
      },
    },
    {
      rejectContains: 'limit',
      mutate: (b) => {
        b['limit'] = 1.5;
      },
    },
  ],
};

export const ACK_DEF: RouteDef = {
  route: '/mailbox/ack',
  validBody: { messageId: 'm-1', readerId: 'ext-reader' },
  cases: [
    {
      rejectContains: 'messageId',
      mutate: (b) => {
        delete b['messageId'];
      },
    },
    {
      rejectContains: 'readerId',
      mutate: (b) => {
        delete b['readerId'];
      },
    },
    {
      rejectContains: 'messageId',
      mutate: (b) => {
        b['messageId'] = 7;
      },
    },
  ],
};

export const ACK_MANY_DEF: RouteDef = {
  route: '/mailbox/ack-many',
  validBody: { acks: [{ messageId: 'm-1', readerId: 'ext-reader', read: true }] },
  cases: [
    {
      rejectContains: '"acks"',
      mutate: (b) => {
        b['acks'] = 'not-array';
      },
    },
    {
      rejectContains: '"acks"',
      mutate: (b) => {
        b['acks'] = null;
      },
    },
    {
      rejectContains: '"acks"',
      mutate: (b) => {
        delete b['acks'];
      },
    },
    {
      rejectContains: 'messageId',
      mutate: (b) => {
        (b['acks'] as Array<Record<string, unknown>>)[0]!.messageId = 7;
      },
    },
  ],
};

export const AGENT_REG_DEF: RouteDef = {
  route: '/mailbox/agents/register',
  validBody: { agentId: 'ext-agent', name: 'Mut Agent', pid: 9999 },
  cases: [
    {
      rejectContains: '"pid"',
      mutate: (b) => {
        b['pid'] = 0;
      },
    },
    {
      rejectContains: '"pid"',
      mutate: (b) => {
        b['pid'] = -1;
      },
    },
    {
      rejectContains: '"pid"',
      mutate: (b) => {
        b['pid'] = 1.5;
      },
    },
    {
      rejectContains: '"pid"',
      mutate: (b) => {
        b['pid'] = 'string-pid';
      },
    },
    {
      rejectContains: 'reserved',
      mutate: (b) => {
        b['agentId'] = 'hq';
      },
    },
  ],
};

export const CLIENT_REG_DEF: RouteDef = {
  route: '/mailbox/register-client',
  validBody: { clientId: 'ext-tui', name: 'Mut TUI', pid: 8888 },
  cases: [
    {
      rejectContains: '"pid"',
      mutate: (b) => {
        b['pid'] = 0;
      },
    },
    {
      rejectContains: '"pid"',
      mutate: (b) => {
        b['pid'] = -1;
      },
    },
    {
      rejectContains: '"pid"',
      mutate: (b) => {
        b['pid'] = 1.5;
      },
    },
    {
      rejectContains: '"pid"',
      mutate: (b) => {
        b['pid'] = 'abc';
      },
    },
  ],
};

export const HEARTBEAT_DEF: RouteDef = {
  route: '/mailbox/heartbeat',
  validBody: { clientId: 'ext-tui' },
  cases: [
    {
      rejectContains: 'clientId',
      mutate: (b) => {
        delete b['clientId'];
      },
    },
  ],
};

export const AGENT_HEARTBEAT_DEF: RouteDef = {
  route: '/mailbox/agents/heartbeat',
  validBody: { agentId: 'ext-agent' },
  cases: [
    {
      rejectContains: 'agentId',
      mutate: (b) => {
        delete b['agentId'];
      },
    },
    {
      rejectContains: 'iterations',
      mutate: (b) => {
        b['iterations'] = -1;
      },
    },
    {
      rejectContains: 'iterations',
      mutate: (b) => {
        b['iterations'] = 0.5;
      },
    },
    {
      rejectContains: 'toolCalls',
      mutate: (b) => {
        b['toolCalls'] = -1;
      },
    },
    {
      rejectContains: 'toolCalls',
      mutate: (b) => {
        b['toolCalls'] = 0.5;
      },
    },
  ],
};

// ── Runner ───────────────────────────────────────────────────────────────

/**
 * Register `describe` blocks for each route definition, running each
 * mutation case as an `it.each` row.
 *
 * @param defs      Route definitions to iterate.
 * @param post      HTTP POST callback — receives the full route path,
 *                  the JSON body, and optional headers; returns status + JSON.
 * @param resourceCleanup
 *                  Optional async function called inside each `it` before
 *                  and after, e.g. to seed a project and assert side effects.
 *                  Receives the route slug. Returns cleanup + a baseline
 *                  message count. When absent, no side-effect check runs.
 */
export function addRouteMutationTests(
  defs: RouteDef[],
  post: PostFn,
  resourceCleanup?: (slug: string) => Promise<{
    projectRoot?: string;
    cleanup: () => Promise<void>;
    baseline?: number;
  } | void>,
): void {
  for (const def of defs) {
    describe(`${def.route} validator mutations`, () => {
      it.each(def.cases)(
        'rejects malformed body (case: $rejectContains)',
        async (c: MutationCase) => {
          let scopeCleanup: (() => Promise<void>) | undefined;
          if (resourceCleanup) {
            const r = await resourceCleanup(def.route.replace(/[^a-z]/g, ''));
            if (r) {
              scopeCleanup = r.cleanup;
            }
          }
          try {
            const body = JSON.parse(JSON.stringify(def.validBody)) as Record<string, unknown>;
            c.mutate(body);
            const res = await post(def.route, body, {});
            expect(res.status, `expected 400 for ${c.rejectContains}`).toBe(400);
            const err = (res.json as { error?: { code?: string; message?: string } }).error;
            expect(err?.code, 'expected VALIDATION_ERROR').toBe('VALIDATION_ERROR');
            expect(err?.message ?? '', 'expected matching reject message').toContain(
              c.rejectContains,
            );
          } finally {
            if (scopeCleanup) await scopeCleanup();
          }
        },
      );
    });
  }
}
