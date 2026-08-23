/**
 * Directive guard: every documented RAM-leak cap stays in place.
 *
 * The bug this encodes: a 10-hour autonomous session once hit
 * `FATAL ERROR: Ineffective mark-compacts near heap limit` with nothing
 * attributing WHAT grew. The subsequent audit (audit 2026-07-31) read every
 * long-running service end-to-end and confirmed each one has an explicit cap
 * with proper cleanup. This test pins those caps at their audited values so
 * a future refactor cannot silently drop a cap or change its value without
 * the test failing.
 *
 * Net effect: the audit verdict (no unmitigated RAM leaks) becomes a CI
 * guard rather than a one-time reading. If a cap is removed, the test
 * names the missing file/constant; if a cap shrinks, the test fails before
 * the change can land.
 *
 * Scan strategy: source-level regex over the relevant src/ trees. A
 * behaviour test only covers the paths it exercises; a re-introduced
 * unbounded `.push()` in some seldom-hit branch would slip through, and
 * the failure mode (quietly growing memory) is one nobody notices for
 * months. Source-level guards see the regression regardless of which call
 * site triggers it.
 *
 * Comments are stripped before scanning so prose describing the old bug
 * doesn't trip the assertions.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../',
);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** Strip comments so prose describing the old bug doesn't trip the scan. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function loadPackage(packagePath: string): Map<string, string> {
  const src = path.join(REPO_ROOT, packagePath, 'src');
  const out = new Map<string, string>();
  for (const file of sourceFiles(src)) {
    const rel = path.relative(src, file).replace(/\\/g, '/');
    out.set(rel, stripComments(readFileSync(file, 'utf8')));
  }
  return out;
}

const PACKAGES = {
  core: 'packages/core',
  tools: 'packages/tools',
  webui: 'packages/webui-server',
  kanban: 'packages/kanban',
  sage: 'packages/sage',
  tui: 'packages/tui',
} as const;

const PKG_FILES: Record<keyof typeof PACKAGES, Map<string, string>> = {
  core: loadPackage(PACKAGES.core),
  tools: loadPackage(PACKAGES.tools),
  webui: loadPackage(PACKAGES.webui),
  kanban: loadPackage(PACKAGES.kanban),
  sage: loadPackage(PACKAGES.sage),
  tui: loadPackage(PACKAGES.tui),
};

/**
 * Resolve a `package/relative/path.ts:CONST_NAME` reference to its
 * `export const … = (…)` value. Returns the literal text that follows
 * `=`, which is then re-parsed by the per-cap helpers. Returns undefined
 * if the file or constant is missing — the per-cap test reports that as
 * a named failure rather than a silent pass.
 */
function readConst(
  pkg: keyof typeof PACKAGES,
  ref: string,
): { value: string | undefined; file: string } {
  const [rel, name] = ref.split(':');
  const file = rel ?? '';
  const code = PKG_FILES[pkg].get(file) ?? '';
  // Match `const NAME = …;` or `export const NAME = …;` (allow private
  // static readonly too — the audit's caps use that pattern).
  const pattern = new RegExp(
    `\\b(?:export\\s+)?(?:const|static\\s+readonly)\\s+${name}\\s*=\\s*([^;]+);`,
  );
  const match = code.match(pattern);
  return { value: match?.[1]?.trim(), file: `${PACKAGES[pkg]}/src/${file}` };
}

describe('RAM-leak caps (audit 2026-07-31)', () => {
  // ── guards-of-the-guard ──────────────────────────────────────────────────
  // Each test below assumes the scan walked real source. A broken glob
  // silently passing every assertion would render the suite useless.

  it.each([
    ['core', 500],
    ['tools', 30],
    ['webui', 50],
    ['kanban', 50],
    ['sage', 50],
    ['tui', 50],
  ] as const)('scans a plausible number of %s sources', (pkg, min) => {
    expect(PKG_FILES[pkg].size).toBeGreaterThan(min);
  });

  // ── core ────────────────────────────────────────────────────────────────

  it('core/events: MAX_NAMED_LISTENERS = 2000', () => {
    const { value, file } = readConst('core', 'kernel/events.ts:MAX_NAMED_LISTENERS');
    expect(value, file).toBe('2000');
  });

  it('core/knowledge-graph: DEFAULT_MAX_NODES = 2_000', () => {
    const { value, file } = readConst(
      'core',
      'coordination/knowledge-graph.ts:DEFAULT_MAX_NODES',
    );
    expect(value, file).toBe('2_000');
  });

  it('core/knowledge-graph: MAX_SUBSCRIPTIONS = 1_000', () => {
    const { value, file } = readConst(
      'core',
      'coordination/knowledge-graph.ts:MAX_SUBSCRIPTIONS',
    );
    expect(value, file).toBe('1_000');
  });

  it('core/knowledge-graph: MAX_PENDING_DELIVERIES_PER_SUBSCRIPTION = 1_000', () => {
    const { value, file } = readConst(
      'core',
      'coordination/knowledge-graph.ts:MAX_PENDING_DELIVERIES_PER_SUBSCRIPTION',
    );
    expect(value, file).toBe('1_000');
  });

  it('core/multi-agent-coordinator: MAX_COMPLETED_RESULTS = 200_000', () => {
    const { value, file } = readConst(
      'core',
      'coordination/multi-agent-coordinator.ts:MAX_COMPLETED_RESULTS',
    );
    expect(value, file).toBe('200_000');
  });

  it('core/multi-agent-coordinator: MAX_SUBAGENT_TASK_HISTORY = 64', () => {
    const { value, file } = readConst(
      'core',
      'coordination/multi-agent-coordinator.ts:MAX_SUBAGENT_TASK_HISTORY',
    );
    expect(value, file).toBe('64');
  });

  it('core/large-answer-store: DEFAULT_MAX_ENTRIES = 256', () => {
    const { value, file } = readConst(
      'core',
      'coordination/large-answer-store.ts:DEFAULT_MAX_ENTRIES',
    );
    expect(value, file).toBe('256');
  });

  it('core/large-answer-store: DEFAULT_MAX_BYTES = 32 MiB', () => {
    const { value, file } = readConst(
      'core',
      'coordination/large-answer-store.ts:DEFAULT_MAX_BYTES',
    );
    expect(value, file).toBe('32 * 1024 * 1024');
  });

  it('core/file-observer: MAX_RECENT_TOOL_MUTATIONS = 500', () => {
    const { value, file } = readConst(
      'core',
      'chronicle/file-observer.ts:MAX_RECENT_TOOL_MUTATIONS',
    );
    expect(value, file).toBe('500');
  });

  it('core/file-observer: SCAN_HASH_CONCURRENCY = 32', () => {
    const { value, file } = readConst(
      'core',
      'chronicle/file-observer.ts:SCAN_HASH_CONCURRENCY',
    );
    expect(value, file).toBe('32');
  });

  it('core/file-observer: DEFAULT_FULL_RESCAN_MIN_INTERVAL_MS = 30_000', () => {
    const { value, file } = readConst(
      'core',
      'chronicle/file-observer.ts:DEFAULT_FULL_RESCAN_MIN_INTERVAL_MS',
    );
    expect(value, file).toBe('30_000');
  });

  it('core/agent-status-tracker: RECENT_TOOL_LIMIT = 12', () => {
    const { value, file } = readConst('core', 'coordination/agent-status-tracker.ts:RECENT_TOOL_LIMIT');
    expect(value, file).toBe('12');
  });

  it('core/agent-status-tracker: RECENT_MAIL_LIMIT = 12', () => {
    const { value, file } = readConst('core', 'coordination/agent-status-tracker.ts:RECENT_MAIL_LIMIT');
    expect(value, file).toBe('12');
  });

  it('core/agent-status-tracker: SEEN_MAIL_LIMIT = 10_000', () => {
    const { value, file } = readConst('core', 'coordination/agent-status-tracker.ts:SEEN_MAIL_LIMIT');
    expect(value, file).toBe('10_000');
  });

  it('core/agent-status-tracker: PARTIAL_TEXT_CAP = 1200', () => {
    const { value, file } = readConst('core', 'coordination/agent-status-tracker.ts:PARTIAL_TEXT_CAP');
    expect(value, file).toBe('1200');
  });

  it('core/agent-status-tracker: TASK_TEXT_CAP = 1200', () => {
    const { value, file } = readConst('core', 'coordination/agent-status-tracker.ts:TASK_TEXT_CAP');
    expect(value, file).toBe('1200');
  });

  it('core/agent-status-tracker: PROMPT_TEXT_CAP = 6000', () => {
    const { value, file } = readConst('core', 'coordination/agent-status-tracker.ts:PROMPT_TEXT_CAP');
    expect(value, file).toBe('6000');
  });

  it('core/agent-status-tracker: AGENT_REAP_MS = 30_000', () => {
    const { value, file } = readConst('core', 'coordination/agent-status-tracker.ts:AGENT_REAP_MS');
    expect(value, file).toBe('30_000');
  });

  it('core/agent-status-tracker: AGENT_SWEEP_INTERVAL_MS = 10_000', () => {
    const { value, file } = readConst(
      'core',
      'coordination/agent-status-tracker.ts:AGENT_SWEEP_INTERVAL_MS',
    );
    expect(value, file).toBe('10_000');
  });

  it('core/agent-status-tracker: PENDING_TOOL_TTL_MS = 300_000', () => {
    const { value, file } = readConst('core', 'coordination/agent-status-tracker.ts:PENDING_TOOL_TTL_MS');
    expect(value, file).toBe('300_000');
  });

  it('core/fleet-supervisor: HISTORY_MAX = 100', () => {
    const { value, file } = readConst('core', 'coordination/fleet-supervisor.ts:HISTORY_MAX');
    expect(value, file).toBe('100');
  });

  it('core/remote-mailbox: HQ_MAILBOX_EVENT_MAX_PENDING = 256', () => {
    const { value, file } = readConst(
      'core',
      'coordination/remote-mailbox.ts:HQ_MAILBOX_EVENT_MAX_PENDING',
    );
    expect(value, file).toBe('256');
  });

  it('core/remote-mailbox: HQ_MAILBOX_SNAPSHOT_MIN_INTERVAL_MS = 10_000', () => {
    const { value, file } = readConst(
      'core',
      'coordination/mailbox-constants.ts:HQ_MAILBOX_SNAPSHOT_MIN_INTERVAL_MS',
    );
    expect(value, file).toBe('10_000');
  });

  it('core/mailbox-project-server: MAX_CLIENT_WRITE_BUFFER_BYTES = 8 MiB', () => {
    const { value, file } = readConst(
      'core',
      'coordination/mailbox-project-server.ts:MAX_CLIENT_WRITE_BUFFER_BYTES',
    );
    expect(value, file).toBe('8 * 1024 * 1024');
  });

  // ── tools ──────────────────────────────────────────────────────────────

  it('tools/_output-spool: SPOOL_WRITE_HWM_BYTES = 4 MiB', () => {
    const { value, file } = readConst('tools', '_output-spool.ts:SPOOL_WRITE_HWM_BYTES');
    expect(value, file).toBe('4 * 1024 * 1024');
  });

  it('tools/_output-spool: SPOOL_RETENTION_MS = 7 days', () => {
    const { value, file } = readConst('tools', '_output-spool.ts:SPOOL_RETENTION_MS');
    expect(value, file).toBe('7 * 24 * 60 * 60 * 1000');
  });

  it('tools/process-registry: DEFAULT_GRACE_MS = 2000', () => {
    const { value, file } = readConst('tools', 'process-registry.ts:DEFAULT_GRACE_MS');
    expect(value, file).toBe('2000');
  });

  it('tools/process-registry-persistent: HEARTBEAT_INTERVAL_MS = 5_000', () => {
    const { value, file } = readConst(
      'tools',
      'process-registry-persistent.ts:HEARTBEAT_INTERVAL_MS',
    );
    expect(value, file).toBe('5_000');
  });

  it('tools/process-registry-persistent: STALE_THRESHOLD_MS = 30_000', () => {
    const { value, file } = readConst(
      'tools',
      'process-registry-persistent.ts:STALE_THRESHOLD_MS',
    );
    expect(value, file).toBe('30_000');
  });

  it('tools/process-registry-persistent: LOCK_STALE_MS = 30_000', () => {
    const { value, file } = readConst(
      'tools',
      'process-registry-persistent.ts:LOCK_STALE_MS',
    );
    expect(value, file).toBe('30_000');
  });

  // ── webui-server ───────────────────────────────────────────────────────

  it('webui/terminal-ws-handler: MAX_SESSIONS_PER_CLIENT = 8', () => {
    const { value, file } = readConst(
      'webui',
      'server/terminal-ws-handler.ts:MAX_SESSIONS_PER_CLIENT',
    );
    expect(value, file).toBe('8');
  });

  it('webui/terminal-ws-handler: MAX_INPUT_BYTES = 64 KiB', () => {
    const { value, file } = readConst(
      'webui',
      'server/terminal-ws-handler.ts:MAX_INPUT_BYTES',
    );
    expect(value, file).toBe('1 << 16');
  });

  it('webui/worktree-ws-handler: MAX_ACTIVITY = 6', () => {
    const { value, file } = readConst(
      'webui',
      'server/worktree-ws-handler.ts:MAX_ACTIVITY',
    );
    expect(value, file).toBe('6');
  });

  // ── kanban ─────────────────────────────────────────────────────────────

  it('kanban/event-emitter: MAX_LISTENERS = 200', () => {
    const { value, file } = readConst('kanban', 'server/event-emitter.ts:MAX_LISTENERS');
    expect(value, file).toBe('200');
  });

  // ── sage ───────────────────────────────────────────────────────────────

  it('sage/sqlite-store-statement-cache: caller-provided cap stays wired', () => {
    // The cache's `maxEntries` is a constructor parameter — the cap lives
    // at the call site, not in the class. Guard the *call* site.
    const sage = PKG_FILES['sage'];
    const callers = [...sage.entries()].filter(
      ([, code]) => /new\s+SqliteStatementCache\s*\(/.test(code),
    );
    expect(
      callers.length,
      'SqliteStatementCache must be instantiated at least once — the cap is wired at the call site',
    ).toBeGreaterThan(0);
    for (const [rel, code] of callers) {
      const match = code.match(/new\s+SqliteStatementCache\s*\(\s*(\d+)/);
      expect(
        match,
        `${rel}: SqliteStatementCache instantiations must pass a numeric maxEntries — ` +
          'audit 2026-07-31 confirmed the cap is 128; a missing arg silently disables the LRU',
      ).not.toBeNull();
      const cap = Number(match![1]);
      expect(
        cap,
        `${rel}: SqliteStatementCache(maxEntries) regressed to ${cap} — the 2026-07-31 cap was 128`,
      ).toBeGreaterThanOrEqual(64);
    }
  });

  // ── tui ────────────────────────────────────────────────────────────────

  it('tui/history-retention: TUI_HISTORY_MAX_ENTRIES = 400', () => {
    const { value, file } = readConst('tui', 'history-retention.ts:TUI_HISTORY_MAX_ENTRIES');
    expect(value, file).toBe('400');
  });

  it('tui/history-retention: TUI_HISTORY_MAX_BYTES = 1 MiB', () => {
    const { value, file } = readConst('tui', 'history-retention.ts:TUI_HISTORY_MAX_BYTES');
    expect(value, file).toBe('1024 * 1024');
  });

  it('tui/history-retention: TUI_HISTORY_MAX_ENTRY_BYTES = 64 KiB', () => {
    const { value, file } = readConst(
      'tui',
      'history-retention.ts:TUI_HISTORY_MAX_ENTRY_BYTES',
    );
    expect(value, file).toBe('64 * 1024');
  });
});
