import {
  Archive,
  Camera,
  Check,
  Clock,
  FileClock,
  FolderSync,
  GitGraph,
  HardDrive,
  Layers3,
  List,
  RotateCcw,
  Shield,
  Trash2,
} from 'lucide-react';
import { ExternalDoc, PageHero, PageNext, SectionIntro } from '@/components/site/primitives';

export function CheckpointsPage() {
  return (
    <>
      <PageHero
        index="28"
        eyebrow="Checkpoints"
        title={
          <>
            Rewind file state
            <br />
            <span className="text-brand">safely.</span>
          </>
        }
        description="Checkpoints capture phase-graph snapshots before risky edits. If a phase fails, roll back to the last checkpoint — task statuses, phase progress, and graph state all restored. No git reset, no lost work."
        aside={<ExternalDoc path="docs/checkpoints.md">Open Checkpoints docs</ExternalDoc>}
      />

      {/* ── Checkpoint anatomy ──────────────────────────────────────────── */}
      <section className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10 lg:py-36">
        <SectionIntro
          index="01"
          eyebrow="Anatomy"
          title="Every checkpoint is a typed snapshot of phase state."
          description="A checkpoint doesn't just copy files — it captures the exact state of the phase graph: which phase was active, what each task's status was, and a human-readable label."
        />
        <div className="mt-12 grid gap-6 lg:grid-cols-[1fr_.7fr]">
          <div className="rounded-2xl border border-line bg-card p-7">
            <Layers3 className="size-5 text-brand" />
            <h2 className="mt-8 text-xl font-black text-fg">Checkpoint fields</h2>
            <div className="mt-5 space-y-2">
              {[
                { field: 'id', type: 'string', desc: 'UUID — unique per checkpoint' },
                {
                  field: 'graphId',
                  type: 'string',
                  desc: 'Which PhaseGraph this checkpoint belongs to',
                },
                {
                  field: 'phaseId',
                  type: 'string',
                  desc: 'The active (or last-active) phase at snapshot time',
                },
                {
                  field: 'phaseStatus',
                  type: 'enum',
                  desc: 'running | paused | completed | failed — copied from PhaseNode',
                },
                {
                  field: 'taskStatuses',
                  type: 'object[]',
                  desc: 'Array of { taskId, status, title } — every task in the active phase',
                },
                {
                  field: 'timestamp',
                  type: 'number',
                  desc: 'Epoch ms — used for sorting and TTL pruning',
                },
                {
                  field: 'label',
                  type: 'string?',
                  desc: 'Optional human label. e.g. "Before risky refactor"',
                },
              ].map(({ field, type, desc }) => (
                <div key={field} className="rounded-lg border border-line bg-bg p-3">
                  <div className="flex items-center gap-2">
                    <code className="font-mono text-xs text-brand">{field}</code>
                    <span className="font-mono text-[10px] text-faint">{type}</span>
                  </div>
                  <p className="mt-0.5 text-[11px] leading-4 text-muted">{desc}</p>
                </div>
              ))}
            </div>
          </div>
          <div className="rounded-2xl border border-line bg-card p-7">
            <Camera className="size-5 text-brand" />
            <h2 className="mt-8 text-xl font-black text-fg">What gets captured</h2>
            <p className="mt-3 text-sm leading-7 text-muted">
              Before saving, the checkpoint triggers a graph save to disk. Then it extracts the
              active phase's task statuses — every task in the phase is recorded with its current
              status.
            </p>
            <ul className="mt-5 space-y-2">
              {[
                'Full PhaseGraph saved to PhaseStore first',
                'Active phase identified (status: running or paused)',
                'Every task node\u2019s { id, status, title } captured',
                'Label stored for human reference',
                'If no active phase, falls back to rootPhaseIds[0]',
              ].map((item) => (
                <li key={item} className="flex items-start gap-2 text-xs leading-5 text-muted">
                  <Check className="mt-0.5 size-3 shrink-0 text-brand-2" />
                  {item}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      {/* ── CheckpointManager API ────────────────────────────────────────── */}
      <section className="border-y border-line bg-surface">
        <div className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10">
          <SectionIntro
            index="02"
            eyebrow="API"
            title="Save, restore, list, delete — four operations."
            description="The CheckpointManager class provides a simple API for the full checkpoint lifecycle. Each graph gets its own checkpoint file on disk."
          />
          <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {[
              {
                icon: Camera,
                method: 'saveCheckpoint',
                sig: '(graph, label?) → Checkpoint',
                body: 'Saves the graph to PhaseStore first, then captures active phase state. Writes checkpoint to disk via atomic write + file lock. Returns the new Checkpoint object.',
              },
              {
                icon: RotateCcw,
                method: 'restoreCheckpoint',
                sig: '(checkpointId) → PhaseGraph | null',
                body: 'Loads the checkpoint from memory or disk, loads the PhaseGraph, then restores phase status and task statuses. Returns null if not found.',
              },
              {
                icon: List,
                method: 'listCheckpoints',
                sig: '(graphId?) → Checkpoint[]',
                body: 'Returns all checkpoints sorted newest-first. Pass graphId to filter to a specific PhaseGraph. Reads from in-memory map.',
              },
              {
                icon: Trash2,
                method: 'deleteCheckpoint',
                sig: '(checkpointId) → boolean',
                body: 'Removes from memory and disk. Uses file lock + atomic rewrite. Deletes the entire file if it was the last checkpoint for that graph.',
              },
            ].map(({ icon: Icon, method, sig, body }) => (
              <article key={method} className="rounded-xl border border-line bg-card p-5">
                <Icon className="size-4 text-brand" />
                <code className="mt-4 block font-mono text-sm font-black text-brand">{method}</code>
                <code className="mt-1 block font-mono text-[10px] text-faint">{sig}</code>
                <p className="mt-3 text-xs leading-5 text-muted">{body}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      {/* ── Storage ─────────────────────────────────────────────────────── */}
      <section className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10 lg:py-36">
        <SectionIntro
          index="03"
          eyebrow="Storage"
          title="Per-graph JSON files with atomic writes and file locking."
          description="Checkpoints are persisted to `<baseDir>/.checkpoints/<graphId>.json`. Each graph gets one file containing an array of serialized checkpoints. Every write uses atomic-write + file-lock for crash safety."
        />
        <div className="mt-12 grid gap-6 lg:grid-cols-3">
          {[
            {
              icon: HardDrive,
              title: 'On-disk format',
              body: 'One JSON file per PhaseGraph: `{graphId}.json`. Contains a flat array of SerializedCheckpoint objects. Directory created lazily on first save.',
              items: [
                'Atomic tmp+rename writes',
                'File-locked reads and writes',
                'Mode 0o600 — owner-only',
                'Lazy directory creation',
              ],
            },
            {
              icon: FolderSync,
              title: 'Load from disk',
              body: 'On initialization, scans the `.checkpoints/` directory for `.json` files. Each file is parsed and all checkpoints are loaded into the in-memory Map.',
              items: [
                'Skips invalid JSON files',
                'Handles empty directories',
                'loadFromDisk() called at startup',
                'Also called on restore if not in memory',
              ],
            },
            {
              icon: Archive,
              title: 'Delete semantics',
              body: 'Finds the checkpoint across all graph files, filters it out, and rewrites. If it was the last checkpoint in a file, the entire file is deleted.',
              items: [
                'File-locked deletion',
                'Atomic rewrite on remainder',
                'Empty file → unlink()',
                'Missing directory → no-op',
              ],
            },
          ].map(({ icon: Icon, title, body, items }) => (
            <article key={title} className="rounded-2xl border border-line bg-card p-7">
              <Icon className="size-5 text-brand" />
              <h2 className="mt-8 text-xl font-black text-fg">{title}</h2>
              <p className="mt-3 text-sm leading-7 text-muted">{body}</p>
              <ul className="mt-4 space-y-1.5">
                {items.map((item) => (
                  <li key={item} className="flex items-start gap-2 text-xs leading-5 text-muted">
                    <Check className="mt-0.5 size-3 shrink-0 text-brand-2" />
                    {item}
                  </li>
                ))}
              </ul>
            </article>
          ))}
        </div>
      </section>

      {/* ── TTL & count pruning ─────────────────────────────────────────── */}
      <section className="border-y border-line bg-surface">
        <div className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10">
          <SectionIntro
            index="04"
            eyebrow="Pruning"
            title="Two policies keep the checkpoint store from growing unbounded."
            description="After every save, the CheckpointManager runs two cleanup passes: TTL-based eviction for stale checkpoints, and count-based eviction to keep only the newest N per graph."
          />
          <div className="mt-12 grid gap-6 lg:grid-cols-2">
            <div className="rounded-2xl border border-line bg-card p-7">
              <Clock className="size-5 text-brand" />
              <h2 className="mt-8 text-xl font-black text-fg">TTL-based pruning</h2>
              <p className="mt-3 text-sm leading-7 text-muted">
                Any checkpoint older than `maxCheckpointAgeMs` (default 7 days) is evicted. This
                prevents stale checkpoints from accumulating indefinitely.
              </p>
              <div className="mt-5 space-y-3">
                {[
                  {
                    label: 'Default',
                    body: '7 days (7 × 24 × 60 × 60 × 1000 ms). Appropriate for most workflows.',
                  },
                  {
                    label: 'Short-lived runs',
                    body: 'Set to 1 hour for CI-style Goal runs where checkpoints are only needed during the session.',
                  },
                  {
                    label: 'Long-running missions',
                    body: 'Set to 30 days for multi-week goals where you may need to roll back days later.',
                  },
                  {
                    label: 'Disabled',
                    body: 'Set to Infinity to disable TTL pruning entirely. Combine with count-based pruning to cap storage.',
                  },
                ].map(({ label, body }) => (
                  <div key={label} className="rounded-lg border border-line bg-bg p-3">
                    <span className="font-black text-xs text-fg">{label}</span>
                    <p className="mt-0.5 text-[11px] leading-4 text-muted">{body}</p>
                  </div>
                ))}
              </div>
            </div>
            <div className="rounded-2xl border border-line bg-card p-7">
              <GitGraph className="size-5 text-brand" />
              <h2 className="mt-8 text-xl font-black text-fg">Count-based pruning</h2>
              <p className="mt-3 text-sm leading-7 text-muted">
                After TTL pruning, the remaining checkpoints are sorted oldest-first. Only the
                newest `maxCheckpoints` (default 10) are kept per graph.
              </p>
              <div className="mt-5 space-y-3">
                {[
                  {
                    label: 'Default',
                    body: '10 checkpoints per graph. Sufficient for most multi-phase workflows.',
                  },
                  {
                    label: 'Pruning order',
                    body: 'TTL first (age-based), then count (oldest-first). TTL always runs before count to avoid keeping stale entries.',
                  },
                  {
                    label: 'Per-graph scope',
                    body: 'Pruning is scoped to a single graphId. Checkpoints from different PhaseGraphs don\u2019t compete for slots.',
                  },
                  {
                    label: 'FIFO discard',
                    body: 'When over the limit, oldest checkpoints are deleted from both memory and disk. The remaining are re-sorted for the next save.',
                  },
                ].map(({ label, body }) => (
                  <div key={label} className="rounded-lg border border-line bg-bg p-3">
                    <span className="font-black text-xs text-fg">{label}</span>
                    <p className="mt-0.5 text-[11px] leading-4 text-muted">{body}</p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── Session & Director integration ───────────────────────────────── */}
      <section className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10 lg:py-36">
        <SectionIntro
          index="05"
          eyebrow="Integration"
          title="Checkpoints plug into the session writer and Director state."
          description="Beyond phase-graph checkpoints, WrongStack maintains Director-level state checkpoints and a fleet manifest — enough to replay an entire run from disk."
        />
        <div className="mt-12 grid gap-6 lg:grid-cols-3">
          {[
            {
              icon: FileClock,
              title: 'Session log',
              body: 'Every checkpoint creation and restoration is appended to the session JSONL via `appendSessionEvent()`. The session becomes fully auditable — you can see exactly when and why a rollback occurred.',
            },
            {
              icon: Archive,
              title: 'DirectorStateCheckpoint',
              body: 'The Director maintains its own checkpoint (separate from PhaseGraph checkpoints). Captures a DirectorStateSnapshot with subagent assignments, task results, and usage counters.',
            },
            {
              icon: Shield,
              title: 'Manifest replay',
              body: '`manifest.json` records every spawn + assigned task with final results. Paired with per-subagent JSONLs, this is enough to replay an entire director run — even after a crash.',
            },
          ].map(({ icon: Icon, title, body }) => (
            <article key={title} className="rounded-2xl border border-line bg-card p-7">
              <Icon className="size-5 text-brand" />
              <h2 className="mt-8 text-xl font-black text-fg">{title}</h2>
              <p className="mt-3 text-sm leading-7 text-muted">{body}</p>
            </article>
          ))}
        </div>
        <div className="mt-8 rounded-2xl border border-line bg-card p-7">
          <h2 className="text-xl font-black text-fg">Director checkpoint flow</h2>
          <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {[
              {
                label: 'acquireLock',
                body: 'Before resuming, check that no other Director process holds the checkpoint lock. Returns false if another instance is alive.',
              },
              {
                label: 'resumeFromCheckpoint',
                body: 'Load a prior DirectorStateSnapshot and re-attach to the fleet mid-flight. Subsequent spawn/assign calls update normally.',
              },
              {
                label: 'setCheckpointState',
                body: 'Push a new snapshot into the on-disk checkpoint. Called after significant fleet state changes.',
              },
              {
                label: 'writeManifest',
                body: 'Debounced atomic write of the fleet manifest. A burst of spawn/assign events collapses into one write.',
              },
            ].map(({ label, body }) => (
              <div key={label} className="rounded-lg border border-line bg-bg p-4">
                <span className="font-black text-xs text-fg">{label}</span>
                <p className="mt-1 text-[11px] leading-4 text-muted">{body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Goal & manual ───────────────────────────────────────────── */}
      <section className="border-y border-line bg-surface">
        <div className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10">
          <SectionIntro
            index="06"
            eyebrow="Workflows"
            title="Automatic before risky edits. Manual when you want control."
            description="Goal creates checkpoints between phases automatically — plan → checkpoint → implement → checkpoint → test → checkpoint. You can also trigger them manually for any operation."
          />
          <div className="mt-12 grid gap-6 lg:grid-cols-2">
            <div className="rounded-2xl border border-line bg-card p-7">
              <Camera className="size-5 text-brand" />
              <h2 className="mt-8 text-xl font-black text-fg">Automatic checkpoints</h2>
              <p className="mt-3 text-sm leading-7 text-muted">
                The agent creates checkpoints automatically before risky multi-file operations. SDD
                phases, Goal worktree transitions, and batch refactors all trigger a checkpoint.
              </p>
              <div className="mt-5 space-y-2">
                {[
                  {
                    phase: 'SDD plan → implement',
                    desc: 'After you approve the plan, a checkpoint captures the current state before the agent writes code.',
                  },
                  {
                    phase: 'SDD implement → verify',
                    desc: 'After implementation, a checkpoint captures the new code before running tests and linters.',
                  },
                  {
                    phase: 'Goal per phase',
                    desc: 'Between every phase (plan/implement/test/review), a checkpoint is written. Failed phases roll back to the last one.',
                  },
                  {
                    phase: 'Batch refactors',
                    desc: 'Before multi-file refactors, the agent snapshots affected files. If the refactor breaks, files revert to checkpoint state.',
                  },
                ].map(({ phase, desc }) => (
                  <div key={phase} className="rounded-lg border border-line bg-bg p-3">
                    <span className="font-black text-xs text-fg">{phase}</span>
                    <p className="mt-0.5 text-[11px] leading-4 text-muted">{desc}</p>
                  </div>
                ))}
              </div>
            </div>
            <div className="rounded-2xl border border-line bg-card p-7">
              <RotateCcw className="size-5 text-brand" />
              <h2 className="mt-8 text-xl font-black text-fg">Manual control</h2>
              <p className="mt-3 text-sm leading-7 text-muted">
                You can trigger checkpoints manually through slash commands or the programmatic API.
                Useful before experimenting with alternative approaches or when you want an explicit
                rollback point.
              </p>
              <div className="mt-5 space-y-3">
                {[
                  {
                    cmd: '/checkpoint save "Before trying approach B"',
                    desc: 'Create a named checkpoint at the current state. Label helps identify it later.',
                  },
                  {
                    cmd: '/checkpoint list',
                    desc: 'List all checkpoints for the current PhaseGraph, newest first. Shows id, timestamp, label, and phase status.',
                  },
                  {
                    cmd: '/checkpoint restore <id>',
                    desc: 'Restore the phase graph to a previous checkpoint. Task statuses and phase state are reverted.',
                  },
                  {
                    cmd: '/checkpoint delete <id>',
                    desc: 'Delete a specific checkpoint. Safe to call any time — only removes that one entry.',
                  },
                ].map(({ cmd, desc }) => (
                  <div key={cmd} className="rounded-lg border border-line bg-bg p-4">
                    <code className="font-mono text-sm font-black text-brand">{cmd}</code>
                    <p className="mt-1.5 text-xs leading-5 text-muted">{desc}</p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>

      <PageNext
        label="Commit workflow"
        title="Generated conventional commits"
        body="Stage changes and create well-formed commit messages automatically."
        href="/commit-workflow"
      />
    </>
  );
}
