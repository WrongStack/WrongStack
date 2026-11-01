/**
 * Daily spend budgets — for the fleet, one project or one machine.
 *
 * The snapshot only knows what LIVE sessions cost, so a session that ended an
 * hour ago no longer counts there. Budgets read the persisted cost series
 * instead (the 5-minute buckets with their per-project and per-machine
 * breakdowns), summed over the last 24 hours.
 *
 * Each budget is its own rule (`budget-fleet-24h`, `budget-project:<id>`,
 * `budget-machine:<key>`), so two projects over budget are two alerts — each
 * snoozable, each notified once per episode.
 *
 * @module hq/alert-budgets
 */
import type { HqSnapshot } from './protocol.js';

/** Spend over the budget window, from the cost series. */
export interface HqAlertSpend {
  windowMs: number;
  totalUsd: number;
  byProject: ReadonlyMap<string, number>;
  byMachine: ReadonlyMap<string, number>;
}

export interface HqBudgetConfig {
  /** Fleet-wide spend allowed per 24 hours (USD). 0/absent = off. */
  dailyBudgetUsd?: number;
  /** projectId → spend allowed per 24 hours. */
  projectDailyBudgetsUsd?: Record<string, number>;
  /** machine key (`host:<hostname>`) → spend allowed per 24 hours. */
  machineDailyBudgetsUsd?: Record<string, number>;
}

export const HQ_BUDGET_WINDOW_MS = 24 * 60 * 60_000;
export const HQ_MAX_BUDGETS_PER_SCOPE = 200;

const BUDGET_RULE =
  /^(budget-fleet-24h|budget-project:.{1,200}|budget-machine:(host|mid):.{1,255})$/;

export function isBudgetRuleId(ruleId: string): boolean {
  return BUDGET_RULE.test(ruleId);
}

function positive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/** Keep only well-formed, positive entries (the map is operator input). */
export function sanitizeBudgetMap(raw: unknown, keyPattern: RegExp): Record<string, number> {
  const out: Record<string, number> = {};
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return out;
  let count = 0;
  for (const [key, value] of Object.entries(raw)) {
    if (count >= HQ_MAX_BUDGETS_PER_SCOPE) break;
    if (!keyPattern.test(key) || !positive(value)) continue;
    Object.defineProperty(out, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
    count += 1;
  }
  return out;
}

// Project ids are folder names ("My Project" is ordinary), so only control
// characters are refused; the keys are map keys, never paths.
export const PROJECT_BUDGET_KEY = /^[^\u0000-\u001f]{1,200}$/;
export const MACHINE_BUDGET_KEY = /^(host|mid):[^\u0000-\u001f]{1,255}$/;

/** Is this budget rule backed by a budget in the config? */
export function isConfiguredBudgetRule(
  ruleId: string,
  config: HqBudgetConfig | undefined,
): boolean {
  if (ruleId === 'budget-fleet-24h') return positive(config?.dailyBudgetUsd);
  const own = (map: Record<string, number> | undefined, key: string): boolean =>
    map !== undefined && Object.hasOwn(map, key) && positive(map[key]);
  if (ruleId.startsWith('budget-project:')) {
    return own(config?.projectDailyBudgetsUsd, ruleId.slice('budget-project:'.length));
  }
  if (ruleId.startsWith('budget-machine:')) {
    return own(config?.machineDailyBudgetsUsd, ruleId.slice('budget-machine:'.length));
  }
  return false;
}

/** Entries of an operator's budget map that would be dropped, and why. */
export function rejectedBudgetEntries(raw: unknown, keyPattern: RegExp): string[] {
  if (raw === undefined || raw === null) return [];
  if (typeof raw !== 'object' || Array.isArray(raw)) return ['(not an object)'];
  return Object.entries(raw)
    .filter(
      ([key, value]) =>
        !keyPattern.test(key) || typeof value !== 'number' || !Number.isFinite(value) || value < 0,
    )
    .map(([key]) => key);
}

const usd = (value: number): string => `$${value.toFixed(2)}`;

export interface HqBudgetFiring {
  ruleId: string;
  message: string;
}

/** Every budget the last 24 hours crossed. */
export function evaluateBudgets(
  snapshot: HqSnapshot | null,
  config: HqBudgetConfig,
  spend: HqAlertSpend | undefined,
): HqBudgetFiring[] {
  if (spend === undefined) return [];
  const out: HqBudgetFiring[] = [];
  if (positive(config.dailyBudgetUsd) && spend.totalUsd >= config.dailyBudgetUsd) {
    out.push({
      ruleId: 'budget-fleet-24h',
      message: `Fleet spent ${usd(spend.totalUsd)} in the last 24h (budget ${usd(config.dailyBudgetUsd)})`,
    });
  }
  const projectName = (id: string): string =>
    snapshot?.projects.find((project) => project.projectId === id)?.projectName ?? id;
  for (const [projectId, budget] of Object.entries(config.projectDailyBudgetsUsd ?? {})) {
    const spent = spend.byProject.get(projectId) ?? 0;
    if (positive(budget) && spent >= budget) {
      out.push({
        ruleId: `budget-project:${projectId}`,
        message: `Project ${projectName(projectId)} spent ${usd(spent)} in the last 24h (budget ${usd(budget)})`,
      });
    }
  }
  for (const [key, budget] of Object.entries(config.machineDailyBudgetsUsd ?? {})) {
    const spent = spend.byMachine.get(key) ?? 0;
    if (positive(budget) && spent >= budget) {
      out.push({
        ruleId: `budget-machine:${key}`,
        message: `Machine ${key.replace(/^(host|mid):/, '')} spent ${usd(spent)} in the last 24h (budget ${usd(budget)})`,
      });
    }
  }
  return out;
}
