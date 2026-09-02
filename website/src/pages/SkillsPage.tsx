import { FileText, Globe, GraduationCap, PackageOpen } from 'lucide-react';
import { ExternalDoc, PageHero, PageNext, SectionIntro } from '@/components/site/primitives';

export function SkillsPage() {
  return (
    <>
      <PageHero
        index="16"
        eyebrow="Skills system"
        title={
          <>
            Teach the agent <span className="text-brand">new capabilities.</span>
          </>
        }
        description="Skills are installable packages of instructions, trigger words, and capability declarations. They auto-activate when you mention their keywords — no mode switch, no manual loading."
        aside={<ExternalDoc path="docs/skills/README.md">Open Skills docs</ExternalDoc>}
      />

      <section className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10 lg:py-36">
        <SectionIntro
          index="01"
          eyebrow="How they work"
          title="Trigger words activate skills automatically."
          description="Every skill declares a set of trigger words. When your message contains one, the skill's full instruction body is injected into the agent's context — no command needed."
        />
        <div className="mt-12 grid gap-px overflow-hidden rounded-2xl border border-line bg-line lg:grid-cols-3">
          {[
            {
              step: '01',
              title: 'You mention a trigger',
              body: 'Type "help me with the security audit" or "scan for SQL injection." The skill system detects the trigger words and activates the matching skill.',
            },
            {
              step: '02',
              title: 'Skill body loads',
              body: "The skill's full instruction text — methodology, checklists, code patterns — is injected into the agent's system prompt for that turn.",
            },
            {
              step: '03',
              title: 'Agent applies it',
              body: "The agent follows the skill's detailed instructions alongside its baseline rules. The skill deactivates after the turn unless triggered again.",
            },
          ].map(({ step, title, body }) => (
            <article key={step} className="bg-card p-7">
              <span className="font-mono text-xs font-black text-brand-2">{step}</span>
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
            eyebrow="Lifecycle"
            title="Seven commands for the full skill lifecycle."
          />
          <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {[
              { cmd: '/skill', desc: 'List all discovered skills or load one body.' },
              { cmd: '/skill-search', desc: 'Search the registry by name, tag, or capability.' },
              {
                cmd: '/skill-install',
                desc: 'Install from GitHub (user/repo) or the official registry.',
              },
              {
                cmd: '/skill-import',
                desc: 'Import from Claude Code, Aider, Continue, and other tools.',
              },
              {
                cmd: '/skill-gen',
                desc: 'Author a new skill with model-assisted content generation.',
              },
              { cmd: '/skill-update', desc: 'Update installed skills to their latest versions.' },
              { cmd: '/skill-uninstall', desc: 'Remove an installed skill cleanly.' },
            ].map(({ cmd, desc }) => (
              <div key={cmd} className="rounded-xl border border-line bg-card p-5">
                <code className="font-mono text-sm font-black text-brand">{cmd}</code>
                <p className="mt-2 text-xs leading-5 text-muted">{desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10 lg:py-36">
        <SectionIntro
          index="03"
          eyebrow="Sources"
          title="Three layers of skill resolution."
          description="WrongStack discovers skills from multiple locations. Layering means you can override a bundled skill with your own version without touching shipped files."
        />
        <div className="mt-12 grid gap-6 lg:grid-cols-3">
          {[
            {
              icon: PackageOpen,
              title: 'Bundled',
              path: 'Shipped with @wrongstack/core',
              body: '50+ skills ship with WrongStack: security scanners, testing patterns, API design guides, refactoring workflows. Always available.',
            },
            {
              icon: Globe,
              title: 'Registry',
              path: 'Official skill registry',
              body: 'Browse community-contributed skills. One command install: /skill-install registry:skill-id. Validated before listing.',
            },
            {
              icon: FileText,
              title: 'GitHub',
              path: 'github.com/user/repo',
              body: 'Install directly from any public GitHub repository. Must contain a valid SKILL.md with frontmatter. Supports version pinning.',
            },
          ].map(({ icon: Icon, title, path, body }) => (
            <article key={title} className="rounded-2xl border border-line bg-card p-7">
              <Icon className="size-5 text-brand" />
              <h2 className="mt-8 text-xl font-black text-fg">{title}</h2>
              <code className="mt-2 block font-mono text-xs text-faint">{path}</code>
              <p className="mt-4 text-sm leading-7 text-muted">{body}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10 lg:py-36">
        <SectionIntro
          index="04"
          eyebrow="Project practice"
          title="Skills grow into your codebase."
          description="A bundled skill teaches the general method. What it means to apply that method here is learned from the work — captured from real runs, distilled, and attached to the skill itself."
        />
        <div className="mt-12 grid gap-6 lg:grid-cols-3">
          {[
            {
              title: 'Captured',
              path: '## LEARNED [skill: testing]',
              body: 'A roster agent ends a run with a durable directive and tags the skill it refines. Untagged directives are routed by wording. Failed runs count too — an agent that hit a wall and wrote down why is the best source there is.',
            },
            {
              title: 'Distilled',
              path: '.wrongstack/agents/<role>/skills/<skill>.md',
              body: 'A background pass groups the directives per skill and writes the delta between the general method and how it must be applied in this repository. It runs unattended; /agent-improve <role> optimize forces it early.',
            },
            {
              title: 'Applied',
              path: 'Injected beneath the bundled skill body',
              body: 'On the next spawn the addendum sits directly under that skill, with the instruction to prefer it where the two differ. Which skills load is ranked by what this project actually developed.',
            },
          ].map(({ title, path, body }) => (
            <article key={title} className="rounded-2xl border border-line bg-card p-7">
              <GraduationCap className="size-5 text-brand" />
              <h2 className="mt-8 text-xl font-black text-fg">{title}</h2>
              <code className="mt-2 block font-mono text-xs text-faint">{path}</code>
              <p className="mt-4 text-sm leading-7 text-muted">{body}</p>
            </article>
          ))}
        </div>
        <p className="mt-8 text-sm leading-7 text-muted">
          These files are committed, so a fresh clone starts with the roster already trained on your
          conventions.
        </p>
      </section>

      <section className="border-y border-line bg-surface">
        <div className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10">
          <SectionIntro
            index="05"
            eyebrow="Authoring"
            title="Write a skill once, use it everywhere."
            description="Every skill is a markdown file with YAML frontmatter. The model can help you author one with /skill-gen."
          />
          <div className="mt-12 grid gap-6 lg:grid-cols-3">
            {[
              { label: 'name', body: 'Unique identifier. Used for installation and resolution.' },
              { label: 'description', body: 'Short summary shown in listings and search results.' },
              { label: 'triggers', body: 'Words and phrases that auto-activate this skill.' },
              { label: 'capabilities', body: 'Required tools or permissions the skill needs.' },
              { label: 'body', body: 'The full instruction text injected into the system prompt.' },
              { label: 'version', body: 'Semver. Used by /skill-update for upgrade checking.' },
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
        label="Prompts library"
        title="Reusable steering templates"
        body="Build a library of prompt templates with variables, favorites, and layered resolution."
        href="/prompts"
      />
    </>
  );
}
