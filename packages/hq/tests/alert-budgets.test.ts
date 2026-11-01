import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HqAlertSpend } from '../src/alert-budgets.js';
import { HqAlertEngine } from '../src/alerts.js';
import { parseHqAlertThresholds } from '../src/alerts-config.js';
import { HqTimeseriesStore } from '../src/persistence/timeseries-store.js';
import type { HqSnapshot } from '../src/protocol.js';

const snapshot = {
  generatedAt: new Date().toISOString(),
  clients: [],
  projects: [{ projectId: 'p-data', projectName: 'Datapipe' }],
  sessions: [],
  fleets: [],
  mailboxes: [],
  totals: { totalCostUsd: 0 },
} as unknown as HqSnapshot;

const spend = (
  totalUsd: number,
  projects: [string, number][],
  machines: [string, number][],
): HqAlertSpend => ({
  windowMs: 86_400_000,
  totalUsd,
  byProject: new Map(projects),
  byMachine: new Map(machines),
});

describe('daily budgets', () => {
  it('fires one alert per budget crossed, named after the project or machine', () => {
    const fired: string[] = [];
    const engine = new HqAlertEngine({
      onAlert: (alert) => fired.push(`${alert.ruleId}|${alert.message}`),
    });
    const config = {
      dailyBudgetUsd: 20,
      projectDailyBudgetsUsd: { 'p-data': 5, 'p-quiet': 5 },
      machineDailyBudgetsUsd: { 'host:lab-02': 3 },
    };
    engine.evaluate(snapshot, config, 1, {
      spend: spend(
        12,
        [
          ['p-data', 7.5],
          ['p-quiet', 1],
        ],
        [['host:lab-02', 3]],
      ),
    });
    expect(fired).toEqual([
      'budget-project:p-data|Project Datapipe spent $7.50 in the last 24h (budget $5.00)',
      'budget-machine:host:lab-02|Machine lab-02 spent $3.00 in the last 24h (budget $3.00)',
    ]);

    // Still over: no repeat. The fleet crosses too: a separate alert.
    engine.evaluate(snapshot, config, 2, {
      spend: spend(25, [['p-data', 8]], [['host:lab-02', 3]]),
    });
    expect(fired).toHaveLength(3);
    expect(fired[2]).toBe('budget-fleet-24h|Fleet spent $25.00 in the last 24h (budget $20.00)');
    expect(
      engine
        .activeAlerts()
        .map((alert) => alert.ruleId)
        .sort(),
    ).toEqual(['budget-fleet-24h', 'budget-machine:host:lab-02', 'budget-project:p-data']);
  });

  it('lets a budget rule be snoozed, but still refuses an unknown rule', () => {
    const engine = new HqAlertEngine({ onAlert: () => undefined });
    expect(engine.snooze('budget-project:p-data', 10_000, 0).effectiveUntilMs).toBe(10_000);
    expect(() => engine.snooze('budget-typo', 10_000, 0)).toThrow(/Unknown alert rule/);
    const fired: string[] = [];
    const muted = new HqAlertEngine({ onAlert: (alert) => fired.push(alert.ruleId) });
    muted.snooze('budget-project:p-data', 10_000, 0);
    muted.evaluate(snapshot, { projectDailyBudgetsUsd: { 'p-data': 1 } }, 5, {
      spend: spend(9, [['p-data', 9]], []),
    });
    expect(fired).toEqual([]);
  });
});

describe('parseHqAlertThresholds', () => {
  it('keeps valid fields, accepts real project ids and refuses a budget it cannot apply', () => {
    expect(
      parseHqAlertThresholds({
        costThresholdUsd: 100,
        staleMachineSeconds: null,
        projectDailyBudgetsUsd: { 'p-data': 5, 'My Project': 5, 'p-zero': 0 },
        machineDailyBudgetsUsd: { 'host:lab': 2 },
      }),
    ).toEqual({
      ok: true,
      thresholds: {
        costThresholdUsd: 100,
        projectDailyBudgetsUsd: { 'p-data': 5, 'My Project': 5 },
        machineDailyBudgetsUsd: { 'host:lab': 2 },
      },
    });
    // Refused, not silently dropped: the dashboard would say "Saved".
    expect(parseHqAlertThresholds({ machineDailyBudgetsUsd: { lab: 2 } })).toMatchObject({
      ok: false,
    });
    expect(parseHqAlertThresholds({ projectDailyBudgetsUsd: { p: -1 } })).toMatchObject({
      ok: false,
    });
    expect(parseHqAlertThresholds({ staleMachineSeconds: 1 })).toMatchObject({ ok: false });
    expect(parseHqAlertThresholds({ costThresholdUsd: '5' })).toMatchObject({ ok: false });
    // A "__proto__" key is stored as plain data, never as the prototype.
    const parsed = parseHqAlertThresholds({
      projectDailyBudgetsUsd: JSON.parse('{"__proto__": 4}'),
    });
    const budgets = parsed.ok ? parsed.thresholds.projectDailyBudgetsUsd : undefined;
    expect(Object.getPrototypeOf(budgets)).toBe(Object.prototype);
    expect(Object.getOwnPropertyDescriptor(budgets, '__proto__')?.value).toBe(4);
  });
});

describe('HqTimeseriesStore.spendSince', () => {
  let dataDir: string;
  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hq-spend-'));
  });
  afterEach(async () => {
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  it('sums the window per project and per machine', () => {
    const store = new HqTimeseriesStore({ dataDir });
    const now = Date.now();
    store.record({
      ts: now - 25 * 3_600_000,
      costUsd: 9,
      projectId: 'p-data',
      machineKey: 'host:lab',
    });
    store.record({ ts: now - 3_600_000, costUsd: 2, projectId: 'p-data', machineKey: 'host:lab' });
    store.record({ ts: now, costUsd: 0.5, projectId: 'p-web', machineKey: 'host:desk' });
    const spent = store.spendSince(now - 24 * 3_600_000);
    expect(spent.totalUsd).toBeCloseTo(2.5);
    expect(Object.fromEntries(spent.byProject)).toEqual({ 'p-data': 2, 'p-web': 0.5 });
    expect(Object.fromEntries(spent.byMachine)).toEqual({ 'host:lab': 2, 'host:desk': 0.5 });
  });
});
