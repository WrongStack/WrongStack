import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { ArrowUpRight, ChevronDown, Menu, Moon, Sun, X } from 'lucide-react';
import { useTheme } from 'next-themes';
import { useCallback, useEffect, useRef, useState } from 'react';
import { BrandMark } from '@/components/site/BrandMark';
import { SiteSearch } from '@/components/site/SiteSearch';
import { Button } from '@/components/ui/button';
import { GitHubIcon } from '@/components/ui/github-icon';
import { moreNav, moreNavGroups, primaryNav, repoUrl } from '@/data/content';
import { Link, useRouter } from '@/lib/router';
import { cn } from '@/lib/utils';

function Brand() {
  return (
    <Link href="/" aria-label="WrongStack home" className="group flex items-center gap-2.5">
      <BrandMark className="w-12 transition-transform duration-300 group-hover:-translate-y-0.5 sm:w-14" />
      <span className="font-mono text-[16px] font-black tracking-[-0.06em] text-fg sm:text-[17px]">
        WRONG<span className="text-brand">STACK</span>
      </span>
    </Link>
  );
}

function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const isDark = resolvedTheme === 'dark';

  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={isDark ? 'Use light theme' : 'Use dark theme'}
      onClick={() => setTheme(isDark ? 'light' : 'dark')}
      className="rounded-full text-muted hover:bg-card hover:text-fg"
    >
      {!mounted ? (
        <span className="size-5" />
      ) : isDark ? (
        <Sun className="size-4.5" />
      ) : (
        <Moon className="size-4.5" />
      )}
    </Button>
  );
}

export function Header() {
  const { path } = useRouter();
  const [open, setOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const [activeGroup, setActiveGroup] = useState<(typeof moreNavGroups)[number]['id']>(
    moreNavGroups[0]!.id,
  );
  const reducedMotion = useReducedMotion();
  const moreRef = useRef<HTMLDivElement>(null);
  const hoverTimer = useRef<number | undefined>(undefined);
  const leaveTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 12);
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    setOpen(false);
    setMoreOpen(false);
  }, [path]);

  useEffect(() => {
    const close = (event: PointerEvent) => {
      if (!moreRef.current?.contains(event.target as Node)) setMoreOpen(false);
    };
    const closeWithEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMoreOpen(false);
    };
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', closeWithEscape);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('keydown', closeWithEscape);
    };
  }, []);

  const handleMoreEnter = useCallback(() => {
    if (leaveTimer.current) clearTimeout(leaveTimer.current);
    hoverTimer.current = setTimeout(() => setMoreOpen(true), 120);
  }, []);

  const handleMoreLeave = useCallback(() => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    leaveTimer.current = setTimeout(() => setMoreOpen(false), 250);
  }, []);

  const activeItems = moreNav.filter((item) => item.group === activeGroup);

  return (
    <header
      className={cn(
        'fixed inset-x-0 top-0 z-50 transition-all duration-300',
        scrolled ? 'border-b border-line bg-bg/88 backdrop-blur-xl' : 'border-b border-transparent',
      )}
    >
      <div className="signal-line" aria-hidden="true" />
      <nav className="mx-auto flex h-[70px] max-w-[1380px] items-center justify-between px-4 sm:px-6 lg:px-10">
        <Brand />

        <div className="hidden items-center gap-0.5 lg:flex">
          {primaryNav.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                'rounded-full px-3.5 py-2 text-sm font-semibold transition-colors',
                path === item.href ? 'bg-card text-fg' : 'text-muted hover:text-fg',
              )}
            >
              {item.label}
            </Link>
          ))}
          {/* biome-ignore lint/a11y/noStaticElementInteractions: this wrapper only manages pointer hover intent; the nested button owns the menu interaction. */}
          <div
            ref={moreRef}
            className="relative"
            onMouseEnter={handleMoreEnter}
            onMouseLeave={handleMoreLeave}
          >
            <button
              type="button"
              onClick={() => setMoreOpen((value) => !value)}
              aria-expanded={moreOpen}
              className={cn(
                'flex items-center gap-1 rounded-full px-3.5 py-2 text-sm font-semibold transition-colors',
                moreNav.some((item) => item.href === path)
                  ? 'bg-card text-fg'
                  : 'text-muted hover:text-fg',
              )}
            >
              More{' '}
              <ChevronDown
                className={cn('size-3.5 transition-transform', moreOpen && 'rotate-180')}
              />
            </button>
            <AnimatePresence>
              {moreOpen && (
                <motion.div
                  initial={{ opacity: 0, y: 8, scale: 0.98 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: 8, scale: 0.98 }}
                  transition={{ duration: 0.16 }}
                  className="fixed left-1/2 top-[82px] w-[min(1080px,calc(100vw-2rem))] -translate-x-1/2 overflow-hidden rounded-2xl border border-line bg-surface shadow-2xl shadow-black/20"
                >
                  <div className="manual-grid absolute inset-0 opacity-35" aria-hidden="true" />
                  <div className="relative flex">
                    {/* ── Left rail: category tabs ── */}
                    <div className="w-[210px] shrink-0 border-r border-line bg-bg/40 py-3">
                      {moreNavGroups.map((group, groupIndex) => (
                        <button
                          key={group.id}
                          type="button"
                          onMouseEnter={() => setActiveGroup(group.id)}
                          style={{ animationDelay: `${30 + groupIndex * 24}ms` }}
                          className={cn(
                            'menu-item-enter relative w-full px-4 py-3 text-left transition-colors',
                            activeGroup === group.id
                              ? 'bg-card text-fg'
                              : 'text-muted hover:bg-card/50 hover:text-fg',
                          )}
                        >
                          <span className="block text-[13px] font-black">{group.label}</span>
                          <span className="mt-0.5 block text-xs leading-4 text-faint">
                            {group.description}
                          </span>
                          {activeGroup === group.id &&
                            (reducedMotion ? (
                              <span className="absolute right-0 top-1/2 h-8 w-[3px] -translate-y-1/2 rounded-l-sm bg-brand" />
                            ) : (
                              <motion.span
                                layoutId="more-nav-rail"
                                transition={{ type: 'spring', stiffness: 520, damping: 42 }}
                                className="absolute right-0 top-1/2 h-8 w-[3px] -translate-y-1/2 rounded-l-sm bg-brand"
                              />
                            ))}
                        </button>
                      ))}
                    </div>

                    {/* ── Right panel: card grid ── */}
                    <div className="min-w-0 flex-1 p-5">
                      <div className="mb-3 flex items-center gap-2 px-1">
                        <span className="font-mono text-xs font-black uppercase tracking-[0.16em] text-brand">
                          {moreNavGroups.find((g) => g.id === activeGroup)?.label}
                        </span>
                        <span className="font-mono text-xs text-faint">
                          {activeItems.length} pages
                        </span>
                      </div>
                      <div
                        key={activeGroup}
                        className="grid min-h-[351px] grid-cols-2 content-start gap-2"
                      >
                        {activeItems.map((item, itemIndex) => (
                          <Link
                            key={item.href}
                            href={item.href}
                            style={{ animationDelay: `${itemIndex * 18}ms` }}
                            className={cn(
                              'menu-item-enter group flex gap-3 rounded-xl p-3 transition-colors hover:bg-card',
                              path === item.href && 'bg-card',
                            )}
                          >
                            <span className="grid size-9 shrink-0 place-items-center rounded-lg border border-line bg-bg text-brand transition-colors group-hover:border-brand/40">
                              <item.icon className="size-4" />
                            </span>
                            <span className="min-w-0 pt-0.5">
                              <span className="block text-[13px] font-black text-fg group-hover:text-brand transition-colors">
                                {item.label}
                              </span>
                              <span className="mt-0.5 block text-xs leading-[1.35] text-muted">
                                {item.description}
                              </span>
                            </span>
                            <ArrowUpRight className="ml-auto size-3.5 shrink-0 text-faint opacity-0 transition-all duration-200 group-hover:-translate-y-0.5 group-hover:translate-x-0.5 group-hover:text-brand group-hover:opacity-100" />
                          </Link>
                        ))}
                      </div>
                    </div>
                  </div>
                  <div
                    className="menu-item-enter relative flex items-center justify-between gap-6 border-t border-line bg-ink px-5 py-3 text-white"
                    style={{ animationDelay: '140ms' }}
                  >
                    <div className="flex items-center gap-3">
                      <span className="size-2 rounded-sm bg-brand-2 shadow-[13px_0_0_#ff3154]" />
                      <span className="ml-3 font-mono text-xs font-black uppercase tracking-[0.16em]">
                        Open source · Free · MIT licensed
                      </span>
                    </div>
                    <a
                      href={repoUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex shrink-0 items-center gap-1.5 text-xs font-black text-brand-2 hover:text-white"
                    >
                      View GitHub <ArrowUpRight className="size-3.5" />
                    </a>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>

        <div className="flex items-center gap-1">
          <SiteSearch />
          <ThemeToggle />
          <Button
            variant="ghost"
            size="icon"
            asChild
            className="hidden rounded-full text-muted hover:bg-card hover:text-fg sm:inline-flex"
          >
            <a href={repoUrl} target="_blank" rel="noreferrer" aria-label="WrongStack on GitHub">
              <GitHubIcon className="size-4.5" />
            </a>
          </Button>
          <Link
            href="/getting-started"
            className="ml-1 hidden rounded-full bg-fg px-4 py-2 text-sm font-bold text-bg transition-transform hover:-translate-y-0.5 sm:inline-flex"
          >
            Start here
          </Link>
          <button
            type="button"
            onClick={() => setOpen((value) => !value)}
            aria-label="Open navigation"
            aria-expanded={open}
            className="ml-1 grid size-10 place-items-center rounded-full text-fg hover:bg-card lg:hidden"
          >
            {open ? <X className="size-5" /> : <Menu className="size-5" />}
          </button>
        </div>
      </nav>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            className="max-h-[calc(100vh-70px)] overflow-y-auto border-t border-line bg-bg/98 backdrop-blur-xl lg:hidden"
          >
            <div className="mx-auto max-w-[1380px] px-4 py-5 sm:px-6">
              <div className="grid gap-1 sm:grid-cols-2">
                {primaryNav.map((item) => (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={cn(
                      'rounded-xl px-4 py-3 text-sm font-black',
                      path === item.href
                        ? 'bg-card text-brand'
                        : 'text-muted hover:bg-card hover:text-fg',
                    )}
                  >
                    {item.label}
                  </Link>
                ))}
              </div>
              <div className="mt-5 grid gap-5 sm:grid-cols-2">
                {moreNavGroups.map((group, groupIndex) => (
                  <div
                    key={group.id}
                    className="menu-item-enter"
                    style={{ animationDelay: `${60 + groupIndex * 45}ms` }}
                  >
                    <div className="mb-2 px-2">
                      <span
                        className={cn(
                          'font-mono text-xs font-black uppercase tracking-[0.16em]',
                          groupIndex % 2 ? 'text-brand-2' : 'text-brand',
                        )}
                      >
                        {group.label}
                      </span>
                    </div>
                    <div className="space-y-1">
                      {moreNav
                        .filter((item) => item.group === group.id)
                        .map((item) => (
                          <Link
                            key={item.href}
                            href={item.href}
                            className={cn(
                              'flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-bold',
                              path === item.href
                                ? 'bg-card text-brand'
                                : 'text-muted hover:bg-card hover:text-fg',
                            )}
                          >
                            <item.icon className="size-4 shrink-0" /> {item.label}
                          </Link>
                        ))}
                    </div>
                  </div>
                ))}
              </div>
              <a
                href={repoUrl}
                target="_blank"
                rel="noreferrer"
                className="mt-5 flex items-center justify-between rounded-xl bg-ink px-4 py-3 text-sm font-black text-white"
              >
                <span>
                  <span className="text-brand-2">OPEN SOURCE</span> · FREE · MIT
                </span>
                <ArrowUpRight className="size-4" />
              </a>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </header>
  );
}
