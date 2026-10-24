/**
 * Every session event carrying free-form text must be scrubbed — or explicitly
 * justified as safe to persist raw.
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
 * Adding those cases fixes today. This file is about tomorrow. Two defects in
 * its own guard, both fixed here, are why it is shaped the way it is:
 *
 * 1. The union walk read `types/session.ts`, which only *re-exports* the union
 *    (`types/session-events.ts` is its real home). That file declares no
 *    `type: '…'` at all, so the ratchet saw an empty variant list and passed
 *    vacuously — it would have reported nothing for a brand-new variant.
 * 2. The ratchet keyed on the variant NAME (`error`, `*_error`, `*_failed`).
 *    Six real leaks then landed through variants not named that way:
 *    `tool_progress`, `compaction`, `checkpoint`, `task_created`/
 *    `task_completed`, `sandbox_audit`, `delegate_started`/
 *    `delegate_completed`. A name is not a shape.
 *
 * The guard is now a complete ledger: every variant declared in the union must
 * appear in exactly one of {@link SCRUBBED_FREE_TEXT_FIELDS} (with the fields
 * the scrubber must scrub) or {@link JUSTIFIED_RAW_VARIANTS} (with the reason
 * it may persist raw). Nothing is decided by name. The behavioural tests below
 * prove the scrubber actually redacts; the structural tests prove nobody can
 * add a variant, or an unbounded text field, without deciding. Per SECURITY.md
 * rule 3 the structural half is validated by injection, not by watching it pass.
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SessionEvent } from '@wrongstack/contracts/types/session';
import { describe, expect, it } from 'vitest';
import { DefaultSecretScrubber } from '../../src/security/secret-scrubber.js';
import { scrubSessionWriterEvent } from '../../src/storage/session-writer-scrubber.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CORE_SRC = path.resolve(HERE, '../../src');

/**
 * Where the `SessionEvent` union is actually declared. `types/session.ts` only
 * imports and re-exports it; reading that file is what made the predecessor of
 * this guard vacuous (see the header).
 */
const UNION_FILE = path.resolve(CORE_SRC, '../../contracts/src/types/session-events.ts');
const SCRUBBER_FILE = path.join(CORE_SRC, 'storage/session-writer-scrubber.ts');

const SCRUBBED_FREE_TEXT_FIELDS: Record<string, readonly string[]> = {
  context_snapshot: ['messages'],
  messages_replaced: ['messages'],
  message_appended: ['message'],
  message_updated: ['message'],
  user_input: ['content'],
  llm_response: ['content'],
  tool_use: ['input'],
  tool_call_start: ['input'],
  tool_result: ['content'],
  file_snapshot: ['files'],
  side_effect: ['*'],
  sandbox_audit: ['detail'],
  tool_progress: ['event.text', 'event.data'],
  compaction: ['digest'],
  checkpoint: ['promptPreview'],
  error: ['message'],
  task_failed: ['title', 'error'],
  task_created: ['title'],
  task_completed: ['title'],
  agent_error: ['error'],
  delegate_started: ['task'],
  delegate_completed: ['task', 'summary'],
  provider_error: ['description'],
  provider_retry: ['description'],
};

/**
 * Every other variant in the union, with the reason it may be persisted raw.
 *
 * This is the "justify" half of the ledger. It is deliberately explicit and
 * complete: a new variant has to be added to one of these two maps, so the
 * decision is made by a human, at the moment the variant is introduced, rather
 * than by a name pattern after a leak.
 */
const JUSTIFIED_RAW_VARIANTS: Record<string, string> = {
  session_start: 'ids, model/provider names, cwd — no free text',
  session_resumed: 'ids + resume counters',
  session_forked: 'ids + lineage references',
  session_moved: 'project paths + ids',
  session_end: 'ids + counters + pending tool-use ids',
  llm_request: 'token counts + model/provider ids',
  enhance_usage: 'usage counters + provider/model ids',
  messages_dropped: '{ version, count } counters only',
  file_observation: 'path + hash + source enum',
  rewound: 'prompt index + counters',
  in_flight_start: 'writer-built "iteration N / max M" (agent-loop.ts)',
  in_flight_end: 'closed reason enum',
  tool_call_end: 'ids + counts + status enum',
  message_truncated: 'before/after counters only',
  skill_activated: 'skill name identifier',
  skill_deactivated: 'skill name identifier',
  mode_changed: 'mode ids',
  agent_spawned: 'agent id + role id',
  agent_session_linked: 'ids + transcript path',
  agent_stopped: 'ids + status enum',
  delegation_delivered: 'ids + delivery counters',
  loop_detected: 'pattern id + counters',
  model_switched: 'provider/model ids',
  task_updated: 'task id + status enum',
  subagent_policy: 'normalized policy ids/flags',
  subagent_model_plan: 'normalized lanes — provider/model ids only',
  leader_effort: 'normalized override (ids/enums)',
  permission_overrides: 'normalized override ids',
  file_event: 'paths + ids + counters (see file-event-record.ts)',
};

function unionSource(): string {
  return readFileSync(UNION_FILE, 'utf8');
}

function scrubberSource(): string {
  return readFileSync(SCRUBBER_FILE, 'utf8');
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
 * Variant names declared in the `SessionEvent` union, read from the file that
 * actually declares them.
 *
 * Depth-aware on purpose: only a brace at the union's top level starts a
 * variant, so a nested object literal's own `type: '…'` cannot be mistaken for
 * one. Comments are stripped first so a brace inside prose cannot shift the
 * depth. Fails loudly if the declaration marker moves, rather than silently
 * returning an empty list — the vacuity this guard was fixed for.
 */
function unionVariantNames(source = unionSource()): string[] {
  const code = withoutComments(source);
  const marker = code.indexOf('SessionEventVariant');
  if (marker < 0) {
    throw new Error('SessionEventVariant declaration not found in types/session-events.ts');
  }
  const names: string[] = [];
  let depth = 0;
  for (let i = marker; i < code.length; i += 1) {
    const ch = code[i];
    if (ch === '{') {
      depth += 1;
      if (depth === 1) {
        const m = /^\{\s*(?:\n\s*)?type:\s*'([a-z_]+)'/u.exec(code.slice(i));
        if (m) names.push(m[1] as string);
      }
      continue;
    }
    if (ch === '}') {
      depth = Math.max(0, depth - 1);
      continue;
    }
    // The union declaration ends at its first top-level `;` after the variants.
    if (depth === 0 && ch === ';' && names.length > 0) break;
  }
  return [...new Set(names)];
}

/** The source of one variant's object type, braces included. */
function variantBlock(code: string, variant: string): string | undefined {
  const decl = new RegExp(String.raw`type:\s*'${variant}'`, 'u').exec(code);
  if (!decl) return undefined;
  const open = code.lastIndexOf('{', decl.index);
  if (open < 0) return undefined;
  let depth = 0;
  for (let i = open; i < code.length; i += 1) {
    const ch = code[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return code.slice(open, i + 1);
    }
  }
  return undefined;
}

/**
 * Fields whose declared type is an UNBOUNDED text container — `Record<…>`,
 * `unknown`, or an array. These are mechanically unambiguous. A bare `string`
 * cannot be told from an identifier without a naming heuristic (and a name is
 * not a shape — the lesson of this file), so bare strings are decided at
 * variant granularity by the ledger while containers are decided per field.
 */
function unboundedTextFields(block: string): string[] {
  const fields: string[] = [];
  for (const m of block.matchAll(/(?:^|[\s{;])(\w+)\??\s*:\s*([^;]+);/gu)) {
    const type = (m[2] ?? '').trim();
    if (/\bRecord\s*</u.test(type) || /\bunknown\b/u.test(type) || /\[\]\s*$/u.test(type)) {
      fields.push(m[1] as string);
    }
  }
  return fields;
}

/**
 * A variant counts as handled only when the scrubber actually COMPARES
 * `event.type` against it in live code. The former check was
 * `source.includes("'<variant>'")`, which any mention anywhere satisfied.
 */
function unhandledVariants(source = scrubberSource()): string[] {
  const code = withoutComments(source);
  return Object.keys(SCRUBBED_FREE_TEXT_FIELDS).filter(
    (variant) => !new RegExp(String.raw`event\.type\s*===\s*(['"])${variant}\1`, 'u').test(code),
  );
}

/** The live case body of a variant's scrubber branch, braces included. */
function liveCaseBlock(code: string, variant: string): string | undefined {
  const m = new RegExp(String.raw`event\.type\s*===\s*'${variant}'`, 'u').exec(code);
  if (!m) return undefined;
  const open = code.indexOf('{', m.index);
  if (open < 0) return undefined;
  let depth = 0;
  for (let i = open; i < code.length; i += 1) {
    const ch = code[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return code.slice(open, i + 1);
    }
  }
  return undefined;
}

/**
 * Listed scrub targets that the variant's live case does not actually touch —
 * a field that stopped being scrubbed, or a case deleted outright.
 */
function unreferencedTargets(source = scrubberSource()): string[] {
  const code = withoutComments(source);
  const missing: string[] = [];
  for (const [variant, targets] of Object.entries(SCRUBBED_FREE_TEXT_FIELDS)) {
    const block = liveCaseBlock(code, variant);
    if (block === undefined) {
      missing.push(`${variant} (no live case)`);
      continue;
    }
    for (const target of targets) {
      if (target === '*') {
        if (!/\bscrubObject\s*\(\s*event\s*\)/u.test(block)) missing.push(`${variant}.*`);
        continue;
      }
      const segment = target.slice(target.lastIndexOf('.') + 1);
      if (!new RegExp(String.raw`\b${segment}\b`, 'u').test(block)) {
        missing.push(`${variant}.${target}`);
      }
    }
  }
  return missing;
}

/**
 * Unbounded text fields on a handled variant that its ledger entry does not
 * cover. A `Record`/`unknown`/array field added to a scrubbed variant must be
 * listed (or covered by a `'*'` whole-event pass) before the suite goes green.
 */
function uncoveredTextFields(source = unionSource()): string[] {
  const code = withoutComments(source);
  const uncovered: string[] = [];
  for (const [variant, targets] of Object.entries(SCRUBBED_FREE_TEXT_FIELDS)) {
    const block = variantBlock(code, variant);
    if (block === undefined) {
      uncovered.push(`${variant} (variant block not found)`);
      continue;
    }
    for (const field of unboundedTextFields(block)) {
      // A target may name the field's parent path — `tool_progress` declares
      // its text inside the union's nested `event` object, so the ledger says
      // `event.data` while the reader reports the bare `data`. Matching the
      // last segment is what lets a parent-path entry cover the field, the
      // same convention `missingTargets` uses above.
      const covered = targets.some(
        (target) =>
          target === '*' ||
          target === field ||
          target.startsWith(`${field}.`) ||
          target.slice(target.lastIndexOf('.') + 1) === field,
      );
      if (!covered) uncovered.push(`${variant}.${field}`);
    }
  }
  return uncovered;
}

const scrubber = new DefaultSecretScrubber();
/**
 * Built dynamically, never as a bare literal. This repo's secret scanner
 * rewrites credential-shaped text in tool output *and* in edits, which is how
 * this fixture silently degraded during the guard rewrite: every read of the
 * original returned the scrubber's own `[REDACTED:anthropic_key]` marker (27
 * chars) in place of the 62-char fake, and a marker is an input no pattern can
 * match — so the three tests below asserted redaction that could never happen
 * and failed instead. Anthropic shape because that is the pattern the marker's
 * type name (`anthropic_key`) reports.
 */
const SECRET = `sk-ant-api03-${'a'.repeat(49)}`;

function scrub(event: SessionEvent): SessionEvent {
  return scrubSessionWriterEvent(event, scrubber);
}

const TS = '2026-01-01T00:00:00.000Z';
const RAW = 'FAKE-BEARER-TOKEN-000000000000';
const bearer = (token: string): string => `Authorization: Bearer ${token}`;

function ofType<T extends SessionEvent['type']>(
  out: SessionEvent | undefined,
  type: T,
): Extract<SessionEvent, { type: T }> {
  if (!out || out.type !== type) throw new Error(`expected a ${type} event`);
  return out as Extract<SessionEvent, { type: T }>;
}

type ScrubCase = [
  label: string,
  token: string,
  build: () => SessionEvent[],
  fields: (out: SessionEvent[]) => ReadonlyArray<{ text: string; kept?: readonly string[] }>,
  record?: { read: (out: SessionEvent[]) => unknown; matches: Record<string, unknown> },
];

describe('session writer scrubs free-text fields', () => {
  const CASES: readonly ScrubCase[] = [
    [
      'scrubs error.message',
      SECRET,
      () => [
        { type: 'error', ts: TS, message: `provider rejected: ${bearer(SECRET)}`, phase: 'llm' },
      ],
      (out) => [{ text: ofType(out[0], 'error').message, kept: ['provider rejected'] }],
    ],
    [
      'scrubs task_failed.error',
      SECRET,
      () => [
        {
          type: 'task_failed',
          ts: TS,
          taskId: 't1',
          title: 'build',
          error: `failed with key ${SECRET}`,
        },
      ],
      (out) => [{ text: ofType(out[0], 'task_failed').error }],
    ],
    [
      'scrubs agent_error.error',
      SECRET,
      () => [{ type: 'agent_error', ts: TS, agentId: 'a1', error: `subagent crashed: ${SECRET}` }],
      (out) => [{ text: ofType(out[0], 'agent_error').error }],
    ],
    [
      'scrubs tool_progress.event.text and .data',
      RAW,
      () => [
        {
          type: 'tool_progress',
          ts: TS,
          name: 'bash',
          id: 'c1',
          event: {
            type: 'partial_output',
            text: `curl -H "${bearer(RAW)}"`,
            data: { header: bearer(RAW) },
          },
        },
      ],
      (out) => {
        const event = ofType(out[0], 'tool_progress');
        // The stream detail survives — only the credential is removed.
        return [
          { text: event.event.text ?? '', kept: ['curl -H'] },
          { text: JSON.stringify(event.event.data ?? {}) },
        ];
      },
    ],
    [
      'scrubs compaction.digest (lossless conversation text)',
      RAW,
      () => [
        {
          type: 'compaction',
          ts: TS,
          before: 10,
          after: 3,
          digest: `[user]: curl -H "${bearer(RAW)}"`,
        },
      ],
      (out) => [{ text: ofType(out[0], 'compaction').digest ?? '', kept: ['[user]:'] }],
    ],
    [
      'scrubs checkpoint.promptPreview (first 80 chars of the user turn)',
      RAW,
      () => [
        {
          type: 'checkpoint',
          ts: TS,
          promptIndex: 0,
          promptPreview: `deploy with curl -H "${bearer(RAW)}"`,
        },
      ],
      (out) => [{ text: ofType(out[0], 'checkpoint').promptPreview, kept: ['deploy with curl'] }],
    ],
    [
      'scrubs task titles on task_created / task_completed / task_failed',
      RAW,
      () => {
        const title = `rotate the leaked key (${bearer(RAW)})`;
        return [
          { type: 'task_created', ts: TS, taskId: 't1', title },
          { type: 'task_completed', ts: TS, taskId: 't1', title },
          { type: 'task_failed', ts: TS, taskId: 't1', title, error: 'boom' },
        ];
      },
      (out) => [
        { text: ofType(out[0], 'task_created').title, kept: ['rotate the leaked key'] },
        { text: ofType(out[1], 'task_completed').title },
        { text: ofType(out[2], 'task_failed').title },
      ],
    ],
    [
      'scrubs sandbox_audit.detail (arbitrary record, like side_effect.input)',
      RAW,
      () => [
        {
          type: 'sandbox_audit',
          ts: TS,
          event: 'sandbox.expansion_outcome',
          tool: 'bash',
          detail: { granted: false, decidedBy: `approver-error: ${bearer(RAW)}` },
        },
      ],
      (out) => [{ text: JSON.stringify(ofType(out[0], 'sandbox_audit').detail) }],
      { read: (out) => ofType(out[0], 'sandbox_audit').detail, matches: { granted: false } },
    ],
    [
      'scrubs delegate_started.task and delegate_completed.task/summary',
      RAW,
      () => [
        {
          type: 'delegate_started',
          ts: TS,
          target: 'bug-hunter',
          task: `call the API with ${bearer(RAW)}`,
        },
        {
          type: 'delegate_completed',
          ts: TS,
          target: 'bug-hunter',
          task: `call the API with ${bearer(RAW)}`,
          ok: true,
          summary: `used ${bearer(RAW)}`,
          durationMs: 1,
          iterations: 1,
          toolCalls: 1,
        },
      ],
      (out) => [
        { text: ofType(out[0], 'delegate_started').task, kept: ['call the API'] },
        { text: ofType(out[1], 'delegate_completed').task },
        { text: ofType(out[1], 'delegate_completed').summary },
      ],
    ],
  ];

  it.each<ScrubCase>(CASES)('%s', (_label, token, build, fields, record) => {
    const out = build().map((event) => scrub(event));
    for (const { text, kept } of fields(out)) {
      expect(text).not.toContain(token);
      for (const fragment of kept ?? []) expect(text).toContain(fragment);
    }
    if (record) expect(record.read(out)).toMatchObject(record.matches);
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

describe('session scrub parity — every variant is decided, scrub or justify', () => {
  it('finds the union variants (the walk is not a vacuous empty list)', () => {
    // The predecessor read `types/session.ts`, which declares none. Assert the
    // walk sees the real union before trusting any parity result built on it.
    const variants = unionVariantNames();
    expect(variants.length).toBeGreaterThan(40);
    expect(variants).toContain('error');
    expect(variants).toContain('tool_progress');
  });

  it('every union variant has an explicit scrub-or-justify entry', () => {
    const decided = new Set([
      ...Object.keys(SCRUBBED_FREE_TEXT_FIELDS),
      ...Object.keys(JUSTIFIED_RAW_VARIANTS),
    ]);
    const undecided = unionVariantNames().filter((name) => !decided.has(name));
    expect(
      undecided,
      'New SessionEvent variant(s) with no decision. Either add a scrub case to ' +
        'scrubSessionWriterEvent and list the variant (with its free-text ' +
        'targets) in SCRUBBED_FREE_TEXT_FIELDS, or list it in ' +
        'JUSTIFIED_RAW_VARIANTS with the reason it may persist raw. Variants:',
    ).toEqual([]);
  });

  it('has no stale entries for variants that no longer exist', () => {
    const variants = new Set(unionVariantNames());
    const stale = [
      ...Object.keys(SCRUBBED_FREE_TEXT_FIELDS),
      ...Object.keys(JUSTIFIED_RAW_VARIANTS),
    ].filter((name) => !variants.has(name));
    expect(
      stale,
      'Ledger entries for variants the union no longer declares — remove them, ' +
        'or the ledger has drifted from the type. Variants:',
    ).toEqual([]);
  });

  it('every decided variant with free text is handled by the scrubber', () => {
    const unhandled = unhandledVariants();
    expect(
      unhandled,
      'These SessionEvent variants carry raw text but have no case in ' +
        'scrubSessionWriterEvent, so they are written to the durable journal ' +
        'verbatim. Variants:',
    ).toEqual([]);
  });

  it('every listed scrub target is touched by its variant live case', () => {
    const missing = unreferencedTargets();
    expect(
      missing,
      'Ledger targets the scrubber no longer touches — a field stopped being ' +
        'scrubbed, or the case was deleted. Targets:',
    ).toEqual([]);
  });

  it('no unbounded text field on a handled variant is missing from its entry', () => {
    const uncovered = uncoveredTextFields();
    expect(
      uncovered,
      'Record/unknown/array fields on handled variants that the ledger entry ' +
        'does not cover. Add them to the variant scrub targets (or cover the ' +
        'whole event with "*"). Fields:',
    ).toEqual([]);
  });

  // SECURITY.md rule 3: validate a guard by injection, never by watching it
  // pass. The tests below re-introduce the exact vulnerabilities this file
  // exists to catch and assert the guard NOTICES. None touches disk — each
  // feeds a mutated copy of the real source through the same predicates the
  // tests above use, so they fail if a predicate is ever weakened.
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
    // doc-comment describing a case that had since been deleted.
    const mutated = scrubberSource().replace(
      "if (event.type === 'error') {",
      "// if (event.type === 'error') {\n  if (false) {",
    );
    expect(mutated).not.toBe(scrubberSource());
    expect(mutated).toContain("'error'");
    expect(unhandledVariants(mutated)).toEqual(['error']);
  });

  it('injection: a brand-new variant with free text is reported as undecided', () => {
    // The class this guard exists for: a variant nobody remembered to decide.
    const mutated = unionSource().replace(
      "  | { type: 'error'",
      "  | { type: 'fresh_leak'; ts: string; detail: Record<string, unknown> }\n  | { type: 'error'",
    );
    expect(mutated, 'injection did not apply').not.toBe(unionSource());
    expect(unionVariantNames(mutated)).toContain('fresh_leak');
    const decided = new Set([
      ...Object.keys(SCRUBBED_FREE_TEXT_FIELDS),
      ...Object.keys(JUSTIFIED_RAW_VARIANTS),
    ]);
    expect(unionVariantNames(mutated).filter((name) => !decided.has(name))).toEqual(['fresh_leak']);
  });

  it('injection: a new unbounded text field on a handled variant is reported', () => {
    // A field added to an already-handled variant must be decided too — the
    // variant-level entry is not a blanket licence for new containers.
    const mutated = unionSource().replace(
      /(type: 'error';[^}]*?message: string;)/u,
      '$1 extra: Record<string, unknown>;',
    );
    expect(mutated, 'injection did not apply').not.toBe(unionSource());
    expect(uncoveredTextFields(mutated)).toContain('error.extra');
  });
});
