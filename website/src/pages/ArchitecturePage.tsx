import { ArrowDown, Boxes, Braces, Cable, RadioTower } from 'lucide-react';
import { ExternalDoc, PageHero, PageNext, SectionIntro } from '@/components/site/primitives';
import { architectureLayers } from '@/data/content';
import { cn } from '@/lib/utils';

const primitives = [
  [
    'Container',
    'Typed dependency injection keyed by branded symbols. Bindings are lazy, memoized and replaceable before a run.',
    Boxes,
  ],
  [
    'Pipeline<T>',
    'Linear async middleware with position-aware replacement. Six pipelines surround each agent step.',
    Cable,
  ],
  [
    'EventBus',
    'The typed source of truth for session, provider, tool, fleet, Brain, worktree and error events.',
    RadioTower,
  ],
  [
    'RunController',
    'One abort tree per run, chained to the parent signal with LIFO cleanup on dispose.',
    Braces,
  ],
] as const;

export function ArchitecturePage() {
  return (
    <>
      <PageHero
        index="06"
        eyebrow="Architecture"
        title={
          <>
            Surfaces above.
            <br />
            <span className="text-brand-2">Contracts below.</span>
          </>
        }
        description="WrongStack is a monorepo, but not a mesh. The dependency graph points toward a small kernel; interfaces compose capabilities without leaking UI concerns back into core."
        aside={<ExternalDoc path="docs/architecture.md">Open architecture reference</ExternalDoc>}
      />
      <section className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10 lg:py-36">
        <SectionIntro
          index="01"
          eyebrow="Dependency map"
          title="Four layers. One direction."
          description="The rule is simple: a lower layer never imports a human-facing surface above it."
        />
        <div className="mt-14 space-y-2">
          {architectureLayers.map((layer, index) => (
            <div key={layer.label}>
              <div className="grid gap-5 rounded-2xl border border-line bg-card p-6 sm:p-7 lg:grid-cols-[150px_1fr_1fr] lg:items-center">
                <div>
                  <span className="font-mono text-xs font-black uppercase tracking-[0.18em] text-faint">
                    Layer 0{index + 1}
                  </span>
                  <h2 className="mt-2 text-2xl font-black tracking-[-0.04em] text-fg">
                    {layer.label}
                  </h2>
                </div>
                <div className="flex flex-wrap gap-2">
                  {layer.packages.map((pkg) => (
                    <code
                      key={pkg}
                      className={cn(
                        'rounded-lg border px-2.5 py-1.5 font-mono text-xs',
                        index === 0 && 'border-brand/20 bg-brand/5 text-brand',
                        index === 1 && 'border-brand-2/20 bg-brand-2/5 text-brand-2',
                        index === 2 &&
                          'border-sky-500/20 bg-sky-500/5 text-sky-600 dark:text-sky-400',
                        index === 3 &&
                          'border-emerald-500/20 bg-emerald-500/5 text-emerald-600 dark:text-emerald-400',
                      )}
                    >
                      {pkg}
                    </code>
                  ))}
                </div>
                <p className="text-sm leading-6 text-muted">{layer.description}</p>
              </div>
              {index < architectureLayers.length - 1 && (
                <div className="flex justify-center py-1">
                  <ArrowDown className="size-4 text-faint" />
                </div>
              )}
            </div>
          ))}
        </div>
      </section>

      <section className="border-y border-line bg-surface">
        <div className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10">
          <SectionIntro
            index="02"
            eyebrow="Kernel"
            title="Small primitives, wide consequences."
            description="The kernel does not know whether a TUI, browser, Electron window or headless command is using it."
          />
          <div className="mt-12 grid gap-px overflow-hidden rounded-2xl border border-line bg-line md:grid-cols-2">
            {primitives.map(([name, body, Icon], index) => (
              <article key={name} className="bg-card p-7">
                <div className="flex items-center justify-between">
                  <Icon className="size-5 text-brand" />
                  <span className="font-mono text-xs font-black text-faint">0{index + 1}</span>
                </div>
                <h2 className="mt-10 font-mono text-xl font-black tracking-[-0.04em] text-fg">
                  {name}
                </h2>
                <p className="mt-3 text-sm leading-7 text-muted">{body}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10 lg:py-36">
        <SectionIntro
          index="03"
          eyebrow="Cross-cutting contracts"
          title="The important behavior is shared, not copied."
        />
        <div className="mt-12 border-y border-line">
          {[
            [
              'Provider contract',
              'Streaming text, tool calls, usage and classified errors cross one adapter boundary.',
            ],
            [
              'Tool contract',
              'Schema, permission, mutation marker, cancellation and optional progress streaming.',
            ],
            [
              'Session contract',
              'One live writer, serialized appends, clean finalization and reconstructable events.',
            ],
            [
              'Coordination contract',
              'Director tasks, budgets, mail and typed fleet events remain surface-independent.',
            ],
            [
              'Extension contract',
              'Scoped capabilities for plugins; hooks steer at known lifecycle points.',
            ],
          ].map(([name, body], index) => (
            <div
              key={name}
              className="grid gap-3 border-b border-line py-6 last:border-b-0 sm:grid-cols-[70px_230px_1fr] sm:items-center"
            >
              <span className="font-mono text-xs font-black text-brand-2">0{index + 1}</span>
              <strong className="text-base text-fg">{name}</strong>
              <p className="text-sm leading-6 text-muted">{body}</p>
            </div>
          ))}
        </div>
      </section>
      <section className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10 lg:py-36">
        <SectionIntro
          index="04"
          eyebrow="Pipelines"
          title="Six middleware pipelines surround every agent step."
          description="Each pipeline is a linear async middleware chain with position-aware replacement. They wrap tool execution, provider calls, context assembly, and more."
        />
        <div className="mt-12 grid gap-4 sm:grid-cols-3">
          {[
            [
              'Pre-tool',
              'Before every tool call: permission check, input validation, env expansion.',
            ],
            [
              'Post-tool',
              'After every tool call: output redaction, secret scrubbing, side-effect recording.',
            ],
            [
              'Pre-provider',
              'Before the LLM request: context assembly, memory injection, skill body loading.',
            ],
            [
              'Post-provider',
              'After the LLM response: token counting, cost accounting, usage logging.',
            ],
            [
              'Pre-iteration',
              'Before each agent iteration: budget check, compaction trigger, context pruning.',
            ],
            [
              'Post-iteration',
              'After each agent iteration: session append, checkpoint update, fleet pulse.',
            ],
          ].map(([name, body]) => (
            <div key={name} className="rounded-xl border border-line bg-card p-5">
              <h3 className="font-black text-sm text-fg">{name}</h3>
              <p className="mt-2 text-xs leading-5 text-muted">{body}</p>
            </div>
          ))}
        </div>
      </section>
      <PageNext
        label="Ecosystem"
        title="Extend the contracts, not the core"
        body="See how MCP, skills, plugins, hooks, prompts and providers fit around the kernel."
        href="/ecosystem"
      />
    </>
  );
}
