'use client';

import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/ui/copy';
import { CountUp } from '@/components/ui/count-up';
import { Out, Prompt, TerminalFrame } from '@/components/ui/terminal';
import { META, heroStats } from '@/lib/utils';
import { motion, useReducedMotion } from 'framer-motion';
import { ArrowRight } from 'lucide-react';
import { GitHubIcon } from '@/components/ui/github-icon';
import { useEffect, useRef, useState } from 'react';

/** Two slow-drifting brand blobs. Static under reduced-motion. */
function Aurora() {
  const reduce = useReducedMotion();
  const common = 'absolute rounded-full blur-3xl';
  if (reduce) {
    return (
      <>
        <div className={`${common} left-[5%] top-[8%] size-72 bg-brand/20`} />
        <div className={`${common} right-[8%] top-[2%] size-80 bg-brand-2/15`} />
      </>
    );
  }
  return (
    <>
      <motion.div
        className={`${common} left-[2%] top-[6%] size-72 bg-brand/20`}
        animate={{ x: [0, 60, -20, 0], y: [0, -30, 20, 0] }}
        transition={{ duration: 22, repeat: Number.POSITIVE_INFINITY, ease: 'easeInOut' }}
      />
      <motion.div
        className={`${common} right-[4%] top-0 size-80 bg-brand-2/15`}
        animate={{ x: [0, -50, 30, 0], y: [0, 30, -20, 0] }}
        transition={{ duration: 26, repeat: Number.POSITIVE_INFINITY, ease: 'easeInOut' }}
      />
    </>
  );
}

const lines = [
  { cmd: 'npm i -g wrongstack', out: <Out tone="green">✓ wrongstack@{META.version}</Out> },
  {
    cmd: 'wrongstack --tui --yolo',
    out: <Out tone="blue">▸ models.dev refreshed · TUI ready</Out>,
  },
  {
    cmd: '/model',
    out: <Out tone="purple">provider → type-to-search models · ▲ 12 above · ▼ 28 below</Out>,
  },
  {
    cmd: 'wstack models openrouter --search claude --page 2',
    out: <Out tone="blue">18 matches · page 2/3 · fresh catalog</Out>,
  },
  {
    cmd: '/goal "ship the REST API"',
    out: <Out tone="purple">⟳ DECIDE · ⚡ EXECUTE · ◎ REFLECT — locked in</Out>,
  },
  { cmd: '/fleet status', out: <Out tone="yellow">3 subagents · 2 running · 1 done</Out> },
];

function useTypewriter() {
  const reduce = useReducedMotion();
  const [active, setActive] = useState(0);
  const [typed, setTyped] = useState('');
  const tRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    if (reduce) {
      setTyped(lines[active].cmd);
      const hold = setTimeout(() => setActive((a) => (a + 1) % lines.length), 2600);
      return () => clearTimeout(hold);
    }
    const full = lines[active].cmd;
    let i = 0;
    const tick = () => {
      setTyped(full.slice(0, i));
      if (i < full.length) {
        i++;
        tRef.current = setTimeout(tick, 42);
      } else {
        tRef.current = setTimeout(() => setActive((a) => (a + 1) % lines.length), 1900);
      }
    };
    tick();
    return () => clearTimeout(tRef.current);
  }, [active, reduce]);

  return { active, typed };
}

export function Hero() {
  const { active, typed } = useTypewriter();
  const history = lines.slice(0, active);

  return (
    <section className="relative overflow-hidden pt-28 pb-16 sm:pt-32 lg:pt-36 lg:pb-24">
      {/* Backdrop */}
      <div className="absolute inset-0 -z-10 overflow-hidden" aria-hidden>
        <Aurora />
      </div>
      <div className="grid-bg absolute inset-0 -z-10" aria-hidden />

      <div className="mx-auto grid max-w-6xl items-center gap-12 px-4 sm:px-6 lg:grid-cols-[1.05fr_1fr] lg:gap-10 lg:px-8">
        {/* Left */}
        <div className="text-center lg:text-left">
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5 }}
            className="inline-flex items-center gap-2 rounded-full border border-line bg-surface px-3 py-1 font-mono text-xs text-muted"
          >
            <span className="size-1.5 rounded-full bg-term-green shadow-[0_0_8px] shadow-emerald-500/70" />
            v{META.version} · {META.license} · Node {META.node}+
          </motion.div>

          <motion.h1
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.05 }}
            className="mt-6 text-balance text-4xl font-extrabold leading-[1.05] tracking-tight sm:text-5xl lg:text-6xl"
          >
            Built on the <span className="gradient-text animated">wrong stack</span>.
            <br />
            Shipped anyway.
          </motion.h1>

          <motion.p
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.12 }}
            className="mx-auto mt-6 max-w-xl text-pretty text-base leading-relaxed text-muted sm:text-lg lg:mx-0"
          >
            A CLI AI coding agent that runs in your terminal. It reads your code, edits files, runs
            commands, and reasons through bugs — while you keep control of every permission.
          </motion.p>

          {/* CTAs */}
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.18 }}
            className="mt-8 flex flex-col items-center gap-3 sm:flex-row lg:justify-start"
          >
            <Button size="lg" asChild className="sheen w-full sm:w-auto">
              <a href="#install">
                Get started <ArrowRight className="size-4" />
              </a>
            </Button>
            <Button size="lg" variant="outline" asChild className="w-full sm:w-auto">
              <a href={META.repo} target="_blank" rel="noopener noreferrer">
                <GitHubIcon className="size-4" /> View on GitHub
              </a>
            </Button>
          </motion.div>

          {/* Install one-liner */}
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.24 }}
            className="mx-auto mt-5 flex max-w-md items-center justify-between gap-2 rounded-lg border border-line bg-card px-3.5 py-2.5 font-mono text-sm lg:mx-0"
          >
            <code className="truncate">
              <span className="text-faint">$ </span>npm i -g {META.npm}
            </code>
            <CopyButton
              value={`npm i -g ${META.npm}`}
              className="text-muted hover:bg-surface hover:text-fg"
            />
          </motion.div>

          {/* Stats */}
          <motion.dl
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.3 }}
            className="mt-10 grid grid-cols-4 gap-3 border-t border-line pt-6"
          >
            {heroStats.map((s) => (
              <div key={s.label} className="text-center lg:text-left">
                <dt className="text-2xl font-extrabold tracking-tight sm:text-3xl">
                  <CountUp value={s.value} />
                </dt>
                <dd className="mt-0.5 text-[11px] uppercase tracking-wide text-muted sm:text-xs">
                  {s.label}
                </dd>
              </div>
            ))}
          </motion.dl>
        </div>

        {/* Right: terminal */}
        <motion.div
          initial={{ opacity: 0, scale: 0.97, y: 18 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          transition={{ duration: 0.7, delay: 0.15, ease: [0.22, 1, 0.36, 1] }}
        >
          <TerminalFrame
            title={`wrongstack — v${META.version}`}
            right={
              <span className="flex items-center gap-1.5">
                configured · model
                <span className="size-1.5 rounded-full bg-brand shadow-[0_0_8px] shadow-brand/70" />
              </span>
            }
          >
            <div className="flex min-h-[300px] flex-col">
              <div className="space-y-1.5">
                {history.map((l) => (
                  <div key={l.cmd} className="opacity-70">
                    <Prompt>{l.cmd}</Prompt>
                    <div className="pl-4">{l.out}</div>
                  </div>
                ))}
                <div>
                  <Prompt>
                    {typed}
                    <span className="caret" />
                  </Prompt>
                </div>
              </div>

              {/* status bar */}
              <div className="mt-auto flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-white/10 pt-3 text-xs text-zinc-500">
                <span>
                  ctx <span className="text-brand">38%</span>
                </span>
                <span>
                  tokens <span className="text-term-purple">2.4k</span>
                </span>
                <span>
                  cache <span className="text-term-blue">71%</span>
                </span>
                <span>
                  cost <span className="text-term-yellow">$0.02</span>
                </span>
                <span className="ml-auto flex items-center gap-1.5 text-brand">
                  <span className="size-1.5 animate-pulse rounded-full bg-brand" />
                  RUNNING
                </span>
              </div>
            </div>
          </TerminalFrame>
        </motion.div>
      </div>
    </section>
  );
}
