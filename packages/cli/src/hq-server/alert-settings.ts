/**
 * Alert thresholds, budgets and snoozes the operator edits from the dashboard.
 *
 * Two sources, one effective config: `auth.json` `alertRules` (hand-edited,
 * live-reloaded) is the base, and `alerts-config.json` `thresholds` — written
 * by the dashboard — overrides it field by field. Snoozes live in
 * `alerts-config.json` too, so a muted rule stays muted across a restart.
 *
 * @module hq-server/alert-settings
 */

import { toErrorMessage } from '@wrongstack/core/utils';
import {
  HQ_BUDGET_WINDOW_MS,
  type HqAlertContext,
  type HqAlertEngine,
  type HqAlertRuleConfig,
  type HqTimeseriesStore,
  isBudgetRuleId,
  isConfiguredBudgetRule,
  mutateHqAlertsConfig,
  parseHqAlertThresholds,
  readHqAlertsConfig,
} from '@wrongstack/hq';

/** Longest single snooze an operator may ask for from the dashboard. */
const MAX_SNOOZE_MINUTES = 24 * 60;

export interface HqAlertSettingsView {
  /** Thresholds the dashboard saved (override `auth.json`). */
  thresholds: HqAlertRuleConfig;
  /** `auth.json` `alertRules`, shown so the operator sees the base. */
  base: HqAlertRuleConfig;
  /** ruleId → epoch ms the snooze ends. */
  snoozes: Record<string, number>;
  /** Spend over the budget window, for "spent / budget" next to each budget. */
  spend24h: {
    totalUsd: number;
    byProject: Record<string, number>;
    byMachine: Record<string, number>;
  };
}

export type HqAlertSettingsOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; error: string };

export interface HqAlertSettings {
  load(): Promise<void>;
  config(): HqAlertRuleConfig | undefined;
  context(): HqAlertContext;
  view(): HqAlertSettingsView;
  updateThresholds(input: unknown): Promise<HqAlertSettingsOutcome<HqAlertSettingsView>>;
  snooze(ruleId: string, minutes: unknown): Promise<HqAlertSettingsOutcome<{ until: number }>>;
  unsnooze(ruleId: string): Promise<HqAlertSettingsOutcome<{ unsnoozed: boolean }>>;
}

function entries(map: ReadonlyMap<string, number>): Record<string, number> {
  // Keys are client data: never let one become a prototype setter.
  return Object.fromEntries(map);
}

export function createHqAlertSettings(deps: {
  dataDir: string;
  engine: HqAlertEngine;
  timeseries: HqTimeseriesStore;
  baseRules: () => HqAlertRuleConfig | undefined;
  /** Thresholds changed (saved or loaded): health verdicts on the snapshot move. */
  onThresholdsChanged?: (() => void) | undefined;
}): HqAlertSettings {
  let thresholds: HqAlertRuleConfig = {};

  const spend = () => deps.timeseries.spendSince(Date.now() - HQ_BUDGET_WINDOW_MS);

  const persistSnoozes = async (): Promise<void> => {
    const snoozes = deps.engine.snoozesSnapshot();
    await mutateHqAlertsConfig(deps.dataDir, (file) => ({ ...file, snoozes }));
  };

  return {
    async load() {
      try {
        const file = await readHqAlertsConfig(deps.dataDir);
        const parsed = parseHqAlertThresholds(file.thresholds ?? {});
        thresholds = parsed.ok ? parsed.thresholds : {};
        if (file.snoozes !== undefined) deps.engine.seedSnoozes(file.snoozes);
      } catch (err) {
        console.warn(
          JSON.stringify({
            level: 'warn',
            event: 'hq.alerts_config_unreadable',
            message: toErrorMessage(err),
          }),
        );
      }
    },
    config() {
      const base = deps.baseRules();
      if (base === undefined && Object.keys(thresholds).length === 0) return undefined;
      return { ...base, ...thresholds };
    },
    context() {
      return { spend: { windowMs: HQ_BUDGET_WINDOW_MS, ...spend() } };
    },
    view() {
      const current = spend();
      return {
        thresholds,
        base: deps.baseRules() ?? {},
        snoozes: deps.engine.snoozesSnapshot(),
        spend24h: {
          totalUsd: current.totalUsd,
          byProject: entries(current.byProject),
          byMachine: entries(current.byMachine),
        },
      };
    },
    async updateThresholds(input) {
      const parsed = parseHqAlertThresholds(input);
      if (!parsed.ok) return { ok: false, status: 400, error: parsed.error };
      await mutateHqAlertsConfig(deps.dataDir, (file) => ({
        ...file,
        thresholds: parsed.thresholds,
      }));
      thresholds = parsed.thresholds;
      deps.onThresholdsChanged?.();
      return { ok: true, value: this.view() };
    },
    async snooze(ruleId, minutes) {
      if (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes <= 0) {
        return { ok: false, status: 400, error: 'minutes must be a positive number.' };
      }
      // A budget rule exists only while its budget does; muting one that is
      // not configured would just grow the snooze list.
      if (isBudgetRuleId(ruleId) && !isConfiguredBudgetRule(ruleId, this.config())) {
        return { ok: false, status: 404, error: `No budget is configured for ${ruleId}.` };
      }
      const capped = Math.min(minutes, MAX_SNOOZE_MINUTES);
      let until: number;
      try {
        until = deps.engine.snooze(ruleId, Date.now() + capped * 60_000).effectiveUntilMs;
      } catch (err) {
        return { ok: false, status: 404, error: toErrorMessage(err) };
      }
      await persistSnoozes();
      return { ok: true, value: { until } };
    },
    async unsnooze(ruleId) {
      const unsnoozed = deps.engine.unsnooze(ruleId);
      if (unsnoozed) await persistSnoozes();
      return { ok: true, value: { unsnoozed } };
    },
  };
}
