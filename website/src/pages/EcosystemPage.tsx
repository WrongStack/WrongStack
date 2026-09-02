import { ArrowRight, Check, Terminal } from 'lucide-react';
import { ExternalDoc, PageHero, PageNext, SectionIntro } from '@/components/site/primitives';
import { Link } from '@/lib/router';
import { ecosystemPillars } from '@/data/content';

export function EcosystemPage() {
  return (
    <>
      <PageHero
        index="07"
        eyebrow="Ecosystem"
        title={
          <>
            Make it yours.
            <br />
            <span className="text-brand">Keep it legible.</span>
          </>
        }
        description="WrongStack has six extension boundaries. Pick the smallest one that fits: a prompt for reusable text, a skill for expert behavior, MCP for remote tools, hooks for policy, or a plugin for runtime code."
        aside={
          <ExternalDoc path="docs/plugin-author-guide.md">Open plugin author guide</ExternalDoc>
        }
      />

      <section className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10 lg:py-36">
        <SectionIntro
          index="01"
          eyebrow="Choose an extension"
          title="Different jobs deserve different boundaries."
          description="You do not need a plugin for every customization. Start with the least powerful mechanism that solves the problem."
        />
        <div className="mt-14 grid gap-5 lg:grid-cols-2">
          {ecosystemPillars.map((pillar, index) => (
            <article
              key={pillar.name}
              className="group rounded-2xl border border-line bg-card p-6 transition-colors hover:border-line-strong sm:p-8"
            >
              <div className="flex items-center justify-between">
                <span className="grid size-11 place-items-center rounded-xl border border-line bg-bg text-brand">
                  <pillar.icon className="size-5" />
                </span>
                <span className="font-mono text-xs font-black text-faint">0{index + 1}</span>
              </div>
              <div className="mt-8 flex flex-wrap items-baseline justify-between gap-3">
                <div>
                  <span className="font-mono text-xs font-black uppercase tracking-[0.18em] text-brand">
                    {pillar.name}
                  </span>
                  <h2 className="mt-2 text-2xl font-black tracking-[-0.04em] text-fg">
                    {pillar.headline}
                  </h2>
                </div>
                <code className="rounded-full border border-line bg-bg px-3 py-1.5 font-mono text-xs font-bold text-faint">
                  {pillar.command}
                </code>
              </div>
              <p className="mt-5 text-sm leading-7 text-muted">{pillar.body}</p>
              <ul className="mt-6 grid gap-2 sm:grid-cols-3">
                {pillar.facts.map((fact) => (
                  <li key={fact} className="flex items-start gap-2 text-xs leading-5 text-muted">
                    <Check className="mt-0.5 size-3.5 shrink-0 text-emerald-500" />
                    {fact}
                  </li>
                ))}
              </ul>
            </article>
          ))}
        </div>
      </section>

      <section className="border-y border-line bg-ink text-white">
        <div className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10 lg:py-32">
          <div className="grid gap-12 lg:grid-cols-[.48fr_1fr]">
            <div>
              <span className="font-mono text-xs font-black uppercase tracking-[0.2em] text-brand">
                Decision guide
              </span>
              <h2 className="mt-6 text-4xl font-black leading-[1.03] tracking-[-0.025em] sm:text-5xl">
                Use the narrowest door.
              </h2>
              <p className="mt-5 text-sm leading-7 text-zinc-400">
                A smaller extension has fewer capabilities to govern and less lifecycle to maintain.
              </p>
            </div>
            <div className="space-y-2">
              {[
                ['Reusable text or workflow starter', 'Prompt', '/prompt-gen'],
                ['Domain rules the model should follow', 'Skill', '/skill-gen'],
                ['External service or standard tool server', 'MCP', '/mcp add'],
                ['Block, mutate or observe lifecycle events', 'Hook', 'config.hooks'],
                ['New tools, providers, middleware or commands', 'Plugin', 'Plugin API'],
              ].map(([need, choice, command], index) => (
                <div
                  key={need}
                  className="grid gap-3 rounded-xl border border-white/10 bg-white/[0.035] p-4 sm:grid-cols-[32px_1fr_110px_110px] sm:items-center"
                >
                  <span className="font-mono text-xs font-black text-brand-2">0{index + 1}</span>
                  <span className="text-sm text-zinc-300">{need}</span>
                  <strong className="text-sm">{choice}</strong>
                  <code className="font-mono text-xs text-zinc-500">{command}</code>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10 lg:py-36">
        <SectionIntro
          index="02"
          eyebrow="Discovery"
          title="Project rules win without mutating global state."
          description="Skills and prompts use layered discovery. Higher-priority project entries shadow lower layers by name or slug; bundled content remains read-only."
        />
        <div className="mt-12 grid gap-6 lg:grid-cols-2">
          <div className="rounded-2xl border border-line bg-card p-6 sm:p-8">
            <h2 className="flex items-center gap-2 font-black text-fg">
              <Terminal className="size-4 text-brand" /> Skill discovery order
            </h2>
            <div className="mt-6 space-y-2">
              {[
                '.wrongstack/skills/',
                '.claude/skills/ + supported foreign agents',
                '~/.wrongstack/profiles/<name>/skills/',
                '~/.claude/skills/ + foreign agents',
                'user-configured extraDirs',
                '29 bundled core skills',
              ].map((path, index) => (
                <div
                  key={path}
                  className="flex items-center gap-3 rounded-lg border border-line bg-bg px-4 py-3"
                >
                  <span className="font-mono text-xs font-black text-brand-2">{index + 1}</span>
                  <code className="font-mono text-xs text-muted">{path}</code>
                </div>
              ))}
            </div>
            <div className="mt-6">
              <ExternalDoc path="docs/skills.md">Read the skill writing guide</ExternalDoc>
            </div>
          </div>
          <div className="rounded-2xl border border-line bg-card p-6 sm:p-8">
            <h2 className="flex items-center gap-2 font-black text-fg">
              <Terminal className="size-4 text-brand" /> Prompt discovery order
            </h2>
            <div className="mt-6 space-y-2">
              {[
                '<project>/.wrongstack/prompts/',
                '~/.wrongstack/profiles/<name>/prompts/',
                'packages/core/data/prompts/',
              ].map((path, index) => (
                <div
                  key={path}
                  className="flex items-center gap-3 rounded-lg border border-line bg-bg px-4 py-3"
                >
                  <span className="font-mono text-xs font-black text-brand-2">{index + 1}</span>
                  <code className="font-mono text-xs text-muted">{path}</code>
                </div>
              ))}
            </div>
            <div className="mt-7 rounded-xl border border-brand/15 bg-brand/5 p-5 text-sm leading-6 text-muted">
              Editing or favoriting a bundled prompt copies it to the user layer with a{' '}
              <code className="font-mono text-xs text-brand">forkedFrom</code> marker. The shipped
              dataset never changes.
            </div>
            <a
              href="https://github.com/WrongStack/WrongStack/tree/main/packages/core/data/prompts"
              target="_blank"
              rel="noreferrer"
              className="mt-6 inline-flex items-center gap-2 text-sm font-bold text-brand"
            >
              Browse prompt data <ArrowRight className="size-4" />
            </a>
          </div>
        </div>
      </section>
      <section className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10">
        <SectionIntro index="05" eyebrow="Related" title="Explore more ecosystem features." />
        <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[
            {
              href: '/skills',
              label: 'Skills',
              desc: 'Installable knowledge packages that auto-activate on trigger words.',
            },
            {
              href: '/prompts',
              label: 'Prompts',
              desc: 'Reusable steering templates with variables and layered resolution.',
            },
            {
              href: '/design-studio',
              label: 'Design Studio',
              desc: '48+ curated UI kits. Materialize CSS tokens and verify palette.',
            },
            {
              href: '/sync',
              label: 'GitHub Sync',
              desc: 'Sync settings, skills, prompts, and memory across machines.',
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
          eyebrow="Plugin development"
          title="Build once. Publish anywhere."
          description="Plugins follow a standard structure: a manifest, a setup function, and optional slash commands, hooks, or tool providers. The plugin SDK handles registration, versioning, and lifecycle."
        />
        <div className="mt-12 grid gap-6 lg:grid-cols-3">
          {[
            {
              title: 'Manifest',
              body: 'name, version, apiVersion, description, capabilities. Declare what your plugin provides without implementing it.',
            },
            {
              title: 'Setup & teardown',
              body: 'setup(api) registers commands, hooks, and providers. teardown(api) cleans up. Both receive a typed API surface.',
            },
            {
              title: 'Distribution',
              body: 'Publish to npm, ship as a local project plugin, or install from GitHub. Plugins auto-discover from the config.',
            },
          ].map(({ title, body }) => (
            <div key={title} className="rounded-xl border border-line bg-card p-5">
              <h3 className="font-black text-sm text-fg">{title}</h3>
              <p className="mt-2 text-xs leading-5 text-muted">{body}</p>
            </div>
          ))}
        </div>
      </section>
      <PageNext
        label="Security"
        title="Know what each extension is allowed to do"
        body="Permissions, capability declarations and untrusted project config keep customization inside explicit boundaries."
        href="/security"
      />
    </>
  );
}
