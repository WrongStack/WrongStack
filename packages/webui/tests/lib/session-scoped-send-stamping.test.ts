import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Every session-scoped request must NAME the tab that sent it.
 *
 * `SessionScopedPayload` is `{ sessionId?: string }` — optional, because the
 * single-session surfaces (SimpleUI, the TUI) send these frames without one
 * and the server falls back to its only session. That optionality is also why
 * this rule cannot be a type: nothing stops a new send site from leaving the
 * field out, and with four tabs open "no session named" means "whichever
 * session the runtime last touched", which is a different tab from the one
 * the user pressed the button in as often as not.
 *
 * Every one of these was found the same way — one surface stamped, a second
 * surface for the same message did not:
 *
 *   - `DesignGalleryView` stamped `design.use`; `DesignStudioPanel` did not,
 *     so picking a kit in one tab restyled another tab's system prompt;
 *   - `/brain` and the settings Brain section asked untagged, and were
 *     answered with an unlabelled mixture of all four tabs' decisions;
 *   - `SessionPanel` reached past its own stamping helper for one
 *     `sessions.list`, and got a list whose "current" row was another tab's.
 *
 * The rule: the argument list of a `send(...)` carrying a session-scoped type
 * must also carry `withSession(...)` or an explicit `sessionId`. A file that
 * stamps through a local helper declares it once with the marker below.
 */

const MARKER = 'session-stamping: stamped-at-helper';
/**
 * A single send that must NOT be stamped. There is one: `session.new` opens
 * an ADDITIONAL tab, and the server reads a session id on it as "the session
 * being replaced" — stamping it aborted the live run and closed its journal.
 * Retirement is opt-in through `replaceSessionId`.
 */
const EXEMPT = 'session-stamping: deliberately-unstamped';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(here, '..', '..', 'src');

/** Message types declared with the shared `SessionScopedPayload` marker. */
function sessionScopedTypes(): Set<string> {
  const scoped = new Set<string>();
  for (const rel of ['types/client-message.ts', 'types/protocol-core.ts']) {
    const lines = fs.readFileSync(path.join(SRC, rel), 'utf8').split('\n');
    let current: string | null = null;
    let block: string[] = [];
    const flush = (): void => {
      if (current && block.join('\n').includes('SessionScopedPayload')) scoped.add(current);
      current = null;
      block = [];
    };
    for (const line of lines) {
      const match = /type:\s*'([a-zA-Z0-9_.]+)'/.exec(line);
      if (match?.[1]) {
        flush();
        current = match[1];
        block = [line];
        continue;
      }
      if (current) block.push(line);
    }
    flush();
  }
  return scoped;
}

function sourceFiles(): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry.name)) found.push(full);
    }
  };
  walk(SRC);
  return found;
}

/**
 * The argument list of every `…send(…)` / `…send?.(…)` call in a file.
 *
 * Scoped to the call's own parentheses rather than a character window around
 * the type literal: a neighbouring stamped call is close enough to hide an
 * unstamped one, which is exactly how a second surface for the same message
 * slips through. Quotes and template literals are skipped so a `(` inside a
 * string cannot unbalance the walk.
 */
function sendCalls(text: string): Array<{ index: number; args: string }> {
  const out: Array<{ index: number; args: string }> = [];
  const opener = /\bsend\s*(?:\?\.)?\s*\(/g;
  let match: RegExpExecArray | null = opener.exec(text);
  for (; match !== null; match = opener.exec(text)) {
    const start = match.index + match[0].length;
    let depth = 1;
    let quote: string | null = null;
    let i = start;
    for (; i < text.length && depth > 0; i += 1) {
      const ch = text[i];
      if (quote) {
        if (ch === '\\') i += 1;
        else if (ch === quote) quote = null;
        continue;
      }
      if (ch === "'" || ch === '"' || ch === '`') quote = ch;
      else if (ch === '(') depth += 1;
      else if (ch === ')') depth -= 1;
    }
    if (depth === 0) out.push({ index: match.index, args: text.slice(start, i - 1) });
  }
  return out;
}

describe('session-scoped requests name the tab that sent them', () => {
  it('declares a non-trivial set of session-scoped types', () => {
    // A parser that quietly matched nothing would make the rule below vacuous.
    const scoped = sessionScopedTypes();
    expect(scoped.size).toBeGreaterThan(30);
    for (const type of ['user_message', 'abort', 'design.use', 'brain.status', 'sessions.list']) {
      expect([...scoped], `${type} must be declared session-scoped`).toContain(type);
    }
  });

  it('sees the send sites it is meant to police', () => {
    // The walker is the whole rule. If it stopped finding calls — a rename, a
    // wrapper, a regex that no longer matches — the check below would pass by
    // inspecting nothing at all.
    const panel = fs.readFileSync(
      path.join(SRC, 'components', 'SidePanel', 'DesignStudioPanel.tsx'),
      'utf8',
    );
    const types = sendCalls(panel)
      .map((call) => /type:\s*'([a-zA-Z0-9_.]+)'/.exec(call.args)?.[1])
      .filter(Boolean);
    expect(types).toContain('design.use');
    // …and the call's own parentheses, not its neighbourhood: the stamped
    // `design.list` a few lines above must not vouch for it.
    const useCall = sendCalls(panel).find((call) => call.args.includes("'design.use'"));
    expect(useCall?.args).not.toContain("'design.list'");
  });

  it('stamps every send site', () => {
    const scoped = sessionScopedTypes();
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      if (file.includes(`${path.sep}types${path.sep}`)) continue;
      const text = fs.readFileSync(file, 'utf8');
      if (text.includes(MARKER)) continue;
      for (const call of sendCalls(text)) {
        const type = /type:\s*'([a-zA-Z0-9_.]+)'/.exec(call.args)?.[1];
        if (!type || !scoped.has(type)) continue;
        if (/withSession|sessionId/.test(call.args)) continue;
        const preceding = text.slice(Math.max(0, call.index - 500), call.index);
        if (preceding.includes(EXEMPT)) continue;
        // A payload passed by name is built a line or two above; the strict
        // in-call check only applies to an inline object literal, which is
        // the shape a second surface actually gets wrong.
        const inlinePayload = /payload\s*:\s*\{/.test(call.args);
        if (!inlinePayload && /withSession|sessionId/.test(preceding.slice(-300))) continue;
        const line = text.slice(0, call.index).split('\n').length;
        offenders.push(`${path.relative(SRC, file)}:${line}  ${type}`);
      }
    }
    expect(
      offenders,
      `stamp with client.withSession(payload), or pass an explicit sessionId; ` +
        `a file that stamps through a local helper declares "${MARKER}" once`,
    ).toEqual([]);
  });
});
