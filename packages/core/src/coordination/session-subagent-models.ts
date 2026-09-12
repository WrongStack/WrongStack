/**
 * Session-scoped subagent model plan.
 *
 * `Config.modelMatrix` (see `model-matrix.ts`) routes subagents by ROLE, lives
 * in the persisted config, and is shared by every session in the project. This
 * module adds the layer users reach for mid-session: "in THIS session, run my
 * parallel workers on these N different provider/model pairs".
 *
 * Two kinds of assignment, both optional:
 *
 *   - **slots** — an ordered lane list. Each live subagent occupies one lane,
 *     and the lane is released the moment that subagent is removed, so N
 *     workers running at once land on N different lanes (i.e. N different
 *     models). This is the "agent 1 / agent 2 / ... / agent 8" model.
 *   - **roles** — a session-scoped overlay on top of the global matrix. A role
 *     match is MORE specific than a lane, so it wins and consumes no lane.
 *
 * `lock` (default true) decides what happens when the leader passes its own
 * `provider`/`model` to `spawn_subagent` / `delegate`: with the lock on the
 * user's pin wins and the leader's pins are discarded wholesale — a
 * half-applied pin would pair one side's provider with the other side's model
 * and produce a reference that resolves to nothing. With the lock off the plan
 * only fills fields the leader left unset, exactly like the matrix.
 *
 * Storage mirrors `session-subagent-policy.ts`: an in-memory registry keyed by
 * session id, written through to the session journal as a `subagent_model_plan`
 * event so `/resume` restores the plan with the session.
 */

import type { ModelMatrixEntry } from '../types/config.js';
import type { SessionEvent, SessionWriter } from '../types/session.js';

/** Hard ceiling on lanes. The UIs default to {@link DEFAULT_SUBAGENT_SLOT_COUNT}. */
export const MAX_SUBAGENT_SLOTS = 16;

/** Lane count a fresh plan is created with. */
export const DEFAULT_SUBAGENT_SLOT_COUNT = 8;

export const SUBAGENT_MODEL_PLAN_META_KEY = 'subagentModelPlan';

/**
 * One lane's model target. Shares its model fields with {@link ModelMatrixEntry}
 * so a lane and a matrix route stay interchangeable everywhere downstream.
 */
export interface SubagentSlot extends ModelMatrixEntry {
  /** Deterministic cost/capability tier for this lane (see `model-tier.ts`). */
  tier?: string | undefined;
  /** Optional user label shown in the pickers ("reviewer lane", "cheap lane"). */
  label?: string | undefined;
}

export interface SessionSubagentModelPlan {
  /** Master switch. A disabled plan is inert but keeps its assignments. */
  enabled: boolean;
  /** When true the plan outranks leader-supplied `provider`/`model`. */
  lock: boolean;
  /**
   * "Run every plain subagent on the model I am using." Outranks the lanes —
   * it is the coarser statement of the same intent — and like them it leaves
   * `/setmodel` role/phase routes alone. Off by default.
   */
  followSessionModel?: boolean | undefined;
  /** Lane assignments, 0-based (the UIs render them 1-based). */
  slots: SubagentSlot[];
  /** Session-scoped role overlay; beats both the lanes and the global matrix. */
  roles?: Record<string, SubagentSlot> | undefined;
}

type PlanContext = {
  meta?: Record<string, unknown> | undefined;
  session?: Pick<SessionWriter, 'id' | 'append'> | undefined;
};

/** A plan with no assignments — what the pickers open on. */
export function emptySubagentModelPlan(
  slotCount = DEFAULT_SUBAGENT_SLOT_COUNT,
): SessionSubagentModelPlan {
  const count = Math.max(1, Math.min(MAX_SUBAGENT_SLOTS, Math.floor(slotCount)));
  return {
    enabled: true,
    lock: true,
    followSessionModel: false,
    slots: Array.from({ length: count }, () => ({})),
  };
}

/** True when the lane names at least one model field (an empty lane is skipped). */
export function isSlotConfigured(slot: SubagentSlot | undefined): boolean {
  if (!slot) return false;
  return Boolean(
    slot.provider || slot.model || slot.tier || slot.fallbackProfile || slot.modelRuntime,
  );
}

/**
 * Render a lane/role target for display. Shared by every surface so a lane
 * reads identically in the TUI panel, the WebUI editor and `/subagent-models`.
 */
export function formatSubagentSlot(slot: SubagentSlot | undefined): string {
  if (!slot) return '';
  const parts: string[] = [];
  if (slot.provider || slot.model) parts.push(`${slot.provider ?? '*'}/${slot.model ?? '*'}`);
  if (slot.tier) parts.push(`tier:${slot.tier}`);
  if (slot.fallbackProfile) parts.push(`profile:${slot.fallbackProfile}`);
  return parts.join(' ');
}

/** True when the plan would actually change any spawn. */
export function planHasAssignments(plan: SessionSubagentModelPlan | undefined): boolean {
  if (!plan?.enabled) return false;
  if (plan.followSessionModel) return true;
  if (plan.slots.some(isSlotConfigured)) return true;
  return Object.values(plan.roles ?? {}).some(isSlotConfigured);
}

function cleanString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeSlot(input: unknown): SubagentSlot {
  if (!input || typeof input !== 'object') return {};
  const raw = input as Record<string, unknown>;
  const slot: SubagentSlot = {};
  const provider = cleanString(raw.provider);
  const model = cleanString(raw.model);
  const tier = cleanString(raw.tier);
  const fallbackProfile = cleanString(raw.fallbackProfile);
  const label = cleanString(raw.label);
  if (provider) slot.provider = provider;
  if (model) slot.model = model;
  if (tier) slot.tier = tier;
  if (fallbackProfile) slot.fallbackProfile = fallbackProfile;
  if (label) slot.label = label;
  if (raw.modelRuntime && typeof raw.modelRuntime === 'object') {
    slot.modelRuntime = raw.modelRuntime as SubagentSlot['modelRuntime'];
  }
  return slot;
}

/**
 * Coerce anything that arrived over a wire (slash command, WebSocket payload, a
 * restored journal event) into a well-formed plan. Never throws: a malformed
 * plan must degrade to "no routing", not break the session.
 */
export function normalizeSubagentModelPlan(input: unknown): SessionSubagentModelPlan {
  if (!input || typeof input !== 'object') return emptySubagentModelPlan();
  const raw = input as Record<string, unknown>;
  const slotsInput = Array.isArray(raw.slots) ? raw.slots : [];
  const slots = slotsInput.slice(0, MAX_SUBAGENT_SLOTS).map(normalizeSlot);
  if (slots.length === 0) slots.push(...emptySubagentModelPlan().slots);

  const roles: Record<string, SubagentSlot> = {};
  if (raw.roles && typeof raw.roles === 'object') {
    for (const [key, value] of Object.entries(raw.roles as Record<string, unknown>)) {
      const role = cleanString(key);
      if (!role) continue;
      const slot = normalizeSlot(value);
      if (isSlotConfigured(slot)) roles[role] = slot;
    }
  }

  const plan: SessionSubagentModelPlan = {
    enabled: raw.enabled !== false,
    lock: raw.lock !== false,
    followSessionModel: raw.followSessionModel === true,
    slots,
  };
  if (Object.keys(roles).length > 0) plan.roles = roles;
  return plan;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const plans = new Map<string, SessionSubagentModelPlan>();
/** Per-session lane occupancy: how many live subagents hold each lane index. */
const laneCounts = new Map<string, number[]>();
/** subagentId -> the lane it holds, so `release` needs no session argument. */
const boundLanes = new Map<string, { sessionId: string; index: number }>();

export function getSessionSubagentModelPlan(
  sessionId: string | undefined,
): SessionSubagentModelPlan | undefined {
  if (!sessionId) return undefined;
  return plans.get(sessionId);
}

/** In-memory write. Use {@link setSessionSubagentModelPlan} to also journal it. */
export function setSessionSubagentModelPlanForSession(
  sessionId: string | undefined,
  plan: SessionSubagentModelPlan | undefined,
): void {
  if (!sessionId) return;
  if (!plan) {
    plans.delete(sessionId);
    laneCounts.delete(sessionId);
    return;
  }
  const normalized = normalizeSubagentModelPlan(plan);
  plans.set(sessionId, normalized);
  // The lane count may have shrunk under live workers; keep the occupancy array
  // in step so a stale index can never be read back as "free".
  const counts = laneCounts.get(sessionId);
  if (counts && counts.length !== normalized.slots.length) {
    counts.length = normalized.slots.length;
    for (let i = 0; i < counts.length; i += 1) counts[i] ??= 0;
  }
}

/** Persist the plan to the session journal and apply it to the live session. */
export async function setSessionSubagentModelPlan(
  ctx: PlanContext,
  plan: SessionSubagentModelPlan,
): Promise<void> {
  const normalized = normalizeSubagentModelPlan(plan);
  if (ctx.meta) ctx.meta[SUBAGENT_MODEL_PLAN_META_KEY] = normalized;
  if (ctx.session) {
    await ctx.session.append({
      type: 'subagent_model_plan',
      ts: new Date().toISOString(),
      plan: normalized,
    });
    setSessionSubagentModelPlanForSession(ctx.session.id, normalized);
  }
}

/** Replay the journal's last plan event into the live registry (resume path). */
export function restoreSessionSubagentModelPlan(
  ctx: PlanContext,
  events: readonly SessionEvent[] | undefined,
): void {
  let plan: SessionSubagentModelPlan | undefined;
  for (const event of events ?? []) {
    if (event.type === 'subagent_model_plan') plan = normalizeSubagentModelPlan(event.plan);
  }
  if (!plan) return;
  if (ctx.meta) ctx.meta[SUBAGENT_MODEL_PLAN_META_KEY] = plan;
  if (ctx.session?.id) setSessionSubagentModelPlanForSession(ctx.session.id, plan);
}

/** Drop the plan and all lane bookkeeping for a session. */
export function resetSessionSubagentModelPlan(sessionId: string | undefined): void {
  if (!sessionId) return;
  plans.delete(sessionId);
  laneCounts.delete(sessionId);
  for (const [subagentId, bound] of boundLanes) {
    if (bound.sessionId === sessionId) boundLanes.delete(subagentId);
  }
}

// ---------------------------------------------------------------------------
// Lane accounting
// ---------------------------------------------------------------------------

export interface SubagentSlotClaim {
  /**
   * What matched: a session role override, a lane, or the "use my model"
   * switch. Only `lane` holds a lane and needs releasing.
   */
  readonly kind: 'role' | 'lane' | 'session-model';
  /** Lane index held, or undefined for the role/session-model kinds. */
  readonly slotIndex: number | undefined;
  /** What the spawn resolver should apply. */
  readonly target: SubagentSlot;
  /** Whether this target outranks leader-supplied provider/model. */
  readonly lock: boolean;
  /** Attach the claim to the spawned subagent so removal can release it. */
  bind(subagentId: string): void;
  /** Give the lane back — the spawn never happened. */
  abandon(): void;
}

function countsFor(sessionId: string, laneCount: number): number[] {
  let counts = laneCounts.get(sessionId);
  if (!counts) {
    counts = new Array<number>(laneCount).fill(0);
    laneCounts.set(sessionId, counts);
  }
  if (counts.length !== laneCount) {
    counts.length = laneCount;
    for (let i = 0; i < counts.length; i += 1) counts[i] ??= 0;
  }
  return counts;
}

/**
 * Pick the lane this spawn should run on: the first free configured lane, or —
 * when every configured lane is busy — the least-loaded one, lowest index
 * first. Returns undefined when no plan applies, in which case resolution falls
 * through to the matrix/tier/session layers untouched.
 */
export function claimSubagentSlot(
  sessionId: string | undefined,
  opts: { role?: string | undefined; routed?: boolean | undefined } = {},
): SubagentSlotClaim | undefined {
  if (!sessionId) return undefined;
  const plan = plans.get(sessionId);
  if (!plan?.enabled) return undefined;

  // The role overlay is the most specific statement the user can make about a
  // spawn — more specific than a lane, and more specific than a `/setmodel`
  // route, because it names both the role AND this session. It wins outright
  // and burns no lane.
  const roleTarget = opts.role ? plan.roles?.[opts.role] : undefined;
  if (roleTarget && isSlotConfigured(roleTarget)) {
    return {
      kind: 'role',
      slotIndex: undefined,
      target: roleTarget,
      lock: plan.lock,
      bind: () => {},
      abandon: () => {},
    };
  }

  // `/setmodel` routing is left intact: a spawn whose role (or phase) the user
  // deliberately routed keeps going where that route sends it. Lanes and the
  // follow-session switch are for the plain spawns — everything the routing
  // table does not name.
  if (opts.routed) return undefined;

  if (plan.followSessionModel) {
    return {
      kind: 'session-model',
      slotIndex: undefined,
      target: {},
      lock: plan.lock,
      bind: () => {},
      abandon: () => {},
    };
  }

  const configured: number[] = [];
  for (let i = 0; i < plan.slots.length; i += 1) {
    if (isSlotConfigured(plan.slots[i])) configured.push(i);
  }
  if (configured.length === 0) return undefined;

  const counts = countsFor(sessionId, plan.slots.length);
  let chosen = configured[0] as number;
  for (const index of configured) {
    const count = counts[index] ?? 0;
    if (count === 0) {
      chosen = index;
      break;
    }
    if (count < (counts[chosen] ?? 0)) chosen = index;
  }
  counts[chosen] = (counts[chosen] ?? 0) + 1;

  let settled = false;
  const release = () => {
    if (settled) return;
    settled = true;
    const live = laneCounts.get(sessionId);
    if (live) live[chosen] = Math.max(0, (live[chosen] ?? 0) - 1);
  };

  return {
    kind: 'lane',
    slotIndex: chosen,
    target: plan.slots[chosen] as SubagentSlot,
    lock: plan.lock,
    bind: (subagentId: string) => {
      if (settled) return;
      settled = true;
      boundLanes.set(subagentId, { sessionId, index: chosen });
    },
    abandon: release,
  };
}

/** Free the lane a retired subagent held. Idempotent; safe for unknown ids. */
export function releaseSubagentSlot(subagentId: string | undefined): void {
  if (!subagentId) return;
  const bound = boundLanes.get(subagentId);
  if (!bound) return;
  boundLanes.delete(subagentId);
  const counts = laneCounts.get(bound.sessionId);
  if (counts) counts[bound.index] = Math.max(0, (counts[bound.index] ?? 0) - 1);
}

/** Live lane -> subagent map, for the pickers' "busy" indicators. */
export function subagentSlotOccupancy(
  sessionId: string | undefined,
): Array<{ slotIndex: number; subagentIds: string[] }> {
  if (!sessionId) return [];
  const plan = plans.get(sessionId);
  if (!plan) return [];
  const out = plan.slots.map((_, slotIndex) => ({ slotIndex, subagentIds: [] as string[] }));
  for (const [subagentId, bound] of boundLanes) {
    if (bound.sessionId !== sessionId) continue;
    out[bound.index]?.subagentIds.push(subagentId);
  }
  return out;
}

/** Test seam: wipe every session's plan and lane bookkeeping. */
export function __resetAllSessionSubagentModelPlans(): void {
  plans.clear();
  laneCounts.clear();
  boundLanes.clear();
}
