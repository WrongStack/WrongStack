import {
  ArrowDown,
  BrainCircuit,
  Check,
  Gauge,
  Mail,
  Network,
  PanelTop,
  Scale,
} from 'lucide-react';
import {
  ExternalDoc,
  PageHero,
  PageNext,
  SectionIntro,
  heroTitleFontSize,
} from '@/components/site/primitives';
import { Link } from '@/lib/router';

const directorTools = [
  ['spawn_subagent', 'Create a worker from a roster role or explicit configuration.'],
  ['assign_task', 'Give one bounded task to a selected worker.'],
  ['await_tasks', 'Wait for all named tasks or the first useful completion.'],
  ['ask_subagent', 'Request a synchronous progress summary from a running worker.'],
  ['roll_up', 'Aggregate completed structured results into markdown or JSON.'],
  ['terminate_subagent', 'Abort a worker and release its Director resources.'],
  ['fleet status', 'Read worker and task state without mutating it.'],
  ['fleet usage', 'Inspect token and cost totals per worker and fleet.'],
  ['fleet session', 'Read a worker transcript summary and tool-use count.'],
  ['fleet health', 'Inspect liveness and operational health signals.'],
] as const;

export function FleetPage() {
  return (
    <>
      <PageHero
        index="11"
        eyebrow="Fleet & Brain"
        titleFontSize={heroTitleFontSize('Single accountability.')}
        title={
          <>
            Parallel work.
            <br />
            <span className="text-brand">Single accountability.</span>
          </>
        }
        description="The Director owns the plan, workers own bounded tasks, budgets own the limits and the Brain owns autonomous policy decisions. Parallelism never removes the need for evidence."
        aside={
          <ExternalDoc path="docs/director-architecture.md">Open Director architecture</ExternalDoc>
        }
      />
      <section className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10 lg:py-36">
        <SectionIntro
          index="01"
          eyebrow="Task lifecycle"
          title="From objective to structured result."
        />
        <Link
          href="/agent-roster"
          className="mt-8 inline-flex rounded-full border border-brand/25 bg-brand/5 px-4 py-2 font-mono text-xs font-black uppercase tracking-[0.12em] text-brand"
        >
          Browse 50 phase roles + Shadow →
        </Link>
        <div className="mt-14 space-y-2">
          {[
            [
              'Leader plans',
              'Split the objective into bounded work with dependencies and completion evidence.',
              'objective → task DAG',
            ],
            [
              'Director routes',
              'Choose a roster role, worker runtime and authoritative lineage.',
              'role + modelMatrix + budget',
            ],
            [
              'Worker executes',
              'Run with its own context, signal, tools, permissions and task-local submit_result.',
              'isolated Context',
            ],
            [
              'Fleet communicates',
              'Publish events, progress, status mail and peer pulse without sharing mutable context.',
              'FleetBus + mailbox',
            ],
            [
              'Leader verifies',
              'Consume structured findings, files, confidence and suggested next steps.',
              'TaskResult.report',
            ],
          ].map(([title, body, code], index) => (
            <div key={title}>
              <article className="grid gap-5 rounded-2xl border border-line bg-card p-6 sm:grid-cols-[52px_210px_1fr_220px] sm:items-center">
                <span className="grid size-11 place-items-center rounded-full border border-line bg-bg font-mono text-xs font-black text-brand-2">
                  0{index + 1}
                </span>
                <h2 className="font-black text-fg">{title}</h2>
                <p className="text-sm leading-7 text-muted">{body}</p>
                <code className="font-mono text-xs text-brand">{code}</code>
              </article>
              {index < 4 && <ArrowDown className="mx-auto my-1 size-4 text-faint" />}
            </div>
          ))}
        </div>
      </section>
      <section className="border-y border-line bg-surface">
        <div className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10">
          <SectionIntro
            index="02"
            eyebrow="Director toolkit"
            title="Ten tools cover the orchestration loop."
          />
          <div className="mt-12 grid gap-px overflow-hidden rounded-2xl border border-line bg-line sm:grid-cols-2">
            {directorTools.map(([name, body], index) => (
              <article key={name} className="grid grid-cols-[36px_150px_1fr] gap-3 bg-card p-5">
                <span className="font-mono text-xs font-black text-brand-2">
                  {String(index + 1).padStart(2, '0')}
                </span>
                <code className="font-mono text-xs font-bold text-fg">{name}</code>
                <p className="text-xs leading-5 text-muted">{body}</p>
              </article>
            ))}
          </div>
        </div>
      </section>
      <section className="border-y border-line bg-surface">
        <div className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10">
          <SectionIntro
            index="03"
            eyebrow="Coordination fabric"
            title="Live events move fast. Durable state survives the session."
            description="FleetBus, Global Mailbox and Kanban have different jobs. Together they let agents coordinate in real time without losing work when a process or interface closes."
          />
          <div className="mt-12 grid gap-5 lg:grid-cols-3">
            {[
              [
                Network,
                'FleetBus',
                'Role-bound events stream findings, plans, evaluations and lifecycle state through a live task pipeline.',
                'live / in-process',
                '/features/coordination-system',
              ],
              [
                Mail,
                'Global Mailbox',
                'Typed notes, tasks, status, steer and results cross sessions, terminals, WebUI tabs and Desktop processes.',
                'durable / cross-process',
                '/features/global-mailbox',
              ],
              [
                PanelTop,
                'Kanban queue',
                'Dependency-ready cards carry acceptance criteria and per-task provider, model, role and tool routing into Director dispatch.',
                'durable / project work',
                '/features/kanban-work-queue',
              ],
            ].map(([Icon, title, body, mode, href]) => {
              const ItemIcon = Icon as typeof Network;
              return (
                <Link
                  key={String(title)}
                  href={String(href)}
                  className="group rounded-2xl border border-line bg-card p-6 transition-all hover:-translate-y-1 hover:border-brand/40"
                >
                  <div className="flex items-center justify-between">
                    <ItemIcon className="size-5 text-brand" />
                    <span className="font-mono text-xs font-black uppercase tracking-wider text-faint">
                      {String(mode)}
                    </span>
                  </div>
                  <h2 className="mt-9 text-xl font-black text-fg">{String(title)}</h2>
                  <p className="mt-3 text-sm leading-7 text-muted">{String(body)}</p>
                  <span className="mt-6 block text-xs font-black text-brand">Open deep dive →</span>
                </Link>
              );
            })}
          </div>
        </div>
      </section>
      <section className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10 lg:py-36">
        <SectionIntro
          index="04"
          eyebrow="Budgets and lifecycle"
          title="Every worker has a fence around it."
          description="Limits are negotiated by kind. An iteration extension does not silently extend tokens, cost or timeout."
        />
        <div className="mt-12 grid gap-px overflow-hidden rounded-2xl border border-line bg-line lg:grid-cols-5">
          {['Iterations', 'Tool calls', 'Tokens', 'Cost', 'Timeout'].map((kind) => (
            <div key={kind} className="bg-card p-6">
              <Gauge className="size-4 text-brand" />
              <h2 className="mt-8 font-black text-fg">{kind}</h2>
              <p className="mt-2 text-xs leading-5 text-muted">
                Independent threshold, event and extension decision.
              </p>
            </div>
          ))}
        </div>
        <div className="mt-6 flex items-start gap-3 rounded-xl border border-line bg-card p-5">
          <Check className="mt-1 size-4 shrink-0 text-emerald-500" />
          <p className="text-sm leading-7 text-muted">
            CLI and WebUI hosts retire completed workers on the next event-loop turn unless queued
            work reuses them. Between-task idle timeout is separate from the in-task activity
            watchdog.
          </p>
        </div>
      </section>
      <section className="border-y border-line bg-ink text-white">
        <div className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10">
          <SectionIntro
            index="05"
            eyebrow="Brain governance"
            title="Supervision proposes. The Brain—and when needed, the Council—decides."
          />
          <div className="mt-12 grid gap-5 lg:grid-cols-[.7fr_1fr]">
            <div className="rounded-2xl border border-white/10 bg-white/[0.035] p-7">
              <BrainCircuit className="size-6 text-brand" />
              <h2 className="mt-7 text-2xl font-black">The decision ladder</h2>
              <div className="mt-6 space-y-3">
                {[
                  ['01', 'Deterministic policy'],
                  ['02', 'Risk-gated model pool'],
                  ['03', 'Council: quorum · veto · majority · judge'],
                  ['04', 'Human or headless terminal policy'],
                ].map(([number, label]) => (
                  <div
                    key={label}
                    className="flex items-center gap-4 rounded-lg border border-white/10 px-4 py-3"
                  >
                    <span className="font-mono text-xs font-black text-brand-2">{number}</span>
                    <span className="text-sm text-zinc-300">{label}</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="grid gap-px overflow-hidden rounded-2xl border border-white/10 bg-white/10 sm:grid-cols-3">
              {[
                [
                  Scale,
                  'Brain Council',
                  'Independent provider/model seats vote with personas, weights and optional veto rights.',
                ],
                [
                  BrainCircuit,
                  'Decision ledger',
                  'Past decisions and observed outcomes inform similar choices and repeated-failure guards.',
                ],
                [
                  Network,
                  'Fleet Supervisor',
                  'Watches starvation, backlog, overload, stuck signals and failure streaks.',
                ],
              ].map(([Icon, title, body]) => {
                const ItemIcon = Icon as typeof Network;
                return (
                  <article key={String(title)} className="bg-[#0c0d12] p-6">
                    <ItemIcon className="size-5 text-brand" />
                    <h3 className="mt-7 font-black">{String(title)}</h3>
                    <p className="mt-3 text-sm leading-6 text-zinc-500">{String(body)}</p>
                  </article>
                );
              })}
            </div>
          </div>
          <div className="mt-8 flex flex-wrap gap-5">
            <Link href="/commands/fleet" className="text-sm font-bold text-brand">
              Learn /fleet →
            </Link>
            <Link href="/commands/brain" className="text-sm font-bold text-brand">
              Learn /brain →
            </Link>
            <Link href="/commands/delegate" className="text-sm font-bold text-brand">
              Learn /delegate →
            </Link>
            <Link href="/features/brain-council" className="text-sm font-bold text-brand">
              Open Brain Council deep dive →
            </Link>
          </div>
          <div className="mt-8 rounded-2xl border border-white/10 bg-white/[0.035] p-7">
            <h2 className="text-xl font-black">Explore more fleet topics</h2>
            <div className="mt-4 flex flex-wrap gap-4">
              <Link
                href="/shadow-agent"
                className="rounded-full border border-brand/40 bg-brand/10 px-4 py-2 text-sm font-bold text-brand hover:bg-brand/20 transition-colors"
              >
                Shadow Agent: background fleet monitor →
              </Link>
              <Link
                href="/supervisor"
                className="rounded-full border border-brand/40 bg-brand/10 px-4 py-2 text-sm font-bold text-brand hover:bg-brand/20 transition-colors"
              >
                Supervisor: Brain-gated safety layer →
              </Link>
              <Link
                href="/acp"
                className="rounded-full border border-brand/40 bg-brand/10 px-4 py-2 text-sm font-bold text-brand hover:bg-brand/20 transition-colors"
              >
                ACP: drive external agents →
              </Link>
            </div>
          </div>
        </div>
      </section>
      <PageNext
        label="Providers"
        title="Route the right model into every role"
        body="Configure credentials, model matrices, fallback profiles and bounded recovery."
        href="/providers"
      />
    </>
  );
}
