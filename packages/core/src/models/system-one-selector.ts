/**
 * System One message selector for the selective compactor.
 *
 * `LLMSelector` asks a chat model to write a keep/collapse plan as JSON —
 * ranges, importance tiers and all — and falls back to plain recency whenever
 * the JSON is missing, malformed, out of bounds or overlapping. The judgment
 * inside that plan is narrow ("does the current goal still need this part of
 * the conversation?"); the rest (range bookkeeping, fitting a token budget)
 * is arithmetic a model is bad at and code is exact at.
 *
 * So the work is split:
 *
 *   - code cuts the history into turns (a turn starts at a user message that
 *     carries text, so a tool_use is never separated from its tool_result),
 *   - one TypeSafe `Score` per middle turn rates how much the current goal
 *     still needs it,
 *   - code keeps the live tail and the opening turn, then packs the rated
 *     turns into the budget, most-needed and most-recent first.
 *
 * Any failure — no judge, host resting, a missing answer, a tail that alone
 * overflows the budget — hands the whole decision to the wrapped selector,
 * which is the LLM selector the compactor would have used anyway.
 */

import { isTextBlock } from '@wrongstack/contracts/types/blocks';
import type { Message } from '@wrongstack/contracts/types/messages';
import type { MessageSelector, SelectorResult } from '@wrongstack/contracts/types/selector';
import type { TypeSafeQuestion } from '../typesafe/client.js';
import type { TypeSafeJudge } from '../typesafe/judgments.js';
import { buildCompactionPreview } from '../utils/compaction-preview.js';
import { estimateMessageTokens } from '../utils/token-estimate.js';

export interface SystemOneSelectorOptions {
  getJudge: () => TypeSafeJudge | undefined;
  /** Selector used whenever this one cannot decide. */
  fallback: MessageSelector;
  /** Most recent turns always kept verbatim. Default 2. */
  tailTurns?: number | undefined;
  /** Preview characters per turn sent as state. Default 600. */
  previewChars?: number | undefined;
  /** Turns rated per request (state budget). Default 40. */
  turnsPerRequest?: number | undefined;
  timeoutMs?: number | undefined;
}

const LEVELS = [
  'Not needed: finished or abandoned work, dead ends, or chatter the current goal does not depend on.',
  'Background: helps understand the current goal, but a short summary would lose nothing important.',
  'Needed verbatim: a decision, constraint, error, file content or user instruction the current goal still depends on.',
];

interface Turn {
  from: number;
  to: number;
  tokens: number;
}

function isTurnStart(message: Message): boolean {
  if (message.role !== 'user') return false;
  if (typeof message.content === 'string') return message.content.trim().length > 0;
  if (!Array.isArray(message.content)) return false;
  const blocks = message.content as Array<{ type?: string }>;
  return blocks.some((b) => b.type === 'text') && !blocks.some((b) => b.type === 'tool_result');
}

function splitTurns(messages: Message[]): Turn[] {
  const turns: Turn[] = [];
  let start = 0;
  for (let i = 1; i <= messages.length; i++) {
    if (i === messages.length || isTurnStart(messages[i] as Message)) {
      const slice = messages.slice(start, i);
      turns.push({ from: start, to: i - 1, tokens: estimateMessageTokens(slice) });
      start = i;
    }
  }
  return turns;
}

function userText(message: Message | undefined): string {
  if (!message) return '';
  if (typeof message.content === 'string') return message.content;
  if (!Array.isArray(message.content)) return '';
  return message.content
    .filter(isTextBlock)
    .map((b) => b.text)
    .join('\n');
}

function preview(messages: Message[], turn: Turn, chars: number): string {
  const per = Math.max(80, Math.floor(chars / Math.max(1, turn.to - turn.from + 1)));
  const lines: string[] = [];
  let used = 0;
  for (let i = turn.from; i <= turn.to && used < chars; i++) {
    const line = `${(messages[i] as Message).role}: ${buildCompactionPreview(messages[i] as Message, per)}`;
    lines.push(line);
    used += line.length;
  }
  return lines.join('\n').slice(0, chars);
}

/** Merge sorted, possibly adjacent index ranges. */
function mergeRanges<T extends { from: number; to: number }>(
  ranges: T[],
  same: (a: T, b: T) => boolean,
): T[] {
  const sorted = [...ranges].sort((a, b) => a.from - b.from);
  const out: T[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && last.to + 1 === r.from && same(last, r)) last.to = r.to;
    else out.push({ ...r });
  }
  return out;
}

export class SystemOneSelector implements MessageSelector {
  private readonly tailTurns: number;
  private readonly previewChars: number;
  private readonly turnsPerRequest: number;
  private readonly timeoutMs: number;

  constructor(private readonly opts: SystemOneSelectorOptions) {
    this.tailTurns = Math.max(1, opts.tailTurns ?? 2);
    this.previewChars = Math.max(120, opts.previewChars ?? 600);
    this.turnsPerRequest = Math.max(1, opts.turnsPerRequest ?? 40);
    this.timeoutMs = opts.timeoutMs ?? 8_000;
  }

  async select(messages: Message[], maxToKeep: number): Promise<SelectorResult> {
    const planned = await this.plan(messages, maxToKeep).catch(() => undefined);
    return planned ?? this.opts.fallback.select(messages, maxToKeep);
  }

  private async plan(messages: Message[], budget: number): Promise<SelectorResult | undefined> {
    const judge = this.opts.getJudge();
    if (!judge) return undefined;
    const turns = splitTurns(messages);
    // Opening turn + tail + at least one middle turn, or there is no choice.
    if (turns.length < this.tailTurns + 2) return undefined;

    const tail = turns.slice(-this.tailTurns);
    const head = turns[0] as Turn;
    const middle = turns.slice(1, -this.tailTurns);
    const tailTokens = tail.reduce((sum, t) => sum + t.tokens, 0);
    if (tailTokens > budget) return undefined;

    const lastTail = tail[tail.length - 1] as Turn;
    const goal = userText(messages[lastTail.from]).slice(0, 2_000);
    const levels = await this.rate(messages, middle, goal, judge);
    if (!levels) return undefined;

    let used = tailTokens;
    const keep = new Map<Turn, 'critical' | 'high' | 'medium'>();
    for (const t of tail) keep.set(t, 'critical');
    // The opening turn usually carries the task's original constraints.
    if (used + head.tokens <= budget) {
      keep.set(head, 'high');
      used += head.tokens;
    }
    const order = middle
      .map((turn, i) => ({ turn, level: levels[i] as number, i }))
      .filter((x) => x.level > 0)
      .sort((a, b) => b.level - a.level || b.i - a.i);
    for (const { turn, level } of order) {
      if (used + turn.tokens > budget) continue;
      keep.set(turn, level === 2 ? 'high' : 'medium');
      used += turn.tokens;
    }

    const kept = mergeRanges(
      [...keep].map(([t, importance]) => ({ from: t.from, to: t.to, importance })),
      (a, b) => a.importance === b.importance,
    );
    const collapsed = mergeRanges(
      turns.filter((t) => !keep.has(t)).map((t) => ({ from: t.from, to: t.to })),
      () => true,
    );
    return {
      kept,
      collapsed,
      reasoning:
        `System One rated ${middle.length} turn(s); kept ${keep.size}/${turns.length} ` +
        `(~${used}/${budget} tokens).`,
    };
  }

  /** One level (0..2) per middle turn, or `undefined` if any answer is missing. */
  private async rate(
    messages: Message[],
    middle: Turn[],
    goal: string,
    judge: TypeSafeJudge,
  ): Promise<number[] | undefined> {
    const chunks: Turn[][] = [];
    for (let i = 0; i < middle.length; i += this.turnsPerRequest) {
      chunks.push(middle.slice(i, i + this.turnsPerRequest));
    }
    const signal = AbortSignal.timeout(this.timeoutMs);
    const rated = await Promise.all(
      chunks.map(async (chunk) => {
        const questions: Record<string, TypeSafeQuestion> = {};
        chunk.forEach((_, i) => {
          questions[`t${i}`] = {
            type: 'score',
            instructions: `How much does \`currentGoal\` still depend on \`turns[${i}]\` of the conversation?`,
            criteria: LEVELS,
          };
        });
        const result = await judge.client.systemOne(
          {
            activityFeature: judge.feature,
            state: {
              currentGoal: goal,
              turns: chunk.map((t) => preview(messages, t, this.previewChars)),
            },
            questions,
            model: judge.model,
          },
          signal,
        );
        return chunk.map((_, i) => {
          const answer = result.answers[`t${i}`];
          if (answer?.type !== 'score') return undefined;
          let best = -1;
          let bestP = -1;
          for (const [key, p] of Object.entries(answer.probabilities)) {
            const idx = Number(key);
            if (Number.isInteger(idx) && idx >= 0 && idx < LEVELS.length && p > bestP) {
              best = idx;
              bestP = p;
            }
          }
          if (best < 0) best = Math.min(2, Math.max(0, Math.round(answer.score)));
          // An unsure "not needed" is kept as background: dropping context
          // the goal needed costs more than keeping a turn it did not.
          if (best === 0 && answer.confidence < 0.5) best = 1;
          return best;
        });
      }),
    );
    const flat = rated.flat();
    return flat.every((level) => level !== undefined) ? (flat as number[]) : undefined;
  }
}
