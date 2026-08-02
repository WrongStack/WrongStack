import { ArrowRight, OctagonX, ShieldCheck, Wrench } from 'lucide-react';
import { PageHero, PageNext, SectionIntro, heroTitleFontSize } from '@/components/site/primitives';
import { TOOL_COUNT, toolCatalog, toolFromSlug, toolSlug } from '@/data/runtime-catalog';
import { toolDetails } from '@/data/tool-details';
import { Link, useRouter } from '@/lib/router';

export function ToolDetailPage() {
  const { path } = useRouter();
  const pathParts = path.split('/').filter(Boolean);
  const slug = pathParts[pathParts.length - 1] ?? '';
  const tool = toolFromSlug(slug);
  if (!tool) return null;
  const detail = toolDetails[tool.name];
  const position = toolCatalog.findIndex((item) => item.name === tool.name) + 1;
  const related = toolCatalog
    .filter((item) => item.category === tool.category && item.name !== tool.name)
    .slice(0, 5);
  const requiredParams = detail?.params.filter((param) => param.required) ?? [];
  const optionalParams = detail?.params.filter((param) => !param.required) ?? [];
  const orderedParams = [...requiredParams, ...optionalParams];

  return (
    <>
      <PageHero
        index={`20.${String(position).padStart(2, '0')}`}
        eyebrow={tool.category}
        title={<span className="font-mono text-brand">{tool.name}</span>}
        titleFontSize={heroTitleFontSize(tool.name, { mono: true })}
        description={tool.summary}
        aside={
          <div className="flex flex-wrap gap-2">
            <span
              className={
                tool.permission === 'auto'
                  ? 'rounded-full border border-emerald-500/25 bg-emerald-500/10 px-3 py-1.5 font-mono text-xs font-black uppercase text-emerald-500'
                  : 'rounded-full border border-brand-2/25 bg-brand-2/10 px-3 py-1.5 font-mono text-xs font-black uppercase text-brand-2'
              }
            >
              {tool.permission}
            </span>
            <span className="rounded-full border border-line bg-card px-3 py-1.5 font-mono text-xs font-black uppercase text-faint">
              {tool.mutating ? 'mutating' : 'read-only'}
            </span>
          </div>
        }
      />

      <section className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10 lg:py-32">
        <SectionIntro index="01" eyebrow="Purpose" title={`What ${tool.name} is for.`} />
        <div className="mt-12 grid gap-6 lg:grid-cols-[1fr_.72fr]">
          <article className="rounded-2xl border border-line bg-card p-6 sm:p-8">
            <Wrench className="size-5 text-brand" />
            <h2 className="mt-8 text-2xl font-black tracking-[-0.04em] text-fg">Behavior</h2>
            <p className="mt-4 text-base leading-8 text-muted">
              {detail?.longDescription ?? tool.summary}
            </p>
            {detail?.notes && detail.notes.length > 0 && (
              <ul className="mt-6 space-y-3">
                {detail.notes.map((note) => (
                  <li key={note} className="flex items-start gap-3 text-sm leading-6 text-muted">
                    <span className="mt-2 size-1.5 shrink-0 rounded-full bg-brand" />
                    {note}
                  </li>
                ))}
              </ul>
            )}
          </article>
          <aside className="rounded-2xl border border-brand/20 bg-brand/5 p-6 sm:p-8">
            <ShieldCheck className="size-6 text-brand" />
            <h2 className="mt-6 text-xl font-black text-fg">Permission contract</h2>
            <p className="mt-4 text-sm leading-7 text-muted">
              {tool.permission === 'auto'
                ? 'Runs without an operator prompt: the policy engine classifies it as safe to execute automatically.'
                : 'Requires operator confirmation before it runs; trust rules and sensitive-path checks refine the decision per call.'}{' '}
              {tool.mutating
                ? 'The tool is mutating — its side effects are recorded in the session ledger.'
                : 'The tool is read-only and leaves no side effects behind.'}
            </p>
            <Link
              href="/security"
              className="group mt-6 inline-flex items-center gap-2 text-sm font-black text-brand"
            >
              See the permission model
              <ArrowRight className="size-4 transition-transform group-hover:translate-x-1" />
            </Link>
          </aside>
        </div>
      </section>

      {orderedParams.length > 0 && (
        <section className="border-y border-line bg-surface">
          <div className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10">
            <SectionIntro
              index="02"
              eyebrow="Parameters"
              title="The input contract."
              description="Extracted from the tool's real JSON Schema. Required parameters are listed first."
            />
            <div className="mt-12 overflow-hidden rounded-2xl border border-line">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[640px] text-left text-sm">
                  <thead>
                    <tr className="border-b border-line bg-card font-mono text-xs font-black uppercase tracking-[0.14em] text-faint">
                      <th className="px-5 py-4">Parameter</th>
                      <th className="px-5 py-4">Type</th>
                      <th className="px-5 py-4">Required</th>
                      <th className="px-5 py-4">Description</th>
                    </tr>
                  </thead>
                  <tbody>
                    {orderedParams.map((param) => (
                      <tr key={param.name} className="border-b border-line bg-card last:border-b-0">
                        <td className="px-5 py-4 font-mono text-xs font-bold text-fg">
                          {param.name}
                        </td>
                        <td className="px-5 py-4 font-mono text-xs text-brand">{param.type}</td>
                        <td className="px-5 py-4 font-mono text-xs text-muted">
                          {param.required ? 'yes' : 'no'}
                        </td>
                        <td className="px-5 py-4 leading-6 text-muted">
                          {param.description ?? '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </section>
      )}

      {((detail?.doNotUseWhen?.length ?? 0) > 0 || (detail?.useInstead?.length ?? 0) > 0) && (
        <section className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10 lg:py-32">
          <SectionIntro
            index="03"
            eyebrow="Selection boundaries"
            title="When another tool is the better call."
            description="Declared by the tool itself and rendered into the agent's system prompt."
          />
          <div className="mt-12 grid gap-5 lg:grid-cols-2">
            {detail?.doNotUseWhen && detail.doNotUseWhen.length > 0 && (
              <div className="rounded-2xl border border-brand-2/20 bg-brand-2/5 p-6 sm:p-8">
                <OctagonX className="size-5 text-brand-2" />
                <h2 className="mt-6 text-lg font-black text-fg">Do not use when</h2>
                <ul className="mt-5 space-y-3">
                  {detail.doNotUseWhen.map((item) => (
                    <li key={item} className="flex items-start gap-3 text-sm leading-6 text-muted">
                      <span className="mt-2 size-1.5 shrink-0 rounded-full bg-brand-2" />
                      {item}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {detail?.useInstead && detail.useInstead.length > 0 && (
              <div className="rounded-2xl border border-line bg-card p-6 sm:p-8">
                <ArrowRight className="size-5 text-brand" />
                <h2 className="mt-6 text-lg font-black text-fg">Use instead</h2>
                <ul className="mt-5 space-y-3">
                  {detail.useInstead.map((item) => (
                    <li key={item} className="flex items-start gap-3 text-sm leading-6 text-muted">
                      <span className="mt-2 size-1.5 shrink-0 rounded-full bg-brand" />
                      {item}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </section>
      )}

      {related.length > 0 && (
        <section className="border-t border-line bg-surface">
          <div className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 lg:px-10">
            <h2 className="text-2xl font-black tracking-[-0.04em] text-fg">
              More {tool.category} tools
            </h2>
            <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {related.map((item) => (
                <Link
                  key={item.name}
                  href={`/tools/${toolSlug(item.name)}`}
                  className="group rounded-2xl border border-line bg-card p-6 hover:border-brand"
                >
                  <h3 className="font-mono text-base font-black text-fg">{item.name}</h3>
                  <p className="mt-2 line-clamp-3 text-sm leading-6 text-muted">{item.summary}</p>
                  <ArrowRight className="mt-6 size-4 text-faint transition-transform group-hover:translate-x-1 group-hover:text-brand" />
                </Link>
              ))}
            </div>
          </div>
        </section>
      )}

      <PageNext
        label="Built-in tools"
        title="Browse the full tool atlas"
        body={`All ${TOOL_COUNT} built-in tools with permission levels, mutability and categories.`}
        href="/tools"
      />
    </>
  );
}
