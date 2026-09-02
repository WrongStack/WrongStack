import { CheckCircle, GitBranch, Play, RotateCcw, Target, Timer } from 'lucide-react';
import { ExternalDoc, PageHero, PageNext, SectionIntro } from '@/components/site/primitives';

export function GoalPage() {
  return (
    <>
      <PageHero
        index="22"
        eyebrow="Goal"
        title={
          <>
            Full autonomy <span className="text-brand">across worktrees.</span>
          </>
        }
        description="Goal runs autonomous phased workflows. Unlike SDD, it never pauses for review. Each phase runs in an isolated git worktree with checkpoint-based rollback and goal tracking across sessions."
        aside={<ExternalDoc path="docs/goal.md">Open Goal docs</ExternalDoc>}
      />

      <section className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10 lg:py-36">
        <SectionIntro
          index="01"
          eyebrow="Architecture"
          title="Worktree isolation and checkpoint recovery."
          description="Every phase runs in its own git worktree. If something goes wrong, checkpoint snapshots let you roll back to the last known-good state."
        />
        <div className="mt-12 grid gap-6 lg:grid-cols-4">
          {[
            {
              icon: GitBranch,
              title: 'Worktree per phase',
              body: 'Plan, implement, test, and review each run in isolated worktrees. No branch switching, no merge conflicts mid-phase.',
            },
            {
              icon: RotateCcw,
              title: 'Checkpoint rollback',
              body: 'After each phase, a checkpoint is saved. Failed phases roll back to the last checkpoint — no starting over from scratch.',
            },
            {
              icon: Play,
              title: 'Autonomous execution',
              body: 'Set a goal, define phases, and let Goal run. Plans, implements, tests, and reports without interactive steering.',
            },
            {
              icon: Target,
              title: 'Goal tracking',
              body: 'Goals persist across phases and sessions via the Coordinator. Resume an interrupted Goal run days later.',
            },
          ].map(({ icon: Icon, title, body }) => (
            <div key={title} className="rounded-xl border border-line bg-card p-6">
              <Icon className="size-5 text-brand" />
              <h2 className="mt-4 text-lg font-black text-fg">{title}</h2>
              <p className="mt-2 text-sm leading-6 text-muted">{body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="border-y border-line bg-surface">
        <div className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10">
          <SectionIntro
            index="02"
            eyebrow="Phase lifecycle"
            title="Four phases — no human in the loop."
            description="Each Goal run progresses through four standard phases. Between phases, checkpoints are written."
          />
          <div className="mt-12 grid gap-px overflow-hidden rounded-2xl border border-line bg-line lg:grid-cols-4">
            {[
              [
                '01',
                'Plan',
                'The agent reads the goal and produces a structured task breakdown with file targets, dependency order, and estimated risk per step.',
              ],
              [
                '02',
                'Implement',
                'Each planned step executes in its own worktree. Code is written, files created, refactors run — fully autonomous.',
              ],
              [
                '03',
                'Test',
                'After implementation, the agent runs the project test suite, typecheck, and linters against the worktree. Failures trigger retry or rollback.',
              ],
              [
                '04',
                'Review',
                'A final review pass checks the diff for anti-patterns, security issues, and style violations. Results written to the phase journal.',
              ],
            ].map(([step, title, body]) => (
              <article key={step} className="bg-card p-7">
                <span className="font-mono text-xs font-black text-brand-2">{step}</span>
                <h2 className="mt-8 text-xl font-black text-fg">{title}</h2>
                <p className="mt-3 text-sm leading-7 text-muted">{body}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10 lg:py-36">
        <SectionIntro
          index="03"
          eyebrow="Recovery"
          title="Three layers of safety for autonomous runs."
        />
        <div className="mt-12 grid gap-6 lg:grid-cols-3">
          {[
            {
              icon: RotateCcw,
              title: 'Per-phase checkpoints',
              body: 'After each phase, a checkpoint captures the worktree state. Failed phases roll back to the last checkpoint.',
            },
            {
              icon: Timer,
              title: 'Automatic retry',
              body: 'Test failures trigger up to 3 retries with adjusted approaches before the phase is marked failed.',
            },
            {
              icon: CheckCircle,
              title: 'Manual intervention',
              body: 'Pause Goal at any time, inspect the worktree, make manual fixes, then resume from where you left off.',
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

      <section className="border-y border-line bg-surface">
        <div className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10">
          <SectionIntro
            index="04"
            eyebrow="Commands"
            title="Start, pause, resume, status."
            description="Goal integrates with /goal for persistent missions and /coordinator for cross-session tracking."
          />
          <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {[
              {
                cmd: '/goal set "refactor auth"',
                desc: 'Create a persistent goal. Goal reads this as its mission.',
              },
              {
                cmd: '/goal start',
                desc: 'Begin autonomous execution. Phases run sequentially without pausing.',
              },
              {
                cmd: '/goal status',
                desc: 'Check current phase, progress, and any errors encountered.',
              },
              {
                cmd: '/goal pause',
                desc: 'Suspend at the next phase boundary. Resume with /goal resume.',
              },
            ].map(({ cmd, desc }) => (
              <div key={cmd} className="rounded-xl border border-line bg-card p-5">
                <code className="font-mono text-sm font-black text-brand">{cmd}</code>
                <p className="mt-2 text-xs leading-5 text-muted">{desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <PageNext
        label="Ensemble"
        title="Parallel multi-agent reviews"
        body="Fan one task to multiple ACP agents for independent perspectives."
        href="/ensemble"
      />
    </>
  );
}
