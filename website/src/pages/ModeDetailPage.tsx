import { ArrowRight, CircleGauge, Sparkles, Wrench } from 'lucide-react';
import { PageHero, PageNext, SectionIntro, heroTitleFontSize } from '@/components/site/primitives';
import { modeCatalog, modeFamilyGuidance, modeFromSlug } from '@/data/product-catalog';
import { Link, useRouter } from '@/lib/router';

export function ModeDetailPage() {
  const { path } = useRouter();
  const pathParts = path.split('/').filter(Boolean);
  const slug = pathParts[pathParts.length - 1] ?? '';
  const mode = modeFromSlug(slug);
  if (!mode) return null;
  const position = modeCatalog.findIndex((item) => item.id === mode.id) + 1;
  const family = modeFamilyGuidance[mode.family];
  const related = modeCatalog
    .filter((item) => item.family === mode.family && item.id !== mode.id)
    .slice(0, 5);

  return (
    <>
      <PageHero
        index={`17.${String(position).padStart(2, '0')}`}
        eyebrow={`${family.label} mode`}
        title={<span className="text-brand">{mode.name}</span>}
        titleFontSize={heroTitleFontSize(mode.name)}
        description={mode.description}
        aside={
          <div className="flex flex-wrap gap-2">
            <span className="rounded-full border border-line bg-card px-3 py-1.5 font-mono text-xs font-black uppercase text-faint">
              {mode.family}
            </span>
            <span className="rounded-full border border-line bg-card px-3 py-1.5 font-mono text-xs font-black uppercase text-faint">
              /mode {mode.id}
            </span>
          </div>
        }
      />

      <section className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10 lg:py-32">
        <SectionIntro
          index="01"
          eyebrow="When to use it"
          title={`Where ${mode.name} earns its keep.`}
        />
        <div className="mt-12 grid gap-6 lg:grid-cols-[1fr_.72fr]">
          <article className="rounded-2xl border border-line bg-card p-6 sm:p-8">
            <CircleGauge className="size-5 text-brand" />
            <h2 className="mt-8 text-2xl font-black tracking-[-0.04em] text-fg">Behavior</h2>
            <p className="mt-4 text-base leading-8 text-muted">{mode.description}</p>
            <p className="mt-4 text-sm leading-7 text-muted">{family.body}</p>
            <p className="mt-4 text-sm leading-7 text-muted">
              Switch with <code className="font-mono text-brand">/mode {mode.id}</code>. Switching
              persona mode does not replace the selected model, clear context or grant new
              permissions.
            </p>
            <Link
              href="/commands/mode"
              className="group mt-6 inline-flex items-center gap-2 text-sm font-black text-brand"
            >
              Learn the /mode command
              <ArrowRight className="size-4 transition-transform group-hover:translate-x-1" />
            </Link>
          </article>
          <div className="space-y-6">
            <aside className="rounded-2xl border border-line bg-card p-6 sm:p-8">
              <div className="flex items-center gap-3">
                <Wrench className="size-4 text-brand" />
                <h2 className="text-lg font-black text-fg">Tool preferences</h2>
              </div>
              {mode.toolPreferences.length > 0 ? (
                <div className="mt-5 flex flex-wrap gap-2">
                  {mode.toolPreferences.map((tool) => (
                    <span
                      key={tool}
                      className="rounded-full border border-line bg-bg px-3 py-1.5 font-mono text-xs font-bold text-fg"
                    >
                      {tool}
                    </span>
                  ))}
                </div>
              ) : (
                <p className="mt-4 text-sm leading-6 text-muted">
                  No preference list — the mode keeps the complete default toolset.
                </p>
              )}
            </aside>
            <aside className="rounded-2xl border border-line bg-card p-6 sm:p-8">
              <div className="flex items-center gap-3">
                <Sparkles className="size-4 text-brand-2" />
                <h2 className="text-lg font-black text-fg">Suggested skills</h2>
              </div>
              {mode.suggestedSkills.length > 0 ? (
                <div className="mt-5 flex flex-wrap gap-2">
                  {mode.suggestedSkills.map((skill) => (
                    <span
                      key={skill}
                      className="rounded-full border border-brand-2/25 bg-brand-2/5 px-3 py-1.5 font-mono text-xs font-bold text-fg"
                    >
                      {skill}
                    </span>
                  ))}
                </div>
              ) : (
                <p className="mt-4 text-sm leading-6 text-muted">
                  No paired skills — the mode works standalone.
                </p>
              )}
            </aside>
          </div>
        </div>
      </section>

      {related.length > 0 && (
        <section className="border-t border-line bg-surface">
          <div className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 lg:px-10">
            <h2 className="text-2xl font-black tracking-[-0.04em] text-fg">
              More {family.label.toLowerCase()} modes
            </h2>
            <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {related.map((item) => (
                <Link
                  key={item.id}
                  href={`/modes/${item.id}`}
                  className="group rounded-2xl border border-line bg-card p-6 hover:border-brand"
                >
                  <h3 className="text-lg font-black text-fg">{item.name}</h3>
                  <p className="mt-2 line-clamp-3 text-sm leading-6 text-muted">
                    {item.description}
                  </p>
                  <ArrowRight className="mt-6 size-4 text-faint transition-transform group-hover:translate-x-1 group-hover:text-brand" />
                </Link>
              ))}
            </div>
          </div>
        </section>
      )}

      <PageNext
        label="Session modes"
        title="Compare all 19 persona modes"
        body="Balanced, lite and deep families side by side, with families, tools and skills."
        href="/modes"
      />
    </>
  );
}
