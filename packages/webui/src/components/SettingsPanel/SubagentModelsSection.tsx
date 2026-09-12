import { Split, X } from 'lucide-react';
import { useCallback, useState } from 'react';
import { type LocalPrefs, useLocalPrefs } from '@/stores/local-prefs';
import { SubagentModelPickerDialog } from '../ChatInput/subagent-model-picker-dialog.js';
import { Button } from '../ui/button';

type SubagentModelPlan = LocalPrefs['subagentModelPlan'];
type SubagentLane = SubagentModelPlan['slots'][number];
const MAX_LANES = 16;
const DEFAULT_LANES = 8;

function laneValue(lane: SubagentLane | undefined): string {
  if (lane?.provider && lane.model) return `${lane.provider}/${lane.model}`;
  if (lane?.tier) return `tier:${lane.tier}`;
  if (lane?.fallbackProfile) return `profile:${lane.fallbackProfile}`;
  return '';
}
function isPinned(lane: SubagentLane | undefined): boolean {
  return Boolean(lane?.provider || lane?.model || lane?.tier || lane?.fallbackProfile);
}
interface SubagentModelsSectionProps {
  syncPref: (key: string, value: unknown) => void;
  candidates?: Array<{ provider: string; model: string; label: string }> | undefined;
}

export function SubagentModelsSection({ syncPref }: SubagentModelsSectionProps): React.ReactElement {
  const prefs = useLocalPrefs();
  const [pickerLane, setPickerLane] = useState<number | null>(null);
  const plan = prefs.subagentModelPlan ?? { enabled: true, lock: true, slots: [] };
  const lanes: SubagentLane[] = plan.slots.length > 0 ? plan.slots : Array.from({ length: DEFAULT_LANES }, () => ({}));
  const patch = useCallback((next: Partial<SubagentModelPlan>) => syncPref('subagentModelPlan', { ...plan, slots: lanes, ...next }), [lanes, plan, syncPref]);
  const setLane = useCallback((index: number, lane: SubagentLane) => patch({ slots: lanes.map((existing, i) => (i === index ? lane : existing)) }), [lanes, patch]);
  const setLaneCount = useCallback((count: number) => {
    const next = Math.max(1, Math.min(MAX_LANES, count));
    patch({ slots: next <= lanes.length ? lanes.slice(0, next) : [...lanes, ...Array.from({ length: next - lanes.length }, (): SubagentLane => ({}))] });
  }, [lanes, patch]);
  const pinnedCount = lanes.filter(isPinned).length;
  const following = plan.followSessionModel === true;
  const pickerLaneValue = pickerLane !== null ? lanes[pickerLane] : undefined;

  return (
    <div className="pt-2">
      <h3 className="text-sm font-semibold mb-1 mt-3 flex items-center gap-2"><Split className="h-4 w-4 text-muted-foreground" />Subagent models (this session)</h3>
      <p className="mb-3 text-xs text-muted-foreground">Each running subagent takes the first free lane, so parallel workers run on different models. Scoped to this tab’s session and restored by resume — config.json is untouched. Model routing above is left intact: a role you routed there keeps its model.</p>
      <label className="mb-3 flex items-center gap-2 rounded-md border border-border/60 bg-card/50 px-2 py-1.5 text-xs"><input type="checkbox" checked={following} onChange={(e) => patch({ followSessionModel: e.target.checked })} /><span>Use my model for all subagents<span className="block text-[10px] text-muted-foreground">Every plain subagent runs on this session’s model. Outranks the lanes below.</span></span></label>
      <div className="mb-3 flex flex-wrap items-center gap-4">
        <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={plan.enabled !== false} onChange={(e) => patch({ enabled: e.target.checked })} />Enabled</label>
        <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={plan.lock !== false} onChange={(e) => patch({ lock: e.target.checked })} />Lanes override the leader</label>
        <label className="flex items-center gap-2 text-xs">Lanes<input type="number" min={1} max={MAX_LANES} value={lanes.length} disabled={following} onChange={(e) => setLaneCount(Number.parseInt(e.target.value, 10) || 1)} className="h-8 w-16 rounded-md border bg-background px-2 text-xs" /></label>
        <span className="text-xs text-muted-foreground">{pinnedCount === 0 ? 'no lane pinned — spawns resolve as before' : `${pinnedCount} pinned`}</span>
      </div>
      <div className={`space-y-1.5 ${following ? 'pointer-events-none opacity-50' : ''}`}>
        {lanes.map((lane, index) => {
          const value = laneValue(lane); const pinned = isPinned(lane);
          return <div key={`lane-${index}`} className="flex items-center gap-2 rounded-md border border-border bg-muted px-2 py-1.5 text-xs"><span className="w-14 shrink-0 font-mono text-muted-foreground">#{index + 1}</span><button type="button" disabled={following} onClick={() => setPickerLane(index)} aria-label={`Lane ${index + 1} model${pinned ? `: ${value}` : ''}`} className="h-8 min-w-0 flex-1 truncate rounded-md border bg-background px-2 text-left font-mono text-xs hover:border-primary/40 disabled:cursor-not-allowed">{pinned ? value : 'inherit — routing / session'}</button><Button type="button" variant="ghost" size="sm" aria-label={`Clear lane ${index + 1}`} disabled={following || !pinned} onClick={() => setLane(index, {})}><X className="h-3.5 w-3.5" /></Button></div>;
        })}
      </div>
      {pickerLane !== null && <SubagentModelPickerDialog laneIndex={pickerLane} currentLane={pickerLaneValue ?? {}} open onOpenChange={(next) => { if (!next) setPickerLane(null); }} onPick={(pick) => { setLane(pickerLane, pick ? { provider: pick.provider, model: pick.model } : {}); setPickerLane(null); }} />}
    </div>
  );
}
