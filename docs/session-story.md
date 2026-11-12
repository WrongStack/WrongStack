# Session Story

Open the WebUI with `wstack --webui`, select a session tab, and click **Story**
in the tab bar. This read-only view follows that tab's recorded work, including
its leader and subagents. No system prompt change is needed.
The secondary left menu also has a compact **Story** widget above its panel
content, available while browsing Session, Files, Changes, Mailbox, or other
sidebar panels. It shows retained leader tool calls, explicitly owned workers,
session age, and a mini chart of retained call starts for the active tab. It
uses existing live stores without polling Chronicle. Click to open the full
dashboard; while Story is open the same widget becomes **Back to session**.
It stays above the scrolling sections. On mobile either action closes the sidebar overlay. Select a session to
enable the widget. These cached snapshot counts are not durable history totals.

The dashboard opens on **Overview**, with an animated category ring, observed
team overlap chart, participant activity bars, recorded reach, and density.
**Timeline** holds replay and event details; **Models**, **Tools**, **Files**, and **Team**
keep deeper tables and the constellation separate. Tabs support arrow/Home/End
keys. Category buttons and table names open the corresponding timeline filter.
**Effects on/off** controls decorative motion; system reduced-motion preferences
are honored. Running roster actors have pulsing nodes and flowing connections;
these are status effects, not evidence of individual network/mail transmissions.

**Tools** reports paired call counts, successful/failed or blocked results,
unsettled calls, average/P95 terminal duration, measured-call coverage, and total
measured tool time. Missing timing is excluded from averages. Total tool time
adds overlapping calls and is not session wall time.

**Models** compares leader and worker evidence by provider + model, with three
compact views:

- **Reliability:** paired physical attempts, usable/failed/unsettled results,
  attempt success rate and sample count, logical requests, actual retry attempts,
  retry scheduling/delay coverage, recovered requests, and fallback in/out.
- **Speed, tokens & cost:** mean/P50/P95/max terminal latency, first-chunk
  latency, measured sample coverage, fresh input/output tokens, disjoint cache
  reads/writes and cache-hit ratio, output tokens per full response second, and
  per-call estimated cost with pricing coverage.
- **Work & quality signals:** tool success/failure/blocked/unsettled results,
  tool timings, invalid tool input/unknown-tool settlements, reported task
  outcomes (including timeout/stopped), verification failures, loop detections,
  recorded drift/interventions, and length-limited stop reasons.

Reliability/latency comparison bars open a model's HTTP status, failure kind,
stop reason, and latest diagnostic records. Diagnostic buttons open the original
timeline evidence. Search and sort support attempts, failures, average latency,
and recorded spend. Model details also show prompt/output token size distributions,
message/tool roster size, streaming sample coverage, and average priced-call cost.

Model attribution requires a recorded model identity or a unique attempt,
request, or task correlation. Ambiguous model switches remain **Unknown model**;
the latest actor model is never used to assign earlier failures. Worker provider
attempts are paired by actor + attempt ID; cumulative token snapshots are not
added to attempt usage. Token accounting deltas supplement models with no
recorded attempt usage. New accounting events record `deltaCost` before being
bridged from subagents, so actor totals across model changes do not get charged
to the last model. Unknown prices and old events without per-call costs display
`—`, while genuine zero pricing is preserved.
Leader loop detection is journaled with its selected model. Worker loop detection
is bridged separately under the host session, keeping the worker identity.
New accounting/loop fields require the updated runtime and a restart; they are
not backfilled into older sessions.

A usable API response is not proof of correct work. Task completion is a
reported status, and a tool failure can be environmental or permission-related.
Verification, loop, and intervention evidence remains separately inspectable;
the dashboard does not fabricate an intelligence/correctness score. Throughput
includes full response latency and prefill, not just decode; first chunk may be
thinking. Missing measurements and incomplete windows remain visible.

**Files** reports successful reads/edits/writes per normalized path, cumulative
returned source lines, and diff additions/deletions. New Chronicle records keep
compact numeric file statistics before output previews are truncated, including
subagent results. Older records without these statistics show `—`. Read counts
include repeat operations, and line counts include repeated returned lines.
Partial diffs and incomplete measurement coverage are marked. Diff counts are
operation totals, not net changes compared with Git. Directory/file counts
describe observed paths; they are not a percentage of repository coverage.

The screen combines:

- Summary cards for observed elapsed span, team lanes, paired tool calls,
  recorded files, unique injected memory IDs, memory write events, mail activity,
  and explicitly recorded drift/retry/error events.
- A stacked activity-density chart and parallel actor timeline, with recorded
  durations and clickable markers. **Export SVG** saves the timeline.
- A team constellation: dashed edges indicate session membership; solid edges
  indicate an explicitly recorded parent agent. Missing parents stay unknown.
- Intra-session branch lanes (`branch:<branchId>`): when a session forks via
  [`/tree`](slash/tree.md) or `session_branch`, `branch_created`,
  `branch_switched`, and `branch_folded` journal records project dedicated
  branch lanes alongside leader and worker lanes with parent-branch lineage.
- Replay controls, actor/category filters, search, a paginated event stream,
  recorded metadata, actor assignments/models when available, and file footprint.

## Ownership and evidence

Chronicle events are queried by the active tab's session ID. Subagent events
recorded under their host session belong to the same story. Fleet actors and
memory traces require an explicit matching session ID. Mail requires a matching
sender/recipient session or a known participant endpoint. Untagged activity and
other tabs' history are excluded. Correlated query replies prevent delayed
responses from a previous tab from changing the current story.

Successful file tools recover paths from their paired recorded inputs. Paths are
normalized relative to the project where possible. Failed reads do not count as
file touches just because their input named a file. Resource events can also
provide file evidence. Injected memory IDs mean recorded context injection;
they do not prove the model used a memory successfully. Memory write events count
records, including native persistence and successful tool confirmations; these
are not necessarily distinct memory entries.

Elapsed span and lane lifetimes are observed intervals, not summed parallel
worker time. Missing timestamps, durations, branch relationships, or drift
diagnoses are never generated. Task/goal/work events appear when recorded;
this view does not infer completed work from a tool invocation.

## Coverage and limits

The initial Chronicle page loads the latest 5,000 events. **Load earlier** pauses
following and can retain up to 10,000 events. Refresh/follow replaces this window
with the latest page. Following polls every 10 seconds while the view is open.
Replay affects timeline and stream; summary cards, density, and team map describe
the loaded window, and roster statuses reflect their latest known state.

The timeline displays up to 32 actor lanes and samples up to 1,000 markers. The
constellation shows up to 24 actors. Actor filters and the event stream retain
access to all loaded participants/events. File footprint previews 30 paths.

Mail and injector traces supplement durable Chronicle history from bounded
recent caches (100 messages and 50 traces). Mail bodies are previewed up to 3,000
characters. Historical sessions may lack cached mail, assignments, or traces;
the screen is not a complete audit of unrecorded activity. Empty history and
backend errors are displayed explicitly. Query correlation needs an updated
backend; restart the WebUI backend after upgrading if replies time out.

## Verification

Focused projection tests cover tab ownership, subagents, tool pairing, duration
evidence, successful/failed file paths, memory IDs, mail scoping, and absent data.
Component tests cover parallel lanes, marker selection, search/replay, and stale
cross-tab replies, dashboard tabs, keyboard navigation, and effects controls.
Server route tests cover query and error request correlation. Numeric evidence
tests cover pairing, measured averages, overlap boundaries, diff headers,
preview truncation, and subagent output redaction.
