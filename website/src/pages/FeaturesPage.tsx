import { ArrowRight, Check, MoveRight } from 'lucide-react';
import { PageHero, PageNext, Reveal, SectionIntro } from '@/components/site/primitives';
import {
  capabilityIndex,
  PLUGIN_COUNT,
  primaryFeatureStories,
  SKILL_COUNT,
  systemSpotlightStories,
  TOOL_COUNT,
} from '@/data/content';
import { Link } from '@/lib/router';
import { cn } from '@/lib/utils';

const accentClasses = {
  red: 'text-brand bg-brand/10 border-brand/20',
  amber: 'text-brand-2 bg-brand-2/10 border-brand-2/20',
  blue: 'text-sky-500 bg-sky-500/10 border-sky-500/20',
  green: 'text-emerald-500 bg-emerald-500/10 border-emerald-500/20',
  purple: 'text-violet-500 bg-violet-500/10 border-violet-500/20',
} as const;

export function FeaturesPage() {
  return (
    <>
      <PageHero
        index="01"
        eyebrow="Product"
        title={
          <>
            Broad capability.
            <br />
            <span className="text-brand">Sharp boundaries.</span>
          </>
        }
        description="WrongStack covers the full coding loop—from understanding a repository to coordinating parallel work—without turning every capability into invisible magic."
        aside={
          <span className="font-mono text-xs font-bold text-faint">
            {`${TOOL_COUNT} tools · ${SKILL_COUNT} skills · ${PLUGIN_COUNT} managed plugins · open source & free`}
          </span>
        }
      />

      <section className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10 lg:py-36">
        <SectionIntro
          index="01"
          eyebrow="Core capabilities"
          title="Six systems that make the agent useful after the demo."
          description="Each feature is designed as an operating system concern: typed, observable and available to every interface."
        />
        <div className="mt-16 space-y-24 lg:space-y-32">
          {primaryFeatureStories.map((feature, index) => (
            <Reveal key={feature.title}>
              <article className="grid gap-8 lg:grid-cols-[.38fr_1fr]">
                <div className="flex items-start justify-between border-t border-line pt-5 lg:block">
                  <span className="font-mono text-xs font-black text-faint">
                    {String(index + 1).padStart(2, '0')} / 06
                  </span>
                  <span
                    className={cn(
                      'grid size-11 place-items-center rounded-xl border lg:mt-8',
                      accentClasses[feature.accent],
                    )}
                  >
                    <feature.icon className="size-5" />
                  </span>
                </div>
                <div className="border-t border-line pt-5">
                  <span className="font-mono text-xs font-black uppercase tracking-[0.2em] text-brand">
                    {feature.eyebrow}
                  </span>
                  <h2 className="mt-5 max-w-4xl text-4xl font-black leading-[1.03] tracking-[-0.025em] text-fg sm:text-5xl lg:text-6xl">
                    {feature.title}
                  </h2>
                  <p className="mt-6 max-w-3xl text-lg leading-8 text-muted">{feature.summary}</p>
                  <div className="mt-8 grid gap-px overflow-hidden rounded-xl border border-line bg-line sm:grid-cols-2">
                    {feature.details.map((detail) => (
                      <div
                        key={detail}
                        className="flex items-start gap-3 bg-card p-4 text-sm leading-6 text-muted"
                      >
                        <Check className="mt-1 size-3.5 shrink-0 text-emerald-500" />
                        {detail}
                      </div>
                    ))}
                  </div>
                  <Link
                    href={`/features/${feature.slug}`}
                    className="group mt-7 inline-flex items-center gap-2 text-sm font-black text-brand"
                  >
                    Open feature deep dive
                    <ArrowRight className="size-4 transition-transform group-hover:translate-x-1" />
                  </Link>
                </div>
              </article>
            </Reveal>
          ))}
        </div>
      </section>

      <section className="border-y border-line bg-surface">
        <div className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10">
          <SectionIntro
            index="02"
            eyebrow="Complete map"
            title="The rest of the system, without the marketing fog."
          />
          <div className="mt-12 grid gap-px overflow-hidden rounded-2xl border border-line bg-line md:grid-cols-2">
            {capabilityIndex.map(([name, description, slug], index) => (
              <Link
                key={name}
                href={`/features/${slug}`}
                className="group grid gap-4 bg-card p-6 sm:grid-cols-[40px_1fr_auto] sm:items-start sm:p-7"
              >
                <span className="font-mono text-xs font-black text-brand-2">
                  {String(index + 1).padStart(2, '0')}
                </span>
                <div>
                  <h3 className="font-black text-fg">{name}</h3>
                  <p className="mt-1.5 text-sm leading-6 text-muted">{description}</p>
                </div>
                <MoveRight className="hidden size-4 text-faint transition-transform group-hover:translate-x-1 sm:block" />
              </Link>
            ))}
          </div>
        </div>
      </section>
      <section className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10 lg:py-36">
        <SectionIntro
          index="03"
          eyebrow="System spotlights"
          title="The coordination features that turn an agent into an operating system."
          description="Mailbox, Kanban, Council and customization are first-class product systems with their own state, rules and failure boundaries."
        />
        <div className="mt-12 grid gap-5 lg:grid-cols-2">
          {systemSpotlightStories.map((feature, index) => (
            <Link
              key={feature.slug}
              href={`/features/${feature.slug}`}
              className="group rounded-2xl border border-line bg-card p-6 transition-all hover:-translate-y-1 hover:border-brand/40 sm:p-8"
            >
              <div className="flex items-center justify-between">
                <span className="font-mono text-xs font-black uppercase tracking-[0.18em] text-brand-2">
                  {String(index + 1).padStart(2, '0')} · {feature.eyebrow}
                </span>
                <feature.icon className="size-5 text-faint transition-colors group-hover:text-brand" />
              </div>
              <h2 className="mt-10 max-w-xl text-2xl font-black tracking-[-0.04em] text-fg sm:text-3xl">
                {feature.title}
              </h2>
              <p className="mt-4 max-w-2xl text-sm leading-7 text-muted">{feature.summary}</p>
              <span className="mt-7 inline-flex items-center gap-2 text-sm font-black text-brand">
                Open system deep dive
                <ArrowRight className="size-4 transition-transform group-hover:translate-x-1" />
              </span>
            </Link>
          ))}
        </div>
      </section>
      <PageNext
        label="How it works"
        title="Follow one turn through the system"
        body="From the first character of a prompt to tools, retries, compaction and the session log."
        href="/how-it-works"
      />
    </>
  );
}
