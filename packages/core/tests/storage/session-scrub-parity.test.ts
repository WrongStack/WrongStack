/**
 * Every session event carrying free-form error text must be scrubbed.
 *
 * The session journal is durable and replayed into later context, so anything
 * unscrubbed here persists indefinitely. `scrubSessionWriterEvent` handled
 * eleven event types and had NO case for `error` — whose `message` is raw
 * provider error text, one of the two places a credential most reliably comes
 * back at you (a gateway echoing `Authorization`, a connection string with an
 * inline password). It fell through to the unscrubbed `return event` while
 * every neighbouring type was handled. `task_failed.error` and
 * `agent_error.error` had the same gap.
 *
 * Adding those three cases fixes today. This file is about tomorrow: it walks
 * the `SessionEvent` union in the type source and fails when a variant with a
 * free-text error field has no case in the scrubber. The behavioural tests
 * below prove the scrubber actually redacts; the structural test proves nobody
 * can add variant number 48 without deciding.
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DefaultSecretScrubber } from '../../src/security/secret-scrubber.js';
import { scrubSessionWriterEvent } from '../../src/storage/session-writer-scrubber.js';
import type { SessionEvent } from '../../src/types/session.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CORE_SRC = path.resolve(HERE, '../../src');

/**
 * Variants declaring a free-text field whose value is a thrown error or a
 * human message — the class that must never land in the journal raw.
 *
 * `reason` fields in this union are closed string unions, not free text, so
 * they are out of scope. `description` on the two provider variants IS in
 * scope: their `errorBody` is documented as scrubbed at the emit site, but
 * `description` is free text whose construction was not traceable to a closed
 * set of categories, so it is scrubbed defensively rather than assumed safe.
 */
const FREE_TEXT_ERROR_FIELDS: Record<string, string> = {
  error: 'message',
  task_failed: 'error',
  agent_error: 'error',
  provider_error: 'description',
  provider_retry: 'description',
};

function scrubberSource(): string {
  return readFileSync(path.join(CORE_SRC, 'storage/session-writer-scrubber.ts'), 'utf8');
}

/**
 * Remove line and block comments so a variant mentioned only in prose cannot
 * satisfy the handled-check. Deliberately naive: it does not track string
 * literals, so its worst case is stripping too much and failing LOUDLY. A
 * guard that errs toward a false alarm is the safe direction; one that errs
 * toward silence is the bug this file was written about.
 */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/\/\/.*/gu, '');
}

/**
 * A variant counts as handled only when the scrubber actually COMPARES
 * `event.type` against it in live code. The former check was
 * `source.includes("'<variant>'")`, which any mention anywhere satisfied.
 */
function unhandledVariants(source: string): string[] {
  const code = withoutComments(source);
  return Object.keys(FREE_TEXT_ERROR_FIELDS).filter(
    (variant) => !new RegExp(String.raw`event\.type\s*===\s*(['"])${variant}\1`, 'u').test(code),
  );
}

const scrubber = new DefaultSecretScrubber();
const SECRET = 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

function scrub(event: SessionEvent): SessionEvent {
  return scrubSessionWriterEvent(event, scrubber);
}

describe('session writer scrubs free-text error fields', () => {
  it('scrubs error.message', () => {
    const out = scrub({
      type: 'error',
      ts: '2026-01-01T00:00:00.000Z',
      message: `provider rejected: Authorization: Bearer ${SECRET}`,
      phase: 'llm',
    }) as Extract<SessionEvent, { type: 'error' }>;
    expect(out.message).not.toContain(SECRET);
    // The message survives — scrubbing removes the credential, not the detail.
    expect(out.message).toContain('provider rejected');
  });

  it('scrubs task_failed.error', () => {
    const out = scrub({
      type: 'task_failed',
      ts: '2026-01-01T00:00:00.000Z',
      taskId: 't1',
      title: 'build',
      error: `failed with key ${SECRET}`,
    }) as Extract<SessionEvent, { type: 'task_failed' }>;
    expect(out.error).not.toContain(SECRET);
  });

  it('scrubs agent_error.error', () => {
    const out = scrub({
      type: 'agent_error',
      ts: '2026-01-01T00:00:00.000Z',
      agentId: 'a1',
      error: `subagent crashed: ${SECRET}`,
    }) as Extract<SessionEvent, { type: 'agent_error' }>;
    expect(out.error).not.toContain(SECRET);
  });

  it('leaves the event shape otherwise intact', () => {
    const input: SessionEvent = {
      type: 'error',
      ts: '2026-01-01T00:00:00.000Z',
      message: 'plain failure',
      phase: 'tool',
    };
    expect(scrub(input)).toEqual(input);
  });

  it('is a no-op without a scrubber, as before', () => {
    const input: SessionEvent = {
      type: 'error',
      ts: '2026-01-01T00:00:00.000Z',
      message: `raw ${SECRET}`,
      phase: 'llm',
    };
    expect(scrubSessionWriterEvent(input, undefined)).toEqual(input);
  });
});

describe('session scrub parity — the union cannot outgrow the scrubber', () => {
  /** Variant names declared in the `SessionEvent` union. */
  function unionVariants(): string[] {
    const source = readFileSync(path.join(CORE_SRC, 'types/session.ts'), 'utf8');
    return [...new Set([...source.matchAll(/type:\s*'([a-z_]+)'/g)].map((m) => m[1] as string))];
  }

  it('every known free-text error variant is handled by the scrubber', () => {
    const unhandled = unhandledVariants(scrubberSource());
    expect(
      unhandled,
      'These SessionEvent variants carry raw error text but have no case in ' +
        'scrubSessionWriterEvent, so they are written to the durable journal ' +
        'verbatim. Variants:',
    ).toEqual([]);
  });

  it('the union has not grown a new free-text error variant unnoticed', () => {
    // A ratchet on shape, not a count of everything: if a NEW variant appears
    // whose name ends in `_error`/`_failed` or is `error`, it must be listed
    // above with a decision, scrubbed or explicitly excluded.
    const candidates = unionVariants().filter(
      (name) => name === 'error' || name.endsWith('_error') || name.endsWith('_failed'),
    );
    const undecided = candidates.filter((name) => !(name in FREE_TEXT_ERROR_FIELDS));
    expect(
      undecided,
      'New SessionEvent variant(s) that look like they carry error text. Add a ' +
        'case to scrubSessionWriterEvent, then list them above — or list them ' +
        'with a comment saying why they are safe raw. Variants:',
    ).toEqual([]);
  });

  // SECURITY.md rule 3: validate a guard by injection, never by watching it
  // pass. The two tests below re-introduce the exact vulnerability this file
  // exists to catch and assert the guard NOTICES. Neither touches disk — each
  // feeds a mutated copy of the real source through the same predicate the
  // test above uses, so they fail if the predicate is ever weakened.
  it('injection: deleting a real case is reported as unhandled', () => {
    const mutated = scrubberSource().replace(
      "event.type === 'error'",
      "event.type === 'definitely_not_error'",
    );
    expect(
      mutated,
      'injection did not apply — the comparison this test mutates was ' +
        'renamed, so the assertion below would pass vacuously',
    ).not.toBe(scrubberSource());
    expect(unhandledVariants(mutated)).toEqual(['error']);
  });

  it('injection: a case surviving only in a comment does not count as handled', () => {
    // The predecessor of this guard was a bare `source.includes("'error'")`
    // over the whole file. It passed on any mention anywhere — including a
    // doc-comment describing a case that had since been deleted. This file's
    // comments happen to use backticks, so the hole never fired; that is luck,
    // not a guarantee, and luck is not a control.
    const mutated = scrubberSource().replace(
      "if (event.type === 'error') {",
      "// if (event.type === 'error') {\n  if (false) {",
    );
    expect(mutated).not.toBe(scrubberSource());
    expect(mutated).toContain("'error'");
    expect(unhandledVariants(mutated)).toEqual(['error']);
  });
});
