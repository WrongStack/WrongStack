# Kanban Workbench

The Kanban Workbench is the cross-board navigation layer for autonomous work.
It answers four questions without turning the UI into another task database:

1. What is executing now?
2. What can start next?
3. What is blocked and why?
4. What is waiting for evidence or acceptance?

Authoritative state remains in the project Kanban server and SQLite store. The
Workbench is a bounded projection returned by `getKanbanWorkbench`; WebUI,
TUI, and SimpleUI never reconstruct global state from the currently paginated
board.

## Shared lanes

| Lane | Meaning | Placement explanation |
|---|---|---|
| Now | Running assignment or in-progress task | Live execution versus manually marked progress is explicit |
| Next | Queued or dependency-ready task | Queued ownership versus ready detail is explicit |
| Blocked | Explicit blocker, unresolved dependency, or failed run | The reason and unresolved dependency count are shown |
| Review | Implementation finished but not accepted | Evidence, verification, or human acceptance is still required |

The visual pipeline (`Captured -> Ready -> Executing -> Review -> Verified`)
explains the durable lifecycle. It is descriptive, not a replacement for the
managed lifecycle transition gate.

## Preventing overload

- Each lane is bounded to `1..50` returned cards; surfaces request smaller
  defaults (WebUI 8, SimpleUI 6, TUI 3).
- Total and omitted counts are retained, so hidden cards are never presented
  as absent.
- Alerts are independently bounded and expose their omitted count.
- Completed cards contribute to verified totals but are not copied into the
  active lanes.
- Project, SDD, import, and session-mirror boards are included; archived boards
  are excluded by default.

Session mirrors are labelled `session`; independent durable cards are labelled
`managed`. Exact-title duplicate warnings intentionally ignore session mirrors
because tactical Todos are expected to have a mirrored card. Managed-card
duplicates remain visible as an attention item.

## Operational signals

The projection surfaces expired execution leases, near-expiry heartbeats,
retryable failures, and exact normalized duplicate managed titles. Parent cards
include completed/total child rollups. Clicking a WebUI card or task-backed
alert loads the authoritative board and opens that task; no copied task is
edited through the Workbench.

## Surface behavior

- WebUI: the Kanban `Focus` tab provides the full pipeline, alert grid, and four
  cross-board lanes with drill-down.
- TUI: `/flow` (alias `/workbench`) renders the shared pipeline, bounded focus
  lanes, placement reasons, omitted counts, and alerts in a text-first view.
- SimpleUI: the workspace launcher exposes `FLOW`, with the pipeline, alerts,
  and bounded lanes refreshed while the panel is open.

Every surface uses the same typed `KanbanWorkbenchSnapshot`. If a lane rule or
alert meaning changes, update the server-side projection rather than forking UI
logic.
