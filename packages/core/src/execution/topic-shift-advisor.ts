import { createHash } from 'node:crypto';
import type { Context } from '../core/context.js';
import { isTextBlock, type Message, type Provider } from '../types/index.js';
import { createContextEvidenceState } from '../utils/context-evidence.js';

const TOPIC_ADVISOR_SYSTEM = [
  'You classify whether a new user prompt belongs in the current coding conversation.',
  'Choose new_context only when the user is starting a materially different goal whose old chat would add noise.',
  'Choose same_context for follow-ups, tests, documentation, fixes, questions, or next steps about the current work.',
  'Reply with ONLY JSON: {"decision":"new_context|same_context","confidence":0..1,"reason":"short phrase","nextTopic":"short label"}.',
].join(' ');

const STRONG_SHIFT_PATTERN =
  /\b(?:new\s+topic|different\s+topic|unrelated\s+(?:question|task)|switch\s+topics?|fresh\s+context|yeni\s+konu|farkl[ıi]\s+(?:bir\s+)?konu|alakas[ıi]z\s+(?:bir\s+)?(?:soru|i[şs])|konuyu\s+de[ğg]i[şs]tir)\b/iu;
const FOLLOW_UP_PATTERN =
  /^(?:devam(?:\s+et)?|continue|go\s+on|bunu|onu|şunu|fix\s+it|run\s+(?:the\s+)?tests?|testleri|dok(?:ü|u)man(?:ları)?|commit(?:le)?|push(?:la)?|tamam|evet|hay[ıi]r)(?:\b|[.!?,])/iu;
const WORD_PATTERN = /[\p{L}\p{N}_./:@-]{2,}/gu;
const STOP_WORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'this',
  'that',
  'from',
  'bir',
  'bu',
  've',
  'ile',
  'için',
  'icin',
  'gibi',
  'daha',
  'şimdi',
  'simdi',
  'yap',
  'et',
  'eder',
  'olan',
  'olarak',
  'kod',
  'code',
  'file',
  'dosya',
]);

export interface TopicShiftAdvice {
  suggestNewContext: boolean;
  confidence: number;
  reason: string;
  nextTopic?: string | undefined;
  source: 'explicit' | 'model' | 'cache' | 'local';
}

export interface TopicShiftAdvisorInput {
  prompt: string;
  messages: readonly Message[];
  provider?: Provider | undefined;
  model?: string | undefined;
  contextTokens?: number | undefined;
  maxContext?: number | undefined;
  signal?: AbortSignal | undefined;
  /** Notifies prompt surfaces only when the remote ambiguity check actually runs. */
  onModelCheck?: ((busy: boolean) => void) | undefined;
}

export interface TopicShiftAdvisorOptions {
  capacity?: number | undefined;
  ttlMs?: number | undefined;
  timeoutMs?: number | undefined;
  now?: (() => number) | undefined;
}

interface CachedAdvice {
  advice: TopicShiftAdvice;
  expiresAt: number;
}

/**
 * Best-effort, bounded topic-boundary advisor for prompt-submit surfaces.
 *
 * Most prompts finish in the local gate. A separate provider call happens
 * only after history is substantial AND the new prompt has little lexical
 * continuity with recent user goals. Results are held in a small TTL/LRU so
 * edit/retry or duplicate submits never pay twice.
 */
export class TopicShiftAdvisor {
  private readonly capacity: number;
  private readonly ttlMs: number;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly cache = new Map<string, CachedAdvice>();

  constructor(options: TopicShiftAdvisorOptions = {}) {
    this.capacity = positiveInteger(options.capacity, 64);
    this.ttlMs = positiveNumber(options.ttlMs, 30 * 60_000);
    this.timeoutMs = positiveNumber(options.timeoutMs, 8_000);
    this.now = options.now ?? Date.now;
  }

  async advise(input: TopicShiftAdvisorInput): Promise<TopicShiftAdvice> {
    const prompt = compact(input.prompt, 2_000);
    const recent = recentConversationText(input.messages);
    if (!topicCheckNeeded(recent, input.contextTokens, input.maxContext) || prompt.length < 12) {
      return localSame('Conversation history is still compact.');
    }

    const strongShift = STRONG_SHIFT_PATTERN.test(prompt);
    if (!strongShift && prompt.length <= 100 && FOLLOW_UP_PATTERN.test(prompt)) {
      return localSame('Prompt is an explicit continuation.');
    }

    const historyTerms = topicTerms(recent.userText);
    const promptTerms = topicTerms(prompt);
    const overlap = overlapRatio(historyTerms, promptTerms);
    if (!strongShift && (overlap >= 0.12 || sharesSpecificIdentifier(historyTerms, promptTerms))) {
      return localSame('Prompt overlaps the current topic.');
    }

    const cacheKey = hashKey(`${recent.basis}\n---\n${prompt}`);
    const cached = this.get(cacheKey);
    if (cached) return { ...cached, source: 'cache' };

    if (!input.provider || !input.model) {
      const advice = strongShift
        ? {
            suggestNewContext: true,
            confidence: 0.98,
            reason: 'The prompt explicitly asks to change topics.',
            source: 'explicit' as const,
          }
        : localSame('Topic classifier is unavailable; continuing safely.');
      this.set(cacheKey, advice);
      return advice;
    }

    const modelAdvice = await this.classify(input, prompt, recent.basis);
    const advice =
      modelAdvice ??
      (strongShift
        ? {
            suggestNewContext: true,
            confidence: 0.95,
            reason: 'The prompt explicitly asks to change topics.',
            source: 'explicit' as const,
          }
        : localSame('Topic check failed; continuing without interruption.'));
    this.set(cacheKey, advice);
    return advice;
  }

  private async classify(
    input: TopicShiftAdvisorInput,
    prompt: string,
    historyBasis: string,
  ): Promise<TopicShiftAdvice | null> {
    const timeout = new AbortController();
    const timer = setTimeout(
      () => timeout.abort(new Error('topic advisor timeout')),
      this.timeoutMs,
    );
    const signal = input.signal ? AbortSignal.any([input.signal, timeout.signal]) : timeout.signal;
    input.onModelCheck?.(true);
    try {
      const response = await input.provider!.complete(
        {
          model: input.model!,
          system: [
            {
              type: 'text',
              text: TOPIC_ADVISOR_SYSTEM,
              cache_control: { type: 'ephemeral' },
            },
          ],
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'text',
                  text: `CURRENT CONVERSATION (bounded):\n${historyBasis}\n\nNEW PROMPT:\n${prompt}`,
                },
              ],
            },
          ],
          maxTokens: 180,
        },
        { signal },
      );
      const text = response.content
        .filter(isTextBlock)
        .map((block) => block.text)
        .join('\n');
      return parseModelAdvice(text);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
      input.onModelCheck?.(false);
    }
  }

  private get(key: string): TopicShiftAdvice | null {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= this.now()) {
      this.cache.delete(key);
      return null;
    }
    this.cache.delete(key);
    this.cache.set(key, entry);
    return entry.advice;
  }

  private set(key: string, advice: TopicShiftAdvice): void {
    this.cache.delete(key);
    this.cache.set(key, { advice, expiresAt: this.now() + this.ttlMs });
    while (this.cache.size > this.capacity) {
      const oldest = this.cache.keys().next().value as string | undefined;
      if (!oldest) break;
      this.cache.delete(oldest);
    }
  }
}

/**
 * Start a clean model context without deleting the session journal or visible
 * chat. Durable memory, provider/model selection, settings and project state
 * remain owned by their existing services.
 */
export async function startFreshTopicContext(ctx: Context): Promise<void> {
  await ctx.flushConversationJournal();
  ctx.state.replaceMessages([
    {
      role: 'system',
      content:
        "[context_boundary: A fresh topic context started at the user's request. Previous chat remains in the session log but is intentionally not part of this prompt.]",
    },
  ]);
  ctx.state.replaceTodos([]);
  ctx.clearFileTracking();
  ctx.contextEvidence = createContextEvidenceState();
  ctx.toolAdjacencyDirty = false;
  ctx.pendingPostToolContext = undefined;
  ctx.clearMemoryEvidence?.();
  ctx.lastRequestTokens = undefined;
  ctx.lastRealInputTokens = undefined;
  delete ctx.meta['lastRequestTokensAt'];
  delete ctx.meta['realAnchorMsgCount'];
  await ctx.flushConversationJournal();
}

function recentConversationText(messages: readonly Message[]): {
  basis: string;
  userText: string;
  userTurns: number;
  chars: number;
} {
  const turns: Array<{ role: 'user' | 'assistant'; text: string }> = [];
  let userTurns = 0;
  let chars = 0;
  for (let i = messages.length - 1; i >= 0 && turns.length < 10; i--) {
    const message = messages[i];
    if (!message || (message.role !== 'user' && message.role !== 'assistant')) continue;
    const text = messageText(message);
    if (!text) continue;
    const bounded = compact(text, 800);
    turns.unshift({ role: message.role, text: bounded });
    chars += bounded.length;
  }
  for (const message of messages) {
    if (message.role === 'user' && messageText(message)) userTurns++;
  }
  const userText = turns
    .filter((turn) => turn.role === 'user')
    .map((turn) => turn.text)
    .join(' ');
  return {
    basis: turns.map((turn) => `${turn.role}: ${turn.text}`).join('\n'),
    userText,
    userTurns,
    chars,
  };
}

function topicCheckNeeded(
  recent: { userTurns: number; chars: number },
  contextTokens?: number,
  maxContext?: number,
): boolean {
  if (recent.userTurns < 5) return false;
  const load =
    typeof contextTokens === 'number' &&
    typeof maxContext === 'number' &&
    maxContext > 0 &&
    Number.isFinite(contextTokens)
      ? contextTokens / maxContext
      : 0;
  return recent.userTurns >= 9 || recent.chars >= 8_000 || load >= 0.2;
}

function messageText(message: Message): string {
  if (typeof message.content === 'string') return message.content.trim();
  return message.content
    .filter(isTextBlock)
    .map((block) => block.text)
    .join(' ')
    .trim();
}

function topicTerms(text: string): Set<string> {
  const terms = new Set<string>();
  for (const match of text.toLocaleLowerCase('en-US').matchAll(WORD_PATTERN)) {
    const term = match[0];
    if (!term || STOP_WORDS.has(term) || term.length < 3) continue;
    terms.add(term);
    if (terms.size >= 160) break;
  }
  return terms;
}

function overlapRatio(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const term of right) if (left.has(term)) shared++;
  return shared / Math.min(left.size, right.size);
}

function sharesSpecificIdentifier(left: Set<string>, right: Set<string>): boolean {
  for (const term of right) {
    if (term.length >= 7 && left.has(term)) return true;
    if ((term.includes('/') || term.includes('.') || term.includes('_')) && left.has(term))
      return true;
  }
  return false;
}

function parseModelAdvice(text: string): TopicShiftAdvice | null {
  const match = /\{[\s\S]*\}/.exec(text);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]) as Record<string, unknown>;
    if (parsed['decision'] !== 'new_context' && parsed['decision'] !== 'same_context') return null;
    const confidence =
      typeof parsed['confidence'] === 'number' && Number.isFinite(parsed['confidence'])
        ? Math.max(0, Math.min(1, parsed['confidence']))
        : 0;
    const reason = compact(
      typeof parsed['reason'] === 'string' ? parsed['reason'] : 'Topic continuity check.',
      180,
    );
    const nextTopic =
      typeof parsed['nextTopic'] === 'string' ? compact(parsed['nextTopic'], 80) : undefined;
    return {
      suggestNewContext: parsed['decision'] === 'new_context' && confidence >= 0.78,
      confidence,
      reason,
      ...(nextTopic ? { nextTopic } : {}),
      source: 'model',
    };
  } catch {
    return null;
  }
}

function localSame(reason: string): TopicShiftAdvice {
  return { suggestNewContext: false, confidence: 1, reason, source: 'local' };
}

function compact(text: string, maxChars: number): string {
  const value = text.replace(/\s+/g, ' ').trim();
  return value.length <= maxChars ? value : `${value.slice(0, maxChars - 1)}…`;
}

function hashKey(value: string): string {
  return createHash('sha256').update(value).digest('base64url');
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback;
}

function positiveNumber(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}
