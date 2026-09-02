import { describe, expect, it } from 'vitest';
import {
  acceptMailboxMessageForSession,
  acceptMailboxMessageForSessionSync,
  type MailboxMessage,
} from '../../src/coordination/mailbox-types.js';

const baseMessage: Pick<MailboxMessage, 'type' | 'sessionAffinity'> = {
  type: 'result',
};

describe('acceptMailboxMessageForSession', () => {
  it('accepts ordinary result and review messages without a Chimera session-affinity token', async () => {
    await expect(
      acceptMailboxMessageForSession({ ...baseMessage, type: 'result' }, 'session-1'),
    ).resolves.toBe(true);
    await expect(
      acceptMailboxMessageForSession({ ...baseMessage, type: 'review' }, 'session-1'),
    ).resolves.toBe(true);
  });

  it('rejects an explicit mismatching session id before report-id fallback', async () => {
    const resolverCalls: string[] = [];

    const accepted = await acceptMailboxMessageForSession(
      {
        ...baseMessage,
        sessionAffinity: {
          sessionId: 'stale-session',
          reportId: 'report-1',
          kind: 'chimera.review',
        },
      },
      'session-1',
      {
        allowUnscoped: true,
        resolveChimeraReportSessionId: (reportId) => {
          resolverCalls.push(reportId);
          return 'session-1';
        },
      },
    );

    expect(accepted).toBe(false);
    expect(resolverCalls).toEqual([]);
  });

  it('uses report-id fallback only for legacy tokens without an explicit session id', async () => {
    const accepted = await acceptMailboxMessageForSession(
      {
        ...baseMessage,
        sessionAffinity: {
          reportId: 'report-1',
          kind: 'chimera.review',
        },
      },
      'session-1',
      {
        resolveChimeraReportSessionId: (reportId) =>
          reportId === 'report-1' ? 'session-1' : undefined,
      },
    );

    expect(accepted).toBe(true);
  });

  it('rejects mismatching session ids in the synchronous helper even when legacy unscoped fallback is enabled', () => {
    const accepted = acceptMailboxMessageForSessionSync(
      {
        ...baseMessage,
        sessionAffinity: {
          sessionId: 'stale-session',
          reportId: 'report-1',
          kind: 'chimera.review',
        },
      },
      'session-1',
      {
        allowUnscoped: true,
        resolveChimeraReportSessionId: () => 'session-1',
      },
    );

    expect(accepted).toBe(false);
  });

  // ── Malformed persisted affinity shape ───────────────────────────────
  // The SQLite read path (JSON.parse without per-field validation) can
  // surface sessionAffinity: null, arrays, or primitives. These must
  // ALWAYS fail closed, even when allowUnscoped is true.

  it('rejects a null affinity token even when allowUnscoped is true (async)', async () => {
    const accepted = await acceptMailboxMessageForSession(
      { ...baseMessage, sessionAffinity: null as unknown as MailboxMessage['sessionAffinity'] },
      'session-1',
      { allowUnscoped: true },
    );
    expect(accepted).toBe(false);
  });

  it('rejects an array affinity token even when allowUnscoped is true (async)', async () => {
    const accepted = await acceptMailboxMessageForSession(
      { ...baseMessage, sessionAffinity: [] as unknown as MailboxMessage['sessionAffinity'] },
      'session-1',
      { allowUnscoped: true },
    );
    expect(accepted).toBe(false);
  });

  it('rejects a primitive affinity token even when allowUnscoped is true (async)', async () => {
    const accepted = await acceptMailboxMessageForSession(
      { ...baseMessage, sessionAffinity: 42 as unknown as MailboxMessage['sessionAffinity'] },
      'session-1',
      { allowUnscoped: true },
    );
    expect(accepted).toBe(false);
  });

  it('rejects a null affinity token in the sync helper', () => {
    const accepted = acceptMailboxMessageForSessionSync(
      { ...baseMessage, sessionAffinity: null as unknown as MailboxMessage['sessionAffinity'] },
      'session-1',
      { allowUnscoped: true },
    );
    expect(accepted).toBe(false);
  });

  // ── Resolved-mismatch is non-overridable ─────────────────────────────
  // When the resolver returns a sessionId that does NOT match the current
  // session, the message must be rejected — even if allowUnscoped is true.
  // This prevents a report belonging to session B from being delivered to
  // session A just because A opted into legacy compatibility.

  it('rejects resolved-mismatch reportId even when allowUnscoped is true (async)', async () => {
    const accepted = await acceptMailboxMessageForSession(
      {
        ...baseMessage,
        sessionAffinity: { reportId: 'report-2', kind: 'chimera.review' },
      },
      'session-1',
      {
        allowUnscoped: true,
        resolveChimeraReportSessionId: () => 'session-other',
      },
    );
    expect(accepted).toBe(false);
  });

  it('rejects resolved-mismatch reportId in the sync helper', () => {
    const accepted = acceptMailboxMessageForSessionSync(
      {
        ...baseMessage,
        sessionAffinity: { reportId: 'report-2', kind: 'chimera.review' },
      },
      'session-1',
      {
        allowUnscoped: true,
        resolveChimeraReportSessionId: () => 'session-other',
      },
    );
    expect(accepted).toBe(false);
  });

  // ── Resolver error falls through to allowUnscoped ───────────────────
  // A throwing resolver is a transient failure (file locked, mid-compaction).
  // Unlike a resolved-mismatch, this does NOT establish that the message
  // belongs to another session — so allowUnscoped MAY accept it.

  it('allows message via allowUnscoped when the resolver throws (async)', async () => {
    const accepted = await acceptMailboxMessageForSession(
      {
        ...baseMessage,
        sessionAffinity: { reportId: 'report-3', kind: 'chimera.review' },
      },
      'session-1',
      {
        allowUnscoped: true,
        resolveChimeraReportSessionId: () => {
          throw new Error('JSONL store locked');
        },
      },
    );
    expect(accepted).toBe(true);
  });

  it('rejects message when the resolver throws and allowUnscoped is false (async)', async () => {
    const accepted = await acceptMailboxMessageForSession(
      {
        ...baseMessage,
        sessionAffinity: { reportId: 'report-4', kind: 'chimera.review' },
      },
      'session-1',
      {
        allowUnscoped: false,
        resolveChimeraReportSessionId: () => {
          throw new Error('JSONL store locked');
        },
      },
    );
    expect(accepted).toBe(false);
  });

  // ── Unknown reportId (resolver returns undefined) ────────────────────

  it('allows message via allowUnscoped when resolver returns undefined for unknown reportId', async () => {
    const accepted = await acceptMailboxMessageForSession(
      {
        ...baseMessage,
        sessionAffinity: { reportId: 'unknown-report', kind: 'chimera.review' },
      },
      'session-1',
      {
        allowUnscoped: true,
        resolveChimeraReportSessionId: () => undefined,
      },
    );
    expect(accepted).toBe(true);
  });

  it('rejects message when resolver returns undefined and allowUnscoped is false', async () => {
    const accepted = await acceptMailboxMessageForSession(
      {
        ...baseMessage,
        sessionAffinity: { reportId: 'unknown-report', kind: 'chimera.review' },
      },
      'session-1',
      {
        allowUnscoped: false,
        resolveChimeraReportSessionId: () => undefined,
      },
    );
    expect(accepted).toBe(false);
  });

  // ── No currentSessionId ──────────────────────────────────────────────

  it('fails closed when no currentSessionId and no affinity token', async () => {
    const accepted = await acceptMailboxMessageForSession({ ...baseMessage }, undefined);
    expect(accepted).toBe(true); // no token → not affected → accept
  });

  it('fails closed when no currentSessionId and affinity token present, no allowUnscoped', async () => {
    const accepted = await acceptMailboxMessageForSession(
      {
        ...baseMessage,
        sessionAffinity: { sessionId: 'some-session' },
      },
      undefined,
    );
    expect(accepted).toBe(false);
  });

  it('accepts via allowUnscoped when no currentSessionId and affinity token present', async () => {
    const accepted = await acceptMailboxMessageForSession(
      {
        ...baseMessage,
        sessionAffinity: { sessionId: 'some-session' },
      },
      undefined,
      { allowUnscoped: true },
    );
    expect(accepted).toBe(true);
  });
});
