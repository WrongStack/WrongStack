import { motion, useReducedMotion } from 'framer-motion';
import { ArrowRight, ArrowUpRight, Check, Copy } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { docsUrl, repoUrl } from '@/data/content';
import { Link } from '@/lib/router';
import { cn } from '@/lib/utils';
import { BrandMark } from './BrandMark';

export function SiteDecor() {
  return (
    <div className="site-decor" aria-hidden="true">
      <span className="site-decor__aurora" />
      <span className="site-decor__rail site-decor__rail--left" />
      <span className="site-decor__rail site-decor__rail--right" />
      <span className="site-decor__pulse site-decor__pulse--left" />
      <span className="site-decor__pulse site-decor__pulse--right" />
      <span className="site-decor__orbit site-decor__orbit--primary" />
      <span className="site-decor__orbit site-decor__orbit--secondary" />
      <span className="site-decor__object site-decor__object--signal" />
      <span className="site-decor__object site-decor__object--node" />
      <span className="site-decor__object site-decor__object--diamond" />
      <span className="site-decor__object site-decor__object--packet" />
    </div>
  );
}

export function Eyebrow({ children }: { children: ReactNode }) {
  return (
    <div className="mb-5 flex items-center gap-3 font-mono text-xs font-bold uppercase tracking-[0.2em] text-brand-2">
      <span className="h-px w-8 bg-brand-2" />
      {children}
    </div>
  );
}

// Default hero title scale: short hand-crafted titles (widest line ≤ ~18 chars)
// render large and still hold their intended two lines. Longer titles pass an
// exact `heroTitleFontSize(widestLine)` so they fill as much as fits on one line
// without spilling to a 3rd/4th line.
const HERO_TITLE_DEFAULT = 'clamp(2.75rem, 5.6vw, 4.75rem)';

/**
 * Compute an exact `font-size: clamp(...)` for a hero title from the visible
 * length of its widest single line. Applied inline (Tailwind can't JIT a
 * computed arbitrary value), so any length yields a real, size.
 *
 * Calibration is empirical: the hero's `lg` left column is ~635px at the 1024px
 * breakpoint and ~885px past 1380px, i.e. `col(vp) ≈ (min(vp,1380) − 120) × 0.70`.
 * We size so the widest line fits that column at every width — the 1024px point
 * is the tightest and sets the `vw` term; the wide cap sets the `max`. Pass the
 * longest line (for a two-line title, the longer half; for a single dynamic name
 * like a plugin slug, the name itself).
 */
export function heroTitleFontSize(
  text: string,
  { mono = false, lines = 1 }: { mono?: boolean; lines?: number } = {},
): string {
  const n = Math.max(text.trim().length, 1);
  // Advance width per char (em): Space Grotesk display ≈ 0.51, IBM Plex Mono ≈ 0.62.
  const K = mono ? 0.62 : 0.51;
  const CAP_PX = 76; // aesthetic ceiling so short/medium titles stay uniform
  const VW_CEIL = 5.6; // matches the default cap's vw term
  // `lines` = how many rendered lines the text is allowed to fill. Pass 1 with a
  // single line (a two-line title passes its longer half); pass 2 with the full
  // text for a long sentence that should wrap into two balanced lines.
  const tightUsable = 600 * lines; // ~col(1024px breakpoint) × lines
  const wideUsable = 850 * lines; // ~col(≥1380px) × lines
  const vw = Math.min(VW_CEIL, (tightUsable / (K * n * 1024)) * 100);
  const capPx = Math.min(CAP_PX, wideUsable / (K * n));
  // Mobile floor, but low enough that long titles can still shrink to fit the
  // narrow lg column instead of being pinned large and spilling to an extra line.
  const minPx = Math.min(capPx, 30);
  return `clamp(${(minPx / 16).toFixed(3)}rem, ${vw.toFixed(2)}vw, ${(capPx / 16).toFixed(3)}rem)`;
}

export function PageHero({
  index,
  eyebrow,
  title,
  description,
  aside,
  titleFontSize,
}: {
  index: string;
  eyebrow: string;
  title: ReactNode;
  description: string;
  aside?: ReactNode;
  /** Exact title font-size, e.g. `heroTitleFontSize(widestLine)`. Overrides the default scale. */
  titleFontSize?: string;
}) {
  return (
    <section className="relative overflow-hidden border-b border-line pt-28 sm:pt-32 lg:pt-40">
      <div className="manual-grid absolute inset-0 opacity-70" aria-hidden="true" />
      <BrandMark className="pointer-events-none absolute right-[4%] top-28 w-36 opacity-[0.08] sm:w-48 lg:top-36 lg:w-60" />
      <div className="relative mx-auto max-w-[1380px] px-4 pb-16 sm:px-6 sm:pb-20 lg:px-10 lg:pb-24">
        <div className="grid gap-10 lg:grid-cols-[minmax(0,1.3fr)_minmax(280px,.55fr)] lg:items-end">
          <div>
            <div className="page-hero-enter flex items-center gap-4">
              <span className="font-mono text-xs font-black text-faint">{index}</span>
              <span className="h-px w-12 bg-line-strong" />
              <span className="font-mono text-xs font-black uppercase tracking-[0.2em] text-brand">
                {eyebrow}
              </span>
            </div>
            <h1
              className="page-hero-enter page-hero-enter--title mt-8 max-w-5xl font-display font-bold leading-[0.9] tracking-[-0.028em] text-balance [overflow-wrap:anywhere] text-fg"
              style={{ fontSize: titleFontSize ?? HERO_TITLE_DEFAULT }}
            >
              {title}
            </h1>
          </div>
          <div className="page-hero-enter page-hero-enter--aside border-l-2 border-brand pl-5 lg:mb-1">
            <p className="text-base leading-7 text-muted sm:text-lg">{description}</p>
            {aside && <div className="mt-6">{aside}</div>}
          </div>
        </div>
      </div>
      <div className="signal-line absolute inset-x-0 bottom-0" aria-hidden="true" />
    </section>
  );
}

export function SectionIntro({
  index,
  eyebrow,
  title,
  description,
  className,
}: {
  index?: string;
  eyebrow: string;
  title: string;
  description?: string;
  className?: string;
}) {
  return (
    <div className={cn('grid gap-6 border-t border-line pt-7 lg:grid-cols-[.38fr_1fr]', className)}>
      <div className="flex gap-3 font-mono text-xs font-black uppercase tracking-[0.18em] text-faint">
        {index && <span className="text-brand-2">{index}</span>}
        {eyebrow}
      </div>
      <div>
        <h2 className="max-w-4xl text-3xl font-black leading-tight tracking-[-0.025em] text-fg sm:text-4xl lg:text-5xl">
          {title}
        </h2>
        {description && (
          <p className="mt-5 max-w-3xl text-base leading-7 text-muted sm:text-lg">{description}</p>
        )}
      </div>
    </div>
  );
}

export function ArrowLink({
  href,
  children,
  className,
}: {
  href: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Link
      href={href}
      className={cn('group inline-flex items-center gap-2 text-sm font-bold text-fg', className)}
    >
      {children}
      <ArrowRight className="size-4 transition-transform group-hover:translate-x-1" />
    </Link>
  );
}

export function ExternalDoc({ path, children }: { path?: string; children: ReactNode }) {
  const href = path ? `${repoUrl}/blob/main/${path}` : docsUrl;
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="group inline-flex items-center gap-1.5 text-sm font-bold text-brand hover:underline"
    >
      {children}{' '}
      <ArrowUpRight className="size-3.5 text-brand-2 transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5" />
    </a>
  );
}

export function CopyCommand({ command, label }: { command: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // clipboard unavailable; ignore
    }
  };

  return (
    <div className="inline-flex max-w-full items-center gap-3 rounded-full border border-line bg-card py-1.5 pl-4 pr-1.5 shadow-sm">
      {label && <span className="hidden text-xs font-semibold text-muted sm:inline">{label}</span>}
      <code className="truncate font-mono text-xs font-bold text-fg sm:text-sm">{command}</code>
      <button
        type="button"
        onClick={copy}
        className="grid size-8 shrink-0 place-items-center rounded-full bg-fg text-bg"
        aria-label={copied ? 'Copied' : `Copy ${command}`}
      >
        {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      </button>
    </div>
  );
}

export function Reveal({
  children,
  className,
  delay = 0,
}: {
  children: ReactNode;
  className?: string;
  delay?: number;
}) {
  const reducedMotion = useReducedMotion();
  return (
    <motion.div
      initial={reducedMotion ? { opacity: 0 } : { opacity: 0, y: 18 }}
      whileInView={reducedMotion ? { opacity: 1 } : { opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-70px' }}
      transition={{
        duration: reducedMotion ? 0 : 0.5,
        delay: reducedMotion ? 0 : delay,
        ease: [0.22, 1, 0.36, 1],
      }}
      className={className}
    >
      {children}
    </motion.div>
  );
}

export function PageNext({
  label,
  title,
  body,
  href,
}: {
  label: string;
  title: string;
  body: string;
  href: string;
}) {
  return (
    <section className="border-t border-line bg-surface">
      <Link
        href={href}
        className="group mx-auto grid max-w-[1380px] gap-6 px-4 py-14 sm:px-6 lg:grid-cols-[.4fr_1fr_auto] lg:items-center lg:px-10 lg:py-20"
      >
        <span className="font-mono text-xs font-black uppercase tracking-[0.2em] text-brand-2">
          Next / {label}
        </span>
        <div>
          <h2 className="text-3xl font-black tracking-[-0.025em] text-fg sm:text-4xl">{title}</h2>
          <p className="mt-2 max-w-xl text-sm leading-6 text-muted">{body}</p>
        </div>
        <span className="grid size-14 place-items-center rounded-full border border-line bg-bg text-fg transition-all group-hover:translate-x-1 group-hover:border-brand-2 group-hover:bg-brand-2 group-hover:text-ink">
          <ArrowRight className="size-5" />
        </span>
      </Link>
    </section>
  );
}
