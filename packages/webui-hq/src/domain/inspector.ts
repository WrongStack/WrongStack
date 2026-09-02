/**
 * RightInspector contract for HQ.
 *
 * Lifted from `webui-operator-workbench-2026-07.md` §3 (RightInspector
 * pattern). Each view that wants to deep-link into a record emits an
 * `InspectorTarget` instead of opening an ad-hoc drawer; the shell binds
 * the active target to the matching `InspectorSlot` registered here.
 *
 * Target kinds live as a closed union so the shell can validate the
 * registry at startup and refuse unknown keys. New kinds must be added
 * to the union AND have a registered `InspectorSlot`.
 */
export type InspectorTarget =
  | { kind: 'hq.kanban.task'; projectId: string; taskId: string }
  | { kind: 'hq.mailbox.message'; projectId: string; mailboxId: string; messageId: string }
  | { kind: 'hq.client'; projectId: string; clientId: string }
  | { kind: 'hq.alert'; alertId: string }
  | { kind: 'hq.command'; commandId: string }
  | { kind: 'hq.cost.session'; sessionId: string }
  | { kind: 'hq.worktree'; handleId: string };

export type InspectorTargetKind = InspectorTarget['kind'];

/**
 * The shell renders one slot at a time. A slot is a registered React
 * component for a given `kind`; the registry lives at module scope so
 * tests and views can both read/write it.
 */
export interface InspectorSlot {
  kind: InspectorTargetKind;
  /** Stable React element factory for the target. Receives the live store
   * snapshot indirectly via the views; the slot owns its own data
   * fetching and renders a fallback when the target is missing. */
  render: (target: InspectorTarget) => React.ReactElement | null;
}

const slots = new Map<InspectorTargetKind, InspectorSlot>();

/** Register (or replace) a slot for a target kind. */
export function registerInspectorSlot(slot: InspectorSlot): () => void {
  slots.set(slot.kind, slot);
  return () => {
    if (slots.get(slot.kind) === slot) slots.delete(slot.kind);
  };
}

/** Drop every registered slot. Tests use this between cases. */
export function clearInspectorSlots(): void {
  slots.clear();
}

/** Resolve a target to its slot. Returns `null` for unknown kinds. */
export function resolveInspectorSlot(target: InspectorTarget): InspectorSlot | null {
  return slots.get(target.kind) ?? null;
}
