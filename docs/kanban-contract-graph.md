# Kanban Contract Graph

> **How the map is written**: the node/edge API described below became
> reachable in 0.304.0 — `kanban` tool actions (`configure_contract_graph`,
> `upsert_contract_node`, `add_contract_edge`, …), `kanban.contract.*`
> WebSocket routes, and the MCP `kanban_manage` tier. Until then it had no
> caller on any surface. See
> [kanban-architecture.md §18](kanban-architecture.md#18-card-contract-and-atomicity).

The Kanban contract graph is an optional safety and visualization layer for
autonomous coding work. The task description and executable acceptance
criteria remain the normal execution contract. Agents must not spend their
implementation loop constructing or repairing a graph unless the user
explicitly asks for graph work.

This is a different graph from the execution dependency DAG:

- `dependsOn`, parent/child tasks, and chains describe **work ordering**.
- `contractGraph` describes **outcomes, impact, constraints, risks, and proof**.

The two graphs coexist on a board. Dependency edges must remain acyclic. Impact
and conflict relationships may contain cycles because real components and
constraints can affect one another bidirectionally.

## Model

Every explicit contract node belongs to a task. The task itself is an implicit
endpoint named `task:<taskId>` so task records are not duplicated inside the
graph.

| Node kind | Meaning | Typical enforcement |
|---|---|---|
| `objective` | The measurable result being optimized | blocking |
| `guardrail` | A property that must not regress | blocking |
| `risk` | A discovered failure or trade-off risk | blocking or advisory |
| `component` | Runtime/package/service potentially affected | informational |
| `artifact` | File, schema, API, report, or other affected output | informational |
| `verification` | Concrete evidence for another node | blocking or advisory |

Supported relationships are `targets`, `affects`, `must_preserve`, `exposes`,
`verified_by`, `conflicts_with`, `derived_from`, and `relates_to`. Objective,
guardrail, risk, component, and artifact nodes are automatically connected to
their owning task when created. Verification nodes are linked explicitly to
the claim they prove.

Contract nodes may bind to an existing task `successCriteria` check or
`goalMetrics` metric. The binding is important: in strict mode, a caller cannot
make a blocking claim pass merely by writing `state: satisfied`. Check and
metric status is the effective state when a binding exists.

## Enforcement

Autonomous product mutation has a separate pre-implementation hard gate. The
card must be on a managed board and contain its owner, due date, labels,
description, and executable acceptance criteria. The agent then calls
`start_task`, which moves the card through the adjacent lifecycle stages to
Running, creates a live assignment, and binds the card to the current run.
Write, shell, package, Git mutation, and other product mutation tools are
blocked in the central tool executor until this succeeds. A missing, off, or
advisory Contract Map does not participate in that gate.

Boards choose one graph enforcement level:

- `off`: graph data is retained but not evaluated.
- `advisory`: issues are reported but do not block completion.
- `strict`: an explicit operator-owned audit severity. Its unresolved issues
  are prominent in evaluation and review surfaces, but do not block
  `start_task`, product mutation, verification, or managed lifecycle
  transitions. The autonomous Kanban tool cannot enable this mode.

Strict evaluation requires:

1. At least one objective for the task.
2. At least one guardrail for the task.
3. Every blocking objective, guardrail, risk, and verification to be satisfied,
   resolved, or covered by a valid human waiver.
4. Every blocking objective, guardrail, and risk to bind directly to a check or
   metric, or to have a `verified_by` edge to satisfied bound evidence.
5. Every blocking `conflicts_with` edge in the task closure to be settled.

The resulting completion rule is:

```text
Done = acceptance criteria passed
   AND verification report passed where required
   AND dependency/child lifecycle gates passed
   AND review evidence persisted
```

Waivers exist in the domain model for human-owned review surfaces, include an
actor, reason, timestamp, and optional expiry, and are invalid after expiry.
The autonomous `kanban` tool cannot create waivers, loosen a strict graph,
change the kind/enforcement of an existing strict node, or remove blocking
strict nodes/edges.

## Autonomous workflow

For ordinary code changes an agent should fill the card, add executable
acceptance criteria, call `start_task`, implement, and verify. It should not
configure, inspect, or repair the Contract Map merely to make progress.

Advisory maps may be populated by operator tooling or deterministic projections
for visualization. Strict maps use the same deterministic closure rules but
remain an operator audit surface rather than agent work or a lifecycle gate.
Agents surface real findings and continue the requested task; they do not
weaken, self-waive, or stop to repair the map.

## Tool actions

| Action | Purpose |
|---|---|
| `get_contract_graph` | Read graph nodes, edges, and enforcement |
| `configure_contract_graph` | Initialize off/advisory data; strict enablement is operator-owned |
| `upsert_contract_node` | Add/update an objective, guardrail, risk, impact, or verification node |
| `link_contract_nodes` | Add a typed relationship |
| `evaluate_contract_graph` | Return deterministic closure issues for one task |
| `start_task` | Validate readiness, enter Running, create the assignment, and bind runtime governance |
| `remove_contract_node` | Remove a non-protected node |
| `remove_contract_edge` | Remove a non-protected edge |

All stateful operations execute through the Kanban project server. The graph is
stored atomically inside the authoritative board payload in
`.wrongstack/kanbans/_kanban.sqlite`; clients do not open SQLite directly.
Graph mutations emit durable `contract.*` Kanban events.

## Copy, duplicate, and delete behavior

- Board duplication remaps task IDs, check IDs, metric IDs, node IDs, implicit
  task endpoints, and edge IDs.
- Cross-board task copy carries the task-owned self-contained contract
  subgraph and remaps its bindings.
- Task deletion removes its owned nodes and all incident edges.
- Legacy boards without a graph retain existing behavior. This avoids turning
  migration into false breakage; strict enforcement is explicit.

## Presentation

The WebUI `Contract Map` board view renders every task and its objective,
blast-radius, risk, guardrail, and evidence nodes on one interactive canvas.
It combines contract coverage and closure scores, open-issue counts, a minimap,
typed legend, and task drill-down so missing protection is visible at board
scale. The task inspector renders the selected task's reachable graph with typed node
colors, relation labels, enforcement, and unresolved issues. The TUI task
detail shows a compact `Contract <mode>: closed|N open` summary. Markdown board
exports include nodes and edges so offline review does not lose the safety
contract.
