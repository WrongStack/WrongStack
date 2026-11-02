'use client';

/**
 * What raises an alert: fleet thresholds and daily spend budgets for the
 * fleet, each project and each machine. Budgets read the last 24 hours of the
 * persisted cost series, so sessions that already ended still count. Every
 * alert reaches the notification channels above.
 *
 * Saved values override `auth.json` `alertRules` field by field; an empty
 * field falls back to that file, then to the built-in default.
 */
import {
  type AlertSettings,
  fetchAlertSettings,
  HqHttpError,
  saveAlertThresholds,
} from '@hq/data/api';
import { useHqStore } from '@hq/data/store/index';
import { formatUsd } from '@hq/lib/format';
import type { HqAlertRuleConfig } from '@wrongstack/hq';
import type { ReactNode } from 'react';
import { useEffect, useId, useMemo, useState } from 'react';
import { cn } from '@/lib/cn';
import { errorText } from '@/lib/error-text';
import { machineKeyOf, machineLabel } from '@/lib/scope';

type NumericField =
  | 'dailyBudgetUsd'
  | 'costThresholdUsd'
  | 'staleMachineSeconds'
  | 'maxAgents'
  | 'tokenExpiryWarningHours'
  | 'hostDiskFreePct'
  | 'hostDiskFreeGiB'
  | 'hostMemAvailablePct';

const FIELDS: {
  field: NumericField;
  label: string;
  hint: string;
  fallback: number;
  unit: string;
}[] = [
  {
    field: 'dailyBudgetUsd',
    label: 'Fleet budget per 24 hours',
    hint: 'All machines and projects together. Empty = no fleet budget.',
    fallback: 0,
    unit: 'USD',
  },
  {
    field: 'costThresholdUsd',
    label: 'Live spend threshold',
    hint: 'What the sessions open right now have spent.',
    fallback: 50,
    unit: 'USD',
  },
  {
    field: 'staleMachineSeconds',
    label: 'Whole fleet silent after',
    hint: 'Alert when no machine has reported for this long.',
    fallback: 120,
    unit: 'seconds',
  },
  {
    field: 'maxAgents',
    label: 'Busy fleet at',
    hint: 'Active agents across the fleet. Empty or 0 = off.',
    fallback: 0,
    unit: 'agents',
  },
  {
    field: 'tokenExpiryWarningHours',
    label: 'Warn before an access token expires',
    hint: 'Empty = 24 hours; 0 = only when expired.',
    fallback: 24,
    unit: 'hours',
  },
  {
    field: 'hostDiskFreePct',
    label: 'Machine disk low below',
    hint: 'Free space on the disk that holds the project. Empty = 5%; 0 = off.',
    fallback: 5,
    unit: '% free',
  },
  {
    field: 'hostDiskFreeGiB',
    label: 'Machine disk low under',
    hint: 'Either limit raises it. Empty = 2 GB; 0 = off.',
    fallback: 2,
    unit: 'GB free',
  },
  {
    field: 'hostMemAvailablePct',
    label: 'Machine short of memory below',
    hint: 'Memory the OS can still hand out. Empty = 5%; 0 = off.',
    fallback: 5,
    unit: '% available',
  },
];

const field = 'h-10 w-full border border-border bg-background px-3 text-sm disabled:opacity-60';

const toText = (value: number | undefined): string => (value === undefined ? '' : String(value));

function parseOptional(text: string): number | undefined | 'invalid' {
  if (text.trim() === '') return undefined;
  const value = Number(text);
  return Number.isFinite(value) && value >= 0 ? value : 'invalid';
}

export function AlertRulesForm(): ReactNode {
  const id = useId();
  const snapshot = useHqStore((state) => state.snapshot);
  const [settings, setSettings] = useState<AlertSettings | null>(null);
  const [values, setValues] = useState<Partial<Record<NumericField, string>>>({});
  const [projectBudgets, setProjectBudgets] = useState<Record<string, string>>({});
  const [machineBudgets, setMachineBudgets] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const adopt = (next: AlertSettings): void => {
    setSettings(next);
    setValues(
      Object.fromEntries(FIELDS.map(({ field: key }) => [key, toText(next.thresholds[key])])),
    );
    setProjectBudgets(
      Object.fromEntries(
        Object.entries(next.thresholds.projectDailyBudgetsUsd ?? {}).map(([k, v]) => [
          k,
          String(v),
        ]),
      ),
    );
    setMachineBudgets(
      Object.fromEntries(
        Object.entries(next.thresholds.machineDailyBudgetsUsd ?? {}).map(([k, v]) => [
          k,
          String(v),
        ]),
      ),
    );
  };

  useEffect(() => {
    fetchAlertSettings()
      .then(adopt)
      .catch((cause: unknown) => setMessage({ ok: false, text: errorText(cause) }));
  }, []);

  // Every project and machine HQ knows, plus any that already has a budget.
  const projects = useMemo(() => {
    const names = new Map<string, string>();
    for (const project of snapshot?.projects ?? [])
      names.set(project.projectId, project.projectName);
    for (const machine of snapshot?.offlineMachines ?? []) {
      for (const project of machine.projects) {
        if (!names.has(project.projectId)) names.set(project.projectId, project.projectName);
      }
    }
    for (const key of Object.keys(projectBudgets)) if (!names.has(key)) names.set(key, key);
    return [...names].sort((a, b) => a[1].localeCompare(b[1]));
  }, [snapshot, projectBudgets]);
  const machines = useMemo(() => {
    const keys = new Set<string>();
    for (const machine of snapshot?.machines ?? [])
      keys.add(machineKeyOf(machine.hostname, machine.machineId));
    for (const machine of snapshot?.offlineMachines ?? []) keys.add(machine.key);
    for (const key of Object.keys(machineBudgets)) keys.add(key);
    return [...keys]
      .map((key) => [key, machineLabel(snapshot, key)] as const)
      .sort((a, b) => a[1].localeCompare(b[1]));
  }, [snapshot, machineBudgets]);

  const save = async (): Promise<void> => {
    if (settings === null) return;
    const next: HqAlertRuleConfig = {
      // Fields this form does not edit (the legacy throughput budget) stay.
      ...(settings.thresholds.throughputBudgetUsd !== undefined
        ? { throughputBudgetUsd: settings.thresholds.throughputBudgetUsd }
        : {}),
    };
    for (const { field: key, label } of FIELDS) {
      const parsed = parseOptional(values[key] ?? '');
      if (parsed === 'invalid') {
        setMessage({ ok: false, text: `${label}: enter a number of zero or more.` });
        return;
      }
      if (parsed !== undefined) next[key] = parsed;
    }
    const budgets = (input: Record<string, string>): Record<string, number> | 'invalid' => {
      const out: Record<string, number> = {};
      for (const [key, text] of Object.entries(input)) {
        const parsed = parseOptional(text);
        if (parsed === 'invalid') return 'invalid';
        if (parsed !== undefined && parsed > 0) out[key] = parsed;
      }
      return out;
    };
    const perProject = budgets(projectBudgets);
    const perMachine = budgets(machineBudgets);
    if (perProject === 'invalid' || perMachine === 'invalid') {
      setMessage({ ok: false, text: 'Budgets must be numbers of zero or more.' });
      return;
    }
    if (Object.keys(perProject).length > 0) next.projectDailyBudgetsUsd = perProject;
    if (Object.keys(perMachine).length > 0) next.machineDailyBudgetsUsd = perMachine;
    setBusy(true);
    setMessage(null);
    try {
      adopt(await saveAlertThresholds(next));
      setMessage({
        ok: true,
        text: 'Saved. The rules apply from the next check (within 15 seconds).',
      });
    } catch (cause) {
      setMessage({
        ok: false,
        text:
          cause instanceof HqHttpError && cause.status === 403
            ? `Alert rules need an admin sign-in. ${cause.message.replace(/^403\s*/, '')}`
            : errorText(cause),
      });
    } finally {
      setBusy(false);
    }
  };

  const budgetRow = (
    key: string,
    label: string,
    spent: number,
    value: string,
    set: (text: string) => void,
    kind: 'project' | 'machine',
  ): ReactNode => (
    <li
      key={key}
      className="grid grid-cols-[minmax(0,1fr)_auto_8rem] items-center gap-3"
      data-budget={`${kind}:${key}`}
    >
      <label htmlFor={`${id}-${kind}-${key}`} className="truncate text-sm">
        {label}
      </label>
      <span className="tabular text-xs text-muted-foreground">{formatUsd(spent)} in 24h</span>
      <input
        id={`${id}-${kind}-${key}`}
        inputMode="decimal"
        className={cn(field, 'h-9')}
        placeholder="No budget"
        value={value}
        onChange={(event) => set(event.target.value)}
      />
    </li>
  );

  return (
    <section
      className="flex flex-col gap-4 border border-border p-5"
      aria-label="Alert rules and budgets"
    >
      <div className="flex flex-col gap-1">
        <h3 className="text-sm font-semibold">Alert rules and budgets</h3>
        <p className="text-sm text-muted-foreground">
          {settings === null
            ? 'Reading the alert rules…'
            : `${formatUsd(settings.spend24h.totalUsd)} spent across the fleet in the last 24 hours. Budgets count sessions that already ended too.`}
        </p>
      </div>
      {settings !== null && (
        <form
          className="flex flex-col gap-6"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            {FIELDS.map((entry) => {
              const base = settings.base[entry.field];
              return (
                <div key={entry.field} className="flex flex-col gap-1.5">
                  <label htmlFor={`${id}-${entry.field}`} className="text-sm font-medium">
                    {entry.label} ({entry.unit})
                  </label>
                  <input
                    id={`${id}-${entry.field}`}
                    inputMode="decimal"
                    className={field}
                    placeholder={String(base ?? entry.fallback)}
                    value={values[entry.field] ?? ''}
                    onChange={(event) =>
                      setValues((current) => ({ ...current, [entry.field]: event.target.value }))
                    }
                  />
                  <p className="text-xs text-muted-foreground">{entry.hint}</p>
                </div>
              );
            })}
          </div>

          {projects.length > 0 && (
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-1 text-sm font-medium">
                Budget per project (USD per 24 hours)
              </legend>
              <ul className="flex flex-col gap-2">
                {projects.map(([projectId, name]) =>
                  budgetRow(
                    projectId,
                    name,
                    settings.spend24h.byProject[projectId] ?? 0,
                    projectBudgets[projectId] ?? '',
                    (text) => setProjectBudgets((current) => ({ ...current, [projectId]: text })),
                    'project',
                  ),
                )}
              </ul>
            </fieldset>
          )}

          {machines.length > 0 && (
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-1 text-sm font-medium">
                Budget per machine (USD per 24 hours)
              </legend>
              <ul className="flex flex-col gap-2">
                {machines.map(([key, label]) =>
                  budgetRow(
                    key,
                    label,
                    settings.spend24h.byMachine[key] ?? 0,
                    machineBudgets[key] ?? '',
                    (text) => setMachineBudgets((current) => ({ ...current, [key]: text })),
                    'machine',
                  ),
                )}
              </ul>
            </fieldset>
          )}

          {message !== null && (
            <p
              role="status"
              className={cn('text-sm', message.ok ? 'text-success' : 'text-destructive')}
            >
              {message.text}
            </p>
          )}
          <div>
            <button
              type="submit"
              disabled={busy}
              className="inline-flex h-10 items-center bg-primary px-5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
            >
              {busy ? 'Saving…' : 'Save alert rules'}
            </button>
          </div>
        </form>
      )}
      {settings === null && message !== null && (
        <p role="alert" className="text-sm text-destructive">
          {message.text}
        </p>
      )}
    </section>
  );
}
