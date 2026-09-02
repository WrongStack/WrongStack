import {
  AlertTriangle,
  ArrowUpDown,
  Check,
  FileCheck,
  FileClock,
  Fingerprint,
  GitBranch,
  GitCommitHorizontal,
  GitCompare,
  GitMerge,
  Shield,
  Tag,
  Users,
} from 'lucide-react';
import { ExternalDoc, PageHero, PageNext, SectionIntro } from '@/components/site/primitives';

export function CommitWorkflowPage() {
  return (
    <>
      <PageHero
        index="29"
        eyebrow="Commit workflow"
        title={
          <>
            Conventional commits
            <br />
            <span className="text-brand">without the typing.</span>
          </>
        }
        description="The agent reads your diff and generates a well-formed conventional commit message — type, scope, summary, and body. You review before it commits. Foreign file detection prevents sweeping up another agent's work."
        aside={<ExternalDoc path="docs/slash/git.md">Open Git commands docs</ExternalDoc>}
      />

      {/* ── The git command family ──────────────────────────────────────── */}
      <section className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10 lg:py-36">
        <SectionIntro
          index="01"
          eyebrow="Git commands"
          title="From working tree inspection to remote push."
          description="WrongStack ships a family of safe, bounded git commands. Each has a clear scope — no blanket operations, no silent overwrites."
        />
        <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[
            {
              cmd: '/commit',
              desc: 'Stage files, generate a conventional commit message from the diff, and commit. Review before confirming.',
              icon: GitCommitHorizontal,
              tag: 'stages + commits',
            },
            {
              cmd: '/git status',
              desc: 'Check working tree state — modified, staged, untracked files. Bounded to 100 paths, 8000 chars per diff summary.',
              icon: FileCheck,
              tag: 'read-only',
            },
            {
              cmd: '/git diff',
              desc: 'Review changes before committing. Supports file globs. --staged flag for pre-commit review of what will go in.',
              icon: GitCompare,
              tag: 'read-only',
            },
            {
              cmd: '/git branch',
              desc: 'Current branch name and short HEAD. Concise — no branch listing, no switching.',
              icon: GitBranch,
              tag: 'read-only',
            },
            {
              cmd: '/gitcheck',
              desc: 'Silent check for uncommitted changes. Exit code only. Ideal for pre-flight automation and CI hooks.',
              icon: Shield,
              tag: 'read-only',
            },
            {
              cmd: '/push',
              desc: 'Push the current branch to its configured remote. Respects your git config for default push behavior.',
              icon: ArrowUpDown,
              tag: 'mutating',
            },
            {
              cmd: '/gitid',
              desc: 'Inspect or set git user.name and user.email for commit attribution. Safe — only modifies the local repo config.',
              icon: Fingerprint,
              tag: 'config',
            },
          ].map(({ cmd, desc, icon: Icon, tag }) => (
            <div key={cmd} className="rounded-xl border border-line bg-card p-5">
              <div className="flex items-center justify-between">
                <Icon className="size-4 text-brand" />
                <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-faint">
                  {tag}
                </span>
              </div>
              <code className="mt-4 block font-mono text-sm font-black text-brand">{cmd}</code>
              <p className="mt-2 text-xs leading-5 text-muted">{desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ── Conventional commits ────────────────────────────────────────── */}
      <section className="border-y border-line bg-surface">
        <div className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10">
          <SectionIntro
            index="02"
            eyebrow="Conventional commits"
            title="Generated messages follow the spec. You review before it commits."
            description="The agent reads your diff and produces a conventional commit: type, optional scope, summary line, and body. Every type maps to a semantic version bump. Breaking changes are detected from the body."
          />
          <div className="mt-12 grid gap-6 lg:grid-cols-2">
            <div className="rounded-2xl border border-line bg-card p-7">
              <Tag className="size-5 text-brand" />
              <h2 className="mt-8 text-xl font-black text-fg">Commit types & semver</h2>
              <div className="mt-5 grid gap-2 sm:grid-cols-2">
                {[
                  { type: 'feat', bump: 'minor', desc: 'A new feature. Bumps the minor version.' },
                  { type: 'fix', bump: 'patch', desc: 'A bug fix. Bumps the patch version.' },
                  { type: 'docs', bump: 'none', desc: 'Documentation only. No version bump.' },
                  {
                    type: 'refactor',
                    bump: 'none',
                    desc: 'Code restructuring. No behavior change.',
                  },
                  { type: 'test', bump: 'none', desc: 'Adding or updating tests.' },
                  { type: 'chore', bump: 'none', desc: 'Build process, tooling, or maintenance.' },
                  { type: 'perf', bump: 'patch', desc: 'Performance improvement. Patch bump.' },
                  { type: 'ci', bump: 'none', desc: 'CI/CD pipeline changes.' },
                  { type: 'build', bump: 'none', desc: 'Build system or external dependencies.' },
                  { type: 'style', bump: 'none', desc: 'Formatting, whitespace. No code change.' },
                  { type: 'revert', bump: 'patch', desc: 'Reverts a previous commit. Patch bump.' },
                ].map(({ type, bump, desc }) => (
                  <div key={type} className="rounded-lg border border-line bg-bg px-3 py-2">
                    <div className="flex items-center gap-2">
                      <code className="font-mono text-xs font-black text-brand">{type}</code>
                      {bump !== 'none' && (
                        <span
                          className={`rounded px-1 py-0.5 font-mono text-[10px] font-black ${bump === 'minor' ? 'bg-amber-400/10 text-amber-400' : 'bg-emerald-400/10 text-emerald-400'}`}
                        >
                          {bump}
                        </span>
                      )}
                    </div>
                    <p className="mt-0.5 text-[11px] leading-4 text-muted">{desc}</p>
                  </div>
                ))}
              </div>
              <div className="mt-5 rounded-lg border border-line bg-bg p-4">
                <h3 className="font-black text-sm text-fg">Breaking changes</h3>
                <p className="mt-1 text-xs leading-5 text-muted">
                  Add <code className="font-mono text-brand">BREAKING CHANGE:</code> in the commit
                  body footer. The agent detects this and maps it to a{' '}
                  <span className="font-black text-red-400">major</span> version bump, regardless of
                  the commit type.
                </p>
              </div>
            </div>
            <div className="rounded-2xl border border-line bg-card p-7">
              <GitCommitHorizontal className="size-5 text-brand" />
              <h2 className="mt-8 text-xl font-black text-fg">Message anatomy</h2>
              <div className="mt-5 overflow-hidden rounded-lg border border-line bg-ink">
                <div className="border-b border-white/10 px-4 py-3">
                  <span className="font-mono text-xs font-black uppercase tracking-[0.16em] text-zinc-500">
                    Generated commit message
                  </span>
                </div>
                <div className="p-5 font-mono text-sm leading-7">
                  <div className="text-emerald-400">feat(auth):</div>
                  <div className="text-zinc-300">
                    add OAuth account switching with session persistence
                  </div>
                  <div className="mt-4 text-zinc-500">
                    Implement multi-account OAuth flow with encrypted token storage
                    <br />
                    and automatic session refresh. Accounts are persisted in the
                    <br />
                    SecretVault and restored on next launch.
                  </div>
                  <div className="mt-4 space-y-1 text-zinc-500">
                    <div>
                      <span className="text-zinc-600">- </span>Closes #142
                    </div>
                    <div>
                      <span className="text-zinc-600">- </span>Reviewed-by: @security-team
                    </div>
                  </div>
                </div>
              </div>
              <div className="mt-5 grid gap-2 sm:grid-cols-2">
                {[
                  {
                    label: 'Type + scope',
                    body: 'First line: `type(scope): summary`. Scope is optional but encouraged for monorepos.',
                  },
                  {
                    label: 'Body',
                    body: 'Blank line, then wrapped paragraphs explaining what and why. Not how — the diff shows how.',
                  },
                  {
                    label: 'Footer',
                    body: 'Blank line, then token-prefixed metadata. BREAKING CHANGE, Closes #N, Reviewed-by, Co-authored-by.',
                  },
                  {
                    label: 'Dry run',
                    body: '`/commit --dry-run` shows the generated message without committing. Edit inline before confirming.',
                  },
                ].map(({ label, body }) => (
                  <div key={label} className="rounded-lg border border-line bg-bg p-3">
                    <h3 className="font-black text-xs text-fg">{label}</h3>
                    <p className="mt-0.5 text-[11px] leading-4 text-muted">{body}</p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── Commit safety ───────────────────────────────────────────────── */}
      <section className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10 lg:py-36">
        <SectionIntro
          index="03"
          eyebrow="Safety"
          title="Never sweep up another agent's work."
          description="When multiple agents (or humans) edit the same working tree, a blind `git add .` captures everyone's uncommitted changes. The commit-safety module cross-references dirty files against the per-project file-author log and warns before committing."
        />
        <div className="mt-12 grid gap-6 lg:grid-cols-3">
          {[
            {
              icon: FileClock,
              title: 'File-author tracking',
              body: 'Every file this session creates or edits is recorded in the per-project author log at `~/.wrongstack/projects/<slug>/file-authors.jsonl`. Session ID and agent name are captured.',
            },
            {
              icon: Users,
              title: 'Foreign file detection',
              body: 'Before committing, dirty files are cross-referenced against the author log. Files authored by a different session are flagged as "foreign." Files with no recorded author are "unverified."',
            },
            {
              icon: AlertTriangle,
              title: 'Shared-worktree warning',
              body: 'If foreign or unverified files are found, a plain-text warning is rendered before the commit proceeds. Warn-only by design — never blocks, but surfaces the risk.',
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
          <h2 className="text-xl font-black text-fg">CommitSafetyReport</h2>
          <p className="mt-3 text-sm leading-7 text-muted">
            `assessCommitSafety()` returns a structured report. Best-effort: any git failure yields
            an empty report rather than throwing — commit-safety must never break a commit.
          </p>
          <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {[
              {
                label: 'dirtyCount',
                body: 'Total uncommitted files (staged + unstaged + untracked).',
              },
              {
                label: 'foreignFiles',
                body: 'Dirty files whose latest author is a DIFFERENT session. Includes agent name and session ID.',
              },
              {
                label: 'unverifiedFiles',
                body: 'Dirty files with no recorded author. Could be a concurrent non-WrongStack agent, build step, or human.',
              },
              {
                label: 'otherWorktrees',
                body: 'Branch names of other active worktrees. Warns when sibling worktrees may conflict.',
              },
            ].map(({ label, body }) => (
              <div key={label} className="rounded-lg border border-line bg-bg p-4">
                <code className="font-mono text-xs font-black text-brand">{label}</code>
                <p className="mt-1 text-[11px] leading-4 text-muted">{body}</p>
              </div>
            ))}
          </div>
          <div className="mt-5 rounded-lg border border-line bg-ink p-4 font-mono text-xs leading-6">
            <div className="text-amber-400">
              ⚠ Shared-worktree warning: 3 of 12 uncommitted changes were NOT recorded as authored
              by this session.
            </div>
            <div className="mt-2 text-zinc-500"> Authored by another agent/session:</div>
            <div className="text-zinc-400"> - src/auth/login.ts (by bug-hunter@a3f2b1c4)</div>
            <div className="text-zinc-400">
              {' '}
              - src/auth/middleware.ts (by refactor-planner@b4c5d6e7)
            </div>
            <div className="mt-2 text-zinc-500">
              {' '}
              Unverified author (concurrent agent, build/format step, or human):
            </div>
            <div className="text-zinc-400"> - dist/bundle.js</div>
          </div>
        </div>
      </section>

      {/* ── Auto-commit flow ────────────────────────────────────────────── */}
      <section className="border-y border-line bg-surface">
        <div className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10">
          <SectionIntro
            index="04"
            eyebrow="Auto-commit"
            title="One command from diff to pushed commit."
            description="`/commit` runs the full pipeline: assess safety, stage files, generate message, present for review. You confirm and the commit is created. `/push` sends it upstream."
          />
          <div className="mt-12 grid gap-px overflow-hidden rounded-2xl border border-line bg-line lg:grid-cols-5">
            {[
              {
                step: '01',
                title: 'Safety check',
                body: 'Cross-reference dirty files against the file-author log. Warn if foreign or unverified files are detected.',
              },
              {
                step: '02',
                title: 'Stage files',
                body: 'Pass an explicit file list — never blind-stage the whole tree. The agent scopes to files it authored.',
              },
              {
                step: '03',
                title: 'Generate message',
                body: 'The model reads the staged diff and produces a conventional commit: type, scope, summary, body, footer.',
              },
              {
                step: '04',
                title: 'Review',
                body: 'The generated message is presented. You can edit inline, add footers, or reject and rephrase.',
              },
              {
                step: '05',
                title: 'Commit & push',
                body: 'On confirmation, the commit is created. /push sends it to the remote. Run /semver when you want to apply a release tag.',
              },
            ].map(({ step, title, body }) => (
              <article key={step} className="bg-card p-6">
                <span className="font-mono text-xs font-black text-brand-2">{step}</span>
                <h2 className="mt-4 text-sm font-black text-fg">{title}</h2>
                <p className="mt-2 text-[11px] leading-5 text-muted">{body}</p>
              </article>
            ))}
          </div>
          <div className="mt-8 grid gap-6 lg:grid-cols-2">
            <div className="rounded-2xl border border-line bg-card p-7">
              <GitMerge className="size-5 text-brand" />
              <h2 className="mt-8 text-xl font-black text-fg">Semver bump</h2>
              <p className="mt-3 text-sm leading-7 text-muted">
                `/semver` reads conventional commits since the last tag and determines the next
                version. Part can be `auto` (infer from commits), or forced to `major`, `minor`, or
                `patch`.
              </p>
              <div className="mt-5 space-y-3">
                {(() => {
                  type Row = { kind: 'slash' | 'tool'; cmd: string; desc: string };
                  const items: ReadonlyArray<Row> = [
                    {
                      kind: 'slash',
                      cmd: '/semver status',
                      desc: 'Show the current version, the latest tag, and the suggested bump.',
                    },
                    {
                      kind: 'slash',
                      cmd: '/semver auto --dry',
                      desc: 'Preview the auto-inferred bump from commits without creating a tag.',
                    },
                    {
                      kind: 'slash',
                      cmd: '/semver patch',
                      desc: 'Force a patch bump regardless of commit types. Useful for hotfix releases.',
                    },
                    {
                      kind: 'tool',
                      cmd: 'semver_changelog',
                      desc: 'Agent tool that generates a markdown changelog between two version tags, grouped by conventional-commit type.',
                    },
                  ];
                  const renderRow = ({ kind, cmd, desc }: Row) => (
                    <div key={cmd} className="rounded-lg border border-line bg-bg p-4">
                      <div className="flex items-center gap-2">
                        {kind === 'tool' ? (
                          <span className="rounded-sm border border-line bg-bg-2 px-1.5 py-0.5 font-mono text-[10px] font-black uppercase tracking-wide text-brand-2">
                            agent tool
                          </span>
                        ) : (
                          <span className="rounded-sm border border-line bg-bg-2 px-1.5 py-0.5 font-mono text-[10px] font-black uppercase tracking-wide text-faint">
                            slash command
                          </span>
                        )}
                        <code className="font-mono text-sm font-black text-brand">{cmd}</code>
                      </div>
                      <p className="mt-1.5 text-xs leading-5 text-muted">{desc}</p>
                    </div>
                  );
                  const slashRows = items.filter((r): r is Row => r.kind === 'slash');
                  const toolRows = items.filter((r): r is Row => r.kind === 'tool');
                  return (
                    <>
                      <p className="text-[11px] font-black uppercase tracking-wide text-faint">
                        Slash commands
                      </p>
                      {slashRows.map(renderRow)}
                      <p className="pt-2 text-[11px] font-black uppercase tracking-wide text-faint">
                        Agent tools
                      </p>
                      {toolRows.map(renderRow)}
                    </>
                  );
                })()}
              </div>
            </div>
            <div className="rounded-2xl border border-line bg-card p-7">
              <Shield className="size-5 text-brand" />
              <h2 className="mt-8 text-xl font-black text-fg">Safety boundaries</h2>
              <div className="mt-5 space-y-3">
                {[
                  {
                    label: 'Never blind-stage',
                    body: "/commit requires an explicit file list. No `git add .` — prevents capturing another agent's work.",
                  },
                  {
                    label: 'Warn-only',
                    body: 'Commit safety never blocks a commit. It surfaces the risk so you can decide: proceed, narrow scope, or coordinate.',
                  },
                  {
                    label: 'Read-only tools',
                    body: '/git, /gitcheck, and /git diff are intentionally read-only. Use /commit for writes, /push for remote.',
                  },
                  {
                    label: 'No rebase or reset',
                    body: 'The git command family does not expose rebase, reset, or force-push. Those stay in the shell domain.',
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

      {/* ── Workflow integration ────────────────────────────────────────── */}
      <section className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10 lg:py-36">
        <SectionIntro
          index="05"
          eyebrow="Integration"
          title="Commit workflow plugs into Goal and quality gates."
          description="Commit generation is not just a slash command — it integrates with the autonomous workflow engine and the quality gate pipeline."
        />
        <div className="mt-12 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
          {[
            {
              icon: Check,
              title: 'Goal',
              body: 'After the review phase, Goal can auto-commit the verified worktree changes. Commit message is generated from the phase plan and diff.',
            },
            {
              icon: Shield,
              title: 'Quality gate',
              body: 'The quality_gate verifier lane can require a clean /gitcheck before passing. Uncommitted changes after verification = gate failure.',
            },
            {
              icon: AlertTriangle,
              title: 'CI pre-flight',
              body: 'Run /gitcheck in CI scripts before deploy. Non-zero exit code means uncommitted changes — fail the pipeline.',
            },
            {
              icon: Fingerprint,
              title: 'Attribution',
              body: "/gitid ensures commits carry the right author. Set per-project or globally. Follows git's own precedence rules.",
            },
          ].map(({ icon: Icon, title, body }) => (
            <article key={title} className="rounded-2xl border border-line bg-card p-6">
              <Icon className="size-5 text-brand" />
              <h2 className="mt-7 text-lg font-black text-fg">{title}</h2>
              <p className="mt-2 text-sm leading-6 text-muted">{body}</p>
            </article>
          ))}
        </div>
      </section>

      <PageNext
        label="Command atlas"
        title="Browse all operator commands"
        body="Search by intent, filter by category and open dedicated reference pages."
        href="/commands"
      />
    </>
  );
}
