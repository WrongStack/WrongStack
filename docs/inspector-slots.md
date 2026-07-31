# RightInspector contract — handoff to `packages/webui-ui`

> This document is the handoff contract for the RightInspector scaffolding
> introduced by the **C1 (Workbench shell + Kanban parity)** card on the
> HQ Evolution 2026-08 board. It exists so the workbench team (who owns
> `packages/webui-ui`) has a single source of truth for the integration
> contract when the workbench shell is promoted out of the project WebUI.

## Goal

HQ today has ad-hoc drawer patterns (`views/fleet-chat-drawer.tsx`,
hand-rolled inspector in `views/cockpit.tsx`, etc.). The C1 card moved HQ
to a typed `InspectorTarget` contract + a single `RightInspector` shell +
a registry of `InspectorSlot` components. Once `packages/webui-ui`
exports a workbench shell, the HQ `RightInspector` is replaced with
`WorkbenchShell.RightInspector`; the contract in this document is what
makes that drop-in possible.

## Surface

All three of the following live in `packages/webui-hq/src/lib/`:

| File | Role |
|------|------|
| `inspector.ts` | `InspectorTarget` union + `registerInspectorSlot` / `resolveInspectorSlot` / `clearInspectorSlots` registry. No React. |
| `inspector-slots.tsx` | `RightInspector` shell — takes a `target: InspectorTarget | null`, dispatches to the slot, renders a scrim + drawer. |
| `inspector-default-slots.tsx` | The three documented default slots: `hq.kanban.task`, `hq.mailbox.message`, `hq.client`. Read-only with "Open in WebUI" deep links. |

### `InspectorTarget` union

Closed union; new kinds must extend it AND register a slot:

```ts
export type InspectorTarget =
  | { kind: 'hq.kanban.task'; projectId: string; taskId: string }
  | { kind: 'hq.mailbox.message'; projectId: string; mailboxId: string; messageId: string }
  | { kind: 'hq.client'; projectId: string; clientId: string }
  | { kind: 'hq.alert'; alertId: string }
  | { kind: 'hq.command'; commandId: string }
  | { kind: 'hq.cost.session'; sessionId: string }
  | { kind: 'hq.worktree'; handleId: string };
```

### `InspectorSlot` registry

```ts
export interface InspectorSlot {
  kind: InspectorTargetKind;
  render: (target: InspectorTarget) => React.ReactElement | null;
}

registerInspectorSlot(slot): () => void; // returns a dispose
resolveInspectorSlot(target): InspectorSlot | null;
clearInspectorSlots(): void;             // tests only
```

Slots are registered on first render via the shell's `useEffect` →
`installDefaultSlots()` (idempotent). Three default slots are registered
in `inspector-default-slots.tsx`.

## Contract for `WorkbenchShell.RightInspector`

When `packages/webui-ui` is ready, the workbench team implements
`WorkbenchShell.RightInspector` with the same minimal contract:

1. **Same props shape**: `target: InspectorTarget | null` + `onClose: () => void`.
2. **Same registry**: it reads from the same `registerInspectorSlot` /
   `resolveInspectorSlot` API in `@wrongstack/core/hq` (or a thin
   re-export from `packages/webui-ui`).
3. **Same return semantics**: returns `React.ReactElement | null`,
   `null` for "drawer closed" or "unknown kind".
4. **Same scrim + drawer UX**: scrim catches outside clicks, drawer
   is keyboard-accessible (Escape closes), focus is moved into the
   drawer on open and restored on close.

The HQ swap is a one-line change in `inspector-slots.tsx`:

```ts
// before
import { RightInspector } from './inspector-slots.js';
// after
import { RightInspector } from '@wrongstack/webui-ui'; // when ready
```

## Test contract

The handoff is locked by `packages/webui-hq/tests/inspector.test.tsx`:

- The registry resolves only known kinds; unknown kinds return `null`.
- The shell renders `null` when `target` is `null` (drawer closed).
- The three default slots render non-empty bodies for their documented
  kinds with the correct deep links.
- The shell returns `null` for an unknown kind (no throw).
- Slot registration is idempotent and replaceable.

When the workbench team implements `WorkbenchShell.RightInspector`,
those same tests run against their implementation to confirm the
contract is honored.

## Per-slot deep-link format

The default slots emit these deep links, which the workbench team must
keep stable:

| Slot | URL pattern |
|------|-------------|
| `hq.kanban.task` | `/projects/{projectId}/board?task={taskId}` |
| `hq.mailbox.message` | `/projects/{projectId}/mailbox/{mailboxId}?message={messageId}` |
| `hq.client` | (no link — read-only in HQ) |

Mutations stay in the per-project WebUI session. HQ is read-only by
design; the deep link is the only path to act on a record.

## What's intentionally NOT in this contract

- **Animations / motion design.** The HQ shell is minimal by intent; the
  workbench team owns the visual treatment.
- **Multiple stacked inspectors.** The contract is one inspector at a
  time; the workbench team can extend later if a use case appears.
- **Cross-window sizing.** The shell uses 360 px wide on desktop and
  full-screen on mobile. If the workbench shell uses a different
  breakpoint, that's a design decision, not a contract violation.

## Status

- **C1 (2026-07-31):** scaffolding landed in `packages/webui-hq` with
  9 / 9 focused tests passing. The hand-rolled shell in
  `inspector-slots.tsx` is the placeholder; once `packages/webui-ui`
  ships `WorkbenchShell.RightInspector`, the import in
  `packages/webui-hq/src/main.tsx` (or wherever the inspector is
  mounted) swaps to the new package.
- **Open question for the workbench team:** should `InspectorTarget` be
  re-exported from `@wrongstack/core/hq` (current location) or moved
  into `packages/webui-ui`? Today it lives next to the shell for
  proximity; a move would centralize the contract in one place but
  require HQ to depend on `webui-ui` types.
