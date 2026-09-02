import { motion, useReducedMotion } from 'framer-motion';
import { ArrowUpRight, Terminal } from 'lucide-react';
import { useEffect, useState } from 'react';
import { repoUrl, version } from '@/data/content';
import { Link } from '@/lib/router';
import { cn } from '@/lib/utils';
import { BrandMark } from './BrandMark';

/* 5×5 pixel font for the welcome wordmark — the same chunky language the real
   TUI boots with. Each letter takes one solid color; the word gradients
   orange → pink across its width. */
const GLYPHS: Record<string, string[]> = {
  W: ['#...#', '#...#', '#.#.#', '##.##', '#...#'],
  R: ['####.', '#...#', '####.', '#.#..', '#..##'],
  O: ['.###.', '#...#', '#...#', '#...#', '.###.'],
  N: ['#...#', '##..#', '#.#.#', '#..##', '#...#'],
  G: ['.####', '#....', '#.###', '#...#', '####.'],
  S: ['.####', '#....', '.###.', '....#', '####.'],
  T: ['#####', '..#..', '..#..', '..#..', '..#..'],
  A: ['.###.', '#...#', '#####', '#...#', '#...#'],
  C: ['.####', '#....', '#....', '#....', '.####'],
  K: ['#...#', '#..#.', '###..', '#..#.', '#...#'],
};

const ORANGE = '#FD9F02';
const PINK = '#FE2E5F';

function mixHex(a: string, b: string, t: number): string {
  const pa = [1, 3, 5].map((i) => Number.parseInt(a.slice(i, i + 2), 16));
  const pb = [1, 3, 5].map((i) => Number.parseInt(b.slice(i, i + 2), 16));
  const mixed = pa.map((va, i) => Math.round(va + ((pb[i] ?? 0) - va) * t));
  return `#${mixed.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

function PixelWord({ word, className }: { word: string; className?: string }) {
  const letters = word.split('');
  const cols = letters.length * 6 - 1; // 5px glyph + 1px tracking
  return (
    <svg
      viewBox={`0 0 ${cols} 5`}
      className={className}
      role="img"
      aria-label={word}
      shapeRendering="crispEdges"
    >
      {letters.map((letter, li) =>
        (GLYPHS[letter] ?? []).map((row, y) =>
          row
            .split('')
            .map((cell, x) =>
              cell === '#' ? (
                <rect
                  key={`${li}-${y}-${x}`}
                  x={li * 6 + x + 0.07}
                  y={y + 0.07}
                  width={0.86}
                  height={0.86}
                  fill={mixHex(ORANGE, PINK, letters.length > 1 ? li / (letters.length - 1) : 0)}
                />
              ) : null,
            ),
        ),
      )}
    </svg>
  );
}

const streamLines = [
  { kind: 'user', text: 'security review the checkout module' },
  { kind: 'think', text: 'planning parallel review lanes…' },
  {
    kind: 'assistant',
    text: 'Splitting into four read-only lanes — attack surface, auth, filesystem and deps.',
  },
  { kind: 'tool', name: 'read', detail: 'packages/checkout/src/payment.ts', meta: '16ms · 66 L' },
  { kind: 'tool', name: 'assign_task', detail: 'security-scanner-b2de9bb8', meta: '9ms' },
  {
    kind: 'tool',
    name: 'mail_send',
    detail: 'leader@d7ef → scanner-01 · "Claiming lane 2"',
    meta: '100ms',
  },
  { kind: 'tool', name: 'fleet_status', detail: '12 agents online', meta: '18ms' },
  { kind: 'done', text: '4 lanes claimed · reviews in flight' },
] as const;

const missions = [
  'Map the attack surface',
  'Review auth & input handling',
  'Audit the filesystem boundary',
  'Report consolidated findings',
] as const;

const leaderStatuses = ['assign_task', 'mail_send', 'thinking…', 'waiting on lanes'] as const;

const scanners = [
  {
    id: '01',
    statuses: ['thinking…', 'read src/auth/session', 'grep token|secret', '2 findings drafted'],
  },
  {
    id: '02',
    statuses: ['thinking…', 'trace attacker input', 'read http/server', '1 finding drafted'],
  },
  { id: '03', statuses: ['thinking…', 'map fs boundary', 'read fs/guards', 'lane clean ✓'] },
  {
    id: '04',
    statuses: ['thinking…', 'audit dep install path', 'read policy/engine', 'lane clean ✓'],
  },
] as const;

const LOOP_TICKS = streamLines.length + 4;

function StreamLine({ line }: { line: (typeof streamLines)[number] }) {
  if (line.kind === 'user') {
    return (
      <div className="flex gap-2.5">
        <span className="shrink-0 font-black text-brand">◆ USER</span>
        <span className="text-zinc-200">{line.text}</span>
      </div>
    );
  }
  if (line.kind === 'think') {
    return (
      <div className="flex gap-2.5">
        <span className="shrink-0 text-zinc-600">✱ THINKING</span>
        <span className="italic text-zinc-500">{line.text}</span>
      </div>
    );
  }
  if (line.kind === 'assistant') {
    return (
      <div className="flex gap-2.5">
        <span className="shrink-0 text-zinc-300">● ASSISTANT</span>
        <span className="text-zinc-400">{line.text}</span>
      </div>
    );
  }
  if (line.kind === 'tool') {
    return (
      <div className="flex gap-2.5">
        <span className="shrink-0 text-emerald-300">✓</span>
        <span className="min-w-0 truncate">
          <span className="font-bold text-cyan-300">{line.name}</span>{' '}
          <span className="text-zinc-400">{line.detail}</span>{' '}
          <span className="text-zinc-600">· {line.meta}</span>
        </span>
      </div>
    );
  }
  return (
    <div className="flex gap-2.5">
      <span className="shrink-0 text-emerald-300">✓</span>
      <span className="font-bold text-emerald-300">{line.text}</span>
    </div>
  );
}

function SwarmCard({
  label,
  status,
  filled,
  leader,
}: {
  label: string;
  status: string;
  filled: number;
  leader?: boolean;
}) {
  return (
    <div
      className={cn(
        'min-w-0 rounded-xl border p-2.5',
        leader ? 'border-brand-2/35 bg-brand-2/[0.05]' : 'border-white/[.08] bg-white/[0.02]',
      )}
    >
      <div className="flex items-center justify-between gap-2 font-mono text-[9px] font-bold uppercase tracking-wider">
        <span className={cn('truncate', leader ? 'text-brand-2' : 'text-zinc-400')}>{label}</span>
        <span className="flex shrink-0 items-center gap-1 text-emerald-300">
          <span className="topology-pulse size-1.5 rounded-full bg-emerald-300" />
          LIVE
        </span>
      </div>
      <div className="mt-2 flex gap-[2px]" aria-hidden="true">
        {Array.from({ length: 10 }).map((_, i) => (
          <span
            key={i}
            className={cn(
              'h-1 flex-1 rounded-[1px] transition-colors duration-300',
              i < filled ? (leader ? 'bg-brand-2/80' : 'bg-emerald-300/70') : 'bg-white/[0.07]',
            )}
          />
        ))}
      </div>
      <div className="mt-1.5 truncate font-mono text-[9px] text-zinc-500">{status}</div>
    </div>
  );
}

export function TuiShowcase() {
  const reducedMotion = useReducedMotion();
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (reducedMotion) return;
    const timer = window.setInterval(() => setTick((v) => (v + 1) % LOOP_TICKS), 900);
    return () => window.clearInterval(timer);
  }, [reducedMotion]);

  const visible = reducedMotion ? streamLines.length : Math.min(tick + 1, streamLines.length);
  const doneCount = reducedMotion
    ? missions.length
    : Math.min(missions.length, Math.floor(tick / 2));

  return (
    <section className="border-b border-line px-4 py-16 sm:px-6 sm:py-24 lg:px-10 lg:py-28">
      <div className="mx-auto max-w-[1380px]">
        <div className="mb-9 grid gap-5 lg:grid-cols-[.8fr_1.2fr] lg:items-end">
          <div>
            <div className="font-mono text-xs font-black uppercase tracking-[0.2em] text-brand">
              Terminal-native
            </div>
            <h2 className="mt-4 max-w-2xl text-3xl font-black leading-[1.06] tracking-[-0.025em] text-fg sm:text-5xl">
              The cockpit is a terminal.
            </h2>
          </div>
          <p className="max-w-2xl text-base leading-7 text-muted lg:justify-self-end">
            The TUI streams the real agent loop — reasoning, tool calls, fleet activity and mission
            state — with zero browser chrome. Not a screenshot: the interface, rebuilt in code.
          </p>
        </div>

        <div className="overflow-hidden rounded-[26px] border border-white/10 bg-[#0a0b0f] shadow-2xl shadow-black/30">
          {/* Frame title bar */}
          <div className="flex items-center justify-between gap-3 border-b border-white/[.08] px-4 py-3 sm:px-5">
            <div className="flex items-center gap-3">
              <span className="grid size-7 place-items-center rounded-lg border border-brand/25 bg-brand/10 text-brand">
                <Terminal className="size-3.5" />
              </span>
              <div>
                <div className="font-mono text-xs font-black uppercase tracking-[0.18em] text-zinc-300">
                  WrongStack / TUI
                </div>
                <div className="text-xs text-zinc-600">read-only product preview</div>
              </div>
            </div>
            <div className="flex items-center gap-2 font-mono text-[8px] font-bold uppercase tracking-wider text-zinc-500">
              <span className="rounded-full border border-white/[.08] px-2.5 py-1.5">
                v{version}
              </span>
              <span className="flex items-center gap-1.5 rounded-full border border-white/[.08] px-2.5 py-1.5">
                <span className="topology-pulse size-1.5 rounded-full bg-emerald-300" />
                live
              </span>
            </div>
          </div>

          {/* Welcome block — pixel wordmark + session info */}
          <div className="border-b border-white/[.06] px-4 py-10 text-center sm:py-12">
            <BrandMark className="mx-auto w-14 sm:w-16" />
            <PixelWord word="WRONGSTACK" className="mx-auto mt-5 w-full max-w-[560px]" />
            <p className="mt-5 font-mono text-[11px] font-bold uppercase tracking-[0.3em] text-zinc-500">
              Built on the wrong stack. Shipped anyway.
            </p>
            <div className="mt-6 flex flex-wrap items-center justify-center gap-x-5 gap-y-1.5 font-mono text-[10px] text-zinc-500">
              <span>
                <span className="text-brand-2">◆</span> route&nbsp;&nbsp;openai-codex › gpt-5.6-sol
              </span>
              <span>
                <span className="text-zinc-600">◇</span> family&nbsp;&nbsp;openai-codex
              </span>
              <span>
                <span className="text-zinc-600">⤿</span> workspace&nbsp;&nbsp;~/projects/WrongStack
              </span>
            </div>
            <div className="mt-3 flex items-center justify-center gap-2 font-mono text-[10px] text-zinc-600">
              <span className="text-brand">◆</span> wrongstack.com
              <span>·</span>
              <a
                href={repoUrl}
                target="_blank"
                rel="noreferrer"
                className="transition-colors hover:text-brand-2"
              >
                <span className="text-brand-2">★</span> github
              </a>
            </div>
          </div>

          {/* Live stream */}
          <div className="min-h-[238px] space-y-2.5 px-4 py-5 font-mono text-[11px] leading-5 sm:px-6 sm:text-[12px]">
            {streamLines.slice(0, visible).map((line, i) => (
              <motion.div
                key={`${line.kind}-${i}`}
                initial={reducedMotion ? false : { opacity: 0, x: -6 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ duration: 0.25 }}
              >
                <StreamLine line={line} />
              </motion.div>
            ))}
            {!reducedMotion && visible < streamLines.length && (
              <motion.span
                animate={{ opacity: [0, 1, 0] }}
                transition={{ repeat: Number.POSITIVE_INFINITY, duration: 1 }}
                className="inline-block h-3.5 w-1.5 bg-brand"
              />
            )}
          </div>

          {/* Input row */}
          <div className="border-t border-white/[.06] px-4 py-3 font-mono text-[11px] sm:px-6">
            <div className="flex items-center justify-between text-zinc-500">
              <span>
                <span className="text-brand-2">◆</span> WRONGSTACK v{version}{' '}
                <span className="text-zinc-600">[02:01]</span>
              </span>
              <span className="flex items-center gap-1.5">
                <span className="size-1.5 animate-pulse rounded-full bg-brand-2" />
                reasoning…
              </span>
            </div>
            <div className="mt-2 flex items-center gap-2 rounded-lg border border-white/[.1] px-2.5 py-1.5 text-zinc-400">
              ❯ <span className="caret" />
            </div>
          </div>

          {/* Agent swarm */}
          <div className="border-t border-white/[.06] px-4 py-4 sm:px-6">
            <div className="flex items-center justify-between font-mono text-[9px] font-bold uppercase tracking-[0.14em] text-zinc-500">
              <span>◈ Agent swarm / parallel workspace</span>
              <span className="flex items-center gap-1.5 text-emerald-300">
                <span className="topology-pulse size-1.5 rounded-full bg-emerald-300" />
                {1 + scanners.length} live
              </span>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-5">
              <SwarmCard
                label="00 Leader"
                leader
                status={`${leaderStatuses[tick % leaderStatuses.length]} · 8i · 27t · 9% ctx`}
                filled={reducedMotion ? 7 : 1 + ((tick + 1) % 9)}
              />
              {scanners.map((scanner, i) => (
                <SwarmCard
                  key={scanner.id}
                  label={`${scanner.id} Scanner`}
                  status={scanner.statuses[(tick + i) % scanner.statuses.length] ?? 'thinking…'}
                  filled={reducedMotion ? 6 : 1 + ((tick + i * 2) % 9)}
                />
              ))}
            </div>
            <div className="mt-4 font-mono text-[10px]">
              <div className="flex items-center justify-between text-zinc-500">
                <span className="font-bold uppercase tracking-[0.14em]">◈ Mission queue</span>
                <span>
                  {doneCount >= missions.length ? 0 : 1} active ·{' '}
                  {Math.max(0, missions.length - doneCount - 1)} queued · {doneCount} done
                </span>
              </div>
              <ul className="mt-2 grid gap-x-6 gap-y-1.5 sm:grid-cols-2">
                {missions.map((mission, i) => (
                  <li key={mission} className="flex items-center gap-2">
                    {i < doneCount ? (
                      <span className="text-emerald-300">✓</span>
                    ) : i === doneCount ? (
                      <span className="text-brand-2">●</span>
                    ) : (
                      <span className="text-zinc-600">○</span>
                    )}
                    <span
                      className={cn(
                        i < doneCount
                          ? 'text-zinc-600 line-through'
                          : i === doneCount
                            ? 'text-zinc-300'
                            : 'text-zinc-600',
                      )}
                    >
                      {mission}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </div>

          {/* Status bar */}
          <div className="border-t border-white/[.08] bg-white/[0.02] px-4 py-2.5 font-mono text-[10px] text-zinc-500 sm:px-6">
            <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1">
              <span className="font-bold text-brand-2">! YOLO</span>
              <span>∞ AUTO</span>
              <span className="text-zinc-300">◆ WrongStack</span>
              <span>openai-codex/gpt-5.6-sol</span>
              <span className="hidden sm:inline">[o······] 4%/1.1M</span>
              <span className="hidden md:inline">↑129k ↓1.0k · cache 26%</span>
              <span className="ml-auto">? help · F3 agents · ^C stop</span>
            </div>
          </div>
        </div>

        <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs leading-5 text-muted">
            Recreated in code from the real TUI welcome screen, stream and swarm panels. Sample
            values shown.
          </p>
          <Link
            href="/interfaces"
            className="group inline-flex shrink-0 items-center gap-1.5 text-xs font-bold text-brand"
          >
            Compare all six interfaces
            <ArrowUpRight className="size-3.5 transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5" />
          </Link>
        </div>
      </div>
    </section>
  );
}
