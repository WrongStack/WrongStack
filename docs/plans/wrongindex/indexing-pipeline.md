# Watcher and indexing pipeline

Status: proposed. All timing/budget values below require measurement.

## 1. Attach without an initial-scan gap

1. Validate registration, compatibility profile, permissions, and owner epoch.
2. Mark project freshness unknown/pending and allocate a reconciliation run ID.
3. Start root watch registration before enumerating the tree, buffering reduced events.
4. Enumerate files using the current discovery/ignore contract.
5. Read/parse a bounded snapshot candidate and stage results.
6. Replay buffered dirty paths; revalidate changed files before publication.
7. Publish a complete usable generation, then drain any later events as incremental work.
8. If watch registration/discovery was incomplete, preserve last good data and schedule a retry; never claim current.

Some OS backends cannot atomically register an entire tree. Record that uncertainty and run a second reconciliation pass. Watching first reduces races but does not prove an immutable filesystem snapshot.

## 2. Discovery

Port current behavior for Git tracked files, untracked eligible files, dirty snapshots, non-Git traversal, ignored files, supported extensions, symlinks, and directory pruning. `ignore` is a candidate library, but its defaults must not silently change the indexed set.

Discovery returns `files`, `complete`, `errors`, `discoveryRevision`, and applicable Git snapshot information. A failed directory read makes the affected scope incomplete. Only a complete authoritative scan may remove stale rows by absence.

Never invoke project scripts to discover files. Git processes use explicit arguments, bounded deadlines/output, and no shell. A Git failure either falls back to a complete filesystem walk under the same contract or produces degraded discovery; it cannot become an empty successful file list.

Ignore policy:

- Preserve current built-in exclusions and user configuration.
- Exclude WrongIndex's own logs/staging/registry and SQLite sidecars from self-trigger loops.
- When an ignore/config file changes, re-evaluate the affected scope and remove/add rows only after complete discovery.
- Track policy revision independently from content hashes; newly excluded files need deletion even if bytes are unchanged.
- Do not globally assume every `dist`, `vendor`, or lockfile is ignored; derive initial behavior from the baseline and allow explicit configuration.

## 3. Event model

Normalize OS events into `PathDirty`, `DirectoryDirty`, `PossibleRename`, `RootUnavailable`, `PolicyChanged`, and `ReconcileRequired`. Retain enough cause information for diagnostics without persisting raw OS event floods.

| Input | Reduction / action |
|---|---|
| Repeated modifications | One dirty path with latest observed revision |
| Atomic editor replacement | Re-stat/read final path; index resulting file once |
| Create then delete before flush | Resolve current existence; avoid publishing temporary rows |
| Delete then recreate | Parse final bytes; do not preserve stale deletion intent |
| Rename with both paths | Dirty old and new paths; invalidate dependent bindings |
| Rename with one/uncertain path | Directory reconciliation; never depend on perfect pairing |
| Directory create | Discover and register descendants under current policy |
| Directory delete | Verify authoritative absence; remove descendants transactionally |
| Metadata-only touch | Hash check; update allowed metadata, skip parse |
| Manifest/config edit | Re-evaluate package/module relations and affected resolution |
| Overflow/backend rescan flag | Collapse queued detail to reconciliation marker |
| Sleep/resume or volume remount | Reattach if needed and reconcile |
| Branch checkout / mass rewrite | Coalesce burst, retain query availability, perform suitable reconciliation |

`notify` documents platform/event limitations and polling as a fallback. Implement Windows behavior with real filesystem tests, not a Linux-only event simulator. [notify documentation](https://docs.rs/notify/latest/notify/)

## 4. Queue and debounce rules

- Keep dirty sets per project with revision counters rather than a timer per raw event.
- Maintain a deadline heap/timing wheel or equivalent bounded timer structure.
- Initial per-path quiet period 400 ms; initial cross-path window 50 ms; hard maximum wait 2 seconds.
- Once admitted to a run, additional edits advance the path revision; successful publication only clears revisions covered by that run.
- Full scan can subsume earlier incremental requests, but request receipts must settle against the resulting generation.
- At 10,000 distinct dirty paths, retain one `reconcile_required` marker and release excess detail.
- Persist coarse dirty/recovery intent, not every keystroke. After any daemon restart, mandatory reconciliation covers events lost before persistence.
- Prioritize active sessions while aging pinned-background work so it eventually progresses.
- Idempotency keys deduplicate retried requests; they do not make stale source results safe to commit.

## 5. Read/hash/parse stages

For each eligible path:

1. Resolve containment and current type; reject unsafe symlink escapes according to policy.
2. Stat and read with file size/resource limits.
3. Use trusted clean Git blob metadata only under the existing qualifying snapshot rules.
4. Compute the compatible content hash; skip parse for exact unchanged bytes/profile.
5. Parse in a bounded slot with cancellation checks.
6. Derive source symbols, module owner, refs, fingerprints, and parser diagnostics.
7. Recheck stat/content evidence to detect edits during the operation.
8. Return a versioned parse result containing input hash, path revision, profile, config revision, and owner epoch.

Parser interface draft:

```text
ParseInput(path, language, source, profile, cancellation)
ParseOutput(symbols, refs, diagnostics, outcome, provenance)
outcome = success | empty | unsupported | failed
```

Use exact field semantics from the compatibility fixtures. `unsupported` is never an empty successful parse that erases existing rows. Generic fallback behavior must be explicit and profile-compatible.

A file can change after a final validation read. The supported guarantee is transactional database consistency plus eventual convergence under continued changes, not an atomic snapshot of a mutable directory. Dirty revisions and reconciliation prevent claiming stability while known edits remain. Repeatedly unstable files become visible degraded/pending work rather than infinite blocking of every project.

## 6. Staging and publication

Default design: parse outside the mutable database transaction; retain bounded results in memory and spill large full runs into a private staging store. Staging has a global quota, per-project budget, cleanup policy, and source/run/profile identity.

Publication transaction:

1. Validate owner epoch, configuration revision, backend/profile, and run validity.
2. `BEGIN IMMEDIATE` on the project's writer connection with bounded retry.
3. Allocate IDs and replace/delete relevant rows.
4. Update FTS, refs, dependent target invalidation, optional vectors/concept state, and other affected rows.
5. Resolve touched names and module/import relations under the compatible incremental/full strategy.
6. Apply required reference binding and eligible rank computation before declaring graph usability.
7. Write graph/version markers, committed run ID, generation, and timestamps using baseline no-op semantics.
8. Commit.
9. Invalidate in-memory caches, update replayable registry bookkeeping, and broadcast committed generation.

Failure before commit rolls back all changes and retains the prior usable generation. Failure after commit is recovered through committed metadata. Do not publish progress=100% before commit.

Large full runs may make this transaction too long. The implementation spike must measure it. An alternative publication strategy requires its own ADR and proof that all query clients observe a complete generation. Windows open-file/WAL semantics rule out casually replacing a live `index.db` file. Batch-by-batch live writes cannot be presented as whole-generation atomicity unless every reader participates in a proven generation filter/snapshot mechanism.

## 7. Incremental dependency correctness

Indexing a changed file is not enough when it changes the target of existing references elsewhere.

Required invalidation domains:

- Removed/renamed exported symbols and all previously resolved incoming references.
- Added symbols that can resolve previously unresolved names.
- Import aliases/re-exports and module path changes.
- Package manifest changes, workspace members, TS config paths, language-specific package roots.
- File/directory deletion and rename.
- Parser semantic/profile changes.

Port current targeted reference repair, relation structure keys, import-aware binding, and graph-rank refresh rules first. Optimize only after output parity. Track why a graph pass ran and how many rows it touched so single-file hot paths can be measured.

## 8. No-op behavior

For watcher echoes and unchanged targeted requests:

- No new content generation.
- No full relation/rank recomputation without a relevant invalidation cause.
- No FTS/vector churn.
- No rewrite of equal metadata values.
- No new Git trust from an incomplete/targeted scan.
- Job receipt can still complete successfully against the existing generation.

A complete unchanged scan may update verification/last-indexed timestamps according to the current contract. Track verification time separately from content-change time in GUI/diagnostics.

## 9. Optional concepts, vectors, and external bridges

Structural indexing works offline without an LLM. Preserve existing concept/subsystem/vector data, apply current stale/structural-change rules, and never replace a valid vector with a different provider's space silently.

New enrichment runs are low priority, separately enabled, cancelable, and budgeted. Their write effects use the same owner lane and generation/cache rules. Credentials and provider settings must not be copied into source-index metadata.

Current finalization can heal anchored SAGE memories after detected symbol moves. Inventory this side effect. During preview preserve it through the compatibility backend; native parity either implements the corresponding integration event/adapter or advertises an unsupported capability that blocks a claim of complete current-profile parity.

## 10. Reconciliation policy

Reconcile on initial attachment, daemon restart, resume after pause/sleep, watcher overflow/error, root/volume restoration, ignore/profile/backend change, and explicit user request.

Proposed periodic policy: metadata/discovery reconciliation every 15 minutes for active projects with jitter, and a deeper hash verification every 24 hours for pinned projects. Make these configurable; current explicit dirty paths are always processed earlier. Do not rely solely on mtime for the deepest verification because same-size content can be rewritten with restored timestamps.

Polling fallback interval proposal: 5 seconds with configurable cost controls and visible mode. Filesystems unable to support the guarantees must be marked unsupported/degraded. A pinned project is not "current" merely because polling ran once.

## 11. Cancellation and retry

Cancel queued jobs immediately; active parser tasks check tokens between bounded operations. Publication cancellation either occurs before commit with rollback or reports that a commit already completed. Never return `CANCELED` for a generation that was successfully committed without recording that outcome.

Retry only transient errors with capped exponential backoff and jitter. A parse syntax error, unsupported profile, or permission denial is not an endless fast retry loop. Watch changes, policy changes, or explicit retry can reactivate it. Repeated failures open a per-project circuit with a visible reason; other projects continue.

## 12. Maintenance

Run passive checkpoint work after quiet periods; observe busy readers rather than forcing their termination. Truncate/checkpoint and optimize actions require the writer lane and must not overlap publication. Do not run VACUUM after every file change.

Bound logs, staging, job history, backups, and WAL monitoring. A journal size limit is not a hard cap on an actively retained WAL. Disk-pressure reporting must identify the actual retaining reader/staging/log category when available and avoid deleting unknown files to free space.
