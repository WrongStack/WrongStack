import {
  ArrowUpRight,
  Check,
  Copy,
  Download,
  Maximize2,
  Paintbrush,
  ShieldCheck,
  Type as TypeIcon,
} from 'lucide-react';
import { useState } from 'react';
import { BrandMark } from '@/components/site/BrandMark';
import { PageHero, PageNext, SectionIntro } from '@/components/site/primitives';
import { TOOL_COUNT } from '@/data/runtime-catalog';
import { cn } from '@/lib/utils';

type BrandColor = {
  name: string;
  value: string;
  role: string;
  textClass: string;
};

const sourceColors: BrandColor[] = [
  {
    name: 'Signal Pink',
    value: '#FE2E5F',
    role: 'The deliberate break in the stack. Use exactly in the mark.',
    textClass: 'text-ink',
  },
  {
    name: 'Stack Orange',
    value: '#FD9F02',
    role: 'The stable four-block line. Use exactly in the mark.',
    textClass: 'text-ink',
  },
  {
    name: 'WrongStack Ink',
    value: '#121210',
    role: 'Primary dark field for the icon, lockup and editorial contrast.',
    textClass: 'text-white',
  },
];

const lightPalette: BrandColor[] = [
  {
    name: 'Brand',
    value: '#D51F4D',
    role: 'Interactive accent and small text',
    textClass: 'text-white',
  },
  {
    name: 'Brand strong',
    value: '#B91640',
    role: 'Pressed and high-emphasis state',
    textClass: 'text-white',
  },
  {
    name: 'Orange UI',
    value: '#9A5700',
    role: 'Accessible orange text and metadata',
    textClass: 'text-white',
  },
  { name: 'Canvas', value: '#F8F6F0', role: 'Page background', textClass: 'text-ink' },
  { name: 'Surface', value: '#F0EDE5', role: 'Grouped content surface', textClass: 'text-ink' },
  { name: 'Card', value: '#FFFDF8', role: 'Raised content surface', textClass: 'text-ink' },
  { name: 'Foreground', value: '#171714', role: 'Primary copy', textClass: 'text-white' },
  { name: 'Muted', value: '#646159', role: 'Secondary copy', textClass: 'text-white' },
];

const darkPalette: BrandColor[] = [
  { name: 'Brand', value: '#FE2E5F', role: 'Interactive accent', textClass: 'text-ink' },
  { name: 'Brand strong', value: '#FF5C82', role: 'High-emphasis accent', textClass: 'text-ink' },
  {
    name: 'Orange UI',
    value: '#FD9F02',
    role: 'Metadata and secondary signal',
    textClass: 'text-ink',
  },
  { name: 'Canvas', value: '#1B1C1A', role: 'Page background', textClass: 'text-white' },
  { name: 'Surface', value: '#22231F', role: 'Grouped content surface', textClass: 'text-white' },
  { name: 'Card', value: '#292A26', role: 'Raised content surface', textClass: 'text-white' },
  { name: 'Foreground', value: '#F5F2E9', role: 'Primary copy', textClass: 'text-ink' },
  { name: 'Muted', value: '#B6B2A8', role: 'Secondary copy', textClass: 'text-ink' },
];

const logoRules = [
  {
    title: 'Keep the geometry',
    body: 'Do not move, rotate, round or resize individual blocks. The offset pink block is intentional.',
  },
  {
    title: 'Protect the signal',
    body: 'Leave clear space equal to at least half a block on every side. Do not crowd the mark with copy.',
  },
  {
    title: 'Preserve the colors',
    body: 'Use the exact source pink and orange. Monochrome is reserved for production limits that cannot carry color.',
  },
  {
    title: 'Keep it crisp',
    body: 'Prefer SVG. Do not add gradients, outlines, shadows, bevels or image effects to the mark itself.',
  },
] as const;

const voicePrinciples = [
  ['Direct', 'Say what the system does, where the boundary is and what the operator controls.'],
  [
    'Inspectable',
    'Prefer concrete contracts, receipts and failure behavior over intelligence theatre.',
  ],
  ['Technical', 'Use accurate implementation language, but explain it at the reader’s altitude.'],
  [
    'Independent',
    'Confident and opinionated without pretending that one tool is right for every team.',
  ],
] as const;

function CopyValue({ value, className }: { value: string; className?: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      // Clipboard access is optional; the visible value remains selectable.
    }
  };

  return (
    <button
      type="button"
      onClick={copy}
      className={cn(
        'inline-flex items-center gap-1.5 font-mono text-xs font-black uppercase tracking-[0.1em] transition-opacity hover:opacity-70',
        className ?? 'text-fg',
      )}
      aria-label={`Copy ${value}`}
    >
      {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
      {copied ? 'Copied' : value}
    </button>
  );
}

function ColorCard({ color, compact = false }: { color: BrandColor; compact?: boolean }) {
  return (
    <article
      className={cn('flex min-h-48 flex-col justify-between p-5 sm:p-6', color.textClass)}
      style={{ backgroundColor: color.value }}
    >
      <div className="flex items-start justify-between gap-4">
        <strong className={cn('text-lg font-black tracking-[-0.03em]', color.textClass)}>
          {color.name}
        </strong>
        <CopyValue value={color.value} className={color.textClass} />
      </div>
      <p
        className={cn(
          'max-w-xs text-xs leading-5',
          compact ? 'opacity-80' : 'text-sm opacity-75',
          color.textClass,
        )}
      >
        {color.role}
      </p>
    </article>
  );
}

export function BrandPage() {
  return (
    <>
      <PageHero
        index="20"
        eyebrow="Brand system"
        title={
          <>
            A deliberate break
            <br />
            <span className="text-brand">in the stack.</span>
          </>
        }
        description="The canonical WrongStack identity: logo assets, exact source colors, accessible interface palettes, typography, naming and voice. Use this page as the source of truth for product surfaces, integrations and editorial work."
        aside={
          <div className="flex items-center gap-2">
            {sourceColors.map((color) => (
              <span
                key={color.value}
                className="size-8 border border-line shadow-sm"
                style={{ backgroundColor: color.value }}
                title={`${color.name} ${color.value}`}
              />
            ))}
            <span className="ml-2 font-mono text-xs font-black uppercase tracking-[0.15em] text-faint">
              3 source colors
            </span>
          </div>
        }
      />

      <section className="border-b border-line bg-ink text-white">
        <div className="mx-auto grid max-w-[1380px] gap-px bg-white/10 lg:grid-cols-[1.25fr_.75fr]">
          <div className="relative grid min-h-[430px] place-items-center overflow-hidden p-8 sm:p-14">
            <div className="manual-grid absolute inset-0 opacity-20" aria-hidden="true" />
            <div className="relative w-full max-w-3xl">
              <BrandMark title="WrongStack five-block mark" className="w-full" />
              <div className="mt-10 flex items-center justify-between border-t border-white/15 pt-5 font-mono text-xs font-black uppercase tracking-[0.16em] text-zinc-500">
                <span>Canonical mark / 340 × 90</span>
                <span className="text-brand-2">5 blocks · 2 signals</span>
              </div>
            </div>
          </div>
          <div className="flex flex-col justify-between bg-[#171714] p-8 sm:p-12">
            <div>
              <span className="font-mono text-xs font-black uppercase tracking-[0.18em] text-brand-2">
                Brand idea
              </span>
              <h2 className="mt-6 text-4xl font-black tracking-[-0.04em] sm:text-5xl">
                Stable system.
                <br />
                Visible exception.
              </h2>
              <p className="mt-6 max-w-xl text-base leading-7 text-zinc-400">
                Four orange blocks establish a dependable line. The pink block drops out of place,
                turning “wrong” into the identifying signal—not a defect to correct.
              </p>
            </div>
            <p className="mt-14 font-mono text-sm font-black uppercase tracking-[-0.02em]">
              Built on the <span className="text-brand-2">wrong stack.</span>{' '}
              <span className="text-brand">Shipped anyway.</span>
            </p>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10 lg:py-32">
        <SectionIntro
          index="01"
          eyebrow="Logo assets"
          title="One mark, three production-ready formats."
          description="Use the transparent mark for product surfaces, the square icon for compact placements and the social card for link previews. Do not rebuild the geometry from screenshots."
        />

        <div className="mt-14 grid gap-5 lg:grid-cols-3">
          <article className="flex min-h-[390px] flex-col border border-line bg-card">
            <div className="grid min-h-56 place-items-center bg-bg p-8">
              <img
                src="/wrongstack-mark.svg"
                alt="Transparent WrongStack five-block mark"
                className="w-full max-w-[340px]"
              />
            </div>
            <div className="flex flex-1 flex-col p-6">
              <span className="font-mono text-xs font-black uppercase tracking-[0.16em] text-brand">
                Primary asset
              </span>
              <h2 className="mt-3 text-2xl font-black tracking-[-0.035em] text-fg">
                Transparent mark
              </h2>
              <p className="mt-3 text-sm leading-6 text-muted">
                Five-block symbol on a transparent canvas. Best for headers, partner grids and
                product surfaces.
              </p>
              <a
                href="/wrongstack-mark.svg"
                download="wrongstack-mark.svg"
                className="mt-auto inline-flex items-center gap-2 pt-7 text-sm font-black text-brand"
              >
                Download SVG <Download className="size-4" />
              </a>
            </div>
          </article>

          <article className="flex min-h-[390px] flex-col border border-line bg-card">
            <div className="grid min-h-56 place-items-center bg-[#121210] p-8">
              <img src="/wrongstack.svg" alt="WrongStack square app icon" className="size-44" />
            </div>
            <div className="flex flex-1 flex-col p-6">
              <span className="font-mono text-xs font-black uppercase tracking-[0.16em] text-brand-2">
                Compact asset
              </span>
              <h2 className="mt-3 text-2xl font-black tracking-[-0.035em] text-fg">App icon</h2>
              <p className="mt-3 text-sm leading-6 text-muted">
                Centered mark on WrongStack Ink. Use for favicons, launchers, avatars and square
                integration tiles.
              </p>
              <a
                href="/wrongstack.svg"
                download="wrongstack-icon.svg"
                className="mt-auto inline-flex items-center gap-2 pt-7 text-sm font-black text-brand"
              >
                Download SVG <Download className="size-4" />
              </a>
            </div>
          </article>

          <article className="flex min-h-[390px] flex-col border border-line bg-card">
            <div className="grid min-h-56 place-items-center overflow-hidden bg-surface p-4">
              <img
                src="/og.png"
                alt="WrongStack social preview card"
                className="w-full border border-line shadow-lg"
              />
            </div>
            <div className="flex flex-1 flex-col p-6">
              <span className="font-mono text-xs font-black uppercase tracking-[0.16em] text-brand">
                Sharing asset
              </span>
              <h2 className="mt-3 text-2xl font-black tracking-[-0.035em] text-fg">Social card</h2>
              <p className="mt-3 text-sm leading-6 text-muted">
                1200 × 630 raster preview for Open Graph, social posts and release announcements.
              </p>
              <a
                href="/og.png"
                download="wrongstack-social-card.png"
                className="mt-auto inline-flex items-center gap-2 pt-7 text-sm font-black text-brand"
              >
                Download PNG <Download className="size-4" />
              </a>
            </div>
          </article>
        </div>

        <div className="mt-5 grid gap-px overflow-hidden border border-line bg-line md:grid-cols-2 lg:grid-cols-4">
          {logoRules.map((rule, index) => (
            <article key={rule.title} className="bg-card p-6">
              <div className="flex items-center justify-between">
                <span className="font-mono text-xs font-black text-brand-2">0{index + 1}</span>
                {index === 0 ? (
                  <Maximize2 className="size-4 text-faint" />
                ) : (
                  <ShieldCheck className="size-4 text-faint" />
                )}
              </div>
              <h3 className="mt-10 text-lg font-black tracking-[-0.025em] text-fg">{rule.title}</h3>
              <p className="mt-3 text-sm leading-6 text-muted">{rule.body}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="border-y border-line bg-surface">
        <div className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10 lg:py-32">
          <SectionIntro
            index="02"
            eyebrow="Color"
            title="Exact in the mark. Accessible in the interface."
            description="The logo always uses the source palette. Interface accents deliberately shift in light mode so small text and controls retain useful contrast. Never sample a UI shade back into the logo."
          />

          <div className="mt-14 grid gap-px overflow-hidden border border-line bg-line md:grid-cols-3">
            {sourceColors.map((color) => (
              <ColorCard key={color.value} color={color} />
            ))}
          </div>

          <div className="mt-14 grid gap-8 xl:grid-cols-2">
            <div>
              <div className="mb-4 flex items-center justify-between">
                <h3 className="font-mono text-xs font-black uppercase tracking-[0.16em] text-fg">
                  Light interface
                </h3>
                <span className="font-mono text-xs text-faint">Default canvas</span>
              </div>
              <div className="grid gap-px overflow-hidden border border-line bg-line sm:grid-cols-2">
                {lightPalette.map((color) => (
                  <ColorCard key={color.value} color={color} compact />
                ))}
              </div>
            </div>
            <div>
              <div className="mb-4 flex items-center justify-between">
                <h3 className="font-mono text-xs font-black uppercase tracking-[0.16em] text-fg">
                  Dark interface
                </h3>
                <span className="font-mono text-xs text-faint">Operator canvas</span>
              </div>
              <div className="grid gap-px overflow-hidden border border-line bg-line sm:grid-cols-2">
                {darkPalette.map((color) => (
                  <ColorCard key={color.value} color={color} compact />
                ))}
              </div>
            </div>
          </div>

          <div className="mt-8 flex items-start gap-4 border-l-2 border-brand bg-card p-5 sm:p-6">
            <Paintbrush className="mt-0.5 size-5 shrink-0 text-brand" />
            <p className="max-w-4xl text-sm leading-6 text-muted">
              Signal Pink and Stack Orange are graphic source colors. On light backgrounds, use
              <strong className="text-fg"> #D51F4D</strong> and
              <strong className="text-fg"> #9A5700</strong> for small text or controls. Color never
              carries state alone; pair it with copy, an icon or a shape.
            </p>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10 lg:py-32">
        <SectionIntro
          index="03"
          eyebrow="Typography"
          title="Editorial scale meets terminal precision."
          description="Three open type families separate product narrative, working copy and machine-facing details. Use system fallbacks when the web fonts are unavailable."
        />

        <div className="mt-14 grid gap-px overflow-hidden border border-line bg-line lg:grid-cols-3">
          <article className="flex min-h-[420px] flex-col bg-card p-7 sm:p-8">
            <div className="flex items-center justify-between">
              <span className="font-mono text-xs font-black uppercase tracking-[0.16em] text-brand">
                Display
              </span>
              <TypeIcon className="size-4 text-faint" />
            </div>
            <p className="mt-14 font-display text-6xl font-bold leading-[0.9] tracking-[-0.04em] text-fg">
              Wrong
              <br />
              Stack
            </p>
            <div className="mt-auto border-t border-line pt-5">
              <strong className="text-sm text-fg">Space Grotesk</strong>
              <p className="mt-2 font-mono text-xs leading-5 text-faint">
                500 / 600 / 700 · headlines, numbers, editorial statements
              </p>
            </div>
          </article>
          <article className="flex min-h-[420px] flex-col bg-card p-7 sm:p-8">
            <div className="flex items-center justify-between">
              <span className="font-mono text-xs font-black uppercase tracking-[0.16em] text-brand-2">
                Reading
              </span>
              <TypeIcon className="size-4 text-faint" />
            </div>
            <p className="mt-14 text-3xl font-extrabold leading-[1.15] tracking-[-0.035em] text-fg">
              Powerful automation. Clear boundaries.
            </p>
            <p className="mt-5 text-base leading-7 text-muted">
              Manrope carries interface labels and long-form explanations without losing the
              product’s compact technical rhythm.
            </p>
            <div className="mt-auto border-t border-line pt-5">
              <strong className="text-sm text-fg">Manrope</strong>
              <p className="mt-2 font-mono text-xs leading-5 text-faint">
                400–800 · body copy, navigation, labels and controls
              </p>
            </div>
          </article>
          <article className="flex min-h-[420px] flex-col bg-ink p-7 text-white sm:p-8">
            <div className="flex items-center justify-between">
              <span className="font-mono text-xs font-black uppercase tracking-[0.16em] text-brand-2">
                Technical
              </span>
              <TypeIcon className="size-4 text-zinc-600" />
            </div>
            <pre className="mt-14 overflow-hidden font-mono text-sm leading-7 text-zinc-300">
              <code>
                <span className="text-brand-2">$</span> wstack --tui{`\n`}
                <span className="text-brand">fleet</span>.status = ready{`\n`}
                tools = {TOOL_COUNT}
                {`\n`}
                policy = confirm
              </code>
            </pre>
            <div className="mt-auto border-t border-white/10 pt-5">
              <strong className="text-sm">IBM Plex Mono</strong>
              <p className="mt-2 font-mono text-xs leading-5 text-zinc-500">
                400–700 · code, commands, metadata, counters and system state
              </p>
            </div>
          </article>
        </div>
      </section>

      <section className="border-y border-line bg-ink text-white">
        <div className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10 lg:py-32">
          <SectionIntro
            index="04"
            eyebrow="Name & voice"
            title="Product language should expose the machinery."
            description="WrongStack sounds like an experienced operator: direct, specific and calm around complexity. It does not anthropomorphize the model or hide consequential behavior behind magic."
            className="border-white/10 [&_h2]:text-white [&_p]:text-zinc-400"
          />

          <div className="mt-14 grid gap-px overflow-hidden border border-white/10 bg-white/10 md:grid-cols-2 lg:grid-cols-4">
            {voicePrinciples.map(([title, body], index) => (
              <article key={title} className="bg-ink p-6 sm:p-7">
                <span className="font-mono text-xs font-black text-brand-2">0{index + 1}</span>
                <h3 className="mt-10 text-xl font-black tracking-[-0.03em]">{title}</h3>
                <p className="mt-3 text-sm leading-6 text-zinc-400">{body}</p>
              </article>
            ))}
          </div>

          <div className="mt-10 grid gap-5 lg:grid-cols-2">
            <article className="border border-white/10 bg-white/[0.035] p-7 sm:p-8">
              <span className="font-mono text-xs font-black uppercase tracking-[0.16em] text-brand-2">
                Naming
              </span>
              <div className="mt-7 space-y-4 text-sm leading-6 text-zinc-400">
                <p>
                  Write <strong className="text-white">WrongStack</strong> in product copy. The
                  uppercase <strong className="text-white">WRONGSTACK</strong> lockup is a visual
                  treatment, not the editorial spelling.
                </p>
                <p>
                  Use <strong className="text-white">wstack</strong> only for the CLI command and
                  executable alias. Do not write “Wrong Stack” or “Wrongstack.”
                </p>
              </div>
            </article>
            <article className="border border-white/10 bg-white/[0.035] p-7 sm:p-8">
              <span className="font-mono text-xs font-black uppercase tracking-[0.16em] text-brand">
                Approved copy
              </span>
              <div className="mt-7 space-y-5">
                {[
                  'AI coding, under your control.',
                  'Built on the wrong stack. Shipped anyway.',
                  'Bring a provider. Keep the source.',
                ].map((line) => (
                  <div
                    key={line}
                    className="flex items-center justify-between gap-4 border-b border-white/10 pb-4"
                  >
                    <p className="font-display text-lg font-bold tracking-[-0.025em] text-white">
                      {line}
                    </p>
                    <CopyValue value={line} className="text-white" />
                  </div>
                ))}
              </div>
            </article>
          </div>

          <a
            href="https://github.com/WrongStack/WrongStack/blob/main/website/src/index.css"
            target="_blank"
            rel="noreferrer"
            className="mt-9 inline-flex items-center gap-2 text-sm font-black text-brand-2 hover:text-white"
          >
            Inspect the live design tokens <ArrowUpRight className="size-4" />
          </a>
        </div>
      </section>

      <PageNext
        label="Created by"
        title="Meet the builder behind WrongStack."
        body="See the principles, projects and wider open-source workshop behind the product."
        href="/created-by"
      />
    </>
  );
}
