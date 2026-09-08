import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type DispatchLogEntry,
  dispatchLogPath,
  recordDispatch,
  summarizeDispatchLog,
} from '../../src/coordination/agents/dispatch-log.js';

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

    const after = readFileSync(dispatchLogPath(root), 'utf8').trim().split('\n');
    expect(after).toHaveLength(2_500);
    expect(JSON.parse(after.at(-1) as string).role).toBe('newest');
    // The dropped lines are the oldest ones, not an arbitrary slice.
    expect(JSON.parse(after[0] as string).role).toBe('role-1501');
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
