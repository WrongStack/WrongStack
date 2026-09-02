import { Bookmark, FileText, Layers3, Library, Puzzle, Search, Star, Wand2 } from 'lucide-react';
import { ExternalDoc, PageHero, PageNext, SectionIntro } from '@/components/site/primitives';

export function PromptsPage() {
  return (
    <>
      <PageHero
        index="17"
        eyebrow="Prompts library"
        title={
          <>
            Reusable steering <span className="text-brand">at your fingertips.</span>
          </>
        }
        description="The prompts library stores reusable prompt templates across three layers — bundled, user, and project. Search, favorite, and insert with variable rendering and AI-assisted authoring."
        aside={<ExternalDoc path="docs/prompts/README.md">Open Prompts docs</ExternalDoc>}
      />

      <section className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10 lg:py-36">
        <SectionIntro
          index="01"
          eyebrow="Three layers"
          title="Bundled, user, or project — the right scope for every prompt."
          description="Prompts merge by slug across three layers. Project overrides user; user overrides bundled. The shipped dataset stays immutable."
        />
        <div className="mt-12 grid gap-px overflow-hidden rounded-2xl border border-line bg-line lg:grid-cols-3">
          {[
            {
              icon: Library,
              title: 'Bundled',
              body: '50+ prompts ship with WrongStack. Code review templates, refactoring checklists, architecture decision records, debugging workflows. Always available.',
            },
            {
              icon: Layers3,
              title: 'Profile',
              body: 'Store prompts in ~/.wrongstack/profiles/<name>/prompts. They follow the active profile across projects.',
            },
            {
              icon: FileText,
              title: 'Project',
              body: 'Project prompts live in .wrongstack/prompts. Share team conventions, onboarding guides, and repo-specific workflows via version control.',
            },
          ].map(({ icon: Icon, title, body }) => (
            <article key={title} className="bg-card p-7">
              <Icon className="size-5 text-brand" />
              <h2 className="mt-8 text-xl font-black text-fg">{title}</h2>
              <p className="mt-3 text-sm leading-7 text-muted">{body}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="border-y border-line bg-surface">
        <div className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10">
          <SectionIntro
            index="02"
            eyebrow="Commands"
            title="Three commands for the full workflow."
          />
          <div className="mt-12 grid gap-6 lg:grid-cols-3">
            {[
              {
                icon: Search,
                cmd: '/prompts',
                desc: 'List all prompts across layers. Filter by source, search by title or tag. Favorite the ones you use most.',
              },
              {
                icon: Bookmark,
                cmd: '/prompt',
                desc: 'Search and insert a prompt by slug. Variables render at insertion time. Favorited prompts appear first in search results.',
              },
              {
                icon: Wand2,
                cmd: '/prompt-gen',
                desc: 'Author a new prompt with model assistance. Describe what you want, and the model drafts the structure, variables, and metadata.',
              },
            ].map(({ icon: Icon, cmd, desc }) => (
              <article key={cmd} className="rounded-2xl border border-line bg-card p-7">
                <Icon className="size-5 text-brand" />
                <code className="mt-5 block font-mono text-sm font-black text-brand">{cmd}</code>
                <p className="mt-3 text-sm leading-7 text-muted">{desc}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10 lg:py-36">
        <SectionIntro
          index="03"
          eyebrow="Variables & favorites"
          title="Dynamic prompts that adapt to context."
          description="Variables let you customize each insertion. Favorites keep your most-used templates one keystroke away."
        />
        <div className="mt-12 grid gap-6 lg:grid-cols-2">
          <div className="rounded-2xl border border-line bg-card p-7">
            <Puzzle className="size-5 text-brand" />
            <h2 className="mt-8 text-xl font-black text-fg">Variable syntax</h2>
            <p className="mt-3 text-sm leading-7 text-muted">
              Prompts use double-brace variable syntax. Variables are rendered at insertion time —
              the agent prompts you for values before injecting the rendered prompt.
            </p>
            <div className="mt-5 rounded-lg border border-line bg-bg p-4 font-mono text-sm leading-7">
              <span className="text-zinc-400">Review the </span>
              <span className="text-brand">{'{{module}}'}</span>
              <span className="text-zinc-400"> module for </span>
              <span className="text-brand">{'{{vulnerability_type}}'}</span>
              <span className="text-zinc-400">.</span>
              <br />
              <span className="text-zinc-400">Report findings at </span>
              <span className="text-brand">{'{{severity}}'}</span>
              <span className="text-zinc-400"> severity or higher.</span>
            </div>
          </div>
          <div className="rounded-2xl border border-line bg-card p-7">
            <Star className="size-5 text-brand" />
            <h2 className="mt-8 text-xl font-black text-fg">Favorites & search</h2>
            <p className="mt-3 text-sm leading-7 text-muted">
              Mark prompts as favorite for quick access. Favorited prompts appear first in `/prompt`
              search results. Prompt-gen uses AI to draft the structure from a natural-language
              description.
            </p>
            <div className="mt-5 space-y-3">
              {[
                { cmd: '/prompt security-review', desc: 'Search and insert by exact slug match.' },
                {
                  cmd: '/prompt refactor',
                  desc: 'Fuzzy search — shows matching prompts across all layers.',
                },
                {
                  cmd: '/prompt-gen "code review checklist for React components"',
                  desc: 'AI-assisted authoring. Model drafts frontmatter and body.',
                },
              ].map(({ cmd, desc }) => (
                <div key={cmd} className="rounded-lg border border-line bg-bg p-4">
                  <code className="font-mono text-sm font-black text-brand">{cmd}</code>
                  <p className="mt-1.5 text-xs leading-5 text-muted">{desc}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section className="border-y border-line bg-surface">
        <div className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10">
          <SectionIntro
            index="04"
            eyebrow="Authoring"
            title="Write a prompt once, use it everywhere."
            description="Every prompt is a markdown file with YAML frontmatter. Simple enough to write by hand, powerful enough to drive complex agent workflows."
          />
          <div className="mt-12 grid gap-6 lg:grid-cols-3">
            {[
              {
                label: 'slug',
                body: 'Unique identifier. Used for search and insertion. Keep it short and descriptive.',
              },
              {
                label: 'title',
                body: 'Human-readable title shown in search results and listings.',
              },
              {
                label: 'description',
                body: 'Short summary shown in search results. Helps others discover your prompt.',
              },
              {
                label: 'variables',
                body: 'Array of variable names. Each becomes a {{placeholder}} in the body.',
              },
              {
                label: 'tags',
                body: 'Optional tags for filtering and discovery. e.g. security, refactor, review.',
              },
              {
                label: 'body',
                body: 'The prompt text. Markdown supported. Variables render at insertion time.',
              },
            ].map(({ label, body }) => (
              <div key={label} className="rounded-xl border border-line bg-card p-5">
                <h3 className="font-black text-sm text-fg">{label}</h3>
                <p className="mt-2 text-xs leading-5 text-muted">{body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <PageNext
        label="SDD workflow"
        title="Spec-driven development from idea to verified code"
        body="Define a spec, let the agent plan, implement, and verify in structured phases."
        href="/sdd"
      />
    </>
  );
}
