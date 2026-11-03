import {
  councilDecisionData,
  councilDecisionText,
} from '@wrongstack/project-surfaces/council/panels';
import { toast } from '@/components/Toaster';
import { chatFor, messageSessionId } from '@/lib/ws-client-utils';
import { type BrainDecisionData, useCouncilLogStore, useVizStore } from '@/stores';
import type { WSServerMessage } from '@/types';

/**
 * The Brain council log of the conversation a frame names.
 *
 * Council panels are per conversation, so the write has to be addressed: the
 * store's foreground `getState()` would put a background tab's panel on the
 * screen the user is looking at.
 */
function councilLogFor(msg: WSServerMessage) {
  return useCouncilLogStore.for(messageSessionId(msg)).getState();
}

export function handleBrainStatus(msg: WSServerMessage) {
  // A decision with no address (or no available lane) cannot be attributed
  // to the foreground tab: four conversations share this socket.
  const chat = chatFor(msg);
  if (!chat) return;
  const p = msg.payload as {
    maxAutoRisk: string;
    log: Array<{ at: number; kind: string; question: string; outcome: string }>;
  };
  const lines = [
    '🧠 **Brain** — policy → LLM decision chain',
    '',
    `Autonomy ceiling: \`${p.maxAutoRisk}\` _(change with \`/brain risk <off|low|medium|high|all>\`)_`,
  ];
  if (p.log.length === 0) {
    lines.push('', '_No decisions recorded yet this session._');
  } else {
    lines.push('', `Recent decisions (${p.log.length}):`);
    for (const entry of p.log.slice(-10)) {
      const ago = Math.max(0, Math.round((Date.now() - entry.at) / 1000));
      const age =
        ago < 60
          ? `${ago}s`
          : ago < 3600
            ? `${Math.round(ago / 60)}m`
            : `${Math.round(ago / 3600)}h`;
      const q = entry.question.length > 70 ? `${entry.question.slice(0, 67)}…` : entry.question;
      lines.push(
        `- \`${age} ago\` **${entry.kind}** — ${q}${entry.outcome ? ` → _${entry.outcome}_` : ''}`,
      );
    }
  }
  chat.addMessage({ role: 'assistant', content: lines.join('\n') });
}

export function handleBrainAnswer(msg: WSServerMessage) {
  // A decision with no address (or no available lane) cannot be attributed
  // to the foreground tab: four conversations share this socket.
  const chat = chatFor(msg);
  if (!chat) return;
  const p = msg.payload as {
    question: string;
    decision: {
      type: string;
      text?: string;
      rationale?: string;
      reason?: string;
      optionId?: string;
    };
  };
  let content: string;
  if (p.decision.type === 'answer') {
    const rationale =
      p.decision.rationale && p.decision.rationale !== p.decision.text
        ? `\n\n_${p.decision.rationale}_`
        : '';
    content = `🧠 ${p.decision.text ?? ''}${rationale}`;
  } else if (p.decision.type === 'deny') {
    content = `🧠 Denied: ${p.decision.reason ?? ''}`;
  } else {
    content = '🧠 The Brain escalated this question back to you — it needs human judgement.';
  }
  const brainDecision: BrainDecisionData = {
    kind:
      p.decision.type === 'answer'
        ? 'answered'
        : p.decision.type === 'deny'
          ? 'denied'
          : 'ask_human',
    question: p.question,
    decisionType: p.decision.type,
    text: p.decision.text,
    rationale: p.decision.rationale,
    reason: p.decision.reason,
    optionId: p.decision.optionId,
    at: Date.now(),
  };
  chat.addMessage({ role: 'assistant', content, brainDecision });
}

/**
 * Council seat votes are NOT buffered here: the council log store already
 * tracks each panel's seats per request id (deduped by seat id, retained as
 * whole panels in its ring buffer). `brain.council_vote` fires once per seat
 * and `brain.council_resolved` once per panel, both from inside
 * `council.decide()`. Both reached the browser and were dropped on the
 * floor, so the most expensive Brain tier — one provider call per seat — was
 * completely invisible in the UI. The resolved handler reads the panel's
 * seats back from the store, so vote eviction is per-panel (per-request): a
 * live panel's seats can never be dropped by other requests' vote traffic
 * (the old global 50-vote buffer could). Whole panels still age out of the
 * store's ring buffer, which is the intended log retention.
 */
export function handleBrainEvent(msg: WSServerMessage) {
  // A decision with no address (or no available lane) cannot be attributed
  // to the foreground tab: four conversations share this socket.
  const chat = chatFor(msg);
  if (!chat) return;
  const p = msg.payload as {
    event: string;
    intervened?: boolean;
    requestId?: string;
    seatId?: string;
    persona?: string;
    status?: string;
    optionId?: string;
    model?: string;
    veto?: boolean;
    resolution?: string;
    reason?: string;
    configuredSeatCount?: number;
    validVoteCount?: number;
    distinctTargetCount?: number;
    judgeUsed?: boolean;
    judgeLabel?: string;
    judgeIsVoter?: boolean;
    warnings?: string[];
    /** Which tier of the ladder resolved the decision. */
    tier?: string;
    /** ask_human only: a human is being waited on and the decision is open. */
    pending?: boolean;
    usage?: { totalTokens?: number; durationMs?: number };
    request?: { id?: string; question?: string; source?: string; risk?: string };
    decision?: {
      type?: string;
      optionId?: string;
      text?: string;
      reason?: string;
      rationale?: string;
    };
  };
  // The question text lives on the decision_* events, not the council ones.
  // Retain it before the first ballot, or enrich an existing panel, so the
  // live log reads as a question rather than a bare request id.
  //
  // NOTE the two id shapes: the council events carry a top-level `requestId`,
  // while every `brain.decision_*` event nests it as `request.id`. Reading only
  // the former silently never matched, which is the whole reason this lookup
  // is spelled out rather than inlined.
  const questionRequestId = p.requestId ?? p.request?.id;
  if (questionRequestId && p.request?.question) {
    councilLogFor(msg).noteQuestion(questionRequestId, p.request.question);
  }
  if (p.event === 'brain.council_vote') {
    councilLogFor(msg).recordVote(p as Record<string, unknown>);
    const requestId = p.requestId ?? 'unknown';
    useVizStore.getState().pushEvent({
      // seatId is always emitted by the server; the timestamp-suffixed
      // fallback only guards a malformed payload from producing duplicate
      // React keys in the live feed.
      id: `council_${requestId}_${p.seatId ?? `seat-${Date.now()}`}`,
      kind: 'brain:council_vote',
      timestamp: Date.now(),
      source: p.model ?? p.persona ?? 'seat',
      target: 'brain',
      label: `${p.persona ?? 'voter'} → ${p.status === 'valid' ? (p.optionId ?? 'stance') : (p.status ?? 'failed')}`,
      data: p,
      color: 'var(--color-viz-1)',
      flowGroup: 'brain',
    });
    return;
  }
  if (p.event === 'brain.council_resolved') {
    const requestId = p.requestId ?? 'unknown';
    const previous = councilLogFor(msg).panels.find((entry) => entry.requestId === requestId);
    councilLogFor(msg).recordResolution(p as Record<string, unknown>);
    // Read the panel's seats back from the log store — recordResolution above
    // upserts the panel, so it is always present. No parallel buffer: eviction
    // is per-panel, so a live panel's votes can never be dropped by other
    // requests' traffic.
    const panel = councilLogFor(msg).panels.find((entry) => entry.requestId === requestId);
    // The reducer rejects duplicate/older frames. Replaying one must not add
    // another transcript card or show the same warning toast again.
    if (panel && panel === previous) return;
    const councilDecision = councilDecisionData(panel, p as Record<string, unknown>);
    chat.addMessage({
      role: 'assistant',
      content: councilDecisionText(councilDecision),
      councilDecision,
    });
    for (const warning of p.warnings ?? []) toast.warn(warning);
    return;
  }
  if (p.event === 'brain.intervention') {
    const guidance = p.decision?.rationale ?? p.decision?.text ?? '';
    const headline = p.intervened
      ? '🧠 **Brain intervention** — corrective guidance was sent to the agent.'
      : '🧠 **Brain check** — a distress signal was reviewed; no action needed.';
    const brainDecision: BrainDecisionData = {
      id: p.requestId ?? p.request?.id,
      kind: p.intervened ? 'intervention' : 'check',
      intervened: Boolean(p.intervened),
      question: p.request?.question,
      source: p.request?.source,
      risk: p.request?.risk,
      decisionType: p.decision?.type ?? (p.intervened ? 'steer' : 'observe'),
      optionId: p.decision?.optionId,
      text: p.decision?.text,
      rationale: guidance,
      reason: p.decision?.reason,
      at: Date.now(),
    };
    chat.addMessage({
      role: 'assistant',
      content: [headline, p.request?.question ?? '', guidance ? `_${guidance}_` : '']
        .filter(Boolean)
        .join('\n\n'),
      brainDecision,
    });
    if (p.intervened) toast.info('Brain intervened: agent steered');
  } else if (p.event === 'brain.decision_denied') {
    const reason = p.decision?.reason ?? p.request?.question ?? 'request';
    const brainDecision: BrainDecisionData = {
      id: p.requestId ?? p.request?.id,
      kind: 'denied',
      question: p.request?.question,
      source: p.request?.source,
      risk: p.request?.risk,
      tier: p.tier,
      decisionType: 'deny',
      reason,
      rationale: p.decision?.rationale,
      at: Date.now(),
    };
    chat.addMessage({
      role: 'assistant',
      content: `🧠 Denied: ${reason}`,
      brainDecision,
    });
    toast.warn(`Brain denied: ${reason}`);
  } else if (p.event === 'brain.decision_answered') {
    const text = p.decision?.text ?? p.decision?.optionId ?? '';
    const rationale = p.decision?.rationale ?? '';
    const brainDecision: BrainDecisionData = {
      id: p.requestId ?? p.request?.id,
      kind: 'answered',
      question: p.request?.question,
      source: p.request?.source,
      risk: p.request?.risk,
      tier: p.tier,
      decisionType: p.decision?.type ?? 'answer',
      optionId: p.decision?.optionId,
      text,
      rationale,
      reason: p.decision?.reason,
      at: Date.now(),
    };
    chat.addMessage({
      role: 'assistant',
      content: `🧠 ${text}${rationale ? `\n\n_${rationale}_` : ''}`,
      brainDecision,
    });
  } else if (p.event === 'brain.decision_ask_human') {
    const brainDecision: BrainDecisionData = {
      id: p.requestId ?? p.request?.id,
      kind: 'ask_human',
      question: p.request?.question,
      source: p.request?.source,
      risk: p.request?.risk,
      tier: p.tier,
      decisionType: 'ask_human',
      rationale: p.decision?.rationale,
      reason: p.decision?.reason,
      at: Date.now(),
    };
    chat.addMessage({
      role: 'assistant',
      // The same event carries the PROMPT (a human is being waited on right
      // now) and a final ask_human (nothing is waiting — the chain simply had
      // no answer). Saying "it needs human judgement" for both told a user
      // to act on a decision that had already closed.
      content: p.pending
        ? '🧠 The Brain is waiting on you — this decision needs human judgement.'
        : '🧠 The Brain escalated this question back to you; no prompt is open for it.',
      brainDecision,
    });
  }
}
