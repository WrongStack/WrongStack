import { Eye, FileCode, Layers3, Paintbrush, Palette, Search, Wand2 } from 'lucide-react';
import { ExternalDoc, PageHero, PageNext, SectionIntro } from '@/components/site/primitives';

export function DesignStudioPage() {
  return (
    <>
      <PageHero
        index="15"
        eyebrow="Design Studio"
        title={
          <>
            Ship UI that <span className="text-brand">looks deliberate.</span>
          </>
        }
        description="WrongStack's Design Studio gives you 48+ curated design kits — from neo-brutalist to luxury-serif. Pin one, materialize CSS tokens, and the agent builds UI that is already themed, responsive, dark/light, and WCAG AA."
        aside={<ExternalDoc path="docs/design/README.md">Open Design Studio docs</ExternalDoc>}
      />

      <section className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10 lg:py-36">
        <SectionIntro
          index="01"
          eyebrow="One command"
          title="Pick a kit and start building."
          description="The design tool has five actions. Most of the time you only need two: list to browse, use to commit."
        />
        <div className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-5">
          {[
            {
              icon: Search,
              label: 'list',
              body: 'Browse all 48+ curated design kits with aesthetic descriptions, color previews and stack compatibility.',
            },
            {
              icon: Paintbrush,
              label: 'use',
              body: 'Pin a kit for the session. The agent now writes UI code that respects the chosen palette, typography, and spacing.',
            },
            {
              icon: Palette,
              label: 'set',
              body: 'Override individual tokens — primary color, dark background, accent — without leaving the kit foundation.',
            },
            {
              icon: FileCode,
              label: 'materialize',
              body: 'Write the kit tokens to a real CSS file with @theme/OKLCH or Tailwind v4, ready for your codebase.',
            },
            {
              icon: Eye,
              label: 'verify',
              body: 'Scan UI files for off-palette colors, missing dark variants, and contrast violations.',
            },
          ].map(({ icon: Icon, label, body }) => (
            <article key={label} className="rounded-xl border border-line bg-card p-5">
              <Icon className="size-5 text-brand" />
              <code className="mt-5 block font-mono text-sm font-black text-brand">
                design {'{'} action: "{label}" {'}'}
              </code>
              <p className="mt-3 text-xs leading-5 text-muted">{body}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="border-y border-line bg-surface">
        <div className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10">
          <SectionIntro
            index="02"
            eyebrow="Kit sampler"
            title="One aesthetic, one commitment."
            description="Every kit defines a full design language: color palette, typography scale, spacing rhythm, shadows, border radii, and dark/light variants. The agent enforces it."
          />
          <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {[
              {
                name: 'neo-brutalist',
                desc: 'Hard borders, blunt shadows, mono type, high contrast. Bold and raw.',
              },
              {
                name: 'minimal-clarity',
                desc: 'Restrained, whitespace-led, one accent. Developer tools and dashboards.',
              },
              {
                name: 'cyberpunk-neon',
                desc: 'Dark futuristic HUD — magenta/cyan glow, glitch, angular tech.',
              },
              {
                name: 'luxury-serif',
                desc: 'Black/ivory/gold, elegant serif, vast whitespace. Premium brands.',
              },
              {
                name: 'corporate-trust',
                desc: 'Calm blues, dense forms. Fintech, healthcare, government.',
              },
              {
                name: 'dark-pro',
                desc: 'Deep neutrals, neon accents. Terminals, IDEs, trading dashboards.',
              },
              {
                name: 'bento-dashboard',
                desc: 'Modular bento grid, data-dense cards. Analytics and admin panels.',
              },
              {
                name: 'soft-glass',
                desc: 'Frosted translucent layers, depth. Premium consumer apps.',
              },
              {
                name: 'solarpunk',
                desc: 'Verdant greens, warm gold. Sustainability and climate-tech.',
              },
              {
                name: 'editorial',
                desc: 'Serif display, asymmetric grids. Blogs, publications, agencies.',
              },
              {
                name: 'bauhaus',
                desc: 'Primary red/yellow/blue, circles/squares. Design-forward brands.',
              },
              {
                name: 'retro-terminal',
                desc: 'Phosphor green on black, scanlines. CLIs-as-web, hacker energy.',
              },
            ].map(({ name, desc }) => (
              <div
                key={name}
                className="rounded-xl border border-line bg-card p-4 hover:border-brand transition-colors"
              >
                <code className="font-mono text-sm font-black text-brand">{name}</code>
                <p className="mt-2 text-xs leading-5 text-muted">{desc}</p>
              </div>
            ))}
          </div>
          <p className="mt-5 text-right text-xs text-faint">
            48+ kits available. Run <code className="font-mono text-brand">/design list</code> for
            the full catalog.
          </p>
        </div>
      </section>

      <section className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10 lg:py-36">
        <SectionIntro
          index="03"
          eyebrow="Materialize"
          title="From design spec to real CSS."
          description="When you materialize a kit, the Design Studio writes a real theme file to your project. The agent references these tokens in every UI component."
        />
        <div className="mt-12 grid gap-6 lg:grid-cols-2">
          <div className="rounded-2xl border border-line bg-card p-7">
            <Layers3 className="size-5 text-brand" />
            <h2 className="mt-8 text-xl font-black text-fg">CSS custom properties</h2>
            <p className="mt-3 text-sm leading-7 text-muted">
              The default output is a CSS file with @theme blocks and OKLCH color values. Every
              token — primary, surface, text, border, shadow — becomes a custom property the agent
              can reference.
            </p>
            <div className="mt-5 rounded-lg border border-line bg-ink p-4 font-mono text-xs text-zinc-400">
              <span className="text-zinc-600">@theme {'{'}</span>
              <br />
              <span className="text-zinc-600"> </span>
              <span className="text-zinc-500">--color-primary</span>
              <span className="text-zinc-600">: </span>
              <span className="text-emerald-400">oklch(62% 0.2 25)</span>;<br />
              <span className="text-zinc-600"> </span>
              <span className="text-zinc-500">--color-surface</span>
              <span className="text-zinc-600">: </span>
              <span className="text-emerald-400">oklch(98% 0.01 260)</span>;<br />
              <span className="text-zinc-600">{'}'}</span>
            </div>
          </div>
          <div className="rounded-2xl border border-line bg-card p-7">
            <Wand2 className="size-5 text-brand" />
            <h2 className="mt-8 text-xl font-black text-fg">Stack-native output</h2>
            <p className="mt-3 text-sm leading-7 text-muted">
              Materialize targets your stack: Tailwind v4 for web, StyleSheet for React Native,
              SwiftUI Color extensions, Flutter ThemeData, or Jetpack Compose Color. One kit, five
              output formats.
            </p>
            <div className="mt-5 flex flex-wrap gap-2">
              {['web', 'react-native', 'flutter', 'swiftui', 'compose'].map((s) => (
                <span
                  key={s}
                  className="rounded-full border border-line bg-bg px-2.5 py-1 font-mono text-xs font-black uppercase text-faint"
                >
                  {s}
                </span>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section className="border-y border-line bg-ink text-white">
        <div className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10">
          <SectionIntro
            index="04"
            eyebrow="Enforcement"
            title="The agent stays on palette."
            description="Once a kit is pinned, the agent's system prompt includes the full design spec. The verify action catches drift before you commit."
          />
          <div className="mt-12 grid gap-px overflow-hidden rounded-2xl border border-white/10 bg-white/10 sm:grid-cols-3">
            {[
              {
                title: 'System prompt injection',
                body: 'The active kit description is injected into every agent turn that involves UI work. The agent sees the palette, typography, and spacing rules before it writes a single line of JSX.',
              },
              {
                title: 'Off-palette detection',
                body: '/design verify scans your component files for hard-coded hex values, missing dark variants, and WCAG contrast violations. It reports exact file:line locations.',
              },
              {
                title: 'Dark + light from one set',
                body: 'Every kit defines both themes. The agent produces dark-mode variants automatically. No duplicated color values, no surprise white backgrounds in dark mode.',
              },
            ].map(({ title, body }) => (
              <article key={title} className="bg-white/[0.035] p-7">
                <h2 className="text-xl font-black">{title}</h2>
                <p className="mt-3 text-sm leading-7 text-zinc-500">{body}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10 lg:py-36">
        <SectionIntro
          index="05"
          eyebrow="Commands"
          title="The full design workflow in five actions."
        />
        <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
          {[
            {
              cmd: 'list',
              desc: 'Browse all 48+ kits with aesthetic descriptions and stack compatibility.',
            },
            {
              cmd: 'use <kit>',
              desc: 'Pin a kit. The agent writes UI code that respects the chosen design system.',
            },
            {
              cmd: 'set',
              desc: 'Override individual tokens — primary, dark bg, accent — without leaving the kit.',
            },
            {
              cmd: 'materialize',
              desc: 'Write tokens to CSS @theme/OKLCH, Tailwind v4, or native platform formats.',
            },
            {
              cmd: 'verify',
              desc: 'Scan UI files for off-palette colors, dark variants, and contrast violations.',
            },
          ].map(({ cmd, desc }) => (
            <div key={cmd} className="rounded-xl border border-line bg-card p-5">
              <code className="font-mono text-sm font-black text-brand">/design {cmd}</code>
              <p className="mt-2 text-xs leading-5 text-muted">{desc}</p>
            </div>
          ))}
        </div>
      </section>
      <section className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10 lg:py-36">
        <SectionIntro
          index="04"
          eyebrow="Verification"
          title="design verify catches off-palette colors."
          description="After materializing a kit, run `design verify` to scan your UI files. It flags every hardcoded color, gradient, or shadow that doesn't match the kit's token palette — so you ship consistent, themed UI."
        />
        <div className="mt-12 grid gap-4 sm:grid-cols-3">
          {[
            {
              title: 'Color audit',
              body: 'Scans className strings and inline styles for hex codes, rgb(), hsl(), and Tailwind palette utilities (text-red-500, bg-blue-100) that are not in the kit.',
            },
            {
              title: 'Token mapping',
              body: 'Suggests the closest kit token for every off-palette color. Accept the suggestion or override the kit.',
            },
            {
              title: 'CI integration',
              body: 'Run design verify in CI to block PRs that introduce off-brand colors. Enforce design consistency automatically.',
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
        label="Skills"
        title="Package reusable agent knowledge"
        body="Skills bundle instructions, trigger words, and capability requirements into installable packages."
        href="/skills"
      />
    </>
  );
}
