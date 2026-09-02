import { motion, useReducedMotion } from 'framer-motion';
import {
  BrainCircuit,
  CheckCircle2,
  CircleAlert,
  Gavel,
  Pause,
  Play,
  RotateCcw,
  ShieldAlert,
  Sparkles,
  Users,
  XCircle,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { cn } from '@/lib/utils';

type VoteOption = 'canary' | 'hold' | 'refuse';
type CouncilOutcome = 'approved' | 'vetoed' | 'judge' | 'abstained';
type ResolutionStage = 'risk' | 'votes' | 'quorum' | 'veto' | 'tally' | 'judge' | 'resolved';

type Seat = {
  id: string;
  persona: string;
  provider: string;
  model: string;
  weight: number;
  veto?: boolean;
  initials: string;
  tone: string;
};

type Scenario = {
  id: string;
  question: string;
  context: string;
  risk: 'high' | 'critical';
  votes: Partial<Record<Seat['id'], VoteOption>>;
  rationales: Partial<Record<Seat['id'], string>>;
  outcome: CouncilOutcome;
  verdict: string;
  rationale: string;
};

const seats: Seat[] = [
  {
    id: 'executor',
    persona: 'Executor',
    provider: 'OpenAI',
    model: 'codex',
    weight: 1,
    initials: 'EX',
    tone: 'border-cyan-300/30 bg-cyan-300/10 text-cyan-200',
  },
  {
    id: 'skeptic',
    persona: 'Skeptic',
    provider: 'Anthropic',
    model: 'sonnet',
    weight: 1.5,
    veto: true,
    initials: 'SK',
    tone: 'border-rose-300/30 bg-rose-300/10 text-rose-200',
  },
  {
    id: 'auditor',
    persona: 'Auditor',
    provider: 'Google',
    model: 'gemini',
    weight: 1.25,
    initials: 'AU',
    tone: 'border-brand-2/30 bg-brand-2/10 text-brand-2',
  },
  {
    id: 'strategist',
    persona: 'Strategist',
    provider: 'OpenRouter',
    model: 'deepseek',
    weight: 0.75,
    initials: 'ST',
    tone: 'border-violet-300/30 bg-violet-300/10 text-violet-200',
  },
];

const scenarios: Scenario[] = [
  {
    id: 'majority',
    question: 'Release the session-store migration to a 10% canary?',
    context: '42 tests passed · rollback prepared · p95 write latency +3.2%',
    risk: 'high',
    votes: { executor: 'canary', skeptic: 'hold', auditor: 'canary', strategist: 'canary' },
    rationales: {
      executor: 'Rollback is ready; a bounded canary keeps work moving.',
      skeptic: 'The latency change needs one more production-shaped sample.',
      auditor: 'Expected blast radius is capped and observable.',
      strategist: 'Progressive exposure preserves optionality.',
    },
    outcome: 'approved',
    verdict: 'Approve 10% canary',
    rationale: '3.00 / 4.50 weighted support clears the 60% threshold.',
  },
  {
    id: 'veto',
    question: 'Rotate the production signing key during an active deploy?',
    context: 'deploy 68% complete · two regions converging · no emergency declared',
    risk: 'critical',
    votes: { executor: 'hold', skeptic: 'refuse', auditor: 'hold', strategist: 'hold' },
    rationales: {
      executor: 'Pause until the current rollout reaches a stable boundary.',
      skeptic: 'Refuse: mixed credentials can strand in-flight instances.',
      auditor: 'The recovery cost exceeds the value of acting now.',
      strategist: 'Sequence rotation after the deploy window closes.',
    },
    outcome: 'vetoed',
    verdict: 'Denied by veto',
    rationale: 'The veto-enabled Skeptic explicitly refused every offered action.',
  },
  {
    id: 'judge',
    question: 'Retry the failed provider or switch to the fallback chain?',
    context: 'primary returned 529 twice · cooldown 45s · fallback cost +8%',
    risk: 'high',
    votes: { executor: 'canary', skeptic: 'hold', auditor: 'canary', strategist: 'hold' },
    rationales: {
      executor: 'Switch now to unblock the verification lane.',
      skeptic: 'Wait for half-open probing instead of adding a second failure mode.',
      auditor: 'The bounded fallback premium is lower than idle fleet cost.',
      strategist: 'Preserve primary affinity and reassess after cooldown.',
    },
    outcome: 'judge',
    verdict: 'Judge selects fallback',
    rationale: 'The 2.25 / 2.25 weighted tie was resolved from all four rationales.',
  },
  {
    id: 'quorum',
    question: 'Delete the stale release artifacts immediately?',
    context: 'three council providers unavailable · operator is offline',
    risk: 'critical',
    votes: { executor: 'hold' },
    rationales: { executor: 'The cleanup is reversible, but quorum is not available.' },
    outcome: 'abstained',
    verdict: 'Ask human',
    rationale: 'Only 1 / 4 seats returned; the 50% quorum requirement was not met.',
  },
];

const stageLabels: Array<{ id: ResolutionStage; label: string }> = [
  { id: 'risk', label: 'Risk gate' },
  { id: 'votes', label: 'Independent votes' },
  { id: 'quorum', label: 'Quorum' },
  { id: 'veto', label: 'Veto' },
  { id: 'tally', label: 'Weighted majority' },
  { id: 'judge', label: 'Judge' },
  { id: 'resolved', label: 'Decision' },
];

const voteLabels: Record<VoteOption, string> = {
  canary: 'Proceed',
  hold: 'Hold',
  refuse: 'Refuse',
};

const voteStyles: Record<VoteOption, string> = {
  canary: 'border-emerald-300/25 bg-emerald-300/10 text-emerald-200',
  hold: 'border-brand-2/25 bg-brand-2/10 text-brand-2',
  refuse: 'border-rose-300/25 bg-rose-300/10 text-rose-200',
};

function stagesFor(outcome: CouncilOutcome): ResolutionStage[] {
  if (outcome === 'vetoed') return ['risk', 'votes', 'quorum', 'veto', 'resolved'];
  if (outcome === 'abstained') return ['risk', 'votes', 'quorum', 'resolved'];
  if (outcome === 'judge') return ['risk', 'votes', 'quorum', 'veto', 'tally', 'judge', 'resolved'];
  return ['risk', 'votes', 'quorum', 'veto', 'tally', 'resolved'];
}

function outcomeStyle(outcome: CouncilOutcome) {
  if (outcome === 'approved') {
    return {
      icon: CheckCircle2,
      frame: 'border-emerald-300/25 bg-emerald-300/[0.07]',
      iconTone: 'text-emerald-300',
      label: 'answer',
    };
  }
  if (outcome === 'vetoed') {
    return {
      icon: XCircle,
      frame: 'border-rose-300/25 bg-rose-300/[0.07]',
      iconTone: 'text-rose-300',
      label: 'deny',
    };
  }
  if (outcome === 'judge') {
    return {
      icon: Gavel,
      frame: 'border-violet-300/25 bg-violet-300/[0.07]',
      iconTone: 'text-violet-300',
      label: 'answer · via judge',
    };
  }
  return {
    icon: CircleAlert,
    frame: 'border-brand-2/25 bg-brand-2/[0.07]',
    iconTone: 'text-brand-2',
    label: 'ask_human',
  };
}

export function BrainCouncilDemo() {
  const reducedMotionPreference = useReducedMotion();
  const reducedMotion = Boolean(reducedMotionPreference);
  const [scenarioIndex, setScenarioIndex] = useState(0);
  const [stepIndex, setStepIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const scenario = scenarios[scenarioIndex] ?? scenarios[0];
  const sequence = stagesFor(scenario.outcome);
  const visibleStep = reducedMotion ? sequence.length - 1 : stepIndex;
  const activeStage = sequence[visibleStep] ?? 'resolved';
  const globalStageIndex = stageLabels.findIndex((stage) => stage.id === activeStage);
  const stageReached = (stage: ResolutionStage) => {
    const position = sequence.indexOf(stage);
    return position >= 0 && position <= visibleStep;
  };
  const votesVisible = globalStageIndex >= 1;
  const resolutionVisible = activeStage === 'resolved';

  useEffect(() => {
    if (paused || reducedMotion) return;
    const timer = window.setTimeout(
      () => {
        if (stepIndex < sequence.length - 1) {
          setStepIndex((value) => value + 1);
          return;
        }
        setScenarioIndex((value) => (value + 1) % scenarios.length);
        setStepIndex(0);
      },
      activeStage === 'resolved' ? 3600 : 1550,
    );
    return () => window.clearTimeout(timer);
  }, [activeStage, paused, reducedMotion, sequence.length, stepIndex]);

  const tally = useMemo(() => {
    const weights: Record<VoteOption, number> = { canary: 0, hold: 0, refuse: 0 };
    for (const seat of seats) {
      const vote = scenario.votes[seat.id];
      if (vote) weights[vote] += seat.weight;
    }
    const total = Object.values(weights).reduce((sum, weight) => sum + weight, 0);
    return { weights, total };
  }, [scenario]);

  const castVotes = Object.keys(scenario.votes).length;
  const quorumMet = castVotes / seats.length >= 0.5;
  const resultStyle = outcomeStyle(scenario.outcome);
  const ResultIcon = resultStyle.icon;

  const reset = () => {
    setScenarioIndex(0);
    setStepIndex(0);
  };

  return (
    <section className="border-b border-line bg-[#11131a] px-4 py-16 text-white sm:px-6 sm:py-24 lg:px-10 lg:py-28">
      <div className="mx-auto max-w-[1380px]">
        <div className="mb-9 grid gap-5 lg:grid-cols-[0.8fr_1.2fr] lg:items-end">
          <div>
            <div className="flex items-center gap-2 font-mono text-xs font-black uppercase tracking-[0.2em] text-brand">
              <BrainCircuit className="size-4" /> Council decision graph
            </div>
            <h2 className="mt-4 max-w-3xl text-3xl font-black leading-[1.04] tracking-[-0.03em] sm:text-5xl">
              One risky choice. Independent minds.
            </h2>
          </div>
          <p className="max-w-2xl text-base leading-7 text-zinc-400 lg:justify-self-end">
            Watch provider-diverse seats vote without seeing each other, then pass through quorum,
            veto, weighted majority and—only for a close call—a separate judge.
          </p>
        </div>

        <div className="overflow-hidden rounded-[26px] border border-white/10 bg-[#090b10] shadow-2xl shadow-black/30">
          <div className="flex flex-wrap items-center justify-between gap-4 border-b border-white/[0.08] px-4 py-4 sm:px-5">
            <div className="flex items-center gap-3">
              <span className="grid size-9 place-items-center rounded-xl border border-brand/20 bg-brand/10 text-brand">
                <ShieldAlert className="size-4" />
              </span>
              <div>
                <div className="font-mono text-xs font-black uppercase tracking-[0.16em] text-zinc-300">
                  Decision {String(scenarioIndex + 1).padStart(2, '0')} / {scenarios.length}
                </div>
                <div className="mt-1 flex items-center gap-2 font-mono text-xs text-zinc-600">
                  <span className="uppercase">risk / {scenario.risk}</span>
                  <span>·</span>
                  <span>timeout / 15s per seat</span>
                </div>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setPaused((value) => !value)}
                aria-pressed={paused}
                disabled={reducedMotion}
                className="inline-flex items-center gap-2 rounded-lg border border-white/10 bg-white/[0.035] px-3 py-2 font-mono text-xs font-black uppercase tracking-wider text-zinc-300 transition-colors hover:border-brand/30 hover:text-brand disabled:cursor-not-allowed disabled:opacity-45"
              >
                {paused || reducedMotion ? (
                  <Play className="size-3" />
                ) : (
                  <Pause className="size-3" />
                )}
                {reducedMotion ? 'Motion reduced' : paused ? 'Resume' : 'Pause'}
              </button>
              <button
                type="button"
                onClick={reset}
                aria-label="Restart council story"
                className="grid size-8 place-items-center rounded-lg border border-white/10 text-zinc-500 transition-colors hover:border-brand-2/30 hover:text-brand-2"
              >
                <RotateCcw className="size-3.5" />
              </button>
            </div>
          </div>

          <div className="border-b border-white/[0.08] px-4 py-4 sm:px-5">
            <div className="no-scrollbar flex gap-1.5 overflow-x-auto pb-1">
              {stageLabels.map((stage) => {
                const scenarioPosition = sequence.indexOf(stage.id);
                const completed = scenarioPosition >= 0 && scenarioPosition < visibleStep;
                const active = stage.id === activeStage;
                const skipped = scenarioPosition < 0;
                return (
                  <div
                    key={stage.id}
                    className={cn(
                      'flex min-w-max items-center gap-2 rounded-full border px-3 py-1.5 font-mono text-xs font-black uppercase tracking-wider transition-colors',
                      active && 'border-brand/35 bg-brand/10 text-brand',
                      completed && 'border-emerald-300/20 bg-emerald-300/[0.06] text-emerald-300',
                      !active && !completed && 'border-white/[0.07] text-zinc-600',
                      skipped && 'opacity-35',
                    )}
                  >
                    <span
                      className={cn(
                        'size-1.5 rounded-full',
                        active ? 'bg-brand' : completed ? 'bg-emerald-300' : 'bg-zinc-700',
                      )}
                    />
                    {stage.label}
                  </div>
                );
              })}
            </div>
          </div>

          <div className="grid gap-px bg-white/[0.07] lg:grid-cols-[0.72fr_1.28fr]">
            <div className="bg-[#0f1219] p-4 sm:p-6">
              <span className="font-mono text-xs font-black uppercase tracking-[0.17em] text-brand-2">
                High-risk request
              </span>
              <h3 className="mt-4 text-xl font-black leading-7 tracking-[-0.025em] text-zinc-100">
                {scenario.question}
              </h3>
              <p className="mt-3 text-xs leading-6 text-zinc-500">{scenario.context}</p>
              <div className="mt-5 grid gap-2">
                {[
                  ['canary', 'Proceed with bounded action'],
                  ['hold', 'Pause or choose safer sequence'],
                  ['refuse', 'Refuse every offered action'],
                ].map(([id, label]) => (
                  <div
                    key={id}
                    className="flex items-center justify-between rounded-lg border border-white/[0.07] bg-white/[0.025] px-3 py-2.5"
                  >
                    <span className="text-xs text-zinc-400">{label}</span>
                    <code className="font-mono text-xs text-zinc-600">{id}</code>
                  </div>
                ))}
              </div>
              <div className="mt-5 rounded-xl border border-cyan-300/10 bg-cyan-300/[0.035] p-3">
                <div className="flex items-center gap-2 font-mono text-xs font-black uppercase tracking-wider text-cyan-300">
                  <Sparkles className="size-3.5" /> Decision ledger digest
                </div>
                <p className="mt-2 text-xs leading-5 text-zinc-500">
                  Similar changes: 3 · successful canaries: 2 · one rollback after latency
                  regression.
                </p>
              </div>
            </div>

            <div className="bg-[#0b0e14] p-4 sm:p-6">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <span className="font-mono text-xs font-black uppercase tracking-[0.16em] text-zinc-500">
                    Independent voting seats
                  </span>
                  <p className="mt-1 text-xs text-zinc-600">
                    Rationales remain sealed until every seat settles.
                  </p>
                </div>
                <span className="flex items-center gap-1.5 font-mono text-xs text-zinc-600">
                  <Users className="size-3" /> {castVotes}/{seats.length} returned
                </span>
              </div>

              <div className="relative mt-4 grid gap-3 sm:grid-cols-2">
                {seats.map((seat, index) => {
                  const vote = scenario.votes[seat.id];
                  const rationale = scenario.rationales[seat.id];
                  const returned = Boolean(vote);
                  return (
                    <motion.article
                      key={seat.id}
                      initial={reducedMotion ? false : { opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: reducedMotion ? 0 : index * 0.06 }}
                      className="rounded-xl border border-white/[0.08] bg-[#151821] p-3.5"
                    >
                      <div className="flex items-start gap-3">
                        <span
                          className={cn(
                            'grid size-9 shrink-0 place-items-center rounded-full border font-mono text-xs font-black',
                            seat.tone,
                          )}
                        >
                          {seat.initials}
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center justify-between gap-2">
                            <strong className="text-sm text-zinc-200">{seat.persona}</strong>
                            <span className="font-mono text-xs text-zinc-600">
                              weight {seat.weight.toFixed(2)}
                            </span>
                          </div>
                          <div className="mt-0.5 truncate font-mono text-xs text-zinc-600">
                            {seat.provider} / {seat.model}
                            {seat.veto ? ' · VETO SEAT' : ''}
                          </div>
                        </div>
                      </div>

                      <div className="mt-3 border-t border-white/[0.07] pt-3">
                        {!votesVisible ? (
                          <div className="flex items-center gap-2 font-mono text-xs text-zinc-600">
                            <motion.span
                              animate={reducedMotion ? undefined : { opacity: [0.25, 1, 0.25] }}
                              transition={{
                                repeat: Number.POSITIVE_INFINITY,
                                duration: 1.2,
                                delay: index * 0.1,
                              }}
                              className="size-1.5 rounded-full bg-cyan-300"
                            />
                            evaluating independently…
                          </div>
                        ) : returned && vote ? (
                          <>
                            <span
                              className={cn(
                                'inline-flex rounded-full border px-2 py-1 font-mono text-xs font-black uppercase tracking-wider',
                                voteStyles[vote],
                              )}
                            >
                              {voteLabels[vote]}
                            </span>
                            <p className="mt-2 text-xs leading-4 text-zinc-500">{rationale}</p>
                          </>
                        ) : (
                          <div className="flex items-center gap-2 font-mono text-xs text-zinc-600">
                            <XCircle className="size-3 text-rose-300" /> timeout · no valid vote
                          </div>
                        )}
                      </div>
                    </motion.article>
                  );
                })}
              </div>
            </div>
          </div>

          <div className="grid gap-px border-t border-white/[0.08] bg-white/[0.07] lg:grid-cols-[0.78fr_1.22fr]">
            <div className="bg-[#0f1219] p-4 sm:p-5">
              <div className="flex items-center justify-between gap-3">
                <span className="font-mono text-xs font-black uppercase tracking-[0.16em] text-zinc-500">
                  Resolution math
                </span>
                <span
                  className={cn(
                    'rounded-full border px-2 py-1 font-mono text-xs font-black uppercase',
                    quorumMet
                      ? 'border-emerald-300/20 text-emerald-300'
                      : 'border-brand-2/20 text-brand-2',
                  )}
                >
                  quorum {castVotes}/{seats.length}
                </span>
              </div>
              <div className="mt-4 space-y-3">
                {(['canary', 'hold', 'refuse'] as VoteOption[]).map((option) => {
                  const weight = tally.weights[option];
                  const width = tally.total > 0 ? (weight / tally.total) * 100 : 0;
                  return (
                    <div key={option}>
                      <div className="flex items-center justify-between font-mono text-xs">
                        <span className="text-zinc-500">{voteLabels[option]}</span>
                        <span className="text-zinc-300">{weight.toFixed(2)}</span>
                      </div>
                      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-white/[0.06]">
                        <motion.div
                          initial={false}
                          animate={{ width: votesVisible ? `${width}%` : '0%' }}
                          transition={{ duration: reducedMotion ? 0 : 0.5, ease: 'easeOut' }}
                          className={cn(
                            'h-full rounded-full',
                            option === 'canary'
                              ? 'bg-emerald-300'
                              : option === 'hold'
                                ? 'bg-brand-2'
                                : 'bg-rose-300',
                          )}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
              <div className="mt-4 grid grid-cols-3 gap-2 font-mono text-xs uppercase tracking-wider text-zinc-600">
                <span
                  className={cn(
                    'rounded-lg border p-2 text-center',
                    stageReached('quorum')
                      ? quorumMet
                        ? 'border-emerald-300/15 text-emerald-300'
                        : 'border-brand-2/20 text-brand-2'
                      : 'border-white/[0.07]',
                  )}
                >
                  quorum
                </span>
                <span
                  className={cn(
                    'rounded-lg border p-2 text-center',
                    stageReached('veto')
                      ? scenario.outcome === 'vetoed'
                        ? 'border-rose-300/20 text-rose-300'
                        : 'border-emerald-300/15 text-emerald-300'
                      : 'border-white/[0.07]',
                  )}
                >
                  veto
                </span>
                <span
                  className={cn(
                    'rounded-lg border p-2 text-center',
                    stageReached('tally')
                      ? 'border-violet-300/20 text-violet-300'
                      : 'border-white/[0.07]',
                  )}
                >
                  majority
                </span>
              </div>
            </div>

            <div className="bg-[#0b0e14] p-4 sm:p-5">
              {activeStage === 'judge' && (
                <motion.div
                  initial={reducedMotion ? false : { opacity: 0, scale: 0.98 }}
                  animate={{ opacity: 1, scale: 1 }}
                  className="mb-3 flex items-start gap-3 rounded-xl border border-violet-300/20 bg-violet-300/[0.06] p-4"
                >
                  <span className="grid size-9 shrink-0 place-items-center rounded-full border border-violet-300/25 bg-violet-300/10 text-violet-300">
                    <Gavel className="size-4" />
                  </span>
                  <div>
                    <div className="font-mono text-xs font-black uppercase tracking-wider text-violet-300">
                      Judge round
                    </div>
                    <p className="mt-1.5 text-xs leading-5 text-zinc-400">
                      A separate model receives all sealed rationales because no option exceeded the
                      approval threshold.
                    </p>
                  </div>
                </motion.div>
              )}

              <motion.div
                animate={{ opacity: resolutionVisible ? 1 : 0.38 }}
                className={cn(
                  'flex min-h-36 items-center gap-4 rounded-xl border p-4 sm:p-5',
                  resultStyle.frame,
                )}
              >
                <span
                  className={cn(
                    'grid size-11 shrink-0 place-items-center rounded-full border border-current/20 bg-black/10',
                    resultStyle.iconTone,
                  )}
                >
                  <ResultIcon className="size-5" />
                </span>
                <div>
                  <div
                    className={cn(
                      'font-mono text-xs font-black uppercase tracking-[0.16em]',
                      resultStyle.iconTone,
                    )}
                  >
                    {resolutionVisible ? resultStyle.label : `evaluating / ${activeStage}`}
                  </div>
                  <h3 className="mt-2 text-lg font-black tracking-[-0.025em] text-zinc-100">
                    {resolutionVisible ? scenario.verdict : 'Council decision pending'}
                  </h3>
                  <p className="mt-1.5 text-xs leading-5 text-zinc-500">
                    {resolutionVisible
                      ? scenario.rationale
                      : 'The resolution ladder stops at the first decisive boundary.'}
                  </p>
                </div>
              </motion.div>
            </div>
          </div>
        </div>

        <div className="mt-4 flex flex-col gap-2 text-xs leading-5 text-zinc-500 sm:flex-row sm:items-center sm:justify-between">
          <p>Illustrative local simulation based on the shipped Council resolution ladder.</p>
          <p className="font-mono text-xs uppercase tracking-wider text-zinc-600">
            independent votes → quorum → veto → majority → judge
          </p>
        </div>
      </div>
    </section>
  );
}
