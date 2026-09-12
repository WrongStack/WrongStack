import { Split, X } from 'lucide-react';
import { useCallback } from 'react';
import { type LocalPrefs, useLocalPrefs } from '@/stores/local-prefs';
import { Button } from '../ui/button';

/**
 * SubagentModelsSection — per-session provider/model lanes for spawned agents.
 *
 * The sibling of RoutingSection, and deliberately a different axis: the routing
 * matrix answers "which model does THIS ROLE use, in every session", while a
 * lane answers "which model does the Nth worker running RIGHT NOW use, in THIS
 * tab". Each live subagent holds one lane and frees it when it retires, so a
 * fan-out of N workers runs on N different models.
 *
 * Session-scoped: the server journals it with the tab's session (and `/resume`
 * restores it) and never writes it to config.json — which is why every edit
 * here is invisible to the other tabs by design.
 */

type SubagentModelPlan = LocalPrefs['subagentModelPlan'];
type SubagentLane = SubagentModelPlan['slots'][number];

/** Hard ceiling mirrored from `MAX_SUBAGENT_SLOTS` in core. */
const MAX_LANES = 16;
const DEFAULT_LANES = 8;

interface ModelCandidate {
  provider: string;
  model: string;
  label: string;
}

interface SubagentModelsSectionProps {
  /** Writes the pref locally AND pushes it to the server (see SettingsPanel). */
  syncPref: (key: string, value: unknown) => void;
  /** Candidate models for the lane dropdown. */
  candidates?: ModelCandidate[] | undefined;
}

/** `provider/model` for a pinned lane, or '' for an unpinned one. */
function laneValue(lane: SubagentLane | undefined): string {
  if (lane?.provider && lane.model) return `${lane.provider}/${lane.model}`;
  if (lane?.tier) return `tier:${lane.tier}`;
  if (lane?.fallbackProfile) return `profile:${lane.fallbackProfile}`;
  return '';
}

function laneFromValue(value: string): SubagentLane {
  if (!value) return {};
  if (value.startsWith('tier:')) return { tier: value.slice(5) };
  if (value.startsWith('profile:')) return { fallbackProfile: value.slice(8) };
  const i = value.indexOf('/');
  if (i <= 0) return { model: value };
  return { provider: value.slice(0, i), model: value.slice(i + 1) };
}

function isPinned(lane: SubagentLane | undefined): boolean {
  return Boolean(lane?.provider || lane?.model || lane?.tier || lane?.fallbackProfile);
}

export function SubagentModelsSection({
  syncPref,
  candidates,
}: SubagentModelsSectionProps): React.ReactElement {
  const prefs = useLocalPrefs();
  const plan = prefs.subagentModelPlan ?? { enabled: true, lock: true, slots: [] };
  // A plan the server has never seen arrives with no lanes; show the default
  // eight so the editor has rows to pin without a separate "create" step.
  const lanes: SubagentLane[] =
    plan.slots.length > 0 ? plan.slots : Array.from({ length: DEFAULT_LANES }, () => ({}));
  const profileNames = Object.keys(prefs.fallbackProfiles ?? {});
  const tierIds = Object.keys(prefs.modelTiers?.levels ?? {});

  // Every write sends the WHOLE plan: the pref channel replaces the value
  // rather than deep-merging, so a partial would drop the sibling keys.
  const patch = useCallback(
    (next: Partial<SubagentModelPlan>) =>
      syncPref('subagentModelPlan', { ...plan, slots: lanes, ...next }),
    [lanes, plan, syncPref],
  );

  const setLane = useCallback(
    (index: number, lane: SubagentLane) => {
      const slots = lanes.map((existing, i) => (i === index ? lane : existing));
      patch({ slots });
    },
    [lanes, patch],
  );

  const setLaneCount = useCallback(
    (count: number) => {
      const next = Math.max(1, Math.min(MAX_LANES, count));
      const slots =
        next <= lanes.length
          ? lanes.slice(0, next)
          : [...lanes, ...Array.from({ length: next - lanes.length }, () => ({}) as SubagentLane)];
      patch({ slots });
    },
    [lanes, patch],
  );

  const pinnedCount = lanes.filter(isPinned).length;
  const following = plan.followSessionModel === true;

  return (
    <div className="pt-2">
      <h3 className="text-sm font-semibold mb-1 mt-3 flex items-center gap-2">
        <Split className="h-4 w-4 text-muted-foreground" />
        Subagent models (this session)
      </h3>
      <p className="mb-3 text-xs text-muted-foreground">
        Each running subagent takes the first free lane, so parallel workers run on different
        models. Scoped to this tab’s session and restored by resume — config.json is untouched.
        Model routing above is left intact: a role you routed there keeps its model.
      </p>

      <label className="mb-3 flex items-center gap-2 rounded-md border border-border/60 bg-card/50 px-2 py-1.5 text-xs">
        <input
          type="checkbox"
          checked={following}
          onChange={(e) => patch({ followSessionModel: e.target.checked })}
        />
        <span>
          Use my model for all subagents
          <span className="block text-[10px] text-muted-foreground">
            Every plain subagent runs on this session’s model. Outranks the lanes below.
          </span>
        </span>
      </label>

      <div className="mb-3 flex flex-wrap items-center gap-4">
        <label className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={plan.enabled !== false}
            onChange={(e) => patch({ enabled: e.target.checked })}
          />
          Enabled
        </label>
        <label className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={plan.lock !== false}
            onChange={(e) => patch({ lock: e.target.checked })}
          />
          Lanes override the leader
        </label>
        <label className="flex items-center gap-2 text-xs">
          Lanes
          <input
            type="number"
            min={1}
            max={MAX_LANES}
            value={lanes.length}
            disabled={following}
            onChange={(e) => setLaneCount(Number.parseInt(e.target.value, 10) || 1)}
            className="h-8 w-16 rounded-md border bg-background px-2 text-xs"
          />
        </label>
        <span className="text-xs text-muted-foreground">
          {pinnedCount === 0
            ? 'no lane pinned — spawns resolve as before'
            : `${pinnedCount} pinned`}
        </span>
      </div>

      <div className={`space-y-1.5 ${following ? 'pointer-events-none opacity-50' : ''}`}>
        {lanes.map((lane, index) => (
          <div
            // Lane identity IS its position — the Nth lane stays the Nth lane
            // across edits, so the index is the stable key here.
            // biome-ignore lint/suspicious/noArrayIndexKey: lane position is the identity
            key={`lane-${index}`}
            className="flex items-center gap-2 rounded-md border border-border bg-muted px-2 py-1.5 text-xs"
          >
            <span className="w-14 shrink-0 font-mono text-muted-foreground">#{index + 1}</span>
            <select
              aria-label={`Lane ${index + 1} model`}
              value={laneValue(lane)}
              onChange={(e) => setLane(index, laneFromValue(e.target.value))}
              className="h-8 min-w-0 flex-1 rounded-md border bg-background px-2 font-mono text-xs"
            >
              <option value="">inherit — matrix / tier / session</option>
              {tierIds.length > 0 && (
                <optgroup label="Cost tiers">
                  {tierIds.map((id) => (
                    <option key={`tier:${id}`} value={`tier:${id}`}>
                      tier:{id}
                    </option>
                  ))}
                </optgroup>
              )}
              {profileNames.length > 0 && (
                <optgroup label="Fallback profiles">
                  {profileNames.map((name) => (
                    <option key={`profile:${name}`} value={`profile:${name}`}>
                      profile:{name}
                    </option>
                  ))}
                </optgroup>
              )}
              {candidates && candidates.length > 0 && (
                <optgroup label="Models">
                  {candidates.map((c) => (
                    <option key={`${c.provider}/${c.model}`} value={`${c.provider}/${c.model}`}>
                      {c.provider}/{c.model}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label={`Clear lane ${index + 1}`}
              disabled={!isPinned(lane)}
              onClick={() => setLane(index, {})}
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
}
