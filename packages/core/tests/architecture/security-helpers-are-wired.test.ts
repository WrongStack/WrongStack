/**
 * Architecture tests that assert security helpers are **wired**, not merely
 * present.
 *
 * Three consecutive audits of this repo produced the same headline: the
 * dominant failure mode is not missing security machinery, it is correct
 * machinery that one or two call sites never reached. WS-066 (a sanitizer on
 * one surface and not its sibling), WS-077 (seven hand-copied auth conditions),
 * WS-110 (one credential compare fixed, four peers missed), WS-016 / H-8 /
 * WS-SEC-02 (the same prompt fence written three times). Every one of those was
 * found by a human reading code, because nothing failed when a call site was
 * skipped.
 *
 * A unit test proves a helper works. Only a test like this proves it is used.
 *
 * The warning that motivated the file: `clampLimit`'s docblock in
 * `webui-server` claims "a future route that forgets the clamp fails the
 * architecture test" — and no such test exists. A docblock is not a gate.
 *
 * When one of these fails, the fix is to wire the new call site, not to widen
 * the allowlist. An allowlist entry needs a comment saying why that file is
 * genuinely different.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE = path.resolve(HERE, '../../../..');
const PACKAGES = path.join(WORKSPACE, 'packages');

interface SourceFile {
  readonly rel: string;
  readonly text: string;
}

function collectSources(): SourceFile[] {
  const out: SourceFile[] = [];
  const skipDir = new Set(['node_modules', 'dist', 'coverage', '.turbo', 'tests', '__snapshots__']);
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!skipDir.has(entry.name)) walk(full);
        continue;
      }
      if (!entry.name.endsWith('.ts') && !entry.name.endsWith('.tsx')) continue;
      if (entry.name.endsWith('.d.ts') || entry.name.endsWith('.test.ts')) continue;
      out.push({
        rel: path.relative(WORKSPACE, full).split(path.sep).join('/'),
        text: fs.readFileSync(full, 'utf8'),
      });
    }
  };
  for (const pkg of fs.readdirSync(PACKAGES)) {
    walk(path.join(PACKAGES, pkg, 'src'));
  }
  return out;
}

/** Drop block and line comments so a doc mentioning a tag is not a violation. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/gm, '$1');
}

const SOURCES = collectSources();

describe('security helpers are wired, not just present', () => {
  it('finds the source tree it is supposed to be scanning', () => {
    // A silently-empty scan would make every assertion below vacuously true —
    // which is the exact failure mode this whole file exists to prevent.
    expect(SOURCES.length).toBeGreaterThan(500);
  });

  /**
   * WS-110 and the WS-SEC low cluster. `authToken !== expected` returns at the
   * first differing byte, so its timing leaks the shared-prefix length. Five
   * project-daemon IPC servers did this. The audit named four; the fifth
   * (`mailbox-project-server.ts`) surfaced only when this test was written,
   * which is the argument for having it.
   */
  it('never compares an auth token with === or !==', () => {
    const offenders: string[] = [];
    for (const { rel, text } of SOURCES) {
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] as string;
        // Only an identifier on the right-hand side is a credential
        // comparison. `=== undefined`, `=== null` and `typeof x === 'string'`
        // are presence checks. Matching the identifier explicitly — rather
        // than excluding literals with a lookahead — avoids the backtracking
        // hole where `\s*` gives a space back and the lookahead then passes.
        const m = /\bauthToken\s*[!=]==\s*([A-Za-z_$][\w$]*)/.exec(line);
        if (m && m[1] !== 'undefined' && m[1] !== 'null') {
          offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  /**
   * The same six lines of constant-time comparison existed as two hand-copies
   * before `@wrongstack/primitives#timingSafeTokenEqual` — and the ACP copy's
   * docblock said it "mirrors tokenMatches in the WebUI server", which is how
   * four other sites ended up mirroring neither. Importing `timingSafeEqual`
   * directly is how copy number three gets written.
   */
  it('imports node:crypto timingSafeEqual only where a raw compare is genuinely needed', () => {
    // Each entry compares something that is not a bearer token — an HMAC, a
    // TOTP code, a stored hash — or is the shared helper itself.
    const ALLOWED = new Set([
      'packages/primitives/src/timing-safe.ts', // the single definition
      'packages/core/src/security/totp.ts', // TOTP codes + recovery-code hashes
      'packages/cli/src/hq-server/auth.ts', // signed session-cookie HMAC
      'packages/core/src/hq/auth-store.ts',
      'packages/core/src/hq/bootstrap-store.ts',
      'packages/core/src/coordination/mailbox-credential-store.ts',
      'packages/core/src/coordination/mailbox-http-auth.ts',
      'packages/core/src/session-catalog/store-schema.ts',
      'packages/core/src/observability/prometheus.ts',
      'packages/cli/src/subcommands/handlers/acp-connection-gate.ts',
      'packages/governance/src/capability-grant.ts',
      'packages/governance/src/verification-execution-lease.ts',
      'packages/mcp/src/authorization.ts',
      'packages/mcp/src/server.ts',
      'packages/webui-server/src/server/ws-auth.ts', // delegates; name kept for its callers
    ]);

    const importers = SOURCES.filter(({ text }) =>
      /import\s*\{[^}]*\btimingSafeEqual\b[^}]*\}\s*from\s*'node:crypto'/.test(text),
    ).map(({ rel }) => rel);

    expect(importers.filter((rel) => !ALLOWED.has(rel))).toEqual([]);
  });

  /**
   * WS-SEC-09. `toErrorMessage` redacts credentials at the source precisely
   * because 587 call sites reached it while 8 reached the sanitizer. An inline
   * `err instanceof Error ? err.message : String(err)` is that helper written
   * out by hand, and it skips the redaction.
   */
  it('does not grow the number of files that hand-inline toErrorMessage', () => {
    const INLINE = /\w+\s+instanceof\s+Error\s*\?\s*\w+\.message\s*:\s*String\(\s*\w+\s*\)/;
    const ALLOWED = new Set([
      'packages/core/src/utils/error.ts', // the definition itself
    ]);

    const offenders = SOURCES.filter(({ rel, text }) => !ALLOWED.has(rel) && INLINE.test(text)).map(
      ({ rel }) => rel,
    );

    // A ratchet, not a zero. 335 files still write this expression by hand
    // after the fourth high-risk migration tranche on 2026-09-10. The remaining
    // surface is recorded in the security report rather than swept in one
    // commit. The number must only ever go DOWN from here.
    expect(offenders.length).toBeLessThanOrEqual(335);
  });

  /**
   * WS-SEC-02. Repository-supplied text reaches a system prompt from four
   * places. Each used to build its own delimiters, and none of the three older
   * ones escaped the delimiter inside the body, so a body carrying a literal
   * closing tag ended its own fence. `project-supplied-fence` owns the
   * construction now, and a hand-built tag is a regression.
   */
  it('builds the project-supplied prompt fence in exactly one module', () => {
    const ALLOWED = new Set(['packages/core/src/utils/project-supplied-fence.ts']);

    const offenders = SOURCES.filter(
      ({ rel, text }) => !ALLOWED.has(rel) && /['"`]<\/?project-supplied/.test(stripComments(text)),
    ).map(({ rel }) => rel);

    expect(offenders).toEqual([]);
  });

  /**
   * The complement of the test above, and the reason it was not enough.
   *
   * That test greps for a hand-built delimiter literal. So it catches a site
   * that DUPLICATES the fence — and is structurally incapable of catching one
   * that OMITS it, because an omitted fence writes no delimiter to find. Three
   * live sites composed repository-supplied text into a system prompt with no
   * fence at all, and all three passed it: the subagent skill addendum (under
   * a line telling the model to PREFER that text over the first-party skill
   * body), repository-supplied `SKILL.md` bodies, and `knowledge.json`.
   *
   * The fence module's own docblock claimed the skill surface was covered. It
   * was not. A guard you have only watched pass is not evidence.
   *
   * This is an enumeration rather than a pattern, because "text that reaches a
   * prompt" is a semantic property no regex recognises. Adding a site here is
   * the point: it forces the question at review time.
   */
  it('fences repository-supplied text at every site that composes it into a prompt', () => {
    /** Files that read untrusted repo content and put it in a system prompt. */
    const INJECTION_SITES = [
      // `.wrongstack/agents/<role>/{identity,learned}.md` + knowledge.json
      'packages/core/src/coordination/agents/project-agent-identity.ts',
      // `.wrongstack/skills/<name>/SKILL.md` bodies
      'packages/core/src/core/system-prompt-skill-bodies.ts',
      // `.wrongstack/instructions/{system.md,sections/*.md}`
      'packages/core/src/core/system-prompt-blocks.ts',
      'packages/core/src/core/system-prompt-builder.ts',
      // `.wrongstack/agents/<role>/skills/<skill>.md` → subagent prompt
      'packages/cli/src/fleet/host-context.ts',
    ] as const;

    const byRel = new Map(SOURCES.map((s) => [s.rel, s.text]));
    const unfenced: string[] = [];
    const missing: string[] = [];

    for (const rel of INJECTION_SITES) {
      const text = byRel.get(rel);
      if (text === undefined) {
        // A moved or renamed file must fail loudly, not silently pass.
        missing.push(rel);
        continue;
      }
      if (!/\bformatProjectSuppliedBlock\s*\(/.test(stripComments(text))) unfenced.push(rel);
    }

    expect(missing, 'Enumerated injection site no longer exists — update this list').toEqual([]);
    expect(
      unfenced,
      'This file composes repository-supplied text into a system prompt but never calls ' +
        '`formatProjectSuppliedBlock`. Untrusted text next to first-party operating rules, ' +
        'with nothing marking which is which. Sites:',
    ).toEqual([]);
  });

  it('self-check: the fence enumeration fails when a call is removed', () => {
    // Proves the assertion above can actually fail — the exact property the
    // delimiter-grep test lacked.
    const withoutCall = 'const entry = `## Skill: ${name}`;\n';
    expect(/\bformatProjectSuppliedBlock\s*\(/.test(stripComments(withoutCall))).toBe(false);

    const withCall = 'const entry = formatProjectSuppliedBlock({ source, body });\n';
    expect(/\bformatProjectSuppliedBlock\s*\(/.test(stripComments(withCall))).toBe(true);

    // A mention in a comment must not count as wiring.
    const commentOnly = '// we should call formatProjectSuppliedBlock(...) here one day\n';
    expect(/\bformatProjectSuppliedBlock\s*\(/.test(stripComments(commentOnly))).toBe(false);
  });

  /**
   * S10. `clampLimit`'s own docblock in `webui-server` claims that "a future
   * route that forgets the clamp fails the architecture test instead of
   * degrading silently" — and no such test existed. That sentence is the reason
   * this whole file was written, so leaving it unbacked would be the joke
   * telling itself.
   *
   * The drift it warned about had already happened by the time the test was
   * written: five call sites clamp, ten read a client-controlled limit and pass
   * it straight through. Those ten are recorded, not swept — several
   * deliberately omit the key when it is absent (`...(x !== undefined ? {limit:
   * x} : {})`), and `clampLimit` always returns a number, so wiring them
   * changes semantics rather than just adding a bound. That is a per-route
   * judgement, not a mechanical edit.
   *
   * What this test does guarantee is the docblock's actual promise: a NEW route
   * that forgets the clamp fails here.
   */
  it('clamps every client-controlled limit in the WebUI server routes', () => {
    const LIMIT_READ = /\bpayload\s*\??\.\s*(?:limit|maxNodes|hops|maxDepth)\b/;
    const ROUTES = 'packages/webui-server/src/server/';

    // Pre-existing unclamped reads, measured 2026-09-10. This list must only
    // ever get SHORTER. Adding to it means a new route shipped without the
    // clamp — wire `clampLimit` instead.
    const PREEXISTING = new Set([
      'packages/webui-server/src/server/chimera-routes.ts',
      'packages/webui-server/src/server/chronicle-routes.ts', // clamps 4, passes 2 through
      'packages/webui-server/src/server/embedded-message-router.ts',
      'packages/webui-server/src/server/file-handlers.ts',
      'packages/webui-server/src/server/kanban-orchestration-routes.ts',
      'packages/webui-server/src/server/kanban-task-routes.ts',
      'packages/webui-server/src/server/routes.ts',
      'packages/webui-server/src/server/session-handlers.ts',
      // The helper's own module: the match there is a validation *message*
      // naming the field, not a read of it.
      'packages/webui-server/src/server/ws-payload-validation.ts',
    ]);

    const offenders: string[] = [];
    for (const { rel, text } of SOURCES) {
      if (!rel.startsWith(ROUTES)) continue;
      if (PREEXISTING.has(rel)) continue;
      const lines = stripComments(text).split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] as string;
        if (!LIMIT_READ.test(line)) continue;
        if (line.includes('clampLimit(')) continue;
        offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  /**
   * The allowlist above is only meaningful if the files in it still exist and
   * still contain the thing being excused. A renamed or deleted route would
   * leave a dead entry that silently excuses nothing — and the next route to
   * take that filename would inherit the excuse.
   */
  it('has no stale entries in the clampLimit allowlist', () => {
    const known = new Set(SOURCES.map(({ rel }) => rel));
    const listed = [
      'packages/webui-server/src/server/chimera-routes.ts',
      'packages/webui-server/src/server/chronicle-routes.ts',
      'packages/webui-server/src/server/embedded-message-router.ts',
      'packages/webui-server/src/server/file-handlers.ts',
      'packages/webui-server/src/server/kanban-orchestration-routes.ts',
      'packages/webui-server/src/server/kanban-task-routes.ts',
      'packages/webui-server/src/server/routes.ts',
      'packages/webui-server/src/server/session-handlers.ts',
      'packages/webui-server/src/server/ws-payload-validation.ts',
    ];

    expect(listed.filter((rel) => !known.has(rel))).toEqual([]);
  });
});
