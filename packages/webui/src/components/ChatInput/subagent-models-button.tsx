import { Split, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useProviderModels } from '@/hooks/useProviderModels';
import { useWebSocket } from '@/hooks/useWebSocket';
import { type LocalPrefs, useLocalPrefs } from '@/stores/local-prefs';
import { useSessionStore } from '@/stores/session-store';

/**
 * Subagent model lanes, inline in the composer toolbar next to the model chip
 * and the effort select.
 *
 * Same trip as `SessionEffortSelect` (local set + `prefs.update`), because the
 * plan is a session-scoped preference: the server journals it with this tab's
 * session and never writes it to config.json. The full editor — role overrides
 * included — lives in Settings → Routing; this popover carries the two controls
 * worth reaching for mid-conversation: "everything on my model", and per-lane
 * pins for a parallel fan-out.
 */

type SubagentModelPlan = LocalPrefs['subagentModelPlan'];
type SubagentLane = SubagentModelPlan['slots'][number];

/** Hard ceiling mirrored from `MAX_SUBAGENT_SLOTS` in core. */
const MAX_LANES = 16;
const DEFAULT_LANES = 8;

function laneValue(lane: SubagentLane | undefined): string {
  if (lane?.provider && lane.model) return `${lane.provider}/${lane.model}`;
  if (lane?.tier) return `tier:${lane.tier}`;
  if (lane?.fallbackProfile) return `profile:${lane.fallbackProfile}`;
  return '';
}

function laneFromValue(value: string): SubagentLane {
  if (!value) return {};
  // The tier/profile prefixes round-trip: the passthrough <option> re-offers a
  // lane pinned from another surface, and parsing it as a bare model id would
  // corrupt it into `{ model: 'tier:budget' }`.
  if (value.startsWith('tier:')) return { tier: value.slice(5) };
  if (value.startsWith('profile:')) return { fallbackProfile: value.slice(8) };
  const i = value.indexOf('/');
  if (i <= 0) return { model: value };
  return { provider: value.slice(0, i), model: value.slice(i + 1) };
}

function isPinned(lane: SubagentLane | undefined): boolean {
  return Boolean(lane?.provider || lane?.model || lane?.tier || lane?.fallbackProfile);
}

export function SubagentModelsButton() {
  const { updatePrefs } = useWebSocket();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement | null>(null);
  const plan = useLocalPrefs((s) => s.subagentModelPlan);
  const sessionProvider = useSessionStore((s) => s.session?.provider);
  const sessionModel = useSessionStore((s) => s.session?.model);
  // Gated on `open`: the catalogue round-trip only fires while the popover is
  // showing, exactly like the SDD worker picker.
  const candidates = useProviderModels(open);

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: MouseEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const current = plan ?? { enabled: true, lock: true, slots: [] };
  // A plan the server has never stored arrives with no lanes; show the default
  // eight so there are rows to pin without a separate "create" step.
  const lanes: SubagentLane[] =
    current.slots.length > 0 ? current.slots : Array.from({ length: DEFAULT_LANES }, () => ({}));
  const pinnedCount = lanes.filter(isPinned).length;
  const following = current.followSessionModel === true;

  // Every write sends the WHOLE plan: the pref channel replaces the value
  // rather than deep-merging it, so a partial would drop the sibling keys.
  const patch = (next: Partial<SubagentModelPlan>) => {
    const value = { ...current, slots: lanes, ...next };
    useLocalPrefs.getState().set({ subagentModelPlan: value });
    updatePrefs({ subagentModelPlan: value });
  };

  const setLane = (index: number, lane: SubagentLane) =>
    patch({ slots: lanes.map((existing, i) => (i === index ? lane : existing)) });

  const setLaneCount = (count: number) => {
    const next = Math.max(1, Math.min(MAX_LANES, count));
    patch({
      slots:
        next <= lanes.length
          ? lanes.slice(0, next)
          : [...lanes, ...Array.from({ length: next - lanes.length }, (): SubagentLane => ({}))],
    });
  };

  const summary = following
    ? 'session model'
    : pinnedCount > 0
      ? `${pinnedCount} lane${pinnedCount === 1 ? '' : 's'}`
      : 'auto';

  return (
    <span ref={wrapRef} className="relative inline-flex shrink-0">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        title="Subagent models — which models spawned subagents run on (this session)"
        className="inline-flex items-center gap-1.5 rounded-lg border border-border/50 bg-card/50 px-2.5 py-1.5 text-xs text-muted-foreground transition-all duration-200 hover:border-primary/30 hover:bg-accent/50 hover:text-foreground"
      >
        <Split className="h-3.5 w-3.5 shrink-0" />
        <span className="whitespace-nowrap">
          Subagents: <span className="font-mono">{summary}</span>
        </span>
      </button>

      {open && (
        <div className="absolute bottom-full left-0 z-50 mb-2 w-80 rounded-lg border border-border bg-popover p-3 shadow-lg">
          <div className="mb-2 flex items-start justify-between gap-2">
            <div>
              <p className="text-xs font-semibold">Subagent models</p>
              <p className="text-[10px] leading-tight text-muted-foreground">
                This session only. Each running subagent takes the first free lane.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Close"
              className="text-muted-foreground hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>

          <label className="flex items-center gap-2 rounded-md border border-border/60 bg-card/50 px-2 py-1.5 text-xs">
            <input
              type="checkbox"
              checked={following}
              onChange={(e) => patch({ followSessionModel: e.target.checked })}
            />
            <span className="min-w-0">
              Use my model for all subagents
              {sessionProvider && sessionModel ? (
                <span className="block truncate font-mono text-[10px] text-muted-foreground">
                  {sessionProvider}/{sessionModel}
                </span>
              ) : null}
            </span>
          </label>

          <div className="mt-2 flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
            <label className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={current.lock !== false}
                onChange={(e) => patch({ lock: e.target.checked })}
              />
              Override the leader
            </label>
            <label className="flex items-center gap-1.5">
              Lanes
              <input
                type="number"
                min={1}
                max={MAX_LANES}
                value={lanes.length}
                disabled={following}
                onChange={(e) => setLaneCount(Number.parseInt(e.target.value, 10) || 1)}
                className="h-6 w-12 rounded border bg-background px-1 text-[10px]"
              />
            </label>
          </div>

          <div
            className={`mt-2 max-h-56 space-y-1 overflow-y-auto ${following ? 'pointer-events-none opacity-50' : ''}`}
          >
            {lanes.map((lane, index) => (
              <div
                // Lane identity IS its position, so the index is the stable key.
                // biome-ignore lint/suspicious/noArrayIndexKey: lane position is the identity
                key={`lane-${index}`}
                className="flex items-center gap-2"
              >
                <span className="w-6 shrink-0 font-mono text-[10px] text-muted-foreground">
                  #{index + 1}
                </span>
                <select
                  aria-label={`Lane ${index + 1} model`}
                  value={laneValue(lane)}
                  onChange={(e) => setLane(index, laneFromValue(e.target.value))}
                  className="h-7 min-w-0 flex-1 rounded border bg-background px-1 font-mono text-[10px]"
                >
                  <option value="">inherit — routing / session</option>
                  {/* A lane pinned to a tier or profile from another surface
                      keeps its value visible instead of reading as "inherit". */}
                  {laneValue(lane) && !lane.provider ? (
                    <option value={laneValue(lane)}>{laneValue(lane)}</option>
                  ) : null}
                  {candidates.map((candidate) => (
                    <option
                      key={`${candidate.provider}/${candidate.model}`}
                      value={`${candidate.provider}/${candidate.model}`}
                    >
                      {candidate.provider}/{candidate.model}
                    </option>
                  ))}
                </select>
              </div>
            ))}
          </div>

          <p className="mt-2 text-[10px] leading-tight text-muted-foreground">
            /setmodel routing is untouched — a role you routed there keeps its model.
          </p>
        </div>
      )}
    </span>
  );
}
