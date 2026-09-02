import {
  ArrowUpDown,
  GitBranch,
  GitCommitHorizontal,
  HardDrive,
  History,
  KeyRound,
  Layers3,
  Lock,
  RefreshCw,
  Shield,
  Tag,
} from 'lucide-react';
import { ExternalDoc, PageHero, PageNext, SectionIntro } from '@/components/site/primitives';

export function SyncPage() {
  return (
    <>
      <PageHero
        index="27"
        eyebrow="GitHub Sync"
        title={
          <>
            Same setup
            <br />
            <span className="text-brand">on every machine.</span>
          </>
        }
        description="Sync your WrongStack configuration — settings, skills, prompts, memory, and session history — through a private GitHub repository. Push from one machine, pull on another. No git CLI needed."
        aside={<ExternalDoc path="docs/slash/sync.md">Open Sync docs</ExternalDoc>}
      />

      {/* ── Sync categories ─────────────────────────────────────────────── */}
      <section className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10 lg:py-36">
        <SectionIntro
          index="01"
          eyebrow="Categories"
          title="Choose what to sync. Enable all or pick selectively."
          description="Five artifact types are syncable. Each maps to a directory under `~/.wrongstack/`. Enable all five for a complete mirror, or pick only what you need across machines."
        />
        <div className="mt-12 grid gap-px overflow-hidden rounded-2xl border border-line bg-line lg:grid-cols-5">
          {[
            {
              icon: Layers3,
              label: 'Settings',
              path: 'settings/',
              body: 'Provider configs, model routing, tool permissions, context policy, and all user preferences.',
            },
            {
              icon: Tag,
              label: 'Skills',
              path: 'skills/',
              body: 'Installed skill packages with their trigger words, capability declarations, and instruction bodies.',
            },
            {
              icon: GitBranch,
              label: 'Prompts',
              path: 'prompts/',
              body: 'User-layer prompt templates with variables, favorites, and metadata. Bundled prompts stay immutable.',
            },
            {
              icon: HardDrive,
              label: 'Memory',
              path: 'memory.md',
              body: 'SAGE entries — facts, conventions, decisions, and anti-patterns the agent has learned.',
            },
            {
              icon: History,
              label: 'History',
              path: 'sessions/',
              body: 'Session logs with timestamps, tool calls, and results. Audit trail that follows you across machines.',
            },
          ].map(({ icon: Icon, label, path, body }) => (
            <article key={label} className="bg-card p-6">
              <Icon className="size-4 text-brand" />
              <h2 className="mt-5 text-sm font-black text-fg">{label}</h2>
              <code className="mt-1.5 block font-mono text-[10px] text-faint">{path}</code>
              <p className="mt-3 text-[11px] leading-5 text-muted">{body}</p>
            </article>
          ))}
        </div>
        <div className="mt-8 grid gap-5 sm:grid-cols-3">
          {[
            {
              title: 'All categories',
              body: '/sync enable without explicit categories syncs all five. The default covers everything you need for a complete cross-machine setup.',
            },
            {
              title: 'Selective sync',
              body: 'Add or remove categories with /sync categories add|remove. Sync only prompts and skills on lightweight machines.',
            },
            {
              title: 'Category independence',
              body: 'Each category syncs independently. A push failure in one category does not block the others.',
            },
          ].map(({ title, body }) => (
            <div key={title} className="rounded-xl border border-line bg-card p-5">
              <h3 className="font-black text-sm text-fg">{title}</h3>
              <p className="mt-2 text-xs leading-6 text-muted">{body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ── How it works ────────────────────────────────────────────────── */}
      <section className="border-y border-line bg-surface">
        <div className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10">
          <SectionIntro
            index="02"
            eyebrow="How it works"
            title="GitHub REST API. No git CLI. No merge conflicts."
            description="CloudSync uses the GitHub REST API directly — tree, blob, commit, and ref endpoints. Local files are hashed into a Git tree, committed to a branch, and pushed. Pulls compare SHA hashes to detect conflicts before overwriting."
          />
          <div className="mt-12 grid gap-px overflow-hidden rounded-2xl border border-line bg-line lg:grid-cols-4">
            {[
              {
                step: '01',
                icon: ArrowUpDown,
                title: 'Build tree',
                body: 'Local files in each category are read and hashed. A Git tree object is constructed containing every file blob and its path relative to the repo root.',
              },
              {
                step: '02',
                icon: GitCommitHorizontal,
                title: 'Create commit',
                body: 'A new commit is created on the remote repo. Uses the previous tree SHA as parent. Commit message includes synced categories and ISO timestamp.',
              },
              {
                step: '03',
                icon: RefreshCw,
                title: 'Update ref',
                body: 'The branch ref (default: main) is updated to point at the new commit. Fast-forward only — SHA mismatch triggers a retry with the latest remote SHA.',
              },
              {
                step: '04',
                icon: History,
                title: 'Record state',
                body: 'The remote commit SHA and a local revision hash are written to `~/.wrongstack/profiles/<name>/sync-state.json`. Next push/pull uses these as the base for comparison.',
              },
            ].map(({ step, icon: Icon, title, body }) => (
              <article key={step} className="bg-card p-7">
                <div className="flex items-center gap-3">
                  <span className="font-mono text-xs font-black text-brand-2">{step}</span>
                  <Icon className="size-5 text-brand" />
                </div>
                <h2 className="mt-6 text-xl font-black text-fg">{title}</h2>
                <p className="mt-3 text-sm leading-7 text-muted">{body}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      {/* ── Conflict resolution ─────────────────────────────────────────── */}
      <section className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10 lg:py-36">
        <SectionIntro
          index="03"
          eyebrow="Conflict resolution"
          title="SHA tracking prevents silent overwrites."
          description="Every sync operation records the remote commit SHA and a local revision hash. Pull compares these against the current local state — conflicts are detected before any file is overwritten."
        />
        <div className="mt-12 grid gap-6 lg:grid-cols-3">
          {[
            {
              icon: Lock,
              title: 'Non-fast-forward retry',
              body: 'When push gets a 422 (branch moved since last sync), CloudSync fetches the latest remote SHA, rebuilds the commit with the updated parent, and retries. No data loss.',
            },
            {
              icon: Shield,
              title: 'Local revision tracking',
              body: '`sync-state.json` stores both the remote SHA and a `localRev` hash. Pull compares localRev against current content — if they differ, the pull is flagged with conflict details.',
            },
            {
              icon: GitBranch,
              title: 'Conflict report',
              body: 'When conflicts are detected, pull reports which files differ and whether they changed locally, remotely, or both. You decide how to resolve before pull proceeds.',
            },
          ].map(({ icon: Icon, title, body }) => (
            <article key={title} className="rounded-2xl border border-line bg-card p-7">
              <Icon className="size-5 text-brand" />
              <h2 className="mt-8 text-xl font-black text-fg">{title}</h2>
              <p className="mt-3 text-sm leading-7 text-muted">{body}</p>
            </article>
          ))}
        </div>
      </section>

      {/* ── Security ────────────────────────────────────────────────────── */}
      <section className="border-y border-line bg-surface">
        <div className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10">
          <SectionIntro
            index="04"
            eyebrow="Security"
            title="Encrypted token. Atomic writes. Owner-only files."
            description="Your GitHub token is never stored in plaintext. Three layers protect it: SecretVault encryption, atomic write with crash safety, and mode 0o600 file permissions."
          />
          <div className="mt-12 grid gap-6 lg:grid-cols-2">
            <div className="rounded-2xl border border-line bg-card p-7">
              <KeyRound className="size-5 text-brand" />
              <h2 className="mt-8 text-xl font-black text-fg">Token storage</h2>
              <div className="mt-5 space-y-3">
                {[
                  {
                    label: 'Encrypted at rest',
                    body: 'When SecretVault is available, the token is encrypted before writing to disk. The field name "githubToken" matches the vault pattern for auto-decryption on load.',
                  },
                  {
                    label: 'Separate config file',
                    body: 'Token stored in `~/.wrongstack/profiles/<name>/sync.json` — separate from main config.json to prevent accidental commits to public repos.',
                  },
                  {
                    label: 'Atomic write',
                    body: 'sync.json is written via atomicWrite (tmp + rename). A crash during write never produces a half-written or corrupted credential file.',
                  },
                  {
                    label: 'Owner-only permissions',
                    body: 'Written with mode 0o600. No group or world read access. The file is invisible to other users on shared hosts.',
                  },
                ].map(({ label, body }) => (
                  <div key={label} className="rounded-lg border border-line bg-bg p-4">
                    <h3 className="font-black text-sm text-fg">{label}</h3>
                    <p className="mt-1 text-xs leading-5 text-muted">{body}</p>
                  </div>
                ))}
              </div>
            </div>
            <div className="rounded-2xl border border-line bg-card p-7">
              <Shield className="size-5 text-brand" />
              <h2 className="mt-8 text-xl font-black text-fg">Sync state</h2>
              <div className="mt-5 space-y-3">
                {[
                  {
                    label: 'sync-state.json',
                    body: 'Tracks version (schema v1), remote SHA, lastSyncedAt timestamp, and localRev hash. Used for conflict detection and fresh/stale checks.',
                  },
                  {
                    label: 'Fine-grained PAT',
                    body: 'Uses a GitHub fine-grained personal access token. Scope it to the single sync repo with Contents: Read & Write permission only.',
                  },
                  {
                    label: 'No git CLI dependency',
                    body: 'CloudSync speaks the GitHub REST API directly. No git binary needed, no shell spawning. Works on any machine with HTTPS access to api.github.com.',
                  },
                  {
                    label: 'Disable without data loss',
                    body: '/sync disable stops syncing but keeps all local files intact. Re-enable later with the same repo and pick up where you left off.',
                  },
                ].map(({ label, body }) => (
                  <div key={label} className="rounded-lg border border-line bg-bg p-4">
                    <h3 className="font-black text-sm text-fg">{label}</h3>
                    <p className="mt-1 text-xs leading-5 text-muted">{body}</p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── Commands ────────────────────────────────────────────────────── */}
      <section className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10 lg:py-36">
        <SectionIntro
          index="05"
          eyebrow="Commands"
          title="Six subcommands for the full sync lifecycle."
          description="Registered by the built-in wstack-sync plugin. Active by default — configure once with /sync enable and your data follows you everywhere."
        />
        <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[
            {
              cmd: '/sync status',
              desc: 'Show enabled/disabled state, configured repo, selected categories, and time since last sync.',
            },
            {
              cmd: '/sync enable owner/repo TOKEN [cats]',
              desc: 'Enable sync. TOKEN is a fine-grained PAT with Contents R/W. Optional: list specific categories (default: all five).',
            },
            {
              cmd: '/sync disable',
              desc: 'Stop syncing. All local data is preserved. Re-enable later with the same repo.',
            },
            {
              cmd: '/sync push',
              desc: 'Upload selected categories. Builds a Git tree, creates a commit, and updates the branch ref. Shows a file-level diff of what changed.',
            },
            {
              cmd: '/sync pull',
              desc: 'Download from the repo. Compares localRev against current files. Conflicts are reported before any file is overwritten.',
            },
            {
              cmd: '/sync categories list|add|remove',
              desc: 'Manage which artifact types are synced. Add or remove categories without disabling sync.',
            },
          ].map(({ cmd, desc }) => (
            <div key={cmd} className="rounded-xl border border-line bg-card p-5">
              <code className="font-mono text-sm font-black text-brand">{cmd}</code>
              <p className="mt-2 text-xs leading-5 text-muted">{desc}</p>
            </div>
          ))}
        </div>
        <div className="mt-8 rounded-2xl border border-line bg-card p-7">
          <h2 className="text-xl font-black text-fg">Example workflow</h2>
          <div className="mt-5 space-y-3">
            {[
              {
                step: '1',
                cmd: '/sync enable myname/wrongstack-data ghp_xxx',
                desc: 'Enable with a fine-grained PAT. All five categories are selected by default.',
              },
              {
                step: '2',
                cmd: '/sync push',
                desc: 'Upload your current settings, skills, prompts, memory, and history. A commit is created on the repo.',
              },
              {
                step: '3',
                cmd: 'On another machine: /sync enable myname/wrongstack-data ghp_xxx',
                desc: 'Enable with the same repo and token. The sync state is empty — ready for pull.',
              },
              {
                step: '4',
                cmd: '/sync pull',
                desc: 'Download all synced data. LocalRev is recorded. Subsequent pulls only download changes.',
              },
              {
                step: '5',
                cmd: '/sync categories remove history',
                desc: 'Stop syncing session history on this machine. Settings and skills still sync.',
              },
            ].map(({ step, cmd, desc }) => (
              <div
                key={step}
                className="flex items-start gap-4 rounded-lg border border-line bg-bg p-4"
              >
                <span className="mt-0.5 shrink-0 font-mono text-xs font-black text-brand-2">
                  {step}
                </span>
                <div>
                  <code className="font-mono text-sm font-black text-brand">{cmd}</code>
                  <p className="mt-1 text-xs leading-5 text-muted">{desc}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <PageNext
        label="Checkpoints"
        title="Reversible file state"
        body="Snapshots that let you roll back file changes around risky edits."
        href="/checkpoints"
      />
    </>
  );
}
