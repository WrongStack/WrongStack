# Project architecture decisions

WrongStack keeps a persistent registry of Architecture Decision Records (ADRs) for
each project. Agents can propose a lasting choice and explain its alternatives;
only a user review activates the exact proposal revision. Acceptance records a
decision, not proof that the implementation follows it.

## Review a decision

Open **ADRs** in the session workspace dock. The panel supports new proposals,
editing pending proposals, accepting or rejecting a displayed revision with a
reason, retiring accepted decisions, and downloading Markdown. Pending and
rejected proposals do not become instructions for agents.

The dock's ADR chip shows the number of proposals awaiting review even while the
panel is closed. Opening it lists pending proposals first. The dock and panel share
one small summary query per session/project: it refreshes every 15 seconds while
the browser tab is visible, on focus, and after a panel proposal or review. Hidden
chips do not poll unless the panel itself is open. Offline queries are not queued
for replay; an unavailable inbox displays `?` instead of a stale count.

An open panel refreshes its list when the registry changes, preserving an unfinished
proposal and the displayed review content. When the refreshed list detects a changed
displayed revision, review actions are disabled until **Open current revision** is
selected; the user then reviews the replacement content and enters a fresh reason.
Background updates never approve a proposal. The bounded `/adr summary-json`
response contains counts, project identity and a registry version digest, without decision text or additional model
tool schemas.

The same registry is available through portable slash commands in the TUI,
WebUI and desktop:

```text
/adr
/adr show <id>
/adr history <id>
/adr revision <id> <revision>
/adr accept <id> <revision> <contentHash> <reason>
/adr reject <id> <revision> <contentHash> <reason>
/adr deprecate <id> <revision> <contentHash> <reason>
/adr export <id>
/adr export-json <id>
/adr import <portable JSON>
/adr check [id]
```

Copy the revision and full content hash from `show`. A stale revision, a mismatched
hash, a missing reason, or an already resolved proposal is rejected. Permission
approval for an agent tool, a recommendation selected by a model, and user silence
are not ADR acceptance. `/adr export` returns Markdown; the panel downloads the
same representation for sharing in `docs/adr/`.

Panel reviews also bind the response to the displayed project identity. A delayed
response cannot authorize a different project after switching workspaces. The
registry rejects records copied from another project's database; transfer decisions
as new proposals rather than copying approval authority.

## Proposals and replacements

The discoverable `architecture_decisions` tool supports `list`, `get`, `propose`
and `revise`. It has no accept, reject or deprecate action. It stays outside the
direct tool surface in token-saving modes and is available through tool discovery.
Its ordinary tool permission grants proposal/edit access, never review authority.

A proposal contains:

```json
{
  "title": "Keep provider implementations outside core",
  "context": "Core needs a stable provider-independent boundary.",
  "decision": "Define provider ports in contracts and implementations in providers.",
  "alternatives": ["Put implementations directly in core"],
  "consequences": ["Provider changes require an explicit contract"],
  "constraints": ["Core must not import provider implementations"],
  "scope": ["packages/core"],
  "revisitWhen": "The provider contract is replaced"
}
```

Scopes are project-relative file or directory paths, without wildcards or parent
traversal. Empty scope applies to the entire project. Independent decisions should
be separate records; content is bounded to 32,000 serialized characters.

`/adr propose <JSON>` provides the same proposal path to the user. To edit a pending
proposal, use the panel or `/adr revise <JSON>` with `id`, `revision`, `contentHash`
and `proposal`. Revisions preserve previous content in history and invalidate old
review requests. Accepted decision content cannot be edited.

To replace an accepted ADR, propose a new record with `supersedes` set to its id.
The old decision remains active until the replacement is accepted. Acceptance
atomically activates the new record and marks the old one superseded. If another
review has changed the predecessor, replacement acceptance fails without a partial
transition. Identical proposals converge on the existing record, including rejected
ones, so an agent cannot repeatedly reopen the same rejected proposal unchanged.

## Inspect history and propose a replacement

Open a decision and select **Revision history** to see saved revisions, newest
first, with their status, timestamp and recorded proposer or reviewer. Select a revision to inspect its
original content, checks, hash, proposal actor and review reason. These snapshots
are read-only and stay separate from the panel's current review target: viewing an
old accepted revision does not reactivate it or make it the subject of an approval.
**Reload history** fetches the latest revisions without modifying any record.

History loads on demand in pages of 50 summaries, with full content fetched only
for a selected revision. An immutable revision cursor keeps older pages stable
when another agent appends a revision. Project/decision identities are checked on
responses; delayed replies from a previous target are ignored. The same inspection
is available as `/adr history <id>` and `/adr revision <id> <revision>`. Structured
clients can use `history-json <id> [beforeRevision]` and `revision-json <id> <revision>`
through the portable ADR command. These inspection commands cannot review a record.

For an accepted decision, **Propose replacement** opens a new draft containing its
content, scope and checks, with the current id prefilled in **Replaces ADR id**.
Edit the draft and save the new proposal. The original decision remains active;
the replacement requires its own explicit acceptance and reason. Acceptance then
atomically activates the replacement and marks the predecessor superseded. If the
predecessor has changed since proposal creation, acceptance fails without a partial
transition. The original revisions remain inspectable after supersession.

## Transfer proposal content

Use **Download proposal JSON** to save a decision's content for version control or
another project. **Import proposal JSON** validates a selected file through the
engine and opens it as an editable draft. File selection does not write a record.
Review its paths and checks, select **Save proposal**, then separately accept the
local revision with a reason. A draft already open in the panel must be closed
before importing another file.

The portable versioned format is:

```json
{
  "format": "wrongstack-adr",
  "version": 1,
  "proposal": {
    "title": "Keep adapters outside core",
    "context": "Core needs a stable boundary.",
    "decision": "Keep adapter implementations in the providers package.",
    "alternatives": [],
    "consequences": [],
    "constraints": [],
    "scope": ["packages/core"],
    "revisitWhen": ""
  }
}
```

Optional `checks` use the same schema as a new proposal. The transfer contains no
source id, project identity, status, review history or approval. Source-project
`supersedes` links are omitted on export and rejected on import; choose any local
replacement relationship explicitly in the draft. Unexpected fields and unsupported
versions are rejected. Exported scope/check paths stay relative and require review
for the target project. Export does not execute checks or certify target compliance.

`/adr export-json <id>` returns the same JSON. `/adr preview-import <portable JSON>`
returns validated content without writing, while `/adr import <portable JSON>`
explicitly saves through the normal proposal path. In a fresh target project this
creates a new local id in `proposed` state, requiring its own acceptance. Existing
identical local records are deduplicated and keep their current review state; an
import cannot reopen a rejected decision or change a prior local acceptance.

Transfer text is limited to 60,000 characters and 128 KiB of UTF-8, with the normal
32,000-character normalized content limit. WebUI files must be valid UTF-8. Large,
invalid imports do not create records, and file reads finishing after a panel project
switch are ignored. This format transfers one
proposal's content; it is not a registry/history backup or a general Markdown parser.

## Declared compliance checks

An ADR can include optional `checks`. Their definitions are part of the reviewed
content hash; changing a pending check invalidates an older review, and changing
an accepted check requires a replacement ADR. Existing records without checks keep
their original content hash. The panel provides an editor and a **Run checks**
button for accepted decisions. `/adr check [id]` runs one accepted decision or all
active decisions; `/adr check-json [id]` returns the structured result.

```json
"checks": [
  { "id": "manifest", "kind": "file_exists", "path": "package.json" },
  { "id": "runtime", "kind": "json_equals", "path": "package.json", "pointer": "/packageManager", "value": "bun@1.4.3" },
  { "id": "marker", "kind": "contains_text", "path": "src/contract.ts", "text": "export interface Contract" },
  { "id": "no-marker", "kind": "excludes_text", "path": "src/contract.ts", "text": "LEGACY_CONTRACT" }
]
```

Text checks compare literal UTF-8 text. JSON checks compare a scalar value at a
JSON Pointer, including escaped object keys and numeric array indices. These are
specific assertions, not semantic import analysis or proof of an entire design.
Each decision supports at most 16 uniquely named checks. Paths must stay within
the ADR scope and the real project root; directory links escaping the project are
blocked. Commands, scripts, regular expressions and unknown check fields are rejected.

Before each native or owned-provider request, the host evaluates accepted checks
through the registered `read` tool's side-effect-free permission explanation. Only
an `auto` read is eligible: disabled tools, missing policies, `deny` and `confirm`
produce **blocked**, without consuming a one-shot approval or opening a dialog.
Portable commands apply the same host policy. No rule grants read or write access.

Results distinguish **pass**, **fail**, **blocked** and **not configured**. Missing
targets fail; unreadable files, invalid JSON/UTF-8, unstable files and limits block
evaluation. Runs inspect at most 32 rules, 1 MiB per content file and 4 MiB total;
exceeding a limit blocks the run rather than silently producing success. Use a
selected ADR when the project has more rules. Reports include decision revision,
content hash, timestamp and inspected-byte SHA-256 where content was read. Actual
file contents and actual JSON values are not returned. Reports are fresh evaluation
results, not persistent verification certificates. A changed decision set invalidates
in-flight results. The stable system prompt is preserved, and unchanged results do
not acquire new timestamp text in the model prompt on every iteration.

These checks provide automatic evidence and guidance for scoped work. They do not
replace the permission boundary or block all mutations: agents still need to edit
files to repair a failed condition. External ACP/WrongForge workers receive the
declared rules, while actual automatic evaluation occurs at the WrongStack request
boundary or through the explicit command; an external agent's private inner loop
is not certified by a snapshot.

## Persistence and agent context

The registry is stored at:

```text
<WRONGSTACK_HOME>/projects/<project-slug>/decisions/decisions.sqlite
```

`WRONGSTACK_HOME` defaults to `~/.wrongstack`. Project identity and linked checkout
behavior use the existing `resolveWstackPaths` convention. Working-directory changes
within the project do not select another registry. This initial registry is shared
at project level; it does not introduce branch-specific approval namespaces.

SQLite serializes writes with `BEGIN IMMEDIATE`; the current record and append-only
revision history commit together. The registry is independent of SAGE cleanup,
ranking, forgetting and the optional governance feature flag. Its directory is
protected as sensitive agent state, including SQLite WAL files. Ordinary file/shell
permissions remain in force; this is not an operating-system sandbox against code
running with the user's own privileges.

At every provider request, WrongStack reads a current snapshot of accepted
decisions into the live context tail. All active decision text and constraints are
included with scope, id, revision and content hash, without relevance filtering or
silent truncation. Older snapshots are explicitly historical. The stable system
prompt is preserved and transcript compaction does not remove the next request's
snapshot. `context.meta.architectureDecisionSnapshot` records the decision identities
used for that request.

This shared request boundary covers the native leader, native subagents (including
special-purpose prompts), and providers with `keepsOwnContext`, such as an ACP
leader. WrongStack-managed ACP and WrongForge workers also receive the same
snapshot at each task assignment, without rewriting the task supplied by the caller.
Steerable ACP turns check accepted decision identities every five seconds and
inject a changed snapshot through `_session/steering`. Unapproved proposal changes
do not trigger steering. Refresh uses `idleBehavior: promptRequired`, so an idle
peer is not asked to start an unsolicited turn. Timers stop on completion or abort;
failed delivery is not recorded as an applied revision.

Workers without active-turn steering, including the current WrongForge task
transport, receive changes at their next task assignment. Standalone external
clients that do not run through WrongStack still need client-specific context
hooks; MCP availability alone does not establish prompt delivery.

The live guidance asks agents to propose significant architecture choices,
recurring decisions and concrete revisit triggers. This first version does not run
a periodic autonomous proposal agent. Conflicts should be explained before the
conflicting work while independent tasks continue. Arbitrary prose constraints are
guidance. Only explicitly declared checks have deterministic pass/fail evidence.

## Boundaries of this version

Existing `docs/adr/` Markdown, legacy decision journals and SAGE decision memories
are not silently imported or upgraded into user approvals. JSON proposals, versioned
JSON content transfer and Markdown export are supported; general Markdown import,
SAGE projections,
branch-specific policy, standalone client hooks, task exception receipts and
semantic architecture analyzers are separate extensions.

## Validation

The normal Vitest suites cover persistence, project isolation, revisions and stale
reviews, atomic supersession, rejected proposal deduplication, model tools without
acceptance authority, native/owned-context request delivery, user command routing,
and panel interactions including stale replies after project switching.
The fleet suites also exercise a real ACP child-process handshake, initial prompt
delivery and a live refresh after user approval against an isolated protocol peer.
This proves the transport boundary, not compliance by a particular external model.

Run the browser flow with:

```sh
bun packages/webui/tests/architecture-decisions-browser-smoke.mjs
```

The smoke uses the real panel, portable command and isolated SQLite, replacing
only WebSocket RPC with a local fixture HTTP transport. It exercises proposal,
explicit acceptance, reload persistence and Markdown download, checks desktop/mobile
geometry and page errors, and writes screenshots under `.reports/architecture-decisions/`.
