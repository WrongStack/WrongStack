import { ShieldCheck } from 'lucide-react';
import { useMemo, useState } from 'react';
import { FallbackEditor } from '@/components/FallbackEditor';
import { ModelPicker } from '@/components/ModelPicker';
import { useProviderModels } from '@/hooks/useProviderModels';
import { useAppTranslation } from '@/i18n';

type ModelTarget = { provider: string; model: string };
type RuntimePolicy = Record<string, unknown> & {
  provider?: string;
  model?: string;
  fallbackProfile?: string;
  tools?: string[];
  skillNames?: string[];
  allowedCapabilities?: string[];
  cwd?: string;
  worktree?: boolean | 'auto' | 'required' | 'off';
  modelPolicy?: { allowed: ModelTarget[]; fallbacks?: ModelTarget[]; strict?: boolean };
  availability?: {
    timezone: string;
    days: number[];
    start: string;
    end: string;
    mode?: 'advisory' | 'enforce';
  };
  budget?: Record<string, number>;
};

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const BUDGETS = [
  ['timeoutMs', 'Total timeout (ms)'],
  ['idleTimeoutMs', 'Idle timeout (ms)'],
  ['maxIterations', 'Max iterations'],
  ['maxToolCalls', 'Max tool calls'],
  ['maxTokens', 'Max tokens'],
  ['maxCostUsd', 'Max cost (USD)'],
] as const;

function targetRef(target: ModelTarget): string {
  return `${target.provider}/${target.model}`;
}

function parseRef(ref: string): ModelTarget {
  const slash = ref.indexOf('/');
  return slash < 0
    ? { provider: '', model: ref }
    : { provider: ref.slice(0, slash), model: ref.slice(slash + 1) };
}

function listValue(value: unknown): string {
  return Array.isArray(value) ? value.join(', ') : '';
}

function parseList(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/[\n,]+/)
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  ];
}

export function AgentRuntimePolicyEditor({
  initialConfig,
  systemProtected,
  saving,
  onSave,
  onCancel,
}: {
  initialConfig: Record<string, unknown>;
  systemProtected: boolean;
  saving: boolean;
  onSave: (config: Record<string, unknown>) => void;
  onCancel: () => void;
}): React.ReactElement {
  const { t } = useAppTranslation();
  const [config, setConfig] = useState<RuntimePolicy>(() => structuredClone(initialConfig));
  const candidates = useProviderModels(true);
  const modelPolicy = config.modelPolicy;
  const allowedRefs = useMemo(
    () => (modelPolicy?.allowed ?? []).map(targetRef),
    [modelPolicy?.allowed],
  );
  const fallbackRefs = useMemo(
    () => (modelPolicy?.fallbacks ?? []).map(targetRef),
    [modelPolicy?.fallbacks],
  );

  const patch = (next: Partial<RuntimePolicy>) => setConfig((current) => ({ ...current, ...next }));
  const updateList = (field: 'tools' | 'skillNames' | 'allowedCapabilities', value: string) => {
    const entries = parseList(value);
    setConfig((current) => {
      const next = { ...current };
      if (entries.length) next[field] = entries;
      else delete next[field];
      return next;
    });
  };
  const updateBudget = (field: string, raw: string) => {
    setConfig((current) => {
      const budget = { ...(current.budget ?? {}) };
      if (raw === '') delete budget[field];
      else budget[field] = Number(raw);
      const next = { ...current };
      if (Object.keys(budget).length) next.budget = budget;
      else delete next.budget;
      return next;
    });
  };
  const setAllowed = (refs: string[]) => {
    const allowed = refs.map(parseRef);
    const allowedSet = new Set(refs);
    setConfig((current) => ({
      ...current,
      modelPolicy: {
        allowed,
        fallbacks: (current.modelPolicy?.fallbacks ?? []).filter((target) =>
          allowedSet.has(targetRef(target)),
        ),
        strict: current.modelPolicy?.strict ?? true,
      },
    }));
  };
  const setFallbacks = (refs: string[]) => {
    const allAllowed = [...new Set([...allowedRefs, ...refs])];
    setConfig((current) => ({
      ...current,
      modelPolicy: {
        allowed: allAllowed.map(parseRef),
        fallbacks: refs.map(parseRef),
        strict: current.modelPolicy?.strict ?? true,
      },
    }));
  };

  return (
    <div className="space-y-4 rounded-lg border border-border bg-card/40 p-4">
      {systemProtected && (
        <div className="flex gap-2 rounded-md border border-warning/30 bg-warning/5 p-2 text-[11px] text-muted-foreground">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
          <span>{t('activity:runtimePolicy.protectedSystemAgentRequiredToolsAnd')}</span>
        </div>
      )}

      <section className="space-y-2">
        <h4 className="text-xs font-semibold">
          {t('activity:runtimePolicy.providerAndModelPolicy')}
        </h4>
        <ModelPicker
          candidates={candidates}
          provider={config.provider}
          value={config.model}
          placeholder={t('activity:runtimePolicy.useProjectDefaultModel')}
          resetLabel="Use project default"
          onReset={() => {
            setConfig((current) => {
              const next = { ...current };
              delete next.provider;
              delete next.model;
              return next;
            });
          }}
          onPick={(model, provider) => {
            const ref = `${provider}/${model}`;
            patch({ provider, model });
            if (modelPolicy && !allowedRefs.includes(ref)) setAllowed([...allowedRefs, ref]);
          }}
        />
        <label className="flex items-center gap-2 text-[11px]">
          <input
            type="checkbox"
            checked={Boolean(modelPolicy)}
            onChange={(event) => {
              if (event.target.checked) {
                const initial =
                  config.provider && config.model
                    ? [{ provider: config.provider, model: config.model }]
                    : candidates[0]
                      ? [{ provider: candidates[0].provider, model: candidates[0].model }]
                      : [];
                if (initial.length) patch({ modelPolicy: { allowed: initial, strict: true } });
              } else {
                setConfig((current) => {
                  const next = { ...current };
                  delete next.modelPolicy;
                  return next;
                });
              }
            }}
          />
          {t('activity:runtimePolicy.restrictThisAgentToAnExplicit')}
        </label>
        {modelPolicy && (
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <span className="text-[10px] font-medium">
                {t('activity:runtimePolicy.allowedModels')}
              </span>
              <FallbackEditor
                value={allowedRefs}
                candidates={candidates}
                onChange={setAllowed}
                placeholder={t('activity:runtimePolicy.addAllowedModel')}
                emptyHint="At least one model is required"
              />
            </div>
            <div className="space-y-1">
              <span className="text-[10px] font-medium">
                {t('activity:runtimePolicy.orderedFallbackChain')}
              </span>
              <FallbackEditor
                value={fallbackRefs}
                candidates={candidates}
                onChange={setFallbacks}
                placeholder={t('activity:runtimePolicy.addFallbackModel')}
                emptyHint="No fallback; primary failure stops the task"
              />
            </div>
          </div>
        )}
      </section>

      <section className="grid gap-3 sm:grid-cols-3">
        {(
          [
            ['tools', 'Tools', 'read_file, search, bash'],
            ['skillNames', 'Skills', 'security-check, browser'],
            ['allowedCapabilities', 'Capabilities', 'fs.read, fs.write'],
          ] as const
        ).map(([field, label, placeholder]) => (
          <label key={field} className="space-y-1 text-[10px]">
            <span className="font-medium">{label}</span>
            <textarea
              value={listValue(config[field])}
              onChange={(event) => updateList(field, event.target.value)}
              placeholder={placeholder}
              className="h-20 w-full resize-y rounded border border-border bg-background p-2 font-mono"
            />
          </label>
        ))}
      </section>

      <section className="space-y-2">
        <h4 className="text-xs font-semibold">
          {t('activity:runtimePolicy.workspaceAndIsolation')}
        </h4>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="space-y-1 text-[10px]">
            <span>{t('activity:runtimePolicy.projectRelativeWorkingDirectory')}</span>
            <input
              value={config.cwd ?? ''}
              onChange={(event) => patch({ cwd: event.target.value || undefined })}
              placeholder={t('activity:runtimePolicy.packagesWebui')}
              className="h-8 w-full rounded border border-border bg-background px-2 font-mono"
            />
          </label>
          <label className="space-y-1 text-[10px]">
            <span>{t('activity:runtimePolicy.gitWorktreeIsolation')}</span>
            <select
              value={String(config.worktree ?? 'auto')}
              onChange={(event) =>
                patch({ worktree: event.target.value as RuntimePolicy['worktree'] })
              }
              className="h-8 w-full rounded border border-border bg-background px-2"
            >
              <option value="auto">{t('activity:runtimePolicy.automatic')}</option>
              <option value="required">{t('activity:runtimePolicy.required')}</option>
              <option value="off">{t('activity:runtimePolicy.off')}</option>
            </select>
          </label>
        </div>
      </section>

      <section className="space-y-2">
        <h4 className="text-xs font-semibold">{t('activity:runtimePolicy.limits')}</h4>
        <div className="grid gap-2 sm:grid-cols-3">
          {BUDGETS.map(([field, label]) => (
            <label key={field} className="space-y-1 text-[10px]">
              <span>{label}</span>
              <input
                type="number"
                min="0"
                step={field === 'maxCostUsd' ? '0.01' : '1'}
                value={config.budget?.[field] ?? ''}
                onChange={(event) => updateBudget(field, event.target.value)}
                className="h-8 w-full rounded border border-border bg-background px-2"
              />
            </label>
          ))}
        </div>
      </section>

      <section className="space-y-2">
        <label className="flex items-center gap-2 text-xs font-semibold">
          <input
            type="checkbox"
            checked={Boolean(config.availability)}
            onChange={(event) => {
              if (event.target.checked) {
                patch({
                  availability: {
                    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
                    days: [1, 2, 3, 4, 5],
                    start: '09:00',
                    end: '18:00',
                    mode: systemProtected ? 'advisory' : 'enforce',
                  },
                });
              } else {
                setConfig((current) => {
                  const next = { ...current };
                  delete next.availability;
                  return next;
                });
              }
            }}
          />
          {t('activity:runtimePolicy.workingHours')}
        </label>
        {config.availability && (
          <div className="space-y-2 rounded border border-border p-2">
            <div className="flex flex-wrap gap-2">
              {DAYS.map((day, index) => (
                <label key={day} className="flex items-center gap-1 text-[10px]">
                  <input
                    type="checkbox"
                    checked={config.availability?.days.includes(index) ?? false}
                    onChange={(event) => {
                      const availability = config.availability;
                      if (!availability) return;
                      const days = event.target.checked
                        ? [...new Set([...availability.days, index])].sort()
                        : availability.days.filter((value) => value !== index);
                      patch({ availability: { ...availability, days } });
                    }}
                  />
                  {day}
                </label>
              ))}
            </div>
            <div className="grid gap-2 sm:grid-cols-4">
              <input
                value={config.availability.timezone}
                onChange={(event) =>
                  patch({ availability: { ...config.availability!, timezone: event.target.value } })
                }
                placeholder={t('activity:runtimePolicy.europeKiev')}
                className="h-8 rounded border border-border bg-background px-2 text-[10px]"
              />
              <input
                type="time"
                value={config.availability.start}
                onChange={(event) =>
                  patch({ availability: { ...config.availability!, start: event.target.value } })
                }
                className="h-8 rounded border border-border bg-background px-2 text-[10px]"
              />
              <input
                type="time"
                value={config.availability.end}
                onChange={(event) =>
                  patch({ availability: { ...config.availability!, end: event.target.value } })
                }
                className="h-8 rounded border border-border bg-background px-2 text-[10px]"
              />
              <select
                value={systemProtected ? 'advisory' : (config.availability.mode ?? 'enforce')}
                disabled={systemProtected}
                onChange={(event) =>
                  patch({
                    availability: {
                      ...config.availability!,
                      mode: event.target.value as 'advisory' | 'enforce',
                    },
                  })
                }
                className="h-8 rounded border border-border bg-background px-2 text-[10px]"
              >
                <option value="enforce">{t('activity:runtimePolicy.enforce')}</option>
                <option value="advisory">{t('activity:runtimePolicy.advisory')}</option>
              </select>
            </div>
          </div>
        )}
      </section>

      <div className="flex gap-2">
        <button
          type="button"
          disabled={saving || Boolean(modelPolicy && modelPolicy.allowed.length === 0)}
          onClick={() => onSave(config)}
          className="rounded bg-primary px-3 py-1.5 text-xs text-primary-foreground disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Save runtime policy'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded border border-border px-3 py-1.5 text-xs hover:bg-accent"
        >
          {t('activity:runtimePolicy.cancel')}
        </button>
      </div>
    </div>
  );
}
