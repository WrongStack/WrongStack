# AI Code Provenance and Engineering Debt

## Purpose

WrongStack already records provider attempts, content-addressed prompt manifests,
tool calls, file mutations, task outcomes, review findings, and architecture
health signals. This design joins those facts into an evidence graph that can
answer two different questions without pretending they are the same:

1. **Provenance:** which human instruction, model request, agent, and tool most
   likely produced a file or code hunk?
2. **Engineering quality:** how long did that code survive, how often was it
   reworked, and which objective quality signals were later attached to it?

The raw Chronicle journal remains the durable evidence log. `metrics.db` remains
a disposable, rebuildable projection for interactive queries and dashboards.

## Non-goals

- Do not classify every changed line as AI-generated merely because an agent
  session was active.
- Do not treat a later edit as proof that earlier code was broken.
- Do not store unsanitized prompts, secrets, or provider request bodies in an
  analytics database.
- Do not make commit-message trailers mandatory or mutate Git history merely to
  improve analytics.
- Do not collapse uncertainty into a single unqualified "AI percentage".

## Evidence graph

The target lineage is:

```text
actor/session
  -> human input
  -> prompt manifest + logical request
  -> model attempt/response
  -> tool call
  -> file mutation (before/after identity and line intervals)
  -> Git hunk/commit
  -> later mutation, revert, finding, test, or architecture signal
```

Every edge carries one of four confidence levels:

| Confidence | Meaning |
| --- | --- |
| `explicit` | Both records contain the same stable identifier, such as `toolUseId`, `logicalRequestId`, or `promptManifestId`. |
| `correlated` | Identity follows from a bounded runtime relationship, such as one active request in the same session/agent context. |
| `inferred` | Content hashes, Git hunks, paths, and time windows agree, but no shared runtime identifier exists. |
| `unknown` | The mutation was observed, but no defensible AI or human attribution exists. |

Product copy must say **AI-assisted** for explicit/correlated attribution. Inferred
results must be shown separately or as a confidence interval. Unknown changes
must remain unknown.

## Runtime provenance contract

For each physical provider request WrongStack already creates a
`logicalRequestId` and a content-addressed `promptManifestId`. These identifiers
must remain active on the owning `Context` until the resulting tool calls have
finished. They are copied into:

- `tool.started`, `tool.completed`, `permission.evaluated`, `tool.executed`, and
  `tool.failed`;
- `file.event` and the session `file_event` record;
- Chronicle correlation fields;
- the `file_lineage` metrics projection.

This makes prompt-to-file attribution an explicit graph edge rather than a
timestamp guess. Provider retries retain the same logical request and prompt
manifest while receiving distinct attempt IDs.

Prompt manifests are identities, not a second prompt archive. They commit to
the system prompt, conversation messages, tools, and request parameters using
hashes. Authorized prompt inspection should resolve the owning session journal,
where content has already passed through the configured secret scrubber.

## Git reconciliation

The next implementation phase belongs to the per-project Chronicle owner. A
read-only Git observer should ingest commits with stable, NUL-delimited commands
and create `git.commit.observed` plus provenance-edge records.

Matching order:

1. optional WrongStack commit trailer -> explicit;
2. committed blob/hunk hash matching a recorded mutation -> correlated;
3. path, line overlap, author/session window, and rename history -> inferred;
4. otherwise -> unknown.

The reconciler must tolerate squash, rebase, merge commits, renames, formatting
commits, and changes produced through shells or external editors. Reconciliation
is idempotent and stores the Git object ID and evidence, never only a mutable
branch name.

## Churn and quality semantics

The dashboard must keep the following metrics separate:

- **Survival:** attributed lines or hunks unchanged after 7/30/90 days.
- **Churn:** additions plus deletions touching attributed hunks in a time window.
- **Rework:** a material fraction of a recently introduced hunk rewritten.
- **Ownership transfer:** a different actor/agent becomes the latest owner.
- **Refactor:** structural rewrite without an objective failure signal.
- **Breakage:** only a revert, verified defect/security finding, blamed failing
  test, or explicit fix relationship. A later edit alone is not breakage.
- **Debt pressure:** a vector, not initially one score: churn, complexity,
  architecture hotspot growth, coverage movement, verification failures,
  findings, and ownership concentration.

When a composite score is introduced, its formula and components must be
versioned and individually inspectable. Historical charts retain the formula
version used at computation time.

## Privacy, identity, and governance

- Actor identity distinguishes authenticated operator, Git author, WrongStack
  agent, provider, and model; these identities are related but not conflated.
- Prompt content stays scrubbed and access-controlled. Organization mode should
  support retention limits and encryption at rest for resolvable prompt text.
- Model identity records provider ID, requested model ID, and provider-reported
  revision when available. Missing revisions remain absent rather than guessed.
- Exports default to hashes, counts, and redacted excerpts.
- Deletion/retention acts on raw prompt/session content independently from
  aggregate metrics, while preserving auditable tombstones where policy allows.

## Delivery slices

1. **Correlation backbone:** propagate request and prompt-manifest identities to
   tool/file events and indexed lineage. This document's first implementation.
2. **Git observer:** commit/hunk reconciliation, rename handling, and confidence
   evidence.
3. **Quality joins:** review findings, task verification, tests, coverage, code
   metrics, and architecture health snapshots.
4. **WebUI:** Provenance Explorer, file/hunk blame, survival curves, churn cohort
   comparison, and debt-pressure graph.
5. **Governance:** retention/RBAC, organization rollups, CI import, and signed
   exports.

## Acceptance criteria for slice 1

- A provider attempt exposes one prompt manifest identity for its logical
  request.
- Every tool lifecycle and tool-owned file mutation can carry that identity.
- Chronicle graph queries connect prompt manifest -> logical request -> tool
  call -> file resource using explicit edges.
- `metrics.db` file lineage returns the logical request, prompt manifest, and
  attribution confidence without scanning raw journals.
- Legacy/external events remain readable and project as `unknown`, never as AI.
