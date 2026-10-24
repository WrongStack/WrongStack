/**
 * Request middleware that puts a skill suggestion in front of the turn.
 *
 * The suggestion is appended as a VOLATILE system block after the roster, not
 * folded into it. The roster text stays byte-identical across turns, which is
 * what keeps the provider's cached prefix intact; `markVolatileSystemBlock`
 * tells wires without explicit cache breakpoints (OpenAI Responses / Codex,
 * which flatten every system block into one `instructions` string) to relocate
 * this block rather than let it invalidate that prefix.
 *
 * ## Why this caches per user message
 *
 * The request pipeline runs on EVERY provider call, tool-loop iterations
 * included — a single user turn can be a dozen calls. The suggestion is a
 * judgment about the USER'S REQUEST, and that does not change between
 * iterations, so calling TypeSafe on each one would multiply both the cost and
 * the added latency by the length of the turn for an identical answer. The
 * result is computed once per distinct user message and replayed for the rest
 * of the turn, which also keeps the block's text stable while the turn runs.
 *
 * ## What leaves the machine
 *
 * The latest user message text, and the roster's skill names plus their
 * one-line triggers (and, for the three shortlisted candidates, the opening of
 * their bodies). This is why the feature is OFF by default and why its config
 * subtree is stripped from in-project config: a repo-committed `endpoint`
 * would otherwise redirect every prompt this agent sees to a host the repo
 * chose.
 */

import type { Middleware } from '@wrongstack/contracts/kernel/pipeline';
import { markVolatileSystemBlock } from '@wrongstack/contracts/types/blocks';
import { authoredText } from '@wrongstack/contracts/types/live-context';
import type { Message } from '@wrongstack/contracts/types/messages';
import type { Request } from '@wrongstack/contracts/types/provider';
import type { SkillSuggester, SkillSuggestion } from './skill-suggester.js';

export interface SkillSuggestionMiddlewareOptions {
  suggester: SkillSuggester;
  getSessionId?: (() => string | undefined) | undefined;
  getAvailableToolNames?: (() => readonly string[]) | undefined;
  /**
   * Hard deadline for both TypeSafe passes combined. The suggestion is an
   * optimization sitting in front of the user's turn; past this point the turn
   * proceeds without one. Default 3000ms.
   */
  deadlineMs?: number | undefined;
  /**
   * Skip requests whose latest user message is shorter than this. Very short
   * turns ("yes", "go on", "fix it") carry no request to judge, and the gate
   * would be answering about a fragment. Default 12.
   */
  minRequestChars?: number | undefined;
  /** Observability hook; never throws into the turn. */
  onSuggestion?:
    | ((info: { suggestion: SkillSuggestion | undefined; sessionId: string | undefined }) => void)
    | undefined;
}

/** Sessions whose last suggestion is remembered. Mirrors the SAGE turn cache. */
const MAX_TRACKED_SESSIONS = 256;

interface CachedSuggestion {
  /** The user text this answer was computed for. */
  query: string;
  toolsKey: string | undefined;
  suggestion: SkillSuggestion | undefined;
  /** An unavailable evaluation must not become a negative relevance claim. */
  evaluated: boolean;
}

export function createSkillSuggestionMiddleware(
  opts: SkillSuggestionMiddlewareOptions,
): Middleware<Request> {
  const deadlineMs = opts.deadlineMs ?? 3_000;
  const minRequestChars = opts.minRequestChars ?? 12;
  const bySession = new Map<string, CachedSuggestion>();

  const remember = (key: string, entry: CachedSuggestion): void => {
    bySession.delete(key);
    bySession.set(key, entry);
    if (bySession.size > MAX_TRACKED_SESSIONS) {
      const oldest = bySession.keys().next().value;
      if (oldest !== undefined) bySession.delete(oldest);
    }
  };

  return {
    name: 'skills.suggest',
    owner: 'skills',
    async handler(request, next) {
      let nextRequest = request;
      try {
        const query = lastUserText(request.messages);
        if (query.length >= minRequestChars) {
          const sessionId = opts.getSessionId?.();
          const sessionKey = sessionId ?? '<no-session>';
          const cached = bySession.get(sessionKey);
          const availableToolNames = opts.getAvailableToolNames?.();
          const toolsKey =
            availableToolNames === undefined
              ? undefined
              : JSON.stringify([...new Set(availableToolNames)].sort());
          let suggestion: SkillSuggestion | undefined;
          let evaluated = false;
          if (cached && cached.query === query && cached.toolsKey === toolsKey) {
            suggestion = cached.suggestion;
            evaluated = cached.evaluated;
          } else {
            const controller = new AbortController();
            let timer: ReturnType<typeof setTimeout> | undefined;
            const deadline = new Promise<undefined>((resolve) => {
              timer = setTimeout(() => {
                controller.abort();
                resolve(undefined);
              }, deadlineMs);
            });
            (timer as unknown as { unref?: () => void }).unref?.();
            try {
              const trace = await Promise.race([
                opts.suggester.explain(query, controller.signal, { availableToolNames }),
                deadline,
              ]);
              evaluated =
                !controller.signal.aborted &&
                (trace?.stop === 'suggested' || trace?.stop === 'gate' || trace?.stop === 'fits');
              suggestion = evaluated ? trace?.suggestion : undefined;
            } finally {
              clearTimeout(timer);
            }
            // A miss is cached too: "nothing fits" is an answer, and re-asking
            // it on every tool-loop iteration is the same waste as re-asking a
            // hit.
            remember(sessionKey, { query, toolsKey, suggestion, evaluated });
            try {
              if (evaluated) opts.onSuggestion?.({ suggestion, sessionId });
            } catch {
              // An observer must not fail the turn it is observing.
            }
          }
          if (evaluated)
            nextRequest = {
              ...request,
              system: [
                ...(request.system ?? []),
                markVolatileSystemBlock({
                  type: 'text',
                  text: renderSuggestionBlock(suggestion?.name),
                  cache_control: { type: 'ephemeral' },
                }),
              ],
            };
        }
      } catch {
        nextRequest = request;
      }
      return next(nextRequest);
    },
  };
}

/**
 * The block appended after the roster.
 *
 * Two deliberate choices, both load-bearing:
 *
 * 1. It says the suggestion can be ignored. Pushing harder wins compliance on
 *    the WRONG suggestions too, and a wrong suggestion is worse than none —
 *    a confident pointer is more persuasive than silence.
 * 2. A turn with nothing to suggest still says so, rather than emitting no
 *    block. The skill manifest carries a standing "load a skill when one is
 *    relevant" instruction; sending nothing would leave that unopposed on
 *    exactly the turns where the gate decided nothing applies.
 *
 * `name` is always a roster entry — the suggester only returns names it sent
 * as Choice options and re-validated on the way back — so nothing
 * model-authored is interpolated here.
 */
export function renderSuggestionBlock(name: string | undefined): string {
  const body = name
    ? `Relevant to the current request: ${name}. Ignore this if it does not fit what ` +
      'the user actually asked for.'
    : 'No skill in the roster appears relevant to this request.';
  return `<skill_relevance>\n${body}\n</skill_relevance>`;
}

function lastUserText(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role !== 'user') continue;
    // Authored text only: the `[live_context]` tail is the host's, not a query.
    const text = authoredText(message, ' ').trim();
    if (text) return text;
  }
  return '';
}
