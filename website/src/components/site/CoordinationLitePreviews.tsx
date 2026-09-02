import { LayoutGroup, motion, useReducedMotion } from 'framer-motion';
import {
  ArrowUpRight,
  BrainCircuit,
  CheckCircle2,
  CircleDot,
  Columns3,
  GitPullRequest,
  Scale,
  ShieldAlert,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from '@/lib/router';
import { cn } from '@/lib/utils';

function KanbanLiteMockup({ reducedMotion }: { reducedMotion: boolean }) {
  const [activeStage, setActiveStage] = useState(1);
  const visibleStage = reducedMotion ? 3 : activeStage;
  const columns = [
    { label: 'Todo', dot: 'bg-sky-300', cards: 3 },
    { label: 'Running', dot: 'bg-brand-2', cards: 2 },
    { label: 'Preview', dot: 'bg-violet-300', cards: 2 },
    { label: 'Done', dot: 'bg-emerald-300', cards: 0 },
  ];

  useEffect(() => {
    if (reducedMotion) return;
    const timer = window.setTimeout(
      () => setActiveStage((stage) => (stage >= 3 ? 1 : stage + 1)),
      activeStage === 3 ? 1800 : 1500,
    );
    return () => window.clearTimeout(timer);
  }, [activeStage, reducedMotion]);

  return (
    <div className="relative h-[380px] overflow-hidden rounded-2xl border border-white/[0.08] bg-[#0b0e14] p-3 sm:p-4">
      <div className="flex items-center justify-between border-b border-white/[0.07] pb-3">
        <div className="flex items-center gap-2">
          <span className="grid size-7 place-items-center rounded-lg border border-cyan-300/20 bg-cyan-300/10 text-cyan-300">
            <Columns3 className="size-3.5" />
          </span>
          <span className="font-mono text-xs font-black uppercase tracking-[0.14em] text-zinc-300">
            Sprint board
          </span>
        </div>
        <span className="flex items-center gap-1.5 font-mono text-xs text-zinc-600">
          <CircleDot className="size-3 text-emerald-300" /> live
        </span>
      </div>

      <LayoutGroup id="home-kanban-cycle">
        <div className="mt-3 grid grid-cols-4 gap-2">
          {columns.map((column, columnIndex) => {
            const hasActiveCard = columnIndex === visibleStage;
            return (
              <div
                key={column.label}
                className="h-[296px] rounded-xl border border-white/[0.06] bg-white/[0.018] p-2"
              >
                <div className="flex items-center justify-between gap-1">
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className={cn('size-1.5 shrink-0 rounded-full', column.dot)} />
                    <span className="truncate font-mono text-xs font-bold uppercase text-zinc-500">
                      {column.label}
                    </span>
                  </span>
                  <span className="font-mono text-xs text-zinc-700">
                    {column.cards + (hasActiveCard ? 1 : 0)}
                  </span>
                </div>

                <div className="mt-3 space-y-2">
                  {hasActiveCard && (
                    <motion.div
                      layoutId="home-kanban-active-task"
                      transition={{
                        layout: { duration: reducedMotion ? 0 : 0.5, ease: [0.22, 1, 0.36, 1] },
                      }}
                      className={cn(
                        'rounded-lg border bg-[#171b24] p-2 shadow-lg shadow-black/20',
                        visibleStage === 1 && 'border-brand-2/35',
                        visibleStage === 2 && 'border-violet-300/35',
                        visibleStage === 3 && 'border-emerald-300/35',
                      )}
                    >
                      <div className="flex items-center justify-between">
                        <div className="h-1.5 w-8 rounded-full bg-white/15" />
                        <motion.span
                          animate={reducedMotion ? undefined : { opacity: [0.45, 1, 0.45] }}
                          transition={{ duration: 1.1, repeat: Number.POSITIVE_INFINITY }}
                          className={cn('size-1.5 rounded-full', column.dot)}
                        />
                      </div>
                      <div className="mt-2 h-1.5 rounded-full bg-white/[0.07]" />
                      <div className="mt-1 h-1.5 w-2/3 rounded-full bg-white/[0.045]" />
                      <div className="mt-3 flex items-center justify-between">
                        <span
                          className={cn(
                            'size-4 rounded-full border',
                            visibleStage === 3
                              ? 'border-emerald-300/30 bg-emerald-300/10'
                              : 'border-brand-2/30 bg-brand-2/10',
                          )}
                        />
                        {visibleStage === 3 ? (
                          <CheckCircle2 className="size-3 text-emerald-300" />
                        ) : (
                          <span className="h-1 w-5 rounded-full bg-white/[0.08]" />
                        )}
                      </div>
                    </motion.div>
                  )}

                  {Array.from({ length: column.cards }).map((_, cardIndex) => (
                    <div
                      key={`${column.label}-${cardIndex}`}
                      className="rounded-lg border border-white/[0.07] bg-[#151922] p-2 shadow-lg shadow-black/10"
                    >
                      <div className="h-1.5 w-7 rounded-full bg-white/10" />
                      <div className="mt-2 h-1.5 rounded-full bg-white/[0.055]" />
                      <div className="mt-1 h-1.5 w-2/3 rounded-full bg-white/[0.035]" />
                      <div className="mt-3 flex items-center justify-between">
                        <span className="size-4 rounded-full border border-white/10 bg-white/[0.03]" />
                        <span className="h-1 w-5 rounded-full bg-white/[0.06]" />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </LayoutGroup>

      <div className="pointer-events-none absolute bottom-5 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-full border border-white/[0.08] bg-[#11141c] px-3 py-1 font-mono text-xs">
        {[1, 2, 3].map((stage) => (
          <span
            key={stage}
            className={cn(
              'flex items-center gap-1.5',
              visibleStage === stage
                ? stage === 1
                  ? 'text-brand-2'
                  : stage === 2
                    ? 'text-violet-300'
                    : 'text-emerald-300'
                : 'text-zinc-700',
            )}
          >
            <span
              className={cn(
                'size-1.5 rounded-full',
                visibleStage === stage
                  ? stage === 1
                    ? 'bg-brand-2'
                    : stage === 2
                      ? 'bg-violet-300'
                      : 'bg-emerald-300'
                  : 'bg-zinc-700',
              )}
            />
            {stage === 1 ? 'running' : stage === 2 ? 'preview' : 'done'}
          </span>
        ))}
      </div>
    </div>
  );
}

function BrainLiteMockup({ reducedMotion }: { reducedMotion: boolean }) {
  const [step, setStep] = useState(0);
  const visibleStep = reducedMotion ? 4 : step;
  const seats = [
    {
      label: 'Executor',
      initials: 'EX',
      vote: 'GO',
      tone: 'border-cyan-300/30 bg-cyan-300/10 text-cyan-200',
      voteTone: 'bg-cyan-300',
      delay: 0,
    },
    {
      label: 'Skeptic',
      initials: 'SK',
      vote: 'HOLD',
      tone: 'border-rose-300/30 bg-rose-300/10 text-rose-200',
      voteTone: 'bg-rose-300',
      delay: 0.15,
    },
    {
      label: 'Auditor',
      initials: 'AU',
      vote: 'GO',
      tone: 'border-brand-2/30 bg-brand-2/10 text-brand-2',
      voteTone: 'bg-brand-2',
      delay: 0.3,
    },
    {
      label: 'Strategist',
      initials: 'ST',
      vote: 'GO',
      tone: 'border-violet-300/30 bg-violet-300/10 text-violet-200',
      voteTone: 'bg-violet-300',
      delay: 0.45,
    },
  ];
  const stages = ['Risk', 'Votes', 'Quorum', 'Veto', 'Decision'];

  useEffect(() => {
    if (reducedMotion) return;
    const timer = window.setTimeout(
      () => setStep((value) => (value + 1) % stages.length),
      step === 4 ? 2400 : 1400,
    );
    return () => window.clearTimeout(timer);
  }, [reducedMotion, step, stages.length]);

  return (
    <div className="relative h-[380px] overflow-hidden rounded-2xl border border-white/[0.08] bg-[#080b11] p-3 sm:p-4">
      <div className="flex items-center justify-between border-b border-white/[0.07] pb-3">
        <div className="flex items-center gap-2">
          <span className="grid size-8 place-items-center rounded-xl border border-brand/25 bg-brand/10 text-brand shadow-[0_0_24px_rgba(254,46,95,.12)]">
            <BrainCircuit className="size-4" />
          </span>
          <div>
            <span className="block font-mono text-xs font-black uppercase tracking-[0.14em] text-zinc-200">
              Decision Council
            </span>
            <span className="mt-0.5 block font-mono text-xs text-zinc-600">
              independent seats · sealed rationales
            </span>
          </div>
        </div>
        <motion.span
          animate={reducedMotion ? undefined : { opacity: [0.5, 1, 0.5] }}
          transition={{ duration: 1.8, repeat: Number.POSITIVE_INFINITY }}
          className="flex items-center gap-1.5 rounded-full border border-rose-300/15 bg-rose-300/[0.05] px-2.5 py-1.5 font-mono text-xs font-black uppercase text-rose-200"
        >
          <ShieldAlert className="size-3" /> risk / high
        </motion.span>
      </div>

      <div className="mt-3 grid grid-cols-5 gap-1.5">
        {stages.map((stage, index) => (
          <div
            key={stage}
            className={cn(
              'relative overflow-hidden rounded-lg border px-1.5 py-2 text-center font-mono text-xs font-black uppercase tracking-wide transition-colors',
              index < visibleStep && 'border-emerald-300/15 bg-emerald-300/[0.04] text-emerald-300',
              index === visibleStep && 'border-brand/30 bg-brand/10 text-brand',
              index > visibleStep && 'border-white/[0.06] text-zinc-700',
            )}
          >
            {stage}
            {index === visibleStep && !reducedMotion && (
              <motion.span
                layoutId="brain-lite-stage"
                className="absolute inset-x-1 bottom-0 h-px bg-brand"
              />
            )}
          </div>
        ))}
      </div>

      <div className="mt-3 grid grid-cols-[0.72fr_1.28fr] gap-2.5">
        <motion.div
          animate={{ opacity: visibleStep >= 0 ? 1 : 0.35 }}
          className="rounded-xl border border-rose-300/12 bg-rose-300/[0.035] p-3"
        >
          <div className="flex items-center gap-2 font-mono text-xs font-black uppercase tracking-wider text-rose-200">
            <ShieldAlert className="size-3.5" /> proposal
          </div>
          <div className="mt-3 space-y-2">
            <div className="h-2 w-4/5 rounded-full bg-white/12" />
            <div className="h-2 rounded-full bg-white/[0.06]" />
            <div className="h-2 w-2/3 rounded-full bg-white/[0.04]" />
          </div>
          <div className="mt-4 flex items-center justify-between border-t border-white/[0.07] pt-2.5 font-mono text-xs">
            <span className="text-zinc-600">canary deploy</span>
            <span className="text-brand-2">10%</span>
          </div>
        </motion.div>

        <div className="grid grid-cols-2 gap-2">
          {seats.map((seat, index) => (
            <motion.div
              key={seat.label}
              animate={
                !reducedMotion && visibleStep === 1
                  ? {
                      y: [0, -2, 0],
                      borderColor: [
                        'rgba(255,255,255,.08)',
                        'rgba(34,211,238,.28)',
                        'rgba(255,255,255,.08)',
                      ],
                    }
                  : undefined
              }
              transition={{ duration: 1.1, delay: seat.delay }}
              className="rounded-xl border border-white/[0.07] bg-[#141820] p-2.5"
            >
              <div className="flex items-center gap-2">
                <span
                  className={cn(
                    'grid size-7 shrink-0 place-items-center rounded-full border font-mono text-xs font-black',
                    seat.tone,
                  )}
                >
                  {seat.initials}
                </span>
                <div className="min-w-0">
                  <strong className="block truncate text-xs text-zinc-300">{seat.label}</strong>
                  <span className="font-mono text-xs text-zinc-700">
                    weight {index === 1 ? '1.5' : '1.0'}
                  </span>
                </div>
              </div>
              <motion.div
                animate={{ opacity: visibleStep >= 1 ? 1 : 0.16, y: visibleStep >= 1 ? 0 : 3 }}
                className="mt-2.5 flex items-center justify-between border-t border-white/[0.06] pt-2"
              >
                <span className="font-mono text-xs font-black text-zinc-400">{seat.vote}</span>
                <span className={cn('size-1.5 rounded-full', seat.voteTone)} />
              </motion.div>
            </motion.div>
          ))}
        </div>
      </div>

      <div className="mt-2.5 grid grid-cols-[1fr_auto_1fr] items-stretch gap-2">
        <motion.div
          animate={{ opacity: visibleStep >= 2 ? 1 : 0.25 }}
          className="rounded-xl border border-white/[0.07] bg-white/[0.025] p-2.5"
        >
          <div className="flex items-center justify-between font-mono text-xs font-bold uppercase tracking-wider">
            <span className="text-zinc-500">Quorum</span>
            <span className={visibleStep >= 2 ? 'text-emerald-300' : 'text-zinc-700'}>4 / 4</span>
          </div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/[0.06]">
            <motion.div
              animate={{ width: visibleStep >= 2 ? '100%' : '0%' }}
              className="h-full rounded-full bg-emerald-300"
            />
          </div>
        </motion.div>

        <div className="grid place-items-center text-zinc-700">
          <ArrowUpRight className="size-3.5 rotate-45" />
        </div>

        <motion.div
          animate={{ opacity: visibleStep >= 3 ? 1 : 0.25 }}
          className="rounded-xl border border-white/[0.07] bg-white/[0.025] p-2.5"
        >
          <div className="flex items-center justify-between font-mono text-xs font-bold uppercase tracking-wider">
            <span className="text-zinc-500">Veto check</span>
            <span className={visibleStep >= 3 ? 'text-emerald-300' : 'text-zinc-700'}>clear</span>
          </div>
          <div className="mt-2 flex gap-1">
            {[0, 1, 2, 3].map((item) => (
              <span
                key={item}
                className={cn(
                  'h-1.5 flex-1 rounded-full',
                  visibleStep >= 3 ? 'bg-emerald-300/70' : 'bg-white/[0.06]',
                )}
              />
            ))}
          </div>
        </motion.div>
      </div>

      <motion.div
        animate={{ opacity: visibleStep >= 4 ? 1 : 0.2, y: visibleStep >= 4 ? 0 : 5 }}
        className="mt-2.5 flex items-center gap-3 rounded-xl border border-emerald-300/20 bg-emerald-300/[0.06] p-3"
      >
        <span className="grid size-9 shrink-0 place-items-center rounded-full border border-emerald-300/25 bg-emerald-300/10 text-emerald-300">
          <CheckCircle2 className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-3">
            <strong className="text-xs text-zinc-100">Approve bounded canary</strong>
            <span className="font-mono text-xs font-black text-emerald-300">3.0 / 4.5</span>
          </div>
          <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-white/[0.06]">
            <motion.div
              animate={{ width: visibleStep >= 4 ? '67%' : '0%' }}
              className="h-full rounded-full bg-gradient-to-r from-cyan-300 via-brand-2 to-emerald-300"
            />
          </div>
        </div>
        <Scale className="size-4 shrink-0 text-emerald-300" />
      </motion.div>
    </div>
  );
}

export function CoordinationLitePreviews() {
  const reducedMotionPreference = useReducedMotion();
  const reducedMotion = Boolean(reducedMotionPreference);

  const previews = [
    {
      href: '/features/kanban-work-queue',
      eyebrow: 'Kanban work queue',
      title: 'Tasks move. Ownership stays visible.',
      body: 'A lightweight glimpse of durable cards, dispatch and review.',
      icon: GitPullRequest,
      mockup: <KanbanLiteMockup reducedMotion={reducedMotion} />,
      link: 'Open Kanban feature',
    },
    {
      href: '/features/brain-council',
      eyebrow: 'Brain Agent · Council',
      title: 'Independent votes become one decision.',
      body: 'A minimal view of provider-diverse seats, veto and consensus.',
      icon: BrainCircuit,
      mockup: <BrainLiteMockup reducedMotion={reducedMotion} />,
      link: 'Open Brain Council',
    },
  ];

  return (
    <section className="border-b border-line bg-ink px-4 py-16 text-white sm:px-6 sm:py-24 lg:px-10 lg:py-28">
      <div className="mx-auto max-w-[1380px]">
        <div className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <div className="font-mono text-xs font-black uppercase tracking-[0.2em] text-brand">
              Coordination previews
            </div>
            <h2 className="mt-3 max-w-3xl text-3xl font-black leading-[1.05] tracking-[-0.03em] sm:text-5xl">
              Complex systems. Clear at a glance.
            </h2>
          </div>
          <p className="max-w-xl text-sm leading-7 text-zinc-400">
            Two intentionally sparse previews—enough motion to show the operating model without
            turning the home page into a dashboard.
          </p>
        </div>

        <div className="mt-10 grid gap-5 lg:grid-cols-2">
          {previews.map((preview) => (
            <Link
              key={preview.href}
              href={preview.href}
              className="group overflow-hidden rounded-[24px] border border-white/10 bg-[#11141b] p-4 transition-all duration-300 hover:-translate-y-1 hover:border-brand/35 hover:shadow-2xl hover:shadow-black/25 sm:p-5"
            >
              {preview.mockup}
              <div className="flex items-end justify-between gap-5 px-1 pb-1 pt-5">
                <div>
                  <div className="flex items-center gap-2 font-mono text-xs font-black uppercase tracking-[0.16em] text-brand-2">
                    <preview.icon className="size-3.5" /> {preview.eyebrow}
                  </div>
                  <h3 className="mt-2 text-xl font-black tracking-[-0.03em] text-zinc-100 sm:text-2xl">
                    {preview.title}
                  </h3>
                  <p className="mt-2 max-w-lg text-xs leading-6 text-zinc-500">{preview.body}</p>
                </div>
                <span className="grid size-10 shrink-0 place-items-center rounded-full border border-white/10 text-zinc-400 transition-all group-hover:border-brand group-hover:bg-brand group-hover:text-white">
                  <ArrowUpRight className="size-4 transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5" />
                </span>
              </div>
              <span className="sr-only">{preview.link}</span>
            </Link>
          ))}
        </div>
      </div>
    </section>
  );
}
