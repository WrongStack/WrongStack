import { Check, Minus } from 'lucide-react';
import {
  CopyCommand,
  ExternalDoc,
  PageHero,
  PageNext,
  Reveal,
  SectionIntro,
} from '@/components/site/primitives';
import { Link } from '@/lib/router';
import { surfaces } from '@/data/content';

const comparison = [
  ['Interactive chat', true, true, true, true, true, false],
  ['Rich tool rendering', false, true, true, true, true, true],
  ['Code editor', false, false, true, false, true, false],
  ['Fleet monitoring', true, true, true, true, true, true],
  ['Cross-session overview', false, false, false, false, true, true],
  ['Scriptable / pipe-friendly', true, false, false, false, false, false],
  ['Cross-machine control', false, false, false, false, false, true],
] as const;

export function InterfacesPage() {
  return (
    <>
      <PageHero
        index="03"
        eyebrow="Interfaces"
        title={
          <>
            Six surfaces.
            <br />
            <span className="text-brand">One live system.</span>
          </>
        }
        description="Choose the interface around the job, not around a reduced feature set. Every surface composes the same agent kernel, permissions, sessions and coordination primitives."
        aside={<ExternalDoc path="docs/webui.md">Read the WebUI guide</ExternalDoc>}
      />

      <section className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10 lg:py-36">
        <SectionIntro
          index="01"
          eyebrow="Surface guide"
          title="From a single terminal to an operations room."
        />
        <div className="mt-14 space-y-5">
          {surfaces.map((surface, index) => (
            <Reveal key={surface.id} delay={index * 0.025}>
              <article className="group grid gap-6 rounded-2xl border border-line bg-card p-6 transition-colors hover:border-line-strong sm:p-8 lg:grid-cols-[80px_.7fr_1fr_220px] lg:items-start">
                <div className="flex items-center justify-between lg:block">
                  <span className="font-mono text-xs font-black text-brand-2">0{index + 1}</span>
                  <span className="grid size-11 place-items-center rounded-xl border border-line bg-bg lg:mt-8">
                    <surface.icon className="size-5 text-fg" />
                  </span>
                </div>
                <div>
                  <span className="font-mono text-xs font-black uppercase tracking-[0.18em] text-faint">
                    {surface.tagline}
                  </span>
                  <h2 className="mt-3 text-3xl font-black tracking-[-0.045em] text-fg">
                    {surface.name}
                  </h2>
                  <p className="mt-3 text-sm font-semibold text-brand">Best for: {surface.best}</p>
                </div>
                <div>
                  <p className="text-sm leading-7 text-muted sm:text-base">{surface.description}</p>
                  <ul className="mt-5 grid gap-2 sm:grid-cols-2">
                    {surface.traits.map((trait) => (
                      <li
                        key={trait}
                        className="flex items-center gap-2 text-xs font-semibold text-muted"
                      >
                        <Check className="size-3.5 text-emerald-500" />
                        {trait}
                      </li>
                    ))}
                  </ul>
                </div>
                <div className="lg:pt-8">
                  <CopyCommand command={surface.launch} />
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
            eyebrow="Compare"
            title="Pick by workflow, not feature anxiety."
            description="HQ observes many sessions; the other five drive a working session. Desktop embeds WebUI runtimes and adds native multi-project management."
          />
          <div className="mt-12 overflow-x-auto rounded-2xl border border-line bg-card">
            <table className="w-full min-w-[900px] border-collapse text-left">
              <thead>
                <tr className="border-b border-line bg-bg font-mono text-xs font-black uppercase tracking-[0.14em] text-faint">
                  <th className="p-4 sm:p-5">Capability</th>
                  {['CLI', 'TUI', 'WebUI', 'SimpleUI', 'Desktop', 'HQ'].map((name) => (
                    <th key={name} className="p-4 text-center sm:p-5">
                      {name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {comparison.map(([label, ...values]) => (
                  <tr key={label} className="border-b border-line last:border-b-0">
                    <th className="p-4 text-sm font-semibold text-fg sm:p-5">{label}</th>
                    {values.map((value, index) => (
                      <td key={`${label}-${index}`} className="p-4 text-center sm:p-5">
                        {value ? (
                          <Check className="mx-auto size-4 text-emerald-500" />
                        ) : (
                          <Minus className="mx-auto size-4 text-faint/50" />
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10 lg:py-36">
        <SectionIntro
          index="03"
          eyebrow="Shared state"
          title="Switch surfaces without splitting the project."
        />
        <div className="mt-12 grid gap-px overflow-hidden rounded-2xl border border-line bg-line lg:grid-cols-3">
          {[
            [
              'Project identity',
              'One canonical project slug maps every surface to the same project directory and manifest entry.',
            ],
            [
              'Sessions',
              'Every TUI, WebUI and SimpleUI starts a fresh session by default; explicit resume claims one live writer before hydration.',
            ],
            [
              'Mailbox',
              'Unique identities and heartbeats reach one SQLite owner over local IPC for exact or fan-out delivery.',
            ],
          ].map(([title, body], index) => (
            <div key={title} className="bg-card p-7">
              <span className="font-mono text-xs font-black text-brand-2">0{index + 1}</span>
              <h3 className="mt-8 text-xl font-black tracking-[-0.035em] text-fg">{title}</h3>
              <p className="mt-3 text-sm leading-7 text-muted">{body}</p>
            </div>
          ))}
        </div>
      </section>
      <section className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10">
        <SectionIntro index="05" eyebrow="Related" title="Explore more interfaces and tools." />
        <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[
            {
              href: '/hq',
              label: 'HQ Command Center',
              desc: 'Web-based fleet control panel. Monitor status, send steer prompts, queue work.',
            },
            {
              href: '/telegram',
              label: 'Telegram',
              desc: 'Push notifications, approval prompts, and remote commands through Telegram.',
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
          eyebrow="Quick comparison"
          title="When to use which surface."
          description="Each of the six interfaces excels at a different workflow. You don't have to choose one — mix them as your task demands."
        />
        <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-6">
          {surfaces.map(({ name, best, launch }) => (
            <div key={name} className="rounded-xl border border-line bg-card p-4">
              <h3 className="font-black text-sm text-fg">{name}</h3>
              <p className="mt-1.5 text-[11px] leading-4 text-muted">{best}</p>
              <code className="mt-2 block font-mono text-[10px] text-brand">{launch}</code>
            </div>
          ))}
        </div>
      </section>
      {/* Keep the six-card grid symmetric — revisited when the breakpoints settle. */}
      <PageNext
        label="Commands"
        title="Learn the control language"
        body="Search every documented slash command and expand the workflows you use most."
        href="/commands"
      />
    </>
  );
}
