import { Coins, Plus, X } from 'lucide-react';
import { useCallback, useState } from 'react';
import { type LocalPrefs, useLocalPrefs } from '@/stores/local-prefs';
import { Button } from '../ui/button';

/**
 * ModelTiersSection — the browser editor for the deterministic cost-tier layer.
 *
 * Sits next to the fallback editor on purpose: a fallback profile answers
 * "which models, in what order", and a tier answers "how expensive may this job
 * be", binding a profile to a spend budget and a routing rule. This writes the
 * same `modelTiers` config that `/tier` and the TUI menu write, so the three
 * surfaces never disagree.
 */

type ModelTiers = LocalPrefs['modelTiers'];
type TierLevel = NonNullable<ModelTiers['levels']>[string];
type LeaderMode = NonNullable<NonNullable<ModelTiers['leader']>['mode']>;

const LEADER_MODES: Array<{ value: LeaderMode; label: string; hint: string }> = [
  { value: 'off', label: 'Off', hint: 'The leader never changes its own tier.' },
  {
    value: 'propose',
    label: 'Propose',
    hint: 'The leader asks before switching. Recommended.',
  },
  {
    value: 'auto',
    label: 'Auto',
    hint: 'The leader switches on its own, still bounded by the guard rails below.',
  },
];

/** Blank level shape used when adding a rung. */
const EMPTY_LEVEL: TierLevel = {};

interface ModelTiersSectionProps {
  /** Writes the pref locally AND pushes it to the server (see SettingsPanel). */
  syncPref: (key: string, value: unknown) => void;
}

export function ModelTiersSection({ syncPref }: ModelTiersSectionProps): React.ReactElement {
  const prefs = useLocalPrefs();
  const tiers = prefs.modelTiers ?? {};
  const levels = tiers.levels ?? {};
  const routing = tiers.routing ?? {};
  const leader = tiers.leader ?? {};
  const levelIds = Object.keys(levels);
  const profileNames = Object.keys(prefs.fallbackProfiles ?? {});

  const [newLevelName, setNewLevelName] = useState('');
  const [newRouteKey, setNewRouteKey] = useState('');
  const [newRouteTier, setNewRouteTier] = useState('');

  // Every write goes through `syncPref` with the WHOLE modelTiers object. The
  // pref channel replaces the value rather than deep-merging it, so sending a
  // partial here would drop the sibling keys (levels, routing, leader) that the
  // edit did not touch.
  const patch = useCallback(
    (next: Partial<ModelTiers>) => syncPref('modelTiers', { ...tiers, ...next }),
    [syncPref, tiers],
  );

  const patchLevel = useCallback(
    (id: string, next: Partial<TierLevel>) =>
      syncPref('modelTiers', {
        ...tiers,
        levels: { ...levels, [id]: { ...(levels[id] ?? {}), ...next } },
      }),
    [syncPref, tiers, levels],
  );

  const removeLevel = useCallback(
    (id: string) => {
      const nextLevels = { ...levels };
      delete nextLevels[id];
      // A routing rule pointing at a deleted level would silently fall through
      // to the default tier, so drop those rules with it.
      const nextRouting = Object.fromEntries(
        Object.entries(routing).filter(([, value]) => value !== id),
      );
      syncPref('modelTiers', { ...tiers, levels: nextLevels, routing: nextRouting });
    },
    [syncPref, tiers, levels, routing],
  );

  const addLevel = () => {
    const name = newLevelName.trim();
    if (!name || levels[name]) return;
    patchLevel(name, EMPTY_LEVEL);
    setNewLevelName('');
  };

  const addRoute = () => {
    const key = newRouteKey.trim();
    if (!key || !newRouteTier) return;
    patch({ routing: { ...routing, [key]: newRouteTier } });
    setNewRouteKey('');
    setNewRouteTier('');
  };

  const removeRoute = (key: string) => {
    const next = { ...routing };
    delete next[key];
    patch({ routing: next });
  };

  const numeric = (raw: string): number | undefined => {
    const trimmed = raw.trim();
    if (!trimmed) return undefined;
    const parsed = Number.parseFloat(trimmed);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
  };

  return (
    <section className="space-y-3" data-testid="model-tiers-section">
      <header className="flex items-center gap-2">
        <Coins className="h-4 w-4 text-muted-foreground" />
        <h3 className="text-sm font-medium text-foreground">Model cost tiers</h3>
        <label className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={tiers.enabled === true}
            onChange={(e) => patch({ enabled: e.target.checked })}
            data-testid="model-tiers-enabled"
          />
          Enabled
        </label>
      </header>

      <p className="text-[11px] leading-relaxed text-muted-foreground">
        A tier binds a fallback profile, a spend budget and a runtime setting under one name, then
        routes work to it by role or phase. Subagents, Kanban dispatch and the leader all read this
        table. While disabled, everything resolves exactly as it did before tiers existed.
      </p>

      {/* ── Levels ─────────────────────────────────────────────────────── */}
      <div className="space-y-1.5">
        <div className="flex items-baseline justify-between">
          <h4 className="text-xs font-medium text-foreground">Levels</h4>
          <span className="text-[10px] text-muted-foreground">
            Order is the ladder — the first row is the cheapest rung.
          </span>
        </div>

        {levelIds.length === 0 && (
          <p className="text-[11px] text-muted-foreground">
            No levels yet. Add one below, then point it at a fallback profile.
          </p>
        )}

        {levelIds.map((id, index) => {
          const level = levels[id] ?? {};
          return (
            <div
              key={id}
              className="space-y-1.5 rounded-md border border-border bg-muted px-2 py-1.5"
              data-testid={`model-tier-row-${id}`}
            >
              <div className="flex items-center gap-1.5 text-xs">
                <span className="font-mono text-[10px] text-muted-foreground">{index + 1}</span>
                <span className="min-w-0 flex-1 break-words font-mono font-medium text-foreground">
                  {id}
                </span>
                <button
                  type="button"
                  onClick={() => removeLevel(id)}
                  className="text-muted-foreground hover:text-destructive"
                  title="Remove level"
                  data-testid={`model-tier-remove-${id}`}
                >
                  <X className="h-3 w-3" />
                </button>
              </div>

              <div className="flex flex-wrap items-center gap-1.5">
                <select
                  value={level.fallbackProfile ?? ''}
                  onChange={(e) => patchLevel(id, { fallbackProfile: e.target.value || undefined })}
                  className="rounded-sm border border-border bg-background px-1.5 py-0.5 text-[11px]"
                  data-testid={`model-tier-profile-${id}`}
                >
                  <option value="">profile: (none)</option>
                  {profileNames.map((name) => (
                    <option key={name} value={name}>
                      profile: {name}
                    </option>
                  ))}
                </select>

                <input
                  type="number"
                  min={0}
                  step="0.01"
                  value={level.maxCostUsd ?? ''}
                  onChange={(e) => patchLevel(id, { maxCostUsd: numeric(e.target.value) })}
                  placeholder="max $"
                  className="w-20 rounded-sm border border-border bg-background px-1.5 py-0.5 text-[11px]"
                  data-testid={`model-tier-cost-${id}`}
                />
                <input
                  type="number"
                  min={0}
                  value={level.maxIterations ?? ''}
                  onChange={(e) => patchLevel(id, { maxIterations: numeric(e.target.value) })}
                  placeholder="iters"
                  className="w-16 rounded-sm border border-border bg-background px-1.5 py-0.5 text-[11px]"
                />
                <input
                  type="number"
                  min={0}
                  value={level.maxToolCalls ?? ''}
                  onChange={(e) => patchLevel(id, { maxToolCalls: numeric(e.target.value) })}
                  placeholder="tools"
                  className="w-16 rounded-sm border border-border bg-background px-1.5 py-0.5 text-[11px]"
                />
              </div>
              {level.maxCostUsd !== undefined && (
                <p className="text-[10px] text-muted-foreground">
                  Tightens a role&apos;s default budget down to this ceiling; it never raises one,
                  and never overrides a budget passed explicitly to the spawn.
                </p>
              )}
            </div>
          );
        })}

        <div className="flex items-center gap-1.5">
          <input
            value={newLevelName}
            onChange={(e) => setNewLevelName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') addLevel();
            }}
            placeholder="new level name (e.g. budget)"
            className="min-w-0 flex-1 rounded-sm border border-border bg-background px-1.5 py-0.5 text-[11px]"
            data-testid="model-tier-new-name"
          />
          <Button size="sm" variant="outline" onClick={addLevel} disabled={!newLevelName.trim()}>
            <Plus className="mr-1 h-3 w-3" /> Add
          </Button>
        </div>
      </div>

      {/* ── Routing ────────────────────────────────────────────────────── */}
      <div className="space-y-1.5">
        <h4 className="text-xs font-medium text-foreground">Routing</h4>
        {Object.keys(routing).length === 0 ? (
          <p className="text-[11px] text-muted-foreground">
            No rules — everything uses the default tier
            {tiers.default ? ` (${tiers.default})` : ' (standard)'}.
          </p>
        ) : (
          <ul className="space-y-1">
            {Object.entries(routing).map(([key, tier]) => (
              <li
                key={key}
                className="flex items-center gap-1.5 rounded-md border border-border bg-muted px-2 py-1 text-[11px]"
                data-testid={`model-tier-route-${key}`}
              >
                <span className="min-w-0 flex-1 break-words font-mono text-foreground">
                  {key} → {tier}
                </span>
                {!levels[tier] && (
                  <span className="rounded-sm bg-warning/15 px-1 py-0.5 text-[10px] text-foreground">
                    missing level
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => removeRoute(key)}
                  className="text-muted-foreground hover:text-destructive"
                  title="Remove rule"
                >
                  <X className="h-3 w-3" />
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="flex items-center gap-1.5">
          <input
            value={newRouteKey}
            onChange={(e) => setNewRouteKey(e.target.value)}
            placeholder="role, phase, or *"
            className="min-w-0 flex-1 rounded-sm border border-border bg-background px-1.5 py-0.5 text-[11px]"
            data-testid="model-tier-new-route-key"
          />
          <select
            value={newRouteTier}
            onChange={(e) => setNewRouteTier(e.target.value)}
            className="rounded-sm border border-border bg-background px-1.5 py-0.5 text-[11px]"
            data-testid="model-tier-new-route-tier"
          >
            <option value="">tier…</option>
            {levelIds.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
          <Button
            size="sm"
            variant="outline"
            onClick={addRoute}
            disabled={!newRouteKey.trim() || !newRouteTier}
          >
            <Plus className="h-3 w-3" />
          </Button>
        </div>

        <div className="flex items-center gap-1.5 text-[11px]">
          <span className="text-muted-foreground">Default tier</span>
          <select
            value={tiers.default ?? ''}
            onChange={(e) => patch({ default: e.target.value || undefined })}
            className="rounded-sm border border-border bg-background px-1.5 py-0.5 text-[11px]"
            data-testid="model-tier-default"
          >
            <option value="">standard</option>
            {levelIds.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* ── Leader self-switching ──────────────────────────────────────── */}
      <div className="space-y-1.5">
        <h4 className="text-xs font-medium text-foreground">Leader self-switching</h4>
        <div className="flex flex-wrap gap-1.5">
          {LEADER_MODES.map((mode) => {
            const active = (leader.mode ?? 'propose') === mode.value;
            return (
              <button
                key={mode.value}
                type="button"
                title={mode.hint}
                onClick={() => patch({ leader: { ...leader, mode: mode.value } })}
                className={
                  active
                    ? 'rounded-sm border border-primary bg-primary/10 px-2 py-0.5 text-[11px] text-foreground'
                    : 'rounded-sm border border-border bg-background px-2 py-0.5 text-[11px] text-muted-foreground hover:text-foreground'
                }
                data-testid={`model-tier-leader-${mode.value}`}
              >
                {mode.label}
              </button>
            );
          })}
        </div>
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          {LEADER_MODES.find((m) => m.value === (leader.mode ?? 'propose'))?.hint}
        </p>

        <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
          <label className="flex items-center gap-1 text-muted-foreground">
            dwell
            <input
              type="number"
              min={0}
              value={leader.dwellTurns ?? ''}
              onChange={(e) =>
                patch({ leader: { ...leader, dwellTurns: numeric(e.target.value) } })
              }
              placeholder="6"
              className="w-14 rounded-sm border border-border bg-background px-1.5 py-0.5"
              data-testid="model-tier-leader-dwell"
            />
            turns
          </label>
          <label className="flex items-center gap-1 text-muted-foreground">
            min saving $
            <input
              type="number"
              min={0}
              step="0.01"
              value={leader.minSavingsUsd ?? ''}
              onChange={(e) =>
                patch({ leader: { ...leader, minSavingsUsd: numeric(e.target.value) } })
              }
              placeholder="0.10"
              className="w-16 rounded-sm border border-border bg-background px-1.5 py-0.5"
            />
          </label>
          <label className="flex items-center gap-1 text-muted-foreground">
            ceiling
            <select
              value={leader.maxTier ?? ''}
              onChange={(e) =>
                patch({ leader: { ...leader, maxTier: e.target.value || undefined } })
              }
              className="rounded-sm border border-border bg-background px-1.5 py-0.5"
              data-testid="model-tier-leader-ceiling"
            >
              <option value="">none</option>
              {levelIds.map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </select>
          </label>
        </div>
        <p className="text-[10px] leading-relaxed text-muted-foreground">
          A switch invalidates the prompt cache, so a downgrade is refused unless the projected
          saving over the dwell window covers re-reading the conversation on the new model. A
          downgrade into a context window the session no longer fits is refused outright.
        </p>
      </div>
    </section>
  );
}
