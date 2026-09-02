import { ArrowUpRight, Globe2, Layers3, Terminal, UserRound } from 'lucide-react';
import { PageHero, SectionIntro, heroTitleFontSize } from '@/components/site/primitives';
import { GitHubIcon } from '@/components/ui/github-icon';
import {
  creatorFeaturedProjects as featuredProjects,
  creatorProfiles,
  creatorWorkshopProjects as workshopProjects,
} from '@/data/content';

const profileIcons = {
  GitHub: GitHubIcon,
  X: Globe2,
  Web: UserRound,
} as const;

const profiles = creatorProfiles.map((profile) => ({
  ...profile,
  icon: profileIcons[profile.label],
}));

const principles = [
  {
    number: '01',
    title: 'Build the whole system.',
    body: 'The interesting work lives between layers: runtime, protocol, storage, interface, operations and the sharp edges where they meet.',
  },
  {
    number: '02',
    title: 'Keep the machinery visible.',
    body: 'Automation should expose its decisions, limits and receipts. Powerful software earns trust by remaining inspectable.',
  },
  {
    number: '03',
    title: 'Ship the improbable stack.',
    body: 'Technology choices matter less than finishing the system, testing its boundaries and making it genuinely useful to somebody.',
  },
] as const;

export function CreatedByPage() {
  return (
    <>
      <PageHero
        index="19"
        eyebrow="Created by"
        titleFontSize={heroTitleFontSize('Independent builder.')}
        title={
          <>
            Ersin KOÇ.
            <br />
            <span className="text-brand-2">Independent builder.</span>
          </>
        }
        description="WrongStack is created and maintained by Ersin KOÇ—an independent developer building production-ready open-source infrastructure from the agent layer down to the systems beneath it."
        aside={
          <div className="flex flex-wrap gap-2">
            {profiles.map((profile) => (
              <a
                key={profile.label}
                href={profile.href}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-2 rounded-full border border-line bg-card px-3 py-2 text-xs font-bold text-fg transition-colors hover:border-brand hover:text-brand"
              >
                <profile.icon className="size-3.5" />
                {profile.handle}
                <ArrowUpRight className="size-3" />
              </a>
            ))}
          </div>
        }
      />

      <section className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10 lg:py-36">
        <div className="grid gap-12 lg:grid-cols-[minmax(300px,.72fr)_minmax(0,1.15fr)] lg:items-center">
          <div className="relative mx-auto w-full max-w-[520px] lg:mx-0">
            <div className="absolute -bottom-4 -right-4 size-full border border-brand-2/45 bg-brand-2/10" />
            <div className="relative overflow-hidden border border-line-strong bg-card p-2">
              <img
                src="/ersin-koc.png"
                alt="Ersin KOÇ, creator of WrongStack"
                width="400"
                height="400"
                className="aspect-square w-full object-cover grayscale"
                loading="eager"
              />
            </div>
            <div className="absolute -bottom-7 left-6 bg-brand px-4 py-2 font-mono text-xs font-black uppercase tracking-[0.16em] text-white shadow-xl">
              Creator / maintainer
            </div>
          </div>

          <div className="lg:pl-10">
            <span className="font-mono text-xs font-black uppercase tracking-[0.2em] text-brand">
              Person behind the stack
            </span>
            <blockquote className="mt-7 max-w-3xl text-4xl font-black leading-[1.06] tracking-[-0.025em] text-fg sm:text-5xl lg:text-6xl">
              “I build production-ready open-source infrastructure from scratch.”
            </blockquote>
            <p className="mt-8 max-w-2xl text-lg leading-8 text-muted">
              Ersin works across backend engineering, systems administration, DevOps and product
              design. WrongStack is one expression of a broader workshop: ambitious infrastructure,
              autonomous systems and developer tools that remain understandable after they become
              powerful.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              {profiles.map((profile) => (
                <a
                  key={profile.label}
                  href={profile.href}
                  target="_blank"
                  rel="noreferrer"
                  className="group inline-flex items-center gap-3 border-b border-line pb-2 text-sm font-black text-fg transition-colors hover:border-brand hover:text-brand"
                >
                  {profile.label}
                  <span className="font-mono text-xs font-normal text-faint">{profile.handle}</span>
                  <ArrowUpRight className="size-3.5 transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5" />
                </a>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section className="border-y border-line bg-ink text-white">
        <div className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10 lg:py-32">
          <SectionIntro
            index="01"
            eyebrow="Working principles"
            title="Built on the wrong stack. Shipped anyway."
            description="A working system is the argument. These principles connect WrongStack to the rest of Ersin's open-source work."
            className="border-white/10 [&_h2]:text-white [&_p]:text-zinc-400"
          />
          <div className="mt-14 grid gap-px overflow-hidden border border-white/10 bg-white/10 lg:grid-cols-3">
            {principles.map((principle) => (
              <article key={principle.number} className="bg-ink p-7 sm:p-9">
                <span className="font-mono text-xs font-black text-brand-2">
                  {principle.number}
                </span>
                <h2 className="mt-12 text-2xl font-black tracking-[-0.04em]">{principle.title}</h2>
                <p className="mt-4 text-sm leading-7 text-zinc-400">{principle.body}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10 lg:py-36">
        <SectionIntro
          index="02"
          eyebrow="Featured projects"
          title="Different products. The same appetite for complete systems."
          description="WrongStack belongs to a family of open-source projects spanning coding agents, agentic operating systems and personal AI infrastructure."
        />
        <div className="mt-14 grid gap-5 lg:grid-cols-3">
          {featuredProjects.map((project, index) => (
            <a
              key={project.name}
              href={project.href}
              target="_blank"
              rel="noreferrer"
              className="group flex min-h-[360px] flex-col rounded-2xl border border-line bg-card p-7 transition-all hover:-translate-y-1 hover:border-brand/45 sm:p-8"
            >
              <div className="flex items-center justify-between">
                <span className="grid size-12 place-items-center rounded-xl border border-line bg-bg text-brand">
                  {index === 0 ? <Terminal className="size-5" /> : <Layers3 className="size-5" />}
                </span>
                <ArrowUpRight className="size-5 text-faint transition-transform group-hover:-translate-y-1 group-hover:translate-x-1 group-hover:text-brand" />
              </div>
              <div className="mt-auto pt-16">
                <span className="font-mono text-xs font-black uppercase tracking-[0.18em] text-brand">
                  {project.eyebrow}
                </span>
                <h2 className="mt-3 text-4xl font-black tracking-[-0.025em] text-fg">
                  {project.name}
                </h2>
                <p className="mt-5 text-sm leading-7 text-muted">{project.description}</p>
                <span className="mt-7 inline-flex rounded-full border border-line bg-bg px-3 py-1.5 font-mono text-xs font-bold text-faint">
                  {project.language}
                </span>
              </div>
            </a>
          ))}
        </div>
      </section>

      <section className="border-t border-line bg-surface">
        <div className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10 lg:py-32">
          <SectionIntro
            index="03"
            eyebrow="The wider workshop"
            title="More infrastructure, protocols and developer tools."
            description="This is a starting shelf, not an exhaustive archive. The project area is designed to grow as more work becomes ready to feature."
          />
          <div className="mt-12 grid gap-px overflow-hidden border border-line bg-line sm:grid-cols-2 lg:grid-cols-3">
            {workshopProjects.map((project) => (
              <a
                key={project.name}
                href={project.href}
                target="_blank"
                rel="noreferrer"
                className="group bg-card p-6 transition-colors hover:bg-bg sm:p-7"
              >
                <div className="flex items-center justify-between gap-4">
                  <strong className="text-xl font-black tracking-[-0.035em] text-fg">
                    {project.name}
                  </strong>
                  <ArrowUpRight className="size-4 shrink-0 text-faint group-hover:text-brand" />
                </div>
                <p className="mt-4 text-sm leading-6 text-muted">{project.description}</p>
              </a>
            ))}
          </div>
          <a
            href="https://github.com/ersinkoc"
            target="_blank"
            rel="noreferrer"
            className="mt-8 inline-flex items-center gap-2 text-sm font-black text-brand"
          >
            Explore all projects on GitHub <ArrowUpRight className="size-4" />
          </a>
        </div>
      </section>
    </>
  );
}
