/**
 * `fallback.suggest` — ready-made fallback chains (strong / balanced / fast /
 * budget) built ONLY from models the user can reach: every saved provider's
 * catalog list (models.dev, minus disabled models), never a hand-kept list.
 *
 * `mode: 'heuristic'` is deterministic and offline. `mode: 'llm'` additionally
 * asks the session's live model to re-rank the same pool with what it knows
 * about benchmark standing; the reply is validated against the pool in core
 * (`mergeLlmFallbackSuggestions`), and any failure degrades to the heuristic
 * result with the error reported — never to an empty card.
 */

import type { Provider, Request } from '@wrongstack/contracts/types';
import {
  buildFallbackSuggestPrompt,
  excludeListedModels,
  FALLBACK_SUGGEST_JSON_SCHEMA,
  FALLBACK_SUGGEST_SYSTEM_PROMPT,
  type FallbackSuggestCandidate,
  type FallbackSuggestion,
  mergeLlmFallbackSuggestions,
  selectLlmCandidatePool,
  suggestFallbackProfiles,
} from '@wrongstack/core/models';
import { toErrorMessage } from '@wrongstack/core/utils';
import type { WebSocket } from 'ws';
import type { WSServerMessage } from './types.js';

export type FallbackSuggestMode = 'heuristic' | 'llm';

export interface FallbackSuggestPayload {
  requestId?: string | undefined;
  sessionId?: string | undefined;
  mode?: FallbackSuggestMode | undefined;
  chainLength?: number | undefined;
  /**
   * The asking tab's live `disabledModels`. Merged with the server's own list
   * (which comes from a config snapshot and can lag a toggle made seconds ago).
   */
  disabledModels?: string[] | undefined;
  /** The asking tab's live `disabledProviders` — every model of these is excluded. */
  disabledProviders?: string[] | undefined;
}

export interface FallbackSuggestDeps {
  collectCandidates: () => Promise<FallbackSuggestCandidate[]>;
  /** The model that runs the LLM pass — the asking tab's live model. */
  resolveLlm: (
    sessionId?: string,
  ) => { provider?: Provider | undefined; model?: string | undefined } | undefined;
  send: (ws: WebSocket, message: WSServerMessage) => void;
  timeoutMs?: number | undefined;
}

const DEFAULT_LLM_TIMEOUT_MS = 90_000;
const LLM_MAX_TOKENS = 2_000;

export function parseFallbackSuggestPayload(input: unknown): FallbackSuggestPayload {
  const raw =
    input && typeof input === 'object' && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};
  return {
    requestId: typeof raw['requestId'] === 'string' ? raw['requestId'] : undefined,
    sessionId: typeof raw['sessionId'] === 'string' ? raw['sessionId'] : undefined,
    mode: raw['mode'] === 'llm' ? 'llm' : 'heuristic',
    chainLength:
      typeof raw['chainLength'] === 'number' && Number.isFinite(raw['chainLength'])
        ? raw['chainLength']
        : undefined,
    disabledModels: stringList(raw['disabledModels']),
    disabledProviders: stringList(raw['disabledProviders']),
  };
}

function stringList(value: unknown): string[] | undefined {
  return Array.isArray(value)
    ? value.filter((ref): ref is string => typeof ref === 'string').slice(0, 2_000)
    : undefined;
}

export async function handleFallbackSuggest(
  ws: WebSocket,
  input: unknown,
  deps: FallbackSuggestDeps,
): Promise<void> {
  const payload = parseFallbackSuggestPayload(input);
  const echo = {
    ...(payload.requestId ? { requestId: payload.requestId } : {}),
    ...(payload.sessionId ? { sessionId: payload.sessionId } : {}),
  };
  let candidates: FallbackSuggestCandidate[];
  try {
    const offProviders = new Set(
      (payload.disabledProviders ?? []).map((id) => id.trim().toLowerCase()),
    );
    candidates = excludeListedModels(
      (await deps.collectCandidates()).filter(
        (c) => !offProviders.has(c.provider.trim().toLowerCase()),
      ),
      payload.disabledModels,
    );
  } catch (error) {
    deps.send(ws, {
      type: 'fallback.suggestions',
      payload: {
        ...echo,
        mode: 'heuristic',
        suggestions: [],
        candidateCount: 0,
        error: toErrorMessage(error),
      },
    });
    return;
  }

  const options = { chainLength: payload.chainLength };
  const draft = suggestFallbackProfiles(candidates, options);
  if (payload.mode !== 'llm' || draft.length === 0) {
    deps.send(ws, {
      type: 'fallback.suggestions',
      payload: {
        ...echo,
        mode: 'heuristic',
        suggestions: draft,
        candidateCount: candidates.length,
      },
    });
    return;
  }

  const llm = deps.resolveLlm(payload.sessionId);
  const result = await runLlmPass(candidates, draft, options, llm, deps.timeoutMs);
  deps.send(ws, {
    type: 'fallback.suggestions',
    payload: {
      ...echo,
      mode: 'llm',
      suggestions: result.suggestions,
      candidateCount: candidates.length,
      ...(llm?.model
        ? { llmModel: llm.provider?.id ? `${llm.provider.id}/${llm.model}` : llm.model }
        : {}),
      ...(result.error ? { error: result.error } : {}),
      ...(result.rejected > 0 ? { rejected: result.rejected } : {}),
    },
  });
}

async function runLlmPass(
  candidates: FallbackSuggestCandidate[],
  draft: FallbackSuggestion[],
  options: { chainLength?: number | undefined },
  llm: { provider?: Provider | undefined; model?: string | undefined } | undefined,
  timeoutMs = DEFAULT_LLM_TIMEOUT_MS,
): Promise<{ suggestions: FallbackSuggestion[]; rejected: number; error?: string }> {
  if (!llm?.provider || !llm.model) {
    return { suggestions: draft, rejected: 0, error: 'No active model to run the LLM pass.' };
  }
  const pool = selectLlmCandidatePool(candidates);
  const req: Request = {
    model: llm.model,
    system: [{ type: 'text', text: FALLBACK_SUGGEST_SYSTEM_PROMPT }],
    messages: [{ role: 'user', content: buildFallbackSuggestPrompt(pool, draft, options) }],
    maxTokens: LLM_MAX_TOKENS,
  };
  if (llm.provider.capabilities.structuredOutput) {
    req.responseFormat = {
      type: 'json_schema',
      jsonSchema: {
        name: 'fallback_profiles',
        strict: false,
        schema: FALLBACK_SUGGEST_JSON_SCHEMA as unknown as Record<string, unknown>,
      },
    };
  } else if (llm.provider.capabilities.jsonMode) {
    req.responseFormat = { type: 'json_object' };
  }

  const timer = new AbortController();
  const to = setTimeout(() => timer.abort(new Error('fallback suggestion timeout')), timeoutMs);
  to.unref?.();
  try {
    const res = await llm.provider.complete(req, { signal: timer.signal });
    const text = res.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n');
    const merged = mergeLlmFallbackSuggestions(text, candidates, draft, options);
    const usedLlm = merged.suggestions.some((s) => s.source === 'llm');
    return usedLlm
      ? merged
      : { ...merged, error: 'The model reply had no usable chain; showing the heuristic result.' };
  } catch (error) {
    return { suggestions: draft, rejected: 0, error: toErrorMessage(error) };
  } finally {
    timer.abort();
    clearTimeout(to);
  }
}
