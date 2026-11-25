/**
 * Small, shared helpers for optional plugin LLM enrichment.
 *
 * The host-owned `api.llm` facade keeps provider credentials and routing out
 * of plugins. These helpers standardise the other half of that contract:
 * bounded prompts, cancellation, defensive response parsing, and an explicit
 * deterministic fallback when no provider is wired or generation fails.
 */

import type { CouncilOption, PluginAPI, PluginLLMOptions } from '@wrongstack/contracts/types';

export interface OptionalLlmResult<T> {
  used: boolean;
  value: T | null;
  fallbackReason:
    | 'not-requested'
    | 'unavailable'
    | 'cancelled'
    | 'provider-error'
    | 'invalid-response'
    | null;
}

export interface OptionalLlmRequest<T> {
  requested: boolean;
  prompt: string;
  options?: PluginLLMOptions | undefined;
  parse(text: string): T | null;
  api: Pick<PluginAPI, 'llm' | 'log'>;
  label: string;
}

export interface OptionalCouncilRequest<T> extends OptionalLlmRequest<T> {
  context?: string | undefined;
  profile?: string | undefined;
  councilOptions?: readonly CouncilOption[] | undefined;
}

/** Remove one outer Markdown fence without modifying inner code fences. */
export function stripOuterMarkdownFence(text: string): string {
  const trimmed = text.trim();
  const match =
    trimmed.match(/^```(?:[a-z0-9_-]+)?[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*```$/i) ??
    trimmed.match(/^```(?:[a-z0-9_-]+)?[ \t]+([^\r\n`]+?)[ \t]*```$/i);
  return (match?.[1] ?? trimmed).trim();
}

/** Parse a JSON object from a plain or fenced provider response. */
export function parseLlmJsonObject(text: string): Record<string, unknown> | null {
  const candidate = stripOuterMarkdownFence(text);
  try {
    const parsed: unknown = JSON.parse(candidate);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function safeErrorText(error: unknown): string {
  try {
    return error instanceof Error ? error.message : String(error);
  } catch {
    return 'unknown error';
  }
}

/**
 * Run optional enrichment without turning a provider outage into a tool
 * failure. Abort remains observable as a fallback reason and the caller's
 * deterministic result remains authoritative.
 */
export async function runOptionalPluginLlm<T>(
  request: OptionalLlmRequest<T>,
): Promise<OptionalLlmResult<T>> {
  if (!request.requested) {
    return { used: false, value: null, fallbackReason: 'not-requested' };
  }
  if (!request.api.llm) {
    return { used: false, value: null, fallbackReason: 'unavailable' };
  }
  if (request.options?.signal?.aborted) {
    return { used: false, value: null, fallbackReason: 'cancelled' };
  }

  try {
    const response = await request.api.llm.complete(request.prompt, request.options);
    if (request.options?.signal?.aborted) {
      return { used: false, value: null, fallbackReason: 'cancelled' };
    }
    let parsed: T | null;
    try {
      parsed = request.parse(response.text);
    } catch {
      parsed = null;
    }
    if (parsed === null) {
      request.api.log.warn(`${request.label}: ignored invalid LLM response`);
      return { used: false, value: null, fallbackReason: 'invalid-response' };
    }
    return { used: true, value: parsed, fallbackReason: null };
  } catch (error) {
    const cancelled = request.options?.signal?.aborted === true;
    request.api.log.warn(`${request.label}: LLM enrichment failed; using deterministic fallback`, {
      error: safeErrorText(error),
    });
    return {
      used: false,
      value: null,
      fallbackReason: cancelled ? 'cancelled' : 'provider-error',
    };
  }
}

/**
 * Prefer the host Council for consequential analysis, then degrade through the
 * same One Shot helper and finally the caller's deterministic result. Council
 * outages therefore never turn an optional enrichment into a tool failure.
 */
export async function runOptionalPluginCouncil<T>(
  request: OptionalCouncilRequest<T>,
): Promise<OptionalLlmResult<T>> {
  if (!request.requested) {
    return { used: false, value: null, fallbackReason: 'not-requested' };
  }
  if (request.options?.signal?.aborted) {
    return { used: false, value: null, fallbackReason: 'cancelled' };
  }
  const council = request.api.llm?.council;
  if (council) {
    try {
      const result = await council(request.prompt, {
        ...(request.context ? { context: request.context } : {}),
        ...(request.profile ? { profile: request.profile } : {}),
        ...(request.councilOptions ? { options: request.councilOptions } : {}),
        ...(request.options?.signal ? { signal: request.options.signal } : {}),
        ...(request.options?.timeoutMs !== undefined
          ? { timeoutMs: request.options.timeoutMs }
          : {}),
      });
      if (request.options?.signal?.aborted || result.status === 'cancelled') {
        return { used: false, value: null, fallbackReason: 'cancelled' };
      }
      let parsed: T | null = null;
      if (result.status === 'decided') {
        try {
          parsed = request.parse(result.answer ?? '');
        } catch {
          parsed = null;
        }
      }
      if (parsed !== null) return { used: true, value: parsed, fallbackReason: null };
      request.api.log.warn(
        `${request.label}: Council did not return a valid answer; trying One Shot`,
        {
          status: result.status,
          resolution: result.resolution,
        },
      );
    } catch (error) {
      if (request.options?.signal?.aborted) {
        return { used: false, value: null, fallbackReason: 'cancelled' };
      }
      request.api.log.warn(`${request.label}: Council failed; trying One Shot`, {
        error: safeErrorText(error),
      });
    }
  }
  return runOptionalPluginLlm(request);
}
