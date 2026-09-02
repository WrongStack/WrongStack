import { ArrowDown, Check, RotateCw } from 'lucide-react';
import {
  ExternalDoc,
  PageHero,
  PageNext,
  Reveal,
  SectionIntro,
} from '@/components/site/primitives';
import { lifecycleSteps } from '@/data/content';

const recovery = [
  [
    '1',
    'In-place retry',
    'Same provider and model. Retry-After wins; otherwise exponential backoff with jitter.',
  ],
  [
    '2',
    'Cross-provider fallback',
    'Only capacity and transport failures hop the configured chain. Request-shaped errors stay put.',
  ],
  [
    '3',
    'Recovery strategy',
    'Context compaction, cheaper-model downgrade or sibling reroute; bounded to two recovery retries.',
  ],
] as const;

export function HowItWorksPage() {
  return (
    <>
      <PageHero
        index="02"
        eyebrow="Execution model"
        title={
          <>
            One request.
            <br />
            <span className="text-brand-2">Every boundary.</span>
          </>
        }
        description="WrongStack is easiest to trust when you can trace it. Here is the complete path a request takes through the kernel, including where policy, recovery and persistence enter."
        aside={<ExternalDoc path="docs/architecture.md">Open engineering reference</ExternalDoc>}
      />
      <section className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10 lg:py-36">
        <SectionIntro
          index="01"
          eyebrow="The loop"
          title="A six-stage path from intent to evidence."
          description="The model is one stage, not the system. Pipelines, policies, tools and storage surround it."
        />
        <div className="relative mt-16 space-y-5">
          <div
            className="absolute bottom-10 left-[27px] top-10 hidden w-px bg-line sm:block"
            aria-hidden="true"
          />
          {lifecycleSteps.map((step, index) => (
            <Reveal key={step.number} delay={index * 0.025}>
              <article className="relative grid gap-5 rounded-2xl border border-line bg-card p-5 sm:grid-cols-[56px_.72fr_1fr] sm:gap-7 sm:p-7 lg:p-9">
                <span className="relative z-10 grid size-14 place-items-center rounded-full border border-line bg-bg font-mono text-xs font-black text-brand">
                  {step.number}
                </span>
                <div>
                  <span className="font-mono text-xs font-black uppercase tracking-[0.18em] text-faint">
                    {step.label}
                  </span>
                  <h2 className="mt-3 text-2xl font-black leading-tight tracking-[-0.035em] text-fg">
                    {step.title}
                  </h2>
                </div>
                <div>
                  <p className="text-sm leading-7 text-muted sm:text-base">{step.body}</p>
                  <code className="mt-5 block overflow-x-auto rounded-lg border border-line bg-bg px-4 py-3 font-mono text-xs text-brand">
                    {step.code}
                  </code>
                </div>
              </article>
            </Reveal>
          ))}
        </div>
      </section>

      <section className="border-y border-line bg-ink text-white">
        <div className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10 lg:py-32">
          <div className="grid gap-12 lg:grid-cols-[.55fr_1fr]">
            <div>
              <div className="flex items-center gap-3 font-mono text-xs font-black uppercase tracking-[0.2em] text-brand">
                <RotateCw className="size-4" /> Failure handling
              </div>
              <h2 className="mt-6 text-4xl font-black leading-[1.03] tracking-[-0.025em] sm:text-5xl">
                Recovery has an order.
              </h2>
              <p className="mt-6 max-w-md text-base leading-7 text-zinc-400">
                A provider error is classified once into a stable kind. Three consumer layers then
                run with fixed precedence, so retries cannot accidentally multiply.
              </p>
            </div>
            <div className="space-y-3">
              {recovery.map(([number, title, body], index) => (
                <div key={title}>
                  <div className="grid gap-4 rounded-xl border border-white/10 bg-white/[0.035] p-5 sm:grid-cols-[40px_170px_1fr] sm:items-center">
                    <span className="grid size-8 place-items-center rounded-full bg-brand-2 font-mono text-xs font-black text-ink">
                      {number}
                    </span>
                    <h3 className="font-black">{title}</h3>
                    <p className="text-sm leading-6 text-zinc-400">{body}</p>
                  </div>
                  {index < recovery.length - 1 && (
                    <ArrowDown className="mx-auto my-2 size-4 text-zinc-700" />
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10 lg:py-36">
        <SectionIntro
          index="02"
          eyebrow="What persists"
          title="Live context is temporary. Evidence is not."
          description="Compaction can reshape what the model sees while preserving raw reconstructable history outside the window."
        />
        <div className="mt-12 overflow-hidden rounded-2xl border border-line">
          {[
            [
              'Conversation state',
              'Live',
              'Messages, todos, provider, tools and run metadata observed by the current surface.',
            ],
            [
              'Session JSONL',
              'Durable',
              'User input, model responses, tool results, checkpoints and in-flight markers.',
            ],
            [
              'SAGE',
              'Project-local',
              'Verified facts, file/symbol anchors, relationships and hygiene metadata.',
            ],
            [
              'Global mailbox',
              'Cross-process',
              'Addressed agent messages, aliases, heartbeats and acknowledgements.',
            ],
            [
              'HQ telemetry',
              'Operational',
              'Events, snapshots, time series and alerts for connected surfaces.',
            ],
          ].map(([name, scope, body], index) => (
            <div
              key={name}
              className="grid gap-3 border-b border-line bg-card p-5 last:border-b-0 sm:grid-cols-[40px_180px_120px_1fr] sm:items-center sm:p-6"
            >
              <span className="font-mono text-xs font-black text-brand-2">
                {String(index + 1).padStart(2, '0')}
              </span>
              <strong className="text-sm text-fg">{name}</strong>
              <span className="w-fit rounded-full border border-line bg-bg px-2.5 py-1 font-mono text-xs font-bold uppercase text-faint">
                {scope}
              </span>
              <p className="text-sm leading-6 text-muted">{body}</p>
            </div>
          ))}
        </div>
        <div className="mt-8 flex items-start gap-3 rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-5 text-sm leading-6 text-muted">
          <Check className="mt-0.5 size-4 shrink-0 text-emerald-500" />
          <p>
            <strong className="text-fg">Key invariant:</strong>{' '}
            <code className="font-mono text-xs text-brand">agent.ctx.session</code> is the single
            live writer. Every surface finalizes it before switching sessions.
          </p>
        </div>
      </section>
      <PageNext
        label="Interfaces"
        title="Choose the surface around the same kernel"
        body="Compare the CLI, TUI, WebUI, SimpleUI, Desktop and HQ by the jobs they do best."
        href="/interfaces"
      />
    </>
  );
}
