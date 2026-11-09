import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type DispatchLogEntry,
  type DispatchOutcomeStatus,
  dispatchLogPath,
  recordDispatch,
  recordDispatchOutcome,
  summarizeDispatchLog,
} from '../src/dispatch-log.js';

const roots: string[] = [];

function newRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'ws-dispatch-log-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

const entry = (over: Partial<DispatchLogEntry> = {}): DispatchLogEntry => ({
  at: '2026-09-08T10:00:00.000Z',
  role: 'executor',
  source: 'description',
  ...over,
});

describe('recordDispatch', () => {
  it('appends one JSON line per spawn and omits absent fields', () => {
    const root = newRoot();
    recordDispatch(entry({ role: 'debugger', method: 'heuristic', confidence: 0.75 }), root);
    recordDispatch(entry({ role: 'planner', source: 'explicit-role' }), root);

    const lines = readFileSync(dispatchLogPath(root), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] as string)).toEqual({
      at: '2026-09-08T10:00:00.000Z',
      role: 'debugger',
      source: 'description',
      method: 'heuristic',
      confidence: 0.75,
    });
    // An explicit role never ran dispatch, so it carries no method/confidence
    // rather than a zero that would read as "the dispatcher was unsure".
    expect(JSON.parse(lines[1] as string)).not.toHaveProperty('method');
    expect(JSON.parse(lines[1] as string)).not.toHaveProperty('confidence');
  });

  it('never records the task description, only catalog-owned keywords', () => {
    const root = newRoot();
    recordDispatch(
      entry({ matched: ['sql migration', 'schema'], alternatives: ['database', 'backend'] }),
      root,
    );
    const raw = readFileSync(dispatchLogPath(root), 'utf8');
    expect(raw).toContain('sql migration');
    expect(JSON.parse(raw.trim())).not.toHaveProperty('description');
  });

  it('swallows filesystem failures rather than failing a spawn', () => {
    // A file where the agents directory should be: mkdir and append both fail.
    const root = newRoot();
    writeFileSync(path.join(root, '.wrongstack'), 'not a directory', 'utf8');
    expect(() => recordDispatch(entry(), root)).not.toThrow();
  });

  it('rotates a log that outgrows the size cap, keeping the newest lines', () => {
    const root = newRoot();
    // Seed an over-cap log directly. Growing one past 1 MiB through
    // `recordDispatch` cannot work as a loop condition: the call rotates on its
    // way out, so the observed size never stays above the cap.
    recordDispatch(entry({ role: 'seed' }), root);
    const padding = Array.from({ length: 6 }, (_, index) => `keyword-${'x'.repeat(64)}-${index}`);
    const fat = Array.from({ length: 4_000 }, (_, index) =>
      JSON.stringify({
        at: '2026-09-08T10:00:00.000Z',
        role: `role-${index}`,
        source: 'description',
        matched: padding,
      }),
    ).join('\n');
    writeFileSync(dispatchLogPath(root), `${fat}\n`, 'utf8');
    expect(statSync(dispatchLogPath(root)).size).toBeGreaterThan(1_024 * 1_024);

    recordDispatch(entry({ role: 'newest' }), root);

    const raw = readFileSync(dispatchLogPath(root), 'utf8');
    const after = raw.trim().split('\n');
    // Rotation lands under the cap even though these lines are long: a fixed
    // line count left this file above 1 MiB, so every append re-rotated.
    expect(Buffer.byteLength(raw, 'utf8')).toBeLessThanOrEqual(512 * 1_024);
    expect(JSON.parse(after.at(-1) as string).role).toBe('newest');
    // The dropped lines are the oldest ones, not an arbitrary slice: the kept
    // tail is contiguous and ends right before the newest entry.
    expect(JSON.parse(after.at(-2) as string).role).toBe('role-3999');
    const firstKept = Number(JSON.parse(after[0] as string).role.replace('role-', ''));
    expect(firstKept).toBe(4_000 - (after.length - 1));
  });

  it('does not rewrite the whole log on every append once rotated', () => {
    const root = newRoot();
    const longRole = 'payments-reconciliation-specialist';
    const long = entry({
      role: longRole,
      alternatives: Array.from({ length: 6 }, (_, index) => `${longRole}-${index}`),
      matched: ['reconciliation', 'settlement', 'ledger', 'payments', 'invoice', 'chargeback'],
      sessionId: '2026-10-01/sess_01M3PGGAZ6F4QPDYW814BX8KG6',
    });
    recordDispatch(long, root);
    const line = readFileSync(dispatchLogPath(root), 'utf8');
    // Over 420 bytes per line: past the point where 2,500 lines fit in the cap.
    expect(Buffer.byteLength(line, 'utf8')).toBeGreaterThan(420);
    writeFileSync(dispatchLogPath(root), line.repeat(Math.ceil((1_024 * 1_024 + 1) / line.length)));

    recordDispatch(long, root);
    expect(statSync(dispatchLogPath(root)).size).toBeLessThanOrEqual(512 * 1_024);
  });
});

describe('summarizeDispatchLog', () => {
  it('returns an empty summary when nothing has been recorded', () => {
    const summary = summarizeDispatchLog(newRoot());
    expect(summary.entries).toBe(0);
    expect(summary.roles).toEqual([]);
    expect(summary.totals.byMethod.fallback).toBe(0);
  });

  it('separates how a spawn was addressed from what decided it', () => {
    const root = newRoot();
    recordDispatch(entry({ role: 'reviewer', source: 'explicit-role' }), root);
    recordDispatch(entry({ role: 'executor', method: 'fallback', confidence: 0 }), root);
    recordDispatch(entry({ role: 'debugger', method: 'heuristic', confidence: 0.8 }), root);
    recordDispatch(entry({ role: 'bare', source: 'name-only' }), root);

    const summary = summarizeDispatchLog(root);
    expect(summary.entries).toBe(4);
    expect(summary.totals.bySource).toEqual({
      'explicit-role': 1,
      description: 2,
      'name-only': 1,
    });
    // Only the two dispatched spawns carry a method — the explicit role and the
    // bare name never reached the dispatcher at all.
    expect(summary.totals.byMethod).toEqual({ heuristic: 1, llm: 0, fallback: 1 });
  });

  it('counts runner-up roles the dispatcher weighed and passed over', () => {
    const root = newRoot();
    recordDispatch(entry({ role: 'executor', alternatives: ['database', 'backend'] }), root);
    recordDispatch(entry({ role: 'executor', alternatives: ['database'] }), root);

    const summary = summarizeDispatchLog(root);
    const database = summary.roles.find((row) => row.role === 'database');
    expect(database).toMatchObject({ spawns: 0, runnerUp: 2 });
    // The winner listing itself as an alternative must not inflate its own
    // runner-up count.
    expect(summary.roles.find((row) => row.role === 'executor')?.runnerUp).toBe(0);
  });

  it('averages confidence only over the spawns dispatch decided', () => {
    const root = newRoot();
    recordDispatch(entry({ role: 'test', method: 'heuristic', confidence: 1 }), root);
    recordDispatch(entry({ role: 'test', method: 'heuristic', confidence: 0.5 }), root);
    recordDispatch(entry({ role: 'test', source: 'explicit-role' }), root);

    const test = summarizeDispatchLog(root).roles.find((row) => row.role === 'test');
    expect(test?.spawns).toBe(3);
    expect(test?.avgConfidence).toBe(0.75);
  });

  it('skips a torn final line instead of failing the whole read', () => {
    const root = newRoot();
    recordDispatch(entry({ role: 'verifier' }), root);
    writeFileSync(dispatchLogPath(root), `${readFileSync(dispatchLogPath(root), 'utf8')}{"role":`, {
      encoding: 'utf8',
    });

    const summary = summarizeDispatchLog(root);
    expect(summary.entries).toBe(1);
    expect(summary.roles[0]?.role).toBe('verifier');
  });

  it('reports the observed time window', () => {
    const root = newRoot();
    recordDispatch(entry({ at: '2026-09-01T00:00:00.000Z' }), root);
    recordDispatch(entry({ at: '2026-09-08T00:00:00.000Z' }), root);
    recordDispatch(entry({ at: '2026-09-04T00:00:00.000Z' }), root);

    const summary = summarizeDispatchLog(root);
    expect(summary.since).toBe('2026-09-01T00:00:00.000Z');
    expect(summary.until).toBe('2026-09-08T00:00:00.000Z');
  });
});

describe('dispatch outcomes', () => {
  it('joins task outcomes to their spawn and grades the routing that made it', () => {
    const root = newRoot();
    recordDispatch(entry({ role: 'test', method: 'heuristic', subagentId: 'w1' }), root);
    recordDispatch(entry({ role: 'test', source: 'explicit-role', subagentId: 'w2' }), root);
    recordDispatch(entry({ role: 'executor', method: 'fallback', subagentId: 'w3' }), root);
    const outcome = (subagentId: string, status: DispatchOutcomeStatus, costUsd?: number) =>
      recordDispatchOutcome(
        {
          at: '2026-10-20T10:00:00.000Z',
          subagentId,
          status,
          costUsd,
          provider: 'p',
          model: 'm',
        },
        root,
      );
    outcome('w1', 'success', 0.25);
    outcome('w1', 'failed', 0.5);
    outcome('w2', 'success');
    outcome('w3', 'timeout');
    // An outcome whose spawn line was rotated away still counts for its role.
    recordDispatchOutcome(
      { at: '2026-10-20T10:00:00.000Z', subagentId: 'gone', role: 'test', status: 'stopped' },
      root,
    );

    const summary = summarizeDispatchLog(root);
    // Outcome lines are not spawns.
    expect(summary.entries).toBe(3);
    expect(summary.totals.outcomes).toBe(5);
    const test = summary.roles.find((row) => row.role === 'test');
    expect(test?.spawns).toBe(2);
    expect(test?.outcomes).toEqual({ success: 2, failed: 1, timeout: 0, stopped: 1 });
    expect(test?.costUsd).toBe(0.75);
    expect(test?.models).toEqual({ 'p/m': 3 });
    expect(summary.totals.outcomesByMethod.heuristic).toEqual({
      success: 1,
      failed: 1,
      timeout: 0,
      stopped: 0,
    });
    expect(summary.totals.outcomesByMethod.fallback.timeout).toBe(1);
    expect(summary.totals.outcomesBySource['explicit-role'].success).toBe(1);
  });

  it('writes the spawn subagentId so outcomes can find it', () => {
    const root = newRoot();
    recordDispatch(entry({ subagentId: 'w9' }), root);
    const line = JSON.parse(readFileSync(dispatchLogPath(root), 'utf8').trim());
    expect(line.subagentId).toBe('w9');
  });

  it('ignores prototype keys in source/method and counts model="toString" numerically (F760)', () => {
    const root = newRoot();
    recordDispatch(
      entry({
        role: 'explorer',
        source: 'toString' as never,
        method: 'valueOf' as never,
        subagentId: 'w-proto',
      }),
      root,
    );
    recordDispatchOutcome(
      {
        at: '2026-10-20T10:00:00.000Z',
        subagentId: 'w-proto',
        role: 'explorer',
        status: 'success',
        model: 'toString',
      },
      root,
    );
    const summary = summarizeDispatchLog(root);
    const explorer = summary.roles.find((r) => r.role === 'explorer');
    expect(explorer?.models['toString']).toBe(1);
    expect(Object.hasOwn(summary.totals.bySource, 'toString')).toBe(false);
    expect(Object.hasOwn(summary.totals.byMethod, 'valueOf')).toBe(false);
  });

  it('deduplicates runner-up alternatives, ignores non-finite confidence, and ignores negative outcome costUsd (F114)', () => {
    const root = newRoot();
    recordDispatch(
      entry({
        role: 'coder',
        method: 'heuristic',
        confidence: Number.NaN,
        alternatives: ['debugger', 'debugger', 'coder'],
        subagentId: 'sub-f114',
      }),
      root,
    );
    writeFileSync(
      dispatchLogPath(root),
      `${readFileSync(dispatchLogPath(root), 'utf8')}${JSON.stringify({
        kind: 'outcome',
        at: '2026-10-20T10:00:00.000Z',
        subagentId: 'sub-f114',
        role: 'coder',
        status: 'success',
        costUsd: -5,
      })}\n`,
      'utf8',
    );
    const summary = summarizeDispatchLog(root);
    const debuggerRole = summary.roles.find((r) => r.role === 'debugger');
    const coderRole = summary.roles.find((r) => r.role === 'coder');
    expect(debuggerRole?.runnerUp).toBe(1);
    expect(coderRole?.avgConfidence).toBeNull();
    expect(coderRole?.costUsd).toBe(0);
  });
});
