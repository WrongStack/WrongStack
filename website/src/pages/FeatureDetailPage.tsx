import { ArrowDown, ArrowRight, Check, Gauge } from 'lucide-react';
import { BrainCouncilDemo } from '@/components/site/BrainCouncilDemo';
import { KanbanLiveDemo } from '@/components/site/KanbanLiveDemo';
import { PageHero, PageNext, SectionIntro, heroTitleFontSize } from '@/components/site/primitives';
import { featureFromSlug, featureStories } from '@/data/content';
import { featureDeepDives } from '@/data/deep-dives';
import { Link, useRouter } from '@/lib/router';

export function FeatureDetailPage() {
  const { path } = useRouter();
  const pathParts = path.split('/').filter(Boolean);
  const slug = pathParts[pathParts.length - 1] ?? '';
  const feature = featureFromSlug(slug);
  const detail = featureDeepDives[slug];
  if (!feature || !detail) return null;
  const position = featureStories.findIndex((item) => item.slug === slug) + 1;
  const related = featureStories.filter((item) => item.slug !== slug).slice(0, 3);
  const titleWords = feature.title.split(' ');
  const lastTitleWord = titleWords[titleWords.length - 1] ?? '';
  const leadingTitle = titleWords.slice(0, -1).join(' ');

  return (
    <>
      <PageHero
        index={`01.${String(position).padStart(2, '0')}`}
        eyebrow={feature.eyebrow}
        titleFontSize={heroTitleFontSize(feature.title, { lines: 2 })}
        title={
          <>
            {leadingTitle} <span className="text-brand">{lastTitleWord}</span>
          </>
        }
        description={feature.summary}
        aside={
          <div className="flex items-center gap-2 font-mono text-xs font-black uppercase tracking-[0.14em] text-faint">
            <feature.icon className="size-4 text-brand" /> Feature deep dive
          </div>
        }
      />
      {slug === 'kanban-work-queue' && <KanbanLiveDemo />}
      {slug === 'brain-council' && <BrainCouncilDemo />}
      <section className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10 lg:py-36">
        <SectionIntro index="01" eyebrow="System promise" title={detail.promise} />
        <div className="mt-12 grid gap-px overflow-hidden rounded-2xl border border-line bg-line sm:grid-cols-3">
          {detail.signals.map((signal) => (
            <div key={signal.label} className="bg-card p-6">
              <span className="font-mono text-xs font-black uppercase tracking-[0.16em] text-faint">
                {signal.label}
              </span>
              <strong className="mt-3 block font-mono text-sm text-brand">{signal.value}</strong>
            </div>
          ))}
        </div>
      </section>
      <section className="border-y border-line bg-surface">
        <div className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10">
          <SectionIntro
            index="02"
            eyebrow="Mechanism"
            title="How the feature behaves inside the runtime."
            description="Each step maps to an explicit contract or lifecycle boundary rather than hidden prompt behavior."
          />
          <div className="mt-12 space-y-2">
            {detail.mechanism.map((step, index) => (
              <div key={step.title}>
                <article className="grid gap-5 rounded-2xl border border-line bg-card p-6 sm:grid-cols-[52px_240px_1fr] sm:items-center">
                  <span className="grid size-11 place-items-center rounded-full border border-line bg-bg font-mono text-xs font-black text-brand-2">
                    0{index + 1}
                  </span>
                  <h2 className="font-black text-fg">{step.title}</h2>
                  <div>
                    <p className="text-sm leading-7 text-muted">{step.body}</p>
                    <code className="mt-3 block font-mono text-xs text-brand">{step.code}</code>
                  </div>
                </article>
                {index < detail.mechanism.length - 1 && (
                  <ArrowDown className="mx-auto my-1 size-4 text-faint" />
                )}
              </div>
            ))}
          </div>
        </div>
      </section>
      <section className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10 lg:py-36">
        <SectionIntro
          index="03"
          eyebrow="Operator notes"
          title="What to keep in mind while using it."
        />
        <div className="mt-12 grid gap-5 lg:grid-cols-[1fr_.65fr]">
          <div className="overflow-hidden rounded-2xl border border-line bg-card">
            {detail.operatorNotes.map((note, index) => (
              <div
                key={note}
                className="flex gap-4 border-b border-line p-5 last:border-b-0 sm:p-6"
              >
                <span className="font-mono text-xs font-black text-brand-2">0{index + 1}</span>
                <p className="text-sm leading-7 text-muted">{note}</p>
              </div>
            ))}
          </div>
          <div className="rounded-2xl border border-brand/20 bg-brand/5 p-6 sm:p-8">
            <Gauge className="size-6 text-brand" />
            <h2 className="mt-6 text-xl font-black text-fg">Built-in guarantees</h2>
            <ul className="mt-5 space-y-3">
              {feature.details.map((item) => (
                <li key={item} className="flex items-start gap-3 text-sm leading-6 text-muted">
                  <Check className="mt-1 size-3.5 shrink-0 text-emerald-500" />
                  {item}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>
      <section className="border-t border-line bg-surface">
        <div className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 lg:px-10">
          <h2 className="text-2xl font-black tracking-[-0.04em] text-fg">
            Continue through the feature system
          </h2>
          <div className="mt-8 grid gap-4 lg:grid-cols-3">
            {related.map((item) => (
              <Link
                key={item.slug}
                href={`/features/${item.slug}`}
                className="group rounded-2xl border border-line bg-card p-6 hover:border-brand"
              >
                <item.icon className="size-5 text-brand" />
                <h3 className="mt-7 text-lg font-black text-fg">{item.title}</h3>
                <p className="mt-2 line-clamp-3 text-sm leading-6 text-muted">{item.summary}</p>
                <ArrowRight className="mt-6 size-4 text-faint transition-transform group-hover:translate-x-1 group-hover:text-brand" />
              </Link>
            ))}
          </div>
        </div>
      </section>
      <PageNext
        label="Features"
        title="Return to the complete capability map"
        body="See how the major systems fit together across the whole product."
        href="/features"
      />
    </>
  );
}
