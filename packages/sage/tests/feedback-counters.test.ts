import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InjectionTracker } from '../src/middleware/injection-tracker.js';
import { createSageTurnMiddleware } from '../src/middleware/turn-memory.js';
import { isSqliteAvailable, SqliteSageStore } from '../src/sqlite-store.js';
import type { Sage } from '../src/types.js';

let tempDir: string;
let current: Date;

const T0 = '2026-01-01T00:00:00.000Z';

function advance(ms: number): void {
  current = new Date(current.getTime() + ms);
}

const DAY = 24 * 60 * 60_000;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wrongstack-feedback-'));
  current = new Date(T0);
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe('InjectionTracker', () => {
  const TEXT = 'Use pnpm for installing dependencies in this repo';

  it('matches a referencing assistant message exactly once (consume-once)', () => {
    const tracker = new InjectionTracker();
    tracker.record('mem_a', TEXT);

    expect(tracker.consumeMatches('I will use pnpm for installing dependencies now.')).toEqual([
      'mem_a',
    ]);
    expect(tracker.consumeMatches('I will use pnpm for installing dependencies now.')).toEqual([]);
  });

  it('matches an explicit memory id citation without restating the body', () => {
    const tracker = new InjectionTracker();
    tracker.record('01HMEMORYIDEXPLICIT01', TEXT);

    expect(
      tracker.consumeMatches('Following memory 01HMEMORYIDEXPLICIT01 for the install path.'),
    ).toEqual(['01HMEMORYIDEXPLICIT01']);
  });

  it('does not match unrelated assistant text', () => {
    const tracker = new InjectionTracker();
    tracker.record('mem_a', TEXT);

    expect(
      tracker.consumeMatches('The database migration failed with a constraint error.'),
    ).toEqual([]);
  });

  it('ignores memories too short to be a trustworthy signal', () => {
    const tracker = new InjectionTracker();
    tracker.record('mem_short', 'Use pnpm');

    expect(tracker.consumeMatches('I will use pnpm now.')).toEqual([]);
  });

  it('rejects ratio-only matches below the absolute token floor (false-positive guard)', () => {
    // 4-token memory + 2 shared tokens hits the default 0.5 ratio, but is too
    // weak a signal for recordUse without an explicit id citation.
    const tracker = new InjectionTracker({ minTokens: 4, minMatchTokens: 3 });
    tracker.record('mem_weak', 'use pnpm for installs');

    expect(tracker.consumeMatches('I will use pnpm tomorrow.')).toEqual([]);
    // Three shared tokens with high ratio is accepted.
    expect(tracker.consumeMatches('Please use pnpm for installs today.')).toEqual(['mem_weak']);
  });

  it('expires tracked injections after the TTL', () => {
    const tracker = new InjectionTracker({ ttlMs: 1_000 });
    tracker.record('mem_a', TEXT, 5_000);

    expect(
      tracker.consumeMatches('I will use pnpm for installing dependencies now.', 7_000),
    ).toEqual([]);
  });

  it('reports exact provider-context entry and exit independently from use attribution', () => {
    const tracker = new InjectionTracker();
    tracker.record('mem_a', TEXT, 5_000, 'sess_a');
    tracker.consumeMatches('I will use pnpm for installing dependencies now.', 5_100);

    expect(tracker.snapshotContext(`tool result\n${TEXT}`, 'sess_a', 5_200)).toEqual({
      activeMemoryIds: ['mem_a'],
      enteredMemoryIds: ['mem_a'],
      exitedMemoryIds: [],
    });
    expect(
      tracker.snapshotContext('compacted summary without the raw hint', 'sess_a', 5_300),
    ).toEqual({
      activeMemoryIds: [],
      enteredMemoryIds: [],
      exitedMemoryIds: ['mem_a'],
    });
  });

  it('tracks the rendered prefix when the provider-visible memory line was truncated', () => {
    const tracker = new InjectionTracker({ minTokens: 4 });
    const fullText =
      'Authentication middleware validates bearer tokens before every protected route';
    const rendered = '--- SAGE ---\n- [fact] Authentication middleware validates bearer tokens…';
    tracker.record('mem_truncated', fullText, 1_000, 'session-a', rendered);

    expect(tracker.snapshotContext(rendered, 'session-a', 1_001)).toEqual({
      activeMemoryIds: ['mem_truncated'],
      enteredMemoryIds: ['mem_truncated'],
      exitedMemoryIds: [],
    });
  });

  it('keeps provider-context tracking after use attribution is consumed', () => {
    // Use attribution (entries) and provider-context presence (contextEntries)
    // are independent maps — consumeMatches must not erase context presence.
    const tracker = new InjectionTracker();
    tracker.record('mem_a', TEXT, 1_000, 'sess');
    expect(
      tracker.consumeMatches('I will use pnpm for installing dependencies now.', 1_200),
    ).toEqual(['mem_a']);
    expect(tracker.snapshotContext(TEXT, 'sess', 1_300).activeMemoryIds).toEqual(['mem_a']);
  });
});

describe('createSageTurnMiddleware feedback loop', () => {
  const memory: Sage = {
    id: 'mem_feedback',
    revision: 1,
    scope: 'project',
    kind: 'convention',
    status: 'active',
    text: 'Always run lifecycle tests with pnpm vitest before committing.',
    importance: 0.95,
    confidence: 0.95,
    freshness: 0.9,
    tags: [],
    anchors: [],
    sources: [],
    createdAt: T0,
    updatedAt: T0,
  };

  function makeService() {
    return {
      searchSage: vi.fn(async (query: string) => (query.includes('lifecycle') ? [memory] : [])),
      recordInjection: vi.fn(async () => {}),
      recordUse: vi.fn(async () => {}),
    };
  }

  it('credits recordUse when the next assistant message references an injected memory', async () => {
    const service = makeService();
    const tracker = new InjectionTracker();
    const middleware = createSageTurnMiddleware({ memory: service, tracker });

    const turn1 = {
      model: 'test',
      system: [],
      messages: [{ role: 'user' as const, content: 'How do I run the lifecycle tests?' }],
    };
    const injected = await middleware.handler(turn1 as never, async (next) => next);
    expect(service.recordInjection).toHaveBeenCalledWith(['mem_feedback'], 'turn_context');
    expect(injected.system?.some((block) => block.text.includes('pnpm vitest'))).toBe(true);

    const turn2 = {
      model: 'test',
      system: injected.system,
      messages: [
        { role: 'user' as const, content: 'How do I run the lifecycle tests?' },
        {
          role: 'assistant' as const,
          content: 'I will run lifecycle tests with pnpm vitest now before committing.',
        },
        { role: 'user' as const, content: 'Thanks.' },
      ],
    };
    await middleware.handler(turn2 as never, async (next) => next);

    expect(service.recordUse).toHaveBeenCalledTimes(1);
    expect(service.recordUse).toHaveBeenCalledWith(['mem_feedback'], 'assistant_reference');
  });

  it('does not credit a use when the assistant ignores the injection', async () => {
    const service = makeService();
    const tracker = new InjectionTracker();
    const middleware = createSageTurnMiddleware({ memory: service, tracker });

    const turn1 = {
      model: 'test',
      system: [],
      messages: [{ role: 'user' as const, content: 'How do I run the lifecycle tests?' }],
    };
    await middleware.handler(turn1 as never, async (next) => next);

    const turn2 = {
      model: 'test',
      system: [],
      messages: [
        { role: 'user' as const, content: 'How do I run the lifecycle tests?' },
        {
          role: 'assistant' as const,
          content: 'The database migration failed with a constraint error.',
        },
        { role: 'user' as const, content: 'Thanks.' },
      ],
    };
    await middleware.handler(turn2 as never, async (next) => next);

    expect(service.recordUse).not.toHaveBeenCalled();
  });
});

describe.skipIf(!isSqliteAvailable())('SqliteSageStore feedback counters', () => {
  let sqliteStores: SqliteSageStore[] = [];

  beforeEach(() => {
    sqliteStores = [];
  });

  afterEach(async () => {
    for (const store of sqliteStores) {
      try {
        store.close();
      } catch {
        /* already closed */
      }
    }
    // Give Windows a tick to release WAL file handles
    await new Promise((resolve) => setTimeout(resolve, 10));
  });

  function makeSqliteStore(): SqliteSageStore {
    const store = new SqliteSageStore({ projectRoot: tempDir, now: () => current });
    sqliteStores.push(store);
    return store;
  }

  it('applies counter increments immediately (no batching throttle)', async () => {
    const store = makeSqliteStore();
    const memory = await store.rememberSage({ text: 'Use pnpm for all package operations.' });

    await store.recordInjection([memory.id], 'turn_context');
    await store.recordInjection([memory.id], 'tool:read');
    await store.recordUse([memory.id], 'assistant_reference');

    const [loaded] = await store.listMemories({ status: 'active', limit: 10 });
    expect(loaded?.injectionCount).toBe(2);
    expect(loaded?.useCount).toBe(1);
    expect(loaded?.lastUsedAt).toBe(current.toISOString());
    expect(loaded?.lastAccessedAt).toBe(current.toISOString());
  });

  it('does not advance updated_at on injection/use (content recency clock)', async () => {
    const store = makeSqliteStore();
    const memory = await store.rememberSage({ text: 'Use pnpm for all package operations.' });
    const createdUpdatedAt = memory.updatedAt;

    await store.recordInjection([memory.id], 'tool:read');
    await store.recordUse([memory.id], 'assistant_reference');

    const [loaded] = await store.listMemories({ status: 'active', limit: 10 });
    // Feedback bookkeeping must not pollute the content recency clock used by
    // pagination ordering and retention aging.
    expect(loaded?.updatedAt).toBe(createdUpdatedAt);
    expect(loaded?.injectionCount).toBe(1);
    expect(loaded?.useCount).toBe(1);
  });

  it('skips corrupt SQLite rows while recording injection counters', async () => {
    const store = makeSqliteStore();
    await store.initialize();
    const db = (store as unknown as { db: import('node:sqlite').DatabaseSync }).db;
    // The production store can encounter corrupt rows from legacy/crash recovery.
    // Drop FTS triggers in this fixture so SQLite allows seeding malformed JSON;
    // the assertion below targets recordInjection's json_valid guard, not FTS.
    db.exec('DROP TRIGGER IF EXISTS memories_ai; DROP TRIGGER IF EXISTS memories_au;');
    db.prepare(
      `INSERT INTO memories
        (id, data, status, kind, scope, legacy_scope, importance, confidence, freshness, updated_at, created_at, audience, tags, canonical_text)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'corrupt-counter-row',
      '{broken',
      'active',
      'fact',
      'project',
      'project-memory',
      0.8,
      0.8,
      1,
      current.toISOString(),
      current.toISOString(),
      null,
      '[]',
      'broken',
    );

    await expect(
      store.recordInjection(['corrupt-counter-row'], 'turn_context'),
    ).resolves.toBeUndefined();
  });

  it('SQLite hygiene currently does NOT auto-archive — report fields reflect zero', async () => {
    // SQLite backend's hygiene() is a separate implementation that was already
    // a near-stub before the redesign (it never had the unused-rule code-path
    // that the JSONL store's hygieneUnlocked had). The redesigned JSONL
    // pipeline (no auto-archive, only review candidates) is the source of
    // truth — the SQLite report's `archived`/`archivedUnused` fields are
    // intentionally zero to mirror the new contract. A full parity follow-up
    // is tracked separately; this test pins the *current* contract surface.
    const store = makeSqliteStore();
    const memory = await store.rememberSage({ text: 'Use pnpm for all package operations.' });

    advance(40 * DAY);
    for (let i = 0; i < 10; i++) {
      await store.recordInjection([memory.id], 'turn_context');
    }

    const report = await store.hygiene({ archiveUnusedAfterDays: 30, unusedMinInjections: 10 });
    expect(report.archivedUnused).toBe(0);
    expect(report.archived).toBe(0);
    expect(report.deleted).toBe(0);

    // Memory status must NOT change — same invariant as the JSONL store.
    const refreshed = await store.listMemories({ status: 'active', limit: 100 });
    expect(refreshed.some((item) => item.id === memory.id)).toBe(true);
  });

  it('does not cross-attribute use between concurrent sessions (P1-7)', () => {
    const tracker = new InjectionTracker();
    const SESSION_A = 'session-alpha';
    const SESSION_B = 'session-beta';

    // Session A records an injection
    tracker.record(
      'mem_a',
      'Use pnpm for installing dependencies in this repo',
      Date.now(),
      SESSION_A,
    );
    // Session B records a different injection with overlapping vocabulary
    tracker.record('mem_b', 'Use pnpm for running tests in this repo', Date.now(), SESSION_B);

    // Session A's assistant references the dependency install path.
    // consumeMatches with sessionId=A should only match mem_a, not mem_b.
    const matchedA = tracker.consumeMatches(
      'I will use pnpm for installing dependencies now.',
      Date.now(),
      SESSION_A,
    );
    expect(matchedA).toEqual(['mem_a']);
    expect(matchedA).not.toContain('mem_b');

    // Session B's assistant references the test path.
    // consumeMatches with sessionId=B should only match mem_b, not mem_a
    // (mem_a was already consumed for session A, but even without that,
    // it would be filtered out because it belongs to a different session).
    const matchedB = tracker.consumeMatches(
      'I will use pnpm for running tests now.',
      Date.now(),
      SESSION_B,
    );
    expect(matchedB).toEqual(['mem_b']);
    expect(matchedB).not.toContain('mem_a');
  });

  it('falls back to unscoped matching when sessionId is omitted (backward compat)', () => {
    const tracker = new InjectionTracker();
    tracker.record(
      'mem_a',
      'Use pnpm for installing dependencies in this repo',
      Date.now(),
      'some-session',
    );

    // No sessionId → matches any entry regardless of session ownership.
    expect(tracker.consumeMatches('I will use pnpm for installing dependencies now.')).toEqual([
      'mem_a',
    ]);
  });
});
