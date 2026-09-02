/**
 * Every child process this repo spawns follows one Windows convention, and the
 * convention lives in eleven files.
 *
 * The rule: a spawn that passes `detached` must also pass `windowsHide: true`.
 * On win32 the two flags interact — `bash.ts` documents the case that forced
 * the rule, where `DETACHED_PROCESS` (`detached: true`) makes CreateProcess
 * ignore `CREATE_NO_WINDOW` and the child's console grandchildren each pop a
 * visible window. The daemon spawns tolerate `detached: true` because their
 * children spawn nothing console-bearing; every one of them still sets
 * `windowsHide`, because the cost of setting it is zero and the cost of
 * discovering you needed it is a user staring at stray console windows.
 *
 * `boot/tui-project-spawn.ts` was the one site outside the convention: it
 * passed `detached: true` with no `windowsHide` and never `unref`'d the child.
 * It is the project-switch path — the most user-visible spawn in the CLI.
 *
 * A shared helper is not available here. `@wrongstack/kanban` sits BELOW core
 * in the workspace DAG (`package-boundaries.test.ts`) and cannot import a core
 * utility, so the convention cannot be centralised in code. A test is the only
 * place it can be centralised at all.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const PACKAGES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** How far from a `detached:` line the paired flag may sit. */
const PROXIMITY_LINES = 15;

/**
 * Spawns that legitimately omit `windowsHide`, with the reason.
 * Adding an entry is a decision; anything else is drift.
 */
const WINDOWS_HIDE_EXEMPT: Record<string, string> = {};

/**
 * Child-process call sites that do not route their environment through
 * `buildChildEnv` (H-8 / VF-09 follow-up, security report Phase 3 item 12),
 * keyed by file path suffix with the reason each is allowed. Every entry is a
 * decision someone made out loud; anything not listed must either pass
 * `env: buildChildEnv(…)` (directly or as the base of a spread) or pass an
 * env identifier the file composes from buildChildEnv. Adding an entry is a
 * decision; anything else is drift. When a listed file gains buildChildEnv at
 * every site, the staleness test below forces the entry to be dropped.
 */
const REASON_AGENT_CHILD =
  'Spawns a WrongStack agent/subagent child that reads provider credentials from its environment by design — filtering would break the child.';
const REASON_SELF_RELAUNCH =
  'Relaunches the wstack CLI itself or its bundled UI — must inherit the full operator shell environment.';
const REASON_OPERATOR_TOOL =
  'Operator-facing helper (browser opener, git query, interactive prompt) running with the operator shell environment by contract.';
const REASON_TRUSTED_DAEMON =
  'Spawns a trusted wstack-managed project daemon that may decrypt config/vault state — inherited env is the contract between wstack processes.';
const REASON_INTERNAL_WORKER =
  'Internal language/parser worker on repo-local toolchains — no credential consumer; migrating to buildChildEnv is welcome.';
const REASON_PLUGIN_RUNNER =
  'Official dev-tooling plugin runner (lint/test/git/package-manager) — no credential consumer by design; migrate to buildChildEnv incrementally, and this entry keeps new plugin spawns a conscious decision.';
const REASON_USER_TERMINAL =
  'Interactive terminal/shell for the human user — the full user environment is the feature.';
const REASON_BENCH = 'Offline benchmark harness — no credentials in scope.';
const REASON_HOOKS =
  'User-configured lifecycle hook executor — hooks run with the operator environment by documented contract.';

const CHILD_ENV_EXEMPT: Record<string, string> = {
  // ── Agent children (fleet / director / delegation / coordination) ──
  'cli/src/fleet/host.ts': REASON_AGENT_CHILD,
  'cli/src/wiring/session-registry.ts': REASON_AGENT_CHILD,
  'cli/src/wiring/session-command-handlers.ts': REASON_AGENT_CHILD,
  'cli/src/wiring/sdd-handlers.ts': REASON_AGENT_CHILD,
  'cli/src/chimera-cascade-evidence.ts': REASON_AGENT_CHILD,
  'core/src/coordination/director.ts': REASON_AGENT_CHILD,
  'core/src/coordination/multi-agent-coordinator.ts': REASON_AGENT_CHILD,
  'core/src/coordination/collab-director-host.ts': REASON_AGENT_CHILD,
  'core/src/coordination/director/director-collab.ts': REASON_AGENT_CHILD,
  'core/src/coordination/director-host-contracts.ts': REASON_AGENT_CHILD,
  'core/src/coordination/icoordinator.ts': REASON_AGENT_CHILD,
  'core/src/types/multi-agent.ts': REASON_AGENT_CHILD,
  'sdd/src/verify-task.ts': REASON_AGENT_CHILD,
  // ── CLI self-relaunch / bundled UI ──
  'cli/src/boot.ts': REASON_SELF_RELAUNCH,
  'cli/src/boot/tui-project-spawn.ts': REASON_SELF_RELAUNCH,
  'cli/src/boot/short-circuit-desktop.ts': REASON_SELF_RELAUNCH,
  'cli/src/simpleui-dist.ts': REASON_SELF_RELAUNCH,
  'cli/src/subcommands/handlers/update.ts': REASON_SELF_RELAUNCH,
  'cli/src/hq-tunnel.ts': REASON_SELF_RELAUNCH,
  'cli/src/mailbox-bridge-bootstrap.ts': REASON_SELF_RELAUNCH,
  'cli/src/slash-commands/dev.ts': REASON_SELF_RELAUNCH,
  'cli/src/slash-commands/mailbox-serve.ts': REASON_SELF_RELAUNCH,
  'cli/src/slash-commands/project.ts': REASON_SELF_RELAUNCH,
  'webui-server/src/server/discover-mailbox-bridge.ts': REASON_SELF_RELAUNCH,
  'webui-server/src/server/goal-ws-handler.ts': REASON_SELF_RELAUNCH,
  // ── Operator-facing helpers ──
  'cli/src/auth-menu/loopback-server.ts': REASON_OPERATOR_TOOL,
  'cli/src/pre-launch/project-check.ts': REASON_OPERATOR_TOOL,
  'cli/src/services/run-git.ts': REASON_OPERATOR_TOOL,
  'cli/src/slash-commands/review.ts': REASON_OPERATOR_TOOL,
  'cli/src/slash-commands/suggest.ts': REASON_OPERATOR_TOOL,
  'webui-server/src/server/open-browser.ts': REASON_OPERATOR_TOOL,
  'webui-server/src/server/frontend-static-serve.ts': REASON_OPERATOR_TOOL,
  // ── Trusted wstack daemons ──
  'core/src/chronicle/project-server-client.ts': REASON_TRUSTED_DAEMON,
  'core/src/session-catalog/client.ts': REASON_TRUSTED_DAEMON,
  'core/src/storage/session-store.ts': REASON_TRUSTED_DAEMON,
  'core/src/coordination/single-instance-mailbox.ts': REASON_TRUSTED_DAEMON,
  'core/src/coordination/mailbox-project-server-client.ts': REASON_TRUSTED_DAEMON,
  'sage/src/project-server-client.ts': REASON_TRUSTED_DAEMON,
  'kanban/src/server/client.ts': REASON_TRUSTED_DAEMON,
  'kanban/src/verification/verification-context.ts': REASON_TRUSTED_DAEMON,
  'governance/src/daemon-launcher.ts': REASON_TRUSTED_DAEMON,
  'tools/src/codebase-index/project-server-client.ts': REASON_TRUSTED_DAEMON,
  'tools/src/process-registry.ts': REASON_TRUSTED_DAEMON,
  'core/src/skills/skill-generator.ts': REASON_TRUSTED_DAEMON,
  // ── Internal parser/toolchain workers ──
  'tools/src/codebase-index/indexer.ts': REASON_INTERNAL_WORKER,
  'tools/src/codebase-index/parser-batch.ts': REASON_INTERNAL_WORKER,
  'tools/src/codebase-index/go-parser.ts': REASON_INTERNAL_WORKER,
  'tools/src/codebase-index/py-parser.ts': REASON_INTERNAL_WORKER,
  'sage/src/anchors/verify.ts': REASON_INTERNAL_WORKER,
  'sage/src/domain-term-extractor.ts': REASON_INTERNAL_WORKER,
  // ── Plugin runners (official dev tooling) ──
  'plugins/src/api-compatibility-gate/index.ts': REASON_PLUGIN_RUNNER,
  'plugins/src/branch-guard/index.ts': REASON_PLUGIN_RUNNER,
  'plugins/src/dependency-vulnerability-gate/index.ts': REASON_PLUGIN_RUNNER,
  'plugins/src/diff-summary/index.ts': REASON_PLUGIN_RUNNER,
  'plugins/src/format-on-save/index.ts': REASON_PLUGIN_RUNNER,
  'plugins/src/git-autocommit/index.ts': REASON_PLUGIN_RUNNER,
  'plugins/src/import-organizer/index.ts': REASON_PLUGIN_RUNNER,
  'plugins/src/lint-gate/index.ts': REASON_PLUGIN_RUNNER,
  'plugins/src/loop-breaker/index.ts': REASON_PLUGIN_RUNNER,
  'plugins/src/path-guard/shell-targets.ts': REASON_PLUGIN_RUNNER,
  'plugins/src/pr-drafter/index.ts': REASON_PLUGIN_RUNNER,
  'plugins/src/release-notes-generator/index.ts': REASON_PLUGIN_RUNNER,
  'plugins/src/semver-bump/index.ts': REASON_PLUGIN_RUNNER,
  'plugins/src/shell-check/index.ts': REASON_PLUGIN_RUNNER,
  'plugins/src/test-flake-detector/index.ts': REASON_PLUGIN_RUNNER,
  'plugins/src/test-runner-gate/index.ts': REASON_PLUGIN_RUNNER,
  'core/src/plugins/auto-review-git.ts': REASON_PLUGIN_RUNNER,
  'core/src/plugins/chimera-plugin.ts': REASON_PLUGIN_RUNNER,
  'core/src/plugins/review-context-builder.ts': REASON_PLUGIN_RUNNER,
  'security-scanner/src/package-audit.ts': REASON_PLUGIN_RUNNER,
  'techstack/src/advisory/native-audit.ts': REASON_PLUGIN_RUNNER,
  // ── Interactive user terminals ──
  'acp/src/client/terminal-server.ts': REASON_USER_TERMINAL,
  'webui-server/src/server/terminal-ws-handler.ts': REASON_USER_TERMINAL,
  'webui-server/src/server/shell-open.ts': REASON_USER_TERMINAL,
  // ── Offline benchmark harness ──
  'bench/src/exec-command.ts': REASON_BENCH,
  'bench/src/runner.ts': REASON_BENCH,
  'bench/src/suites/swebench-patch.ts': REASON_BENCH,
  // ── User-configured hooks ──
  'core/src/hooks/shell-executor.ts': REASON_HOOKS,
};

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === 'coverage') continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

function packageSources(): string[] {
  const out: string[] = [];
  for (const pkg of readdirSync(PACKAGES)) {
    const src = path.join(PACKAGES, pkg, 'src');
    try {
      if (statSync(src).isDirectory()) sourceFiles(src, out);
    } catch {
      // package without a src/ dir
    }
  }
  return out;
}

interface DetachedSite {
  readonly rel: string;
  readonly line: number;
  readonly hasWindowsHide: boolean;
}

interface ChildCallSite {
  readonly rel: string;
  readonly line: number;
  readonly hasBuildChildEnv: boolean;
}

/** A child-process call: spawn/spawnSync/fork/execFile/exec(+Sync) — but not
 *  RegExp `.exec(…)` method calls, identifiers like `execAndCapture(`
 *  (alternatives require `\s*(` immediately after the API name), imports,
 *  comments, or declarations. The lookbehind rejects `.exec(` and
 *  word-prefixed names; a namespace form like `cp.spawn(…)` is matched
 *  explicitly. */
const CHILD_CALL_RE =
  /(?<![\w.])(?:spawn|spawnSync|fork|execFile|execFileSync|exec|execSync)\s*\(|(?:childProcess|child_process|cp)\.(?:spawn|spawnSync|fork|execFile|execFileSync|exec|execSync)\s*\(/;

function isNoiseLine(text: string): boolean {
  const trimmed = text.trim();
  return (
    trimmed.startsWith('//') ||
    trimmed.startsWith('*') ||
    trimmed.startsWith('/*') ||
    trimmed.startsWith('import ') ||
    trimmed.startsWith('export ')
  );
}

/** True when a `//` comment marker outside any string literal precedes the
 *  child-process call on the same line — the call text is prose. Quote-aware
 *  so `'https://…'` inside a string does not count as a comment start. */
function hasInlineCommentBefore(text: string, matchIndex: number): boolean {
  let quote: string | null = null;
  for (let i = 0; i < matchIndex; i++) {
    const ch = text[i]!;
    if (quote) {
      if (ch === '\\') {
        i++;
        continue;
      }
      if (ch === quote) quote = null;
    } else if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
    } else if (ch === '/' && text[i + 1] === '/') {
      return true;
    }
  }
  return false;
}

/** Whether `index` in `line` sits inside a string literal — prose like
 *  `'exec (RCE)'` or a path glob pattern must not look like calls. */
function matchInsideString(line: string, index: number): boolean {
  let quote: string | null = null;
  for (let i = 0; i < index; i++) {
    const ch = line[i]!;
    if (quote) {
      if (ch === '\\') {
        i++;
        continue;
      }
      if (ch === quote) quote = null;
    } else if (ch === "'" || ch === '"' || ch === '`') quote = ch;
  }
  return quote !== null;
}

/**
 * The matched call's own argument span: starting AT the match index, walk
 * parenthesis depth until the call's own closing paren (bounded at 40 lines).
 * Index-based, not line-based: two calls on one line must not share a span —
 * the first call's buildChildEnv must not credit the second (Chimera review).
 */
function callSpanText(lines: string[], startLine: number, startIndex: number): string {
  const rest = lines.slice(startLine, startLine + 40).join('\n');
  let depth = 0;
  let opened = false;
  for (let j = startIndex; j < rest.length; j++) {
    const ch = rest[j]!;
    if (ch === '(') {
      depth++;
      opened = true;
    } else if (ch === ')') {
      depth--;
      if (opened && depth <= 0) return rest.slice(startIndex, j + 1);
    }
  }
  return rest.slice(startIndex);
}

export interface ScannedChildCall {
  readonly line: number;
  readonly compliant: boolean;
}

/**
 * Pure line scanner for one file's child-process call sites. Exported so the
 * regression fixtures below can drive synthetic sources (adjacent compliant
 * and non-compliant calls, prose in strings) through the exact logic the
 * repo-wide scan uses.
 *
 * Compliant shapes, decided on the call's OWN argument span:
 *   1. `buildChildEnv(…)` appears inside the span (`env: buildChildEnv()` or
 *      `env: { ...buildChildEnv(), ...overrides }`), or
 *   2. the span passes an env IDENTIFIER (`env,` / `env: someVar` with no
 *      object literal) AND the file composes that identifier from
 *      buildChildEnv (`= buildChildEnv(`) AND the span never touches
 *      `process.env` — the bash/pwsh "compose once, spawn twice" shape.
 */
/**
 * Identifiers in `fileText` defined as `const <name> = buildChildEnv(…)` (or
 * `= { …buildChildEnv(…) }`). An `env: <name>` argument is compliant ONLY
 * when <name> is in this set — a buildChildEnv definition elsewhere in the
 * file must not launder an unrelated, process.env-derived variable into a
 * later spawn (Chimera review of the identifier path).
 */
export function buildChildEnvDerivedIdentifiers(fileText: string): Set<string> {
  const names = new Set<string>();
  // Direct composition: `const env = buildChildEnv(…)`. `[^=;\n]*` tolerates a
  // type annotation (`const env: NodeJS.ProcessEnv = buildChildEnv(…)`).
  for (const m of fileText.matchAll(
    /(?:const|let|var)\s+([A-Za-z_$][\w$]*)[^=;\n]*=\s*\{?\s*(?:\.\.\.)?\s*buildChildEnv\s*\(/g,
  )) {
    if (m[1]) names.add(m[1]);
  }
  // Options-object composition: `const spawnOpts: SpawnOptions = { … env:
  // buildChildEnv(…) … }`. Bounded lazy window so a later, unrelated
  // buildChildEnv cannot credit a distant definition (Chimera review:
  // name-tie, do not rely on adjacency). The window also refuses to cross a
  // statement terminator — `}` closes the object literal and `;` ends the
  // statement, so a definition that closes BEFORE any buildChildEnv cannot
  // be credited by a composition that appears in a LATER statement.
  for (const m of fileText.matchAll(
    /(?:const|let|var)\s+([A-Za-z_$][\w$]*)[^=;\n]*=\s*\{[^\};]{0,400}?buildChildEnv\s*\(/g,
  )) {
    if (m[1]) names.add(m[1]);
  }
  return names;
}

/**
 * Remove string-literal contents and comments from a call's argument span so
 * prose inside the arguments cannot satisfy the compliance checks —
 * `'call buildChildEnv() first'` as an option value must not credit a
 * process.env-derived spawn (Chimera review).
 */
function stripStringsAndComments(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i] ?? '';
    if (ch === '/' && text[i + 1] === '/') {
      // Line comment: skip to the END OF THIS LINE, not the end of the span.
      // The real H-8 migration sites carry explanatory comments inside their
      // multi-line options objects BEFORE `env: buildChildEnv()` — breaking
      // out here discarded the rest of the span and misflagged compliant
      // sites as non-compliant.
      const nl = text.indexOf('\n', i);
      if (nl === -1) break; // single-line text: nothing follows anyway
      out += ' ';
      i = nl + 1;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      out += ' ';
      i = end === -1 ? text.length : end + 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      out += ' ';
      i += 1;
      while (i < text.length && text[i] !== ch) {
        if (text[i] === '\\') i += 1; // escaped quote or backslash
        i += 1;
      }
      i += 1; // closing quote
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/**
 * Pure line scanner for one file's child-process call sites. Exported so the
 * regression fixtures below can drive synthetic sources (adjacent compliant
 * and non-compliant calls, prose in strings) through the exact logic the
 * repo-wide scan uses. EVERY call on a line is scanned (matchAll), the
 * string/comment guards are applied per match index, and string/comment
 * CONTENT is stripped from each span before the compliance tests.
 *
 * Compliant shapes, decided on the call's OWN argument span:
 *   1. `buildChildEnv(…)` appears inside the span (outside strings/comments),
 *   2. the span passes `env` as an identifier whose NAME is defined in the
 *      file as `= buildChildEnv(…)` (bash/pwsh "compose once, spawn twice"),
 *      and the span never touches `process.env`, or
 *   3. the call passes a bare options identifier (`spawnOpts`) read from the
 *      END of this call's own span, and that identifier is itself defined
 *      as a buildChildEnv-derived options object in this file (name-tied,
 *      not adjacency-tied — a nearby unrelated composition cannot launder
 *      a process.env-derived options object).
 */
export function scanChildCallLines(
  lines: string[],
  buildChildEnvIdentifiers: ReadonlySet<string>,
): ScannedChildCall[] {
  const out: ScannedChildCall[] = [];
  const globalRe = new RegExp(CHILD_CALL_RE.source, `${CHILD_CALL_RE.flags}g`);
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i] ?? '';
    if (isNoiseLine(text)) continue;
    globalRe.lastIndex = 0;
    for (const match of text.matchAll(globalRe)) {
      if (match.index === undefined) continue;
      if (matchInsideString(text, match.index)) continue;
      if (hasInlineCommentBefore(text, match.index)) continue;
      // String/comment contents are inert: strip them BEFORE any compliance
      // test so prose in an argument cannot impersonate a buildChildEnv call
      // or an env-key assignment (Chimera review).
      const span = stripStringsAndComments(callSpanText(lines, i, match.index));
      // Shape 2: `env,` shorthand names `env`; `env: someVar` names someVar.
      // The name must be a buildChildEnv-derived identifier in THIS file.
      const envIdentifier = /[{,]\s*env\s*,/.test(span)
        ? 'env'
        : span.match(/[{,]\s*env\s*:\s*([A-Za-z_$][\w$]*)\s*[,}\n]/)?.[1];
      const passesEnvIdentifier =
        envIdentifier !== undefined && buildChildEnvIdentifiers.has(envIdentifier);
      // Shape 3: options-object indirection. The trailing bare identifier
      // (`spawn(cmd, args, spawnOpts)`) is read from the END OF THIS CALL'S
      // SPAN — matching against the whole line would credit every call on a
      // multi-call line with the last call's identifier (Chimera review) —
      // and must itself be a buildChildEnv-derived identifier: name-tied,
      // NOT adjacency-tied, so a nearby unrelated composition cannot
      // launder a process.env-derived options object.
      const optionsIdentifier = span.trimEnd().match(/,\s*([A-Za-z_$][\w$]*)\s*\)$/)?.[1];
      const passesIdentifierOptions =
        optionsIdentifier !== undefined && buildChildEnvIdentifiers.has(optionsIdentifier);
      const compliant =
        /buildChildEnv\s*\(/.test(span) ||
        (passesEnvIdentifier && !/process\.env/.test(span)) ||
        passesIdentifierOptions;
      out.push({ line: i + 1, compliant });
    }
  }
  return out;
}

function childCallSites(): ChildCallSite[] {
  const sites: ChildCallSite[] = [];
  for (const file of packageSources()) {
    const fileText = readFileSync(file, 'utf8');
    const identifiers = buildChildEnvDerivedIdentifiers(fileText);
    const rel = path.relative(PACKAGES, file).split(path.sep).join('/');
    for (const scanned of scanChildCallLines(fileText.split('\n'), identifiers)) {
      sites.push({ rel, line: scanned.line, hasBuildChildEnv: scanned.compliant });
    }
  }
  return sites;
}

function detachedSites(): DetachedSite[] {
  const sites: DetachedSite[] = [];
  for (const file of packageSources()) {
    const lines = readFileSync(file, 'utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const text = lines[i] ?? '';
      // Option assignment only — skip comments, type declarations, and reads.
      if (!/^\s*detached:\s*\S/.test(text)) continue;
      // `detached: false` keeps the child on the parent's console; there is no
      // second window for `windowsHide` to suppress. (Whether every NON-
      // detached spawn that also redirects stdio should set the flag is a
      // wider sweep than this convention — those sites pop a console only when
      // they neither inherit nor detach.)
      if (/^\s*detached:\s*false/.test(text)) continue;
      const from = Math.max(0, i - PROXIMITY_LINES);
      const to = Math.min(lines.length, i + PROXIMITY_LINES + 1);
      const window = lines.slice(from, to).join('\n');
      sites.push({
        rel: path.relative(PACKAGES, file).split(path.sep).join('/'),
        line: i + 1,
        hasWindowsHide: /windowsHide:\s*true/.test(window),
      });
    }
  }
  return sites;
}

describe('Windows spawn convention', () => {
  const sites = detachedSites();

  it('finds the spawn sites it is meant to police', () => {
    // Guards every case below: an empty scan would pass vacuously.
    expect(sites.length).toBeGreaterThan(8);
  });

  it('every spawn that sets detached also sets windowsHide', () => {
    const missing = sites
      .filter((s) => !s.hasWindowsHide)
      .filter((s) => !Object.keys(WINDOWS_HIDE_EXEMPT).some((k) => s.rel.endsWith(k)))
      .map((s) => `${s.rel}:${s.line}`);
    expect(
      missing,
      `these pass detached without windowsHide: true — ${missing.join(', ')}. ` +
        `On win32 a detached console child (or its grandchildren) pops a visible ` +
        `window. Add the flag, or add the file to WINDOWS_HIDE_EXEMPT with a reason.`,
    ).toEqual([]);
  });

  it('the exemption list has no stale entries', () => {
    for (const [rel, reason] of Object.entries(WINDOWS_HIDE_EXEMPT)) {
      expect(reason.length, `${rel} needs a stated reason`).toBeGreaterThan(10);
      const matched = sites.filter((s) => s.rel.endsWith(rel));
      expect(matched.length, `${rel} no longer spawns detached — drop the entry`).toBeGreaterThan(
        0,
      );
      expect(
        matched.some((s) => !s.hasWindowsHide),
        `${rel} now sets windowsHide everywhere — drop it from WINDOWS_HIDE_EXEMPT`,
      ).toBe(true);
    }
  });
});

describe('child-process environment convention (buildChildEnv)', () => {
  const sites = childCallSites();

  it('finds the child-process call sites it is meant to police', () => {
    // Guards every case below: an empty scan would pass vacuously.
    expect(sites.length).toBeGreaterThan(15);
  });

  it('every child-process call routes its env through buildChildEnv', () => {
    const missing = sites
      .filter((s) => !s.hasBuildChildEnv)
      .filter((s) => !Object.keys(CHILD_ENV_EXEMPT).some((k) => s.rel.endsWith(k)))
      .map((s) => `${s.rel}:${s.line}`);
    expect(
      missing,
      `these spawn/exec sites do not reference buildChildEnv — ${missing.join(', ')}. ` +
        `An inherited or hand-built environment hands every provider API key and ` +
        `WRONGSTACK_VAULT_PASSPHRASE to the child (security report VF-09). Pass ` +
        `'env: buildChildEnv(…)' (or a spread based on it), or add the file to ` +
        `CHILD_ENV_EXEMPT with a stated reason.`,
    ).toEqual([]);
  });

  it('the child-env exemption list has no stale entries', () => {
    const stale: string[] = [];
    for (const [rel, reason] of Object.entries(CHILD_ENV_EXEMPT)) {
      expect(reason.length, `${rel} needs a stated reason`).toBeGreaterThan(10);
      const matched = sites.filter((s) => s.rel.endsWith(rel));
      if (matched.length === 0) {
        stale.push(`${rel} (no longer spawns children)`);
        continue;
      }
      if (!matched.some((s) => !s.hasBuildChildEnv)) {
        stale.push(`${rel} (now uses buildChildEnv everywhere)`);
      }
    }
    expect(stale, `drop these entries: ${stale.join('; ')}`).toEqual([]);
  });
});

describe('childCallSites scanner (regression fixtures)', () => {
  it('a compliant neighbor never masks an adjacent unsafe call', () => {
    const lines = [
      "import { spawn } from 'node:child_process';",
      'const a = spawn(cmd, args, { env: buildChildEnv() });',
      'const b = spawn(cmd, args, { env: { ...process.env } });',
    ];
    const scanned = scanChildCallLines(lines, new Set<string>());
    expect(scanned).toHaveLength(2);
    expect(scanned[0]?.compliant).toBe(true);
    expect(scanned[1]?.compliant).toBe(false);
  });

  it('prose inside string literals is not a call', () => {
    const lines = [
      "const reason = 'arbitrary command exec (RCE)';",
      "const glob = scan('**' + '/*.ts');",
    ];
    expect(scanChildCallLines(lines, new Set<string>())).toEqual([]);
  });

  it('RegExp .exec(…) method calls are ignored', () => {
    const lines = ['const m = SOME_RE.exec(text);', 'if (pattern.exec(line)) return;'];
    expect(scanChildCallLines(lines, new Set<string>())).toEqual([]);
  });

  it('env identifier composed once from buildChildEnv covers every spawn', () => {
    const lines = [
      'const env = buildChildEnv(sessionId);',
      'const a = spawn(cmd, args, {',
      '  cwd,',
      '  env,',
      '  windowsHide: true,',
      '});',
    ];
    const scanned = scanChildCallLines(lines, new Set(['env']));
    expect(scanned).toHaveLength(1);
    expect(scanned[0]?.compliant).toBe(true);
  });

  it('env identifier is NOT compliant when the file composes from process.env', () => {
    const lines = [
      'const env = { ...process.env, EXTRA: "1" };',
      'const a = spawn(cmd, args, { cwd, env, windowsHide: true });',
    ];
    const scanned = scanChildCallLines(lines, new Set());
    expect(scanned).toHaveLength(1);
    expect(scanned[0]?.compliant).toBe(false);
  });

  it('a buildChildEnv definition does not launder an unrelated env variable', () => {
    // Chimera review: the identifier path must tie the NAME — a safeEnv
    // definition elsewhere in the file cannot bless a rawEnv pass-through.
    const lines = [
      'const safeEnv = buildChildEnv();',
      'const rawEnv = { ...process.env };',
      'const a = spawn(cmd, args, { env: rawEnv, windowsHide: true });',
    ];
    const scanned = scanChildCallLines(lines, new Set(['safeEnv']));
    expect(scanned).toHaveLength(1);
    expect(scanned[0]?.compliant).toBe(false);
  });

  it('every call on a multi-call line is scanned', () => {
    // Chimera review: exec-without-g scanned only the first match per line.
    const lines = [
      'const a = spawn(x, y, { env: buildChildEnv() }); const b = spawn(p, q, { env: { ...process.env } });',
    ];
    const scanned = scanChildCallLines(lines, new Set<string>());
    expect(scanned).toHaveLength(2);
    expect(scanned[0]?.compliant).toBe(true);
    expect(scanned[1]?.compliant).toBe(false);
  });

  it('options-identifier credit is per-call, not per-line', () => {
    // Chimera review: the trailing identifier was matched against the whole
    // LINE, so on a multi-call line every call inherited the LAST call's
    // identifier — the unsafe first spawn below was credited with `safeOpts`.
    const lines = [
      'const a = spawn(p, q, { env: { ...process.env } }); const b = spawn(x, y, safeOpts);',
    ];
    const scanned = scanChildCallLines(lines, new Set(['safeOpts']));
    expect(scanned).toHaveLength(2);
    expect(scanned[0]?.compliant).toBe(false);
    expect(scanned[1]?.compliant).toBe(true);
  });

  it('prose inside a string argument cannot satisfy the checks', () => {
    // Chimera review: `'call buildChildEnv() first'` as an option VALUE used
    // to satisfy the direct-composition test inside the span.
    const lines = [
      "const child = spawn(x, y, { env: { ...process.env }, note: 'call buildChildEnv() first' });",
    ];
    const scanned = scanChildCallLines(lines, new Set<string>());
    expect(scanned).toHaveLength(1);
    expect(scanned[0]?.compliant).toBe(false);
  });

  it('a line comment inside a multi-line span does not truncate it', () => {
    // The H-8 migration sites carry explanatory comments inside their
    // options objects BEFORE `env: buildChildEnv()` — the stripper must skip
    // to end-of-line, not discard the rest of the span (regression: the
    // `break` version misflagged all seven migrated sites).
    const lines = [
      "const child = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {",
      "  stdio: 'ignore',",
      '  // H-8 convention (spawn-convention test): strip credentials.',
      '  env: buildChildEnv(),',
      '  windowsHide: true,',
      '});',
    ];
    const scanned = scanChildCallLines(lines, new Set<string>());
    expect(scanned).toHaveLength(1);
    expect(scanned[0]?.compliant).toBe(true);
  });

  it('options-identifier calls are name-tied, not adjacency-tied', () => {
    // spawn-background shape: spawnOpts composed from buildChildEnv.
    const compliant = [
      'const spawnOpts = {',
      '  cwd,',
      '  env: buildChildEnv({ extra: env }),',
      '  windowsHide: true,',
      '};',
      'const child = spawn(shell, shellArgs, spawnOpts);',
    ];
    expect(
      scanChildCallLines(compliant, buildChildEnvDerivedIdentifiers(compliant.join('\n'))),
    ).toHaveLength(1);
    expect(
      scanChildCallLines(compliant, buildChildEnvDerivedIdentifiers(compliant.join('\n')))[0]
        ?.compliant,
    ).toBe(true);

    // Chimera laundering shape: an unrelated buildChildEnv NEAR a spawn whose
    // options object was derived from process.env — adjacency must not credit.
    const laundering = [
      'const unrelated = buildChildEnv();',
      'const spawnOpts = { env: { ...process.env } };',
      'const child = spawn(shell, shellArgs, spawnOpts);',
    ];
    const scanned = scanChildCallLines(
      laundering,
      buildChildEnvDerivedIdentifiers(laundering.join('\n')),
    );
    expect(scanned).toHaveLength(1);
    expect(scanned[0]?.compliant).toBe(false);

    // Chimera follow-up — AFTER direction: the definition closes before any
    // buildChildEnv appears (composition in a LATER statement). The tightened
    // window refuses to cross `}` / `;`, so the options identifier is not
    // credited by the later composition.
    const launderingAfter = [
      'const opts: SpawnOptions = { env: { ...process.env } };',
      'const safe = buildChildEnv();',
      'const child = spawn(shell, shellArgs, opts);',
    ];
    const scannedAfter = scanChildCallLines(
      launderingAfter,
      buildChildEnvDerivedIdentifiers(launderingAfter.join('\n')),
    );
    expect(scannedAfter).toHaveLength(1);
    expect(scannedAfter[0]?.compliant).toBe(false);
  });

  it('inline prose comments after code are ignored', () => {
    const lines = ['const x = 1; // spawn(never) happened here'];
    expect(scanChildCallLines(lines, new Set())).toEqual([]);
  });
});
