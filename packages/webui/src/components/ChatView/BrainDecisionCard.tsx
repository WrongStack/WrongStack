import {
  Activity,
  AlertOctagon,
  Brain,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Compass,
  Copy,
  Cpu,
  HelpCircle,
  Lightbulb,
  ShieldAlert,
  Sparkles,
  UserCheck,
  Zap,
} from 'lucide-react';
import { memo, useMemo, useState } from 'react';
import { useAppTranslation } from '@/i18n';
import { cn } from '@/lib/utils';
import type { BrainDecisionData, ChatMessage } from '@/stores';

/**
 * Tiers that reached a verdict without a provider call. Mirrors core's
 * `DETERMINISTIC_BRAIN_TIERS`; a literal here so the browser bundle takes no
 * runtime dependency on core.
 */
const FREE_BRAIN_TIERS = new Set([
  'rule',
  'policy',
  'heuristic',
  'cache',
  'ledger-guard',
  'terminal',
]);

/** Parse legacy or replayed markdown into a structured BrainDecisionData fallback */
export function parseBrainMarkdown(content: string): BrainDecisionData | null {
  if (!content.includes('🧠')) return null;

  const isIntervention = content.includes('Brain intervention');
  const isCheck = content.includes('Brain check');
  const isDenied = content.includes('Denied:') || content.includes('denied');
  const isAskHuman =
    content.includes('needs human judgement') || content.includes('escalated this question');

  if (!isIntervention && !isCheck && !isDenied && !isAskHuman && !content.startsWith('🧠')) {
    return null;
  }

  const lines = content
    .split('\n\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const headline = lines[0] ?? '';
  const question = lines.length > 1 ? lines[1] : undefined;
  const rationale = lines.length > 2 ? lines[2]?.replace(/^[_*]+|[_*]+$/g, '') : undefined;

  let kind: BrainDecisionData['kind'] = 'answered';
  let decisionType = 'answer';
  let text = '';
  let reason = '';

  if (isIntervention) {
    kind = 'intervention';
    decisionType = 'steer';
    text = rationale ?? headline;
  } else if (isCheck) {
    kind = 'check';
    decisionType = 'observe';
    text = question ?? headline;
  } else if (isDenied) {
    kind = 'denied';
    decisionType = 'deny';
    reason = headline.replace(/^🧠\s*Denied:\s*/i, '');
  } else if (isAskHuman) {
    kind = 'ask_human';
    decisionType = 'ask_human';
    text = headline.replace(/^🧠\s*/, '');
  } else {
    text = headline.replace(/^🧠\s*/, '');
  }

  return {
    id: 'replayed-brain',
    kind,
    intervened: isIntervention,
    decisionType,
    question,
    text,
    reason,
    rationale,
    at: Date.now(),
  };
}

const RISK_BADGES: Record<string, { label: string; badge: string }> = {
  low: { label: 'Low Risk', badge: 'border-success/30 bg-success/10 text-success' },
  medium: { label: 'Medium Risk', badge: 'border-warning/30 bg-warning/10 text-warning' },
  high: {
    label: 'High Risk',
    badge: 'border-brand-orange/30 bg-brand-orange/10 text-brand-orange',
  },
  critical: {
    label: 'Critical Risk',
    badge: 'border-destructive/30 bg-destructive/10 text-destructive animate-pulse',
  },
};

interface BrainDecisionCardProps {
  message: ChatMessage;
}

export const BrainDecisionCard = memo(function BrainDecisionCard({
  message,
}: BrainDecisionCardProps) {
  const { t } = useAppTranslation();
  const [rationaleExpanded, setRationaleExpanded] = useState(true);
  const [copied, setCopied] = useState(false);

  const brainData = useMemo<BrainDecisionData | null>(() => {
    if (message.brainDecision) return message.brainDecision;
    return parseBrainMarkdown(message.content);
  }, [message.brainDecision, message.content]);

  if (!brainData) return null;

  const {
    id,
    kind = 'answered',
    intervened = false,
    decisionType,
    optionId,
    question,
    text,
    reason,
    rationale,
    source,
    risk,
    tier,
    confidence,
  } = brainData;

  const isIntervention = kind === 'intervention' || intervened;
  const isDenied = kind === 'denied' || decisionType === 'deny';
  const isAskHuman = kind === 'ask_human' || decisionType === 'ask_human';
  const isCheck = kind === 'check';

  const riskInfo = risk ? RISK_BADGES[risk.toLowerCase()] : undefined;

  const handleCopy = async () => {
    const content = [
      isIntervention ? '🧠 [Brain Intervention — Agent Steered]' : '🧠 [Brain Decision]',
      question ? `Trigger: ${question}` : '',
      text ? `Directive: ${text}` : '',
      reason ? `Policy Reason: ${reason}` : '',
      rationale ? `Rationale: ${rationale}` : '',
    ]
      .filter(Boolean)
      .join('\n\n');

    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // ignore
    }
  };

  return (
    <div
      className="mx-auto max-w-6xl w-full px-3 sm:px-5 lg:px-6 py-2"
      data-brain-decision-card={id ?? 'brain'}
    >
      <div
        className={cn(
          'relative overflow-hidden rounded-2xl border shadow-sm transition-all duration-200',
          'bg-gradient-to-br from-background via-surface-1/50 to-surface-2/70 backdrop-blur-sm',
          isIntervention
            ? 'border-warning/40 shadow-warning/5'
            : isDenied
              ? 'border-destructive/40 shadow-destructive/5'
              : isAskHuman
                ? 'border-info/40 shadow-info/5'
                : 'border-primary/40 shadow-primary/5',
        )}
      >
        {/* Top Accent Gradient Line */}
        <div
          className={cn(
            'h-1 w-full',
            isIntervention
              ? 'bg-gradient-to-r from-warning via-brand-orange to-primary'
              : isDenied
                ? 'bg-gradient-to-r from-destructive via-warning to-primary'
                : isAskHuman
                  ? 'bg-gradient-to-r from-info via-primary to-accent'
                  : 'bg-gradient-to-r from-primary via-info to-success',
          )}
        />

        <div className="p-4 sm:p-5 space-y-4">
          {/* Header Row */}
          <div className="flex flex-wrap items-center justify-between gap-2.5">
            <div className="flex items-center gap-2.5 min-w-0">
              <div
                className={cn(
                  'flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border shadow-xs transition-transform duration-200 hover:scale-105',
                  isIntervention
                    ? 'border-warning/30 bg-warning/10 text-warning'
                    : isDenied
                      ? 'border-destructive/30 bg-destructive/10 text-destructive'
                      : isAskHuman
                        ? 'border-info/30 bg-info/10 text-info'
                        : 'border-primary/30 bg-primary/10 text-primary',
                )}
              >
                {isIntervention ? (
                  <Zap className="h-5 w-5" />
                ) : isDenied ? (
                  <ShieldAlert className="h-5 w-5" />
                ) : isAskHuman ? (
                  <UserCheck className="h-5 w-5" />
                ) : (
                  <Brain className="h-5 w-5" />
                )}
              </div>

              <div>
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-semibold tracking-tight text-foreground flex items-center gap-1.5">
                    <span>
                      {isIntervention
                        ? t('activity:brainDecision.interventionTitle', {
                            defaultValue: 'Brain Intervention',
                          })
                        : isDenied
                          ? t('activity:brainDecision.deniedTitle', {
                              defaultValue: 'Brain Policy Guardrail',
                            })
                          : isAskHuman
                            ? t('activity:brainDecision.askHumanTitle', {
                                defaultValue: 'Brain Human Escalation',
                              })
                            : isCheck
                              ? t('activity:brainDecision.checkTitle', {
                                  defaultValue: 'Brain Distress Review',
                                })
                              : t('activity:brainDecision.title', {
                                  defaultValue: 'Brain Arbiter Decision',
                                })}
                    </span>
                  </h3>
                  {id ? (
                    <span className="font-mono text-[10px] text-muted-foreground/70 bg-muted/60 px-1.5 py-0.5 rounded border border-border/40">
                      {id}
                    </span>
                  ) : null}
                </div>
                <p className="text-xs text-muted-foreground">
                  {isIntervention
                    ? t('activity:brainDecision.interventionSubtitle', {
                        defaultValue: 'Autonomous steering signal injected to keep agent on track',
                      })
                    : t('activity:brainDecision.subtitle', {
                        defaultValue: 'Cognitive reasoning & safety oversight layer',
                      })}
                </p>
              </div>
            </div>

            {/* Badges & Copy Action */}
            <div className="flex items-center gap-1.5 flex-wrap">
              <button
                type="button"
                onClick={handleCopy}
                className="inline-flex items-center gap-1 rounded-full border border-border bg-surface-1/60 hover:bg-surface-1 px-2.5 py-0.5 text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
                title="Copy Brain Directive"
              >
                {copied ? <Check className="h-3 w-3 text-success" /> : <Copy className="h-3 w-3" />}
                <span className="text-[11px]">{copied ? 'Copied' : 'Copy'}</span>
              </button>

              {/* Status Badge */}
              <span
                className={cn(
                  'inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-bold border shadow-2xs',
                  isIntervention
                    ? 'border-warning/30 bg-warning/15 text-warning'
                    : isDenied
                      ? 'border-destructive/30 bg-destructive/15 text-destructive'
                      : isAskHuman
                        ? 'border-info/30 bg-info/15 text-info'
                        : isCheck
                          ? 'border-border bg-muted text-muted-foreground'
                          : 'border-primary/30 bg-primary/15 text-primary',
                )}
              >
                {isIntervention ? (
                  <Zap className="h-3.5 w-3.5" />
                ) : isDenied ? (
                  <ShieldAlert className="h-3.5 w-3.5" />
                ) : isAskHuman ? (
                  <UserCheck className="h-3.5 w-3.5" />
                ) : (
                  <CheckCircle2 className="h-3.5 w-3.5" />
                )}
                <span>
                  {isIntervention
                    ? 'Agent Steered'
                    : isDenied
                      ? 'Action Denied'
                      : isAskHuman
                        ? 'Human Required'
                        : isCheck
                          ? 'Reviewed (Safe)'
                          : 'Decided'}
                </span>
              </span>

              {/* Risk Level Badge */}
              {riskInfo ? (
                <span
                  className={cn(
                    'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium border shadow-2xs',
                    riskInfo.badge,
                  )}
                >
                  <AlertOctagon className="h-3 w-3" />
                  <span>{riskInfo.label}</span>
                </span>
              ) : null}

              {/* Source Badge */}
              {source ? (
                <span className="inline-flex items-center gap-1 rounded-full border border-border bg-muted/70 px-2 py-0.5 text-[11px] font-medium text-foreground font-mono">
                  <Cpu className="h-3 w-3 text-muted-foreground" />
                  <span>{source}</span>
                </span>
              ) : null}

              {/* Tier Badge — which layer of the ladder actually decided.
                  It used to render only as a FALLBACK for `source`, which is
                  always present, so the tier was never visible; the handler
                  did not populate it either. A council call and a free rule
                  hit looked identical in the transcript. */}
              {tier ? (
                <span
                  className={cn(
                    'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium border shadow-2xs font-mono',
                    FREE_BRAIN_TIERS.has(tier)
                      ? 'border-border bg-muted/50 text-muted-foreground'
                      : 'border-primary/40 bg-primary/10 text-primary',
                  )}
                >
                  <span>{tier}</span>
                </span>
              ) : null}
            </div>
          </div>

          {/* Evaluated Question / Context */}
          {question ? (
            <div className="rounded-xl border border-border/70 bg-surface-1/60 p-3.5 text-xs">
              <div className="flex items-center gap-1.5 font-semibold text-muted-foreground mb-1.5">
                <HelpCircle className="h-3.5 w-3.5 text-primary" />
                <span>
                  {t('activity:brainDecision.evaluatedPrompt', {
                    defaultValue: 'Context / Evaluated Trigger:',
                  })}
                </span>
              </div>
              <p className="text-foreground font-medium whitespace-pre-wrap leading-relaxed">
                {question}
              </p>
            </div>
          ) : null}

          {/* Corrective Guidance / Decision Result Banner */}
          {isIntervention ? (
            <div className="rounded-xl border border-warning/35 bg-gradient-to-r from-warning/[0.12] via-warning/[0.06] to-transparent p-4 space-y-2 shadow-xs">
              <div className="flex items-center gap-2 text-xs font-semibold text-warning">
                <Compass className="h-4 w-4 text-warning" />
                <span>
                  {t('activity:brainDecision.steeringGuidance', {
                    defaultValue: 'Corrective Guidance Issued to Agent:',
                  })}
                </span>
              </div>
              <p className="text-sm font-semibold text-foreground leading-relaxed pl-6">
                {text || rationale || 'Agent distress signal caught and trajectory corrected.'}
              </p>
            </div>
          ) : isDenied ? (
            <div className="rounded-xl border border-destructive/35 bg-gradient-to-r from-destructive/[0.12] via-destructive/[0.06] to-transparent p-4 space-y-2 shadow-xs">
              <div className="flex items-center gap-2 text-xs font-semibold text-destructive">
                <ShieldAlert className="h-4 w-4 text-destructive" />
                <span>
                  {t('activity:brainDecision.deniedReason', {
                    defaultValue: 'Safety Policy Block:',
                  })}
                </span>
              </div>
              <p className="text-sm font-semibold text-foreground leading-relaxed pl-6">
                {reason ||
                  text ||
                  'Requested operation was vetoed or denied by Brain arbiter policy.'}
              </p>
            </div>
          ) : isAskHuman ? (
            <div className="rounded-xl border border-info/35 bg-gradient-to-r from-info/[0.12] via-info/[0.06] to-transparent p-4 space-y-2 shadow-xs">
              <div className="flex items-center gap-2 text-xs font-semibold text-info">
                <UserCheck className="h-4 w-4 text-info" />
                <span>
                  {t('activity:brainDecision.humanJudgement', {
                    defaultValue: 'Escalated for Human Judgement:',
                  })}
                </span>
              </div>
              <p className="text-sm font-semibold text-foreground leading-relaxed pl-6">
                {text ||
                  'The Brain determined this decision exceeds autonomous authority and requires human input.'}
              </p>
            </div>
          ) : text ? (
            <div className="rounded-xl border border-primary/35 bg-gradient-to-r from-primary/[0.1] via-primary/[0.05] to-transparent p-4 space-y-2 shadow-xs">
              <div className="flex items-center gap-2 text-xs font-semibold text-primary">
                <Lightbulb className="h-4 w-4 text-primary" />
                <span>
                  {t('activity:brainDecision.decisionResult', {
                    defaultValue: 'Brain Strategy & Answer:',
                  })}
                </span>
                {optionId ? (
                  <span className="font-mono text-[10px] bg-primary/15 text-primary px-2 py-0.5 rounded border border-primary/25">
                    option: {optionId}
                  </span>
                ) : null}
              </div>
              <p className="text-sm font-medium text-foreground leading-relaxed pl-6">{text}</p>
            </div>
          ) : null}

          {/* Rationale & Cognitive Trace */}
          {rationale && rationale !== text ? (
            <div className="rounded-xl border border-border/60 bg-surface-1/40 p-3.5 space-y-2 shadow-2xs">
              <div className="flex items-center justify-between text-xs">
                <div className="flex items-center gap-1.5 font-semibold text-muted-foreground">
                  <Activity className="h-3.5 w-3.5 text-primary" />
                  <span>
                    {t('activity:brainDecision.cognitiveRationale', {
                      defaultValue: 'Cognitive Rationale & Policy Trace',
                    })}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => setRationaleExpanded(!rationaleExpanded)}
                  className="text-[11px] text-primary hover:underline font-medium flex items-center gap-0.5 cursor-pointer"
                >
                  <span>{rationaleExpanded ? 'Collapse' : 'Expand'}</span>
                  {rationaleExpanded ? (
                    <ChevronDown className="h-3 w-3" />
                  ) : (
                    <ChevronRight className="h-3 w-3" />
                  )}
                </button>
              </div>

              {rationaleExpanded ? (
                <div className="text-xs text-foreground/90 leading-relaxed font-normal whitespace-pre-wrap pl-4 border-l-2 border-primary/40 bg-background/50 p-2.5 rounded-r-lg">
                  {rationale}
                </div>
              ) : null}
            </div>
          ) : null}

          {/* Footer Metadata */}
          {confidence !== undefined ? (
            <div className="flex items-center justify-between text-xs text-muted-foreground pt-2 border-t border-border/40">
              <div className="flex items-center gap-2">
                <Sparkles className="h-3.5 w-3.5 text-primary" />
                <span className="text-[11px] font-medium">Confidence Score:</span>
                <div className="h-2 w-28 rounded-full bg-muted/80 overflow-hidden border border-border/30">
                  <div
                    className="h-full bg-primary rounded-full transition-all duration-500"
                    style={{ width: `${Math.round(confidence * 100)}%` }}
                  />
                </div>
              </div>
              <span className="font-mono text-[11px] font-bold text-foreground">
                {(confidence * 100).toFixed(0)}%
              </span>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
});
