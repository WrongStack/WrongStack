/**
 * `--json-schema <file|json>`: a single-shot run whose answer is a JSON value a
 * script can consume.
 *
 * The schema rides in the prompt, the final answer is parsed (a surrounding
 * code fence is tolerated) and checked with core's validator. One repair turn
 * is allowed — same conversation, the errors spelled out — because a model
 * that got the shape almost right usually fixes it when told exactly where;
 * after that the run fails rather than looping on tokens.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { JSONSchema } from '@wrongstack/contracts/types';
import { type ValidationError, validateAgainstSchema } from '@wrongstack/core/utils';

/** Inline JSON when the value starts with `{`, otherwise a path relative to `cwd`. */
export async function resolveJsonSchemaFlag(
  value: string | boolean | undefined,
  cwd: string,
): Promise<JSONSchema | undefined> {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('--json-schema needs a JSON Schema file path or an inline JSON object');
  }
  const trimmed = value.trim();
  let text = trimmed;
  let source = 'inline JSON';
  if (!trimmed.startsWith('{')) {
    const file = path.resolve(cwd, trimmed);
    source = file;
    try {
      text = await fs.readFile(file, 'utf8');
    } catch (err) {
      const reason = (err as NodeJS.ErrnoException).code ?? String(err);
      throw new Error(`--json-schema: cannot read ${file} (${reason})`);
    }
  }
  let schema: unknown;
  try {
    schema = JSON.parse(text);
  } catch (err) {
    throw new Error(`--json-schema: ${source} is not valid JSON (${(err as Error).message})`);
  }
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
    throw new Error(`--json-schema: ${source} must be a JSON Schema object`);
  }
  return schema as JSONSchema;
}

/** Appended to the user's task. The task stays first: it is the instruction. */
export function withSchemaInstruction(query: string, schema: JSONSchema): string {
  return `${query}

When you are done, reply with ONLY a JSON value that validates against this JSON Schema — no prose, no code fence:
${JSON.stringify(schema)}`;
}

export type StructuredCheck = { ok: true; value: unknown } | { ok: false; errors: string[] };

/** Parse and validate a final answer. */
export function checkStructuredAnswer(
  text: string | undefined,
  schema: JSONSchema,
): StructuredCheck {
  if (!text?.trim()) return { ok: false, errors: ['the answer was empty'] };
  const fenced = text.trim().match(/^```(?:json)?\s*\n([\s\S]*?)\n?```$/);
  const body = (fenced?.[1] ?? text).trim();
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch (err) {
    return { ok: false, errors: [`not valid JSON (${(err as Error).message})`] };
  }
  const result = validateAgainstSchema(value, schema);
  if (result.ok) return { ok: true, value };
  return {
    ok: false,
    errors: result.errors.map((e: ValidationError) => `${e.path || '(root)'}: ${e.message}`),
  };
}

export function repairPrompt(errors: readonly string[]): string {
  return `Your last answer did not validate against the JSON Schema:
${errors.map((e) => `- ${e}`).join('\n')}
Reply with ONLY the corrected JSON value.`;
}
