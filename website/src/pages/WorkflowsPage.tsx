import { ArrowRight, Check, GitBranch, MessageCircleMore, Route, Workflow } from 'lucide-react';
import { ExternalDoc, PageHero, PageNext, SectionIntro } from '@/components/site/primitives';
import { Link } from '@/lib/router';

const workflows = [
  [
    'Direct prompt',
    'One bounded request with an obvious finish condition.',
    'wstack "refactor src/auth.ts"',
    '/commands/help',
  ],
  [
    'Goal',
    'A durable mission that can pause, resume, journal progress and drive autonomy.',
    '/goal set "finish the migration"',
    '/commands/goal',
  ],
  [
    'SDD',
    'Feature work that benefits from requirements, design, tasks, implementation and verification.',
    '/sdd "add account switching"',
    '/commands/sdd',
  ],
  [
    'Goal',
    'A phase-based autonomous run with worktree-aware task execution and persisted state.',
    '/goal start',
    '/commands/goal',
  ],
  [
    'Review / fix',
    'A focused classification, review or repair pass around an existing change or failure.',
    '/review',
    '/commands/review',
  ],
  [
    'Collab debug',
    'Three specialist roles that stream bug findings, plans and criticism through FleetBus.',
    '/collab src/auth',
    '/commands/collab',
  ],
  [
    'ACP ensemble',
    'Ask several external coding agents the same question and synthesize independent answers.',
    '/ensemble <task>',
    '/commands/ensemble',
  ],
  [
    'BTW',
    'Send a non-aborting side note while the main run is still working.',
    '/btw <message>',
    '/commands/btw',
  ],
] as const;

export function WorkflowsPage() {
  return (
    <>
      <PageHero
        index="10"
        eyebrow="Workflows"
        title={
          <>
            Match the loop
            <br />
            <span className="text-brand-2">to the work.</span>
          </>
        }
        description="WrongStack workflows are not different personalities for the same prompt. They create different state, checkpoints, phase contracts and coordination behavior."
        aside={<ExternalDoc path="docs/slash/sdd.md">Read the SDD workflow</ExternalDoc>}
      />
      <section className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10 lg:py-36">
        <SectionIntro
          index="01"
          eyebrow="Chooser"
          title="Use the smallest workflow that preserves correctness."
        />
        <div className="mt-14 overflow-hidden rounded-2xl border border-line bg-card">
          {workflows.map(([name, when, command, href], index) => (
            <div
              key={name}
              className="grid gap-4 border-b border-line p-5 last:border-b-0 sm:grid-cols-[42px_150px_1fr_230px_auto] sm:items-center sm:p-6"
            >
              <span className="font-mono text-xs font-black text-brand-2">
                {String(index + 1).padStart(2, '0')}
              </span>
              <strong className="text-sm text-fg">{name}</strong>
              <p className="text-sm leading-6 text-muted">{when}</p>
              <code className="overflow-x-auto font-mono text-xs text-brand">{command}</code>
              <Link
                href={href}
                aria-label={`Open ${name}`}
                className="grid size-9 place-items-center rounded-full border border-line hover:border-brand hover:text-brand"
              >
                <ArrowRight className="size-3.5" />
              </Link>
            </div>
          ))}
        </div>
      </section>
      <section className="border-y border-line bg-surface">
        <div className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10">
          <SectionIntro
            index="02"
            eyebrow="Spec-driven development"
            title="Turn a feature request into a verified implementation trail."
            description="SDD keeps requirements, analysis, design, tasks and implementation state under the project instead of leaving the plan inside transient chat."
          />
          <div className="mt-12 grid gap-2 lg:grid-cols-5">
            {['Requirements', 'Analysis', 'Design', 'Tasks', 'Implementation'].map(
              (phase, index) => (
                <article key={phase} className="relative rounded-xl border border-line bg-card p-5">
                  <span className="font-mono text-xs font-black text-brand-2">0{index + 1}</span>
                  <h2 className="mt-8 text-sm font-black text-fg">{phase}</h2>
                  {index < 4 && (
                    <ArrowRight className="absolute -right-3 top-1/2 z-10 hidden size-4 -translate-y-1/2 text-faint lg:block" />
                  )}
                </article>
              ),
            )}
          </div>
          <div className="mt-6 grid gap-5 lg:grid-cols-3">
            {[
              [
                'Auto-detection',
                'Existing specs and project patterns can be detected before creating new state.',
              ],
              [
                'Parallel robustness',
                'Independent implementation tasks can route into supervised subagent work.',
              ],
              [
                'Goal integration',
                'Long SDD work can attach to a durable goal and eternal autonomy loop.',
              ],
            ].map(([title, body]) => (
              <div key={title} className="rounded-xl border border-line bg-card p-5">
                <Check className="size-4 text-emerald-500" />
                <h3 className="mt-5 font-black text-fg">{title}</h3>
                <p className="mt-2 text-sm leading-6 text-muted">{body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>
      <section className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10 lg:py-36">
        <SectionIntro
          index="03"
          eyebrow="Control while running"
          title="Steer without destroying useful progress."
        />
        <div className="mt-12 grid gap-px overflow-hidden rounded-2xl border border-line bg-line lg:grid-cols-4">
          {[
            [MessageCircleMore, 'BTW', 'Attach a side note to the active run without an abort.'],
            [Route, 'Steer', 'Change the next direction with a high-priority message.'],
            [
              GitBranch,
              'Pause / resume',
              'Stop durable goal progress without clearing its journal.',
            ],
            [
              Workflow,
              'Interrupt',
              'Abort the in-flight leader iteration and its owned work safely.',
            ],
          ].map(([Icon, title, body]) => {
            const ItemIcon = Icon as typeof Workflow;
            return (
              <article key={String(title)} className="bg-card p-6">
                <ItemIcon className="size-5 text-brand" />
                <h2 className="mt-8 font-black text-fg">{String(title)}</h2>
                <p className="mt-3 text-sm leading-6 text-muted">{String(body)}</p>
              </article>
            );
          })}
        </div>
      </section>
      <section className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10">
        <SectionIntro index="05" eyebrow="Related" title="Explore more coordination tools." />
        <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[
            {
              href: '/sdd',
              label: 'SDD workflow',
              desc: 'Spec-driven: plan, implement, verify with review between phases.',
            },
            {
              href: '/goal',
              label: 'Goal',
              desc: 'Fully autonomous phased work with worktree isolation and rollback.',
            },
            {
              href: '/checkpoints',
              label: 'Checkpoints',
              desc: 'File state snapshots. Rewind after risky edits.',
            },
            {
              href: '/commit-workflow',
              label: 'Commit workflow',
              desc: 'Auto-generated conventional commits from your diff.',
            },
          ].map(({ href, label, desc }) => (
            <Link
              key={href}
              href={href}
              className="group rounded-xl border border-line bg-card p-5 hover:border-brand/40 transition-colors"
            >
              <h3 className="font-black text-base text-fg group-hover:text-brand transition-colors">
                {label}
              </h3>
              <p className="mt-2 text-xs leading-5 text-muted">{desc}</p>
              <span className="mt-3 inline-block text-xs font-bold text-brand">Explore →</span>
            </Link>
          ))}
        </div>
      </section>
      <section className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10 lg:py-36">
        <SectionIntro
          index="04"
          eyebrow="Decision guide"
          title="Which workflow for which situation?"
        />
        <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[
            {
              when: 'Well-understood feature',
              use: 'SDD',
              why: 'Interactive phases, you review each step.',
            },
            {
              when: 'Complex multi-day effort',
              use: 'Goal',
              why: 'Autonomous worktrees + checkpoint rollback.',
            },
            {
              when: 'Quick fix or refactor',
              use: 'BTW / Goals',
              why: 'Lightweight. No phase overhead.',
            },
            {
              when: 'Independent perspectives',
              use: 'Ensemble',
              why: 'Multiple ACP agents, compare results.',
            },
            {
              when: 'Code review / QA',
              use: 'Collab',
              why: 'BugHunter + RefactorPlanner + Critic pipeline.',
            },
            {
              when: 'Team coordination',
              use: 'Mailbox / HQ',
              why: 'Cross-session steer and fleet monitoring.',
            },
            {
              when: 'CI/CD autonomous',
              use: 'Goal',
              why: 'Zero-interaction pipeline with manifest.',
            },
            {
              when: 'Learning / exploring',
              use: 'Goals',
              why: 'Loosely structured, adapts as you go.',
            },
          ].map(({ when, use, why }) => (
            <div key={when} className="rounded-xl border border-line bg-card p-4">
              <span className="font-black text-xs text-fg">{when}</span>
              <span className="mt-1 block font-mono text-[10px] text-brand">{use}</span>
              <p className="mt-1.5 text-[11px] leading-4 text-muted">{why}</p>
            </div>
          ))}
        </div>
      </section>
      <PageNext
        label="Fleet & Brain"
        title="Scale a workflow into coordinated specialist work"
        body="Learn task ownership, model routing, budgets, result roll-up and Brain-governed supervision."
        href="/fleet"
      />
    </>
  );
}
