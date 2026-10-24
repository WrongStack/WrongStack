import type { Plugin } from '@wrongstack/contracts/types';

export type ConventionalType =
  | 'feat'
  | 'fix'
  | 'docs'
  | 'style'
  | 'refactor'
  | 'test'
  | 'chore'
  | 'perf'
  | 'ci'
  | 'build'
  | 'revert';

// ---------------------------------------------------------------------------
// Commit message generation
// ---------------------------------------------------------------------------

export function generateCommitMessage(
  type: ConventionalType,
  scope: string | undefined,
  summary: string,
  body?: string | undefined,
): string {
  const scopePart = scope ? `(${scope})` : '';
  const footer = body ? `\n\n${body}` : '';
  return `${type}${scopePart}: ${summary}${footer}`;
}

const VALID_TYPES: ConventionalType[] = [
  'feat',
  'fix',
  'docs',
  'style',
  'refactor',
  'test',
  'chore',
  'perf',
  'ci',
  'build',
  'revert',
];

/**
 * Ask the host LLM (`api.llm`) for a conventional commit message from the
 * staged diff. Returns null on any failure (no api.llm, provider error, or
 * an unparseable / invalid response) so the caller keeps whatever the user
 * supplied. Provider/model follow `config.extensions['git-autocommit'].llm`,
 * then the session default.
 */
export async function generateCommitFromDiff(
  api: Parameters<Plugin['setup']>[0],
  stat: string,
  diff: string,
  signal?: AbortSignal,
): Promise<{ type: ConventionalType; scope?: string; summary: string; body?: string } | null> {
  if (!api.llm) return null;
  signal?.throwIfAborted();
  try {
    const result = await api.llm.complete(
      'Write a Conventional Commits message for this staged git diff. ' +
        'Respond with ONLY a JSON object of the form ' +
        '{"type": string, "scope": string, "summary": string, "body": string}. ' +
        `type is one of: ${VALID_TYPES.join(', ')}. ` +
        'scope is a short area (empty string if unclear). summary is an imperative, ' +
        'lower-case, <=72-char subject with no trailing period. body is an optional ' +
        'short explanation (empty string if not needed). No prose outside the JSON.\n\n' +
        `Stat:\n${stat}\n\nDiff:\n${diff}`,
      {
        system:
          'You are a precise release engineer writing Conventional Commits. Output only JSON.',
        role: 'document',
        responseFormat: 'json',
        signal,
      },
    );
    signal?.throwIfAborted();
    const parsed = JSON.parse(extractJsonObject(result.text)) as {
      type?: unknown;
      scope?: unknown;
      summary?: unknown;
      body?: unknown;
    };
    const type = VALID_TYPES.includes(parsed.type as ConventionalType)
      ? (parsed.type as ConventionalType)
      : null;
    const summary =
      typeof parsed.summary === 'string' && parsed.summary.trim() ? parsed.summary.trim() : null;
    if (!type || !summary) return null;
    const scope =
      typeof parsed.scope === 'string' && parsed.scope.trim() ? parsed.scope.trim() : undefined;
    const body =
      typeof parsed.body === 'string' && parsed.body.trim() ? parsed.body.trim() : undefined;
    return { type, summary, ...(scope ? { scope } : {}), ...(body ? { body } : {}) };
  } catch {
    signal?.throwIfAborted();
    return null;
  }
}

/** Pull the first {...} JSON object out of a possibly-fenced response. */
function extractJsonObject(text: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const body = fenced?.[1] ?? text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  return start >= 0 && end > start ? body.slice(start, end + 1) : body.trim();
}
