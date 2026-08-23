/**
 * Project-daemon invariant.
 *
 * Kanban, Mailbox, SAGE memory, Codebase Index, Chronicle telemetry, and the
 * Session Catalog are all
 * meant to be the same shape: exactly one detached daemon per project, reached
 * only over IPC, with SQLite as the sole backing store. Two properties keep
 * that true, and both are easy to lose silently:
 *
 *  1. The IPC endpoint is derived from a hash of the resolved project directory
 *     plus a protocol version. That is what makes N terminals converge on ONE
 *     daemon — the socket bind doubles as the ownership election.
 *
 *  2. When the built server cannot be reached, the client fails **closed**.
 *     A silent in-process fallback is the failure mode that quietly turns "one
 *     daemon per project" into "one private store per process": nothing errors,
 *     the data just stops being shared. Chronicle's own source notes that a
 *     bundled `import.meta.url` can "silently select the inline fallback", so
 *     this is not hypothetical.
 *
 * Escape hatches are fine — every subsystem has an env var for recovery — but
 * they must be *requested*, never entered by accident.
 *
 * `KNOWN_GAPS` below is the live migration checklist. It is asserted in BOTH
 * directions: a listed subsystem that becomes compliant fails this test until
 * its entry is deleted, so the list can never drift into a stale allowlist.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Module-relative so the suite passes from any vitest root (the package
// `test` script runs vitest with --root ../.. from the package directory).
const ROOT = path.resolve(fileURLToPath(new URL('../../../..', import.meta.url)));

interface DaemonSpec {
  readonly name: string;
  /** Module that computes the IPC endpoint path. */
  readonly endpointModule: string;
  /** Module holding the "use the daemon, or fall back" decision. */
  readonly accessModule: string;
  /** Env var a user must set to deliberately leave the daemon path. */
  readonly inlineEnv: string;
  /** The daemon entry that binds the endpoint. */
  readonly serverModule: string;
}

const DAEMONS: readonly DaemonSpec[] = [
  {
    name: 'mailbox',
    endpointModule: 'packages/core/src/coordination/mailbox-project-server-endpoint.ts',
    accessModule: 'packages/core/src/coordination/mailbox-project-server-client.ts',
    inlineEnv: 'WRONGSTACK_MAILBOX_INLINE',
    serverModule: 'packages/core/src/coordination/mailbox-project-server.ts',
  },
  {
    name: 'sage',
    endpointModule: 'packages/sage/src/project-server-endpoint.ts',
    accessModule: 'packages/sage/src/project-server-client.ts',
    inlineEnv: 'WRONGSTACK_SAGE_INLINE',
    serverModule: 'packages/sage/src/project-server.ts',
  },
  {
    name: 'chronicle',
    endpointModule: 'packages/core/src/chronicle/project-server-endpoint.ts',
    accessModule: 'packages/core/src/chronicle/project-access.ts',
    inlineEnv: 'WRONGSTACK_CHRONICLE_INLINE',
    serverModule: 'packages/core/src/chronicle/project-server.ts',
  },
  {
    name: 'codebase-index',
    endpointModule: 'packages/tools/src/codebase-index/project-server-endpoint.ts',
    accessModule: 'packages/tools/src/codebase-index/background-indexer.ts',
    inlineEnv: 'WRONGSTACK_INDEX_INLINE',
    serverModule: 'packages/tools/src/codebase-index/project-server.ts',
  },
  {
    name: 'kanban',
    endpointModule: 'packages/kanban/src/server/endpoint.ts',
    accessModule: 'packages/kanban/src/server/kanban-store.ts',
    inlineEnv: 'WRONGSTACK_KANBAN_SERVER',
    serverModule: 'packages/kanban/src/server/project-server.ts',
  },
  {
    name: 'session-catalog',
    endpointModule: 'packages/core/src/session-catalog/endpoint.ts',
    accessModule: 'packages/core/src/session-catalog/client.ts',
    inlineEnv: 'WRONGSTACK_SESSION_CATALOG_INLINE',
    serverModule: 'packages/core/src/session-catalog/project-server.ts',
  },
];

/**
 * Subsystems that still enter a non-daemon path without being asked to.
 *
 * Empty: all five now refuse to continue when the built server is missing.
 * Kept as a bidirectional ratchet — add a name here only alongside the reason
 * and a plan, and the honesty test below forces it back out once fixed.
 */
const KNOWN_GAPS = new Set<string>();

/**
 * Subsystems whose primary stream is still a file format other than SQLite.
 *
 * Empty: chronicle completed `chronicle-sqlite-journal-v1`. Its events live in
 * `chronicle.sqlite` with the `previousHash`/`sequence` chain carried over
 * untouched, and `identity.ts` now resolves a directory and a day rather than a
 * `.jsonl` path. `WRONGSTACK_CHRONICLE_STORE=jsonl` still selects the legacy
 * writer, which is why the assertion below targets identity resolution rather
 * than the mere existence of partition code.
 */
const KNOWN_NON_SQLITE = new Set<string>();

/**
 * Subsystems whose endpoint key is not a cryptographic hash.
 *
 * Keep this list empty. It remains as a bidirectional ratchet for future
 * project daemons that have not yet adopted the SHA-256 endpoint convention.
 */
const WEAK_ENDPOINT_HASH = new Set<string>();

/** `return new InlineX(...)`, `return callInline(...)`, or a file-mode branch. */
const INLINE_HANDOFF = /return\s+(?:new\s+Inline\w*|callInline\s*\()|mode\s*===\s*['"]file['"]/u;

/**
 * Does this module take the non-daemon path only when explicitly asked?
 *
 * Naming the escape-hatch env var in a raised error is the observable
 * difference between "the operator chose this" and "the build is broken and we
 * carried on anyway". Merely *having* an inline implementation is fine — every
 * subsystem needs a recovery mode — so the check is for the guard, not for the
 * absence of the fallback.
 */
function guardsInlineHandoff(source: string, inlineEnv: string): boolean {
  if (!INLINE_HANDOFF.test(source)) return true;
  // A promise-returning entry point rejects rather than throwing synchronously;
  // both surface the failure to the caller, so accept either form.
  return new RegExp(
    `(?:throw\\s+new\\s+Error\\(|Promise\\.reject\\(\\s*new\\s+Error\\()[\\s\\S]{0,400}?${inlineEnv}`,
    'u',
  ).test(source);
}

/** Either raising form counts as refusing to continue. */
const RAISES = /throw\s+new\s+Error\(|Promise\.reject\(\s*new\s+Error\(/u;

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/^\s*\/\/.*$/gmu, '');
}

async function readSource(relative: string): Promise<string> {
  return stripComments(await fs.readFile(path.join(ROOT, relative), 'utf8'));
}

describe('project daemon boundary', () => {
  it('keeps the legacy device-global session registry out of production consumers', async () => {
    const packageRoot = path.join(ROOT, 'packages');
    const violations: string[] = [];
    const visit = async (directory: string): Promise<void> => {
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== 'tests' && entry.name !== 'dist' && entry.name !== 'node_modules') {
            await visit(full);
          }
          continue;
        }
        if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
        const relative = path.relative(ROOT, full).replaceAll('\\', '/');
        if (relative === 'packages/core/src/session-catalog/session-registry.ts') continue;
        const source = await fs.readFile(full, 'utf8');
        if (source.includes('session-registry.json')) violations.push(relative);
        if (
          /import\s+(?!type\b)[^;]{0,300}?from\s+['"](?:\.\.\/|\.\/)session-registry\.js['"]/u.test(
            source,
          )
        ) {
          violations.push(`${relative}: imports legacy registry behavior`);
        }
      }
    };
    await visit(packageRoot);
    expect(violations).toEqual([]);
  });

  it('derives every IPC endpoint from a hashed project directory and a protocol version', async () => {
    const violations: string[] = [];

    for (const daemon of DAEMONS) {
      const source = await readSource(daemon.endpointModule);
      // The hash is what makes two terminals in the same project agree on one
      // socket; the version is what stops an old build from adopting a new
      // protocol's daemon.
      if (
        !WEAK_ENDPOINT_HASH.has(daemon.name) &&
        !/createHash\s*\(\s*['"]sha256['"]\s*\)/u.test(source)
      ) {
        violations.push(`${daemon.name}: endpoint key is not a sha256 of the project directory`);
      }
      // Whatever the digest, the input must be a canonicalized absolute path or
      // two spellings of one directory get two daemons.
      if (!/path\.resolve\s*\(/u.test(source)) {
        violations.push(`${daemon.name}: endpoint key is not derived from a resolved path`);
      }
      if (!/PROTOCOL_VERSION/u.test(source)) {
        violations.push(`${daemon.name}: endpoint path omits the protocol version`);
      }
      if (!/\\\\\.\\pipe\\|\.sock/u.test(source)) {
        violations.push(`${daemon.name}: endpoint is neither a named pipe nor a unix socket`);
      }
    }

    expect(violations).toEqual([]);
  });

  it('fails closed when the built server is unavailable', async () => {
    const violations: string[] = [];

    for (const daemon of DAEMONS) {
      if (KNOWN_GAPS.has(daemon.name)) continue;
      const source = await readSource(daemon.accessModule);
      if (!guardsInlineHandoff(source, daemon.inlineEnv)) {
        violations.push(
          `${daemon.name}: ${daemon.accessModule} enters an inline path without requiring ${daemon.inlineEnv}`,
        );
      }
      if (!RAISES.test(source)) {
        violations.push(
          `${daemon.name}: ${daemon.accessModule} never raises when the daemon is missing`,
        );
      }
    }

    expect(violations).toEqual([]);
  });

  it('keeps KNOWN_GAPS honest — a fixed subsystem must be removed from the list', async () => {
    const stillBroken: string[] = [];

    for (const daemon of DAEMONS) {
      if (!KNOWN_GAPS.has(daemon.name)) continue;
      const source = await readSource(daemon.accessModule);
      if (!guardsInlineHandoff(source, daemon.inlineEnv)) stillBroken.push(daemon.name);
    }

    // If this fails with a MISSING entry, the subsystem was fixed: delete it
    // from KNOWN_GAPS so the fail-closed test starts guarding it for real.
    expect(stillBroken.sort()).toEqual([...KNOWN_GAPS].sort());
  });

  it('keeps WEAK_ENDPOINT_HASH honest — a hardened endpoint must be removed from the list', async () => {
    const stillWeak: string[] = [];

    for (const daemon of DAEMONS) {
      if (!WEAK_ENDPOINT_HASH.has(daemon.name)) continue;
      const source = await readSource(daemon.endpointModule);
      if (!/createHash\s*\(\s*['"]sha256['"]\s*\)/u.test(source)) stillWeak.push(daemon.name);
    }

    expect(stillWeak.sort()).toEqual([...WEAK_ENDPOINT_HASH].sort());
  });

  it('binds through the shared endpoint election, never a hand-rolled listen', async () => {
    // Why this is a gate and not a convention: the probe-then-reclaim ladder
    // was previously copied by hand into five daemons at three levels of
    // completeness, and the two that omitted the probe — kanban and
    // codebase-index — were wedgeable by a single SIGKILL. A daemon that dies
    // without releasing its Unix socket leaves a file that refuses clients AND
    // blocks every replacement from binding, with nothing to break the loop.
    //
    // `bindProjectEndpoint` (@wrongstack/persistence) is that ladder, written
    // once. A daemon that calls `server.listen()` directly has opted out of it,
    // which is exactly how the defect shipped twice.
    const offenders: string[] = [];
    for (const daemon of DAEMONS) {
      const source = await readSource(daemon.serverModule);
      if (!source.includes('bindProjectEndpoint(')) {
        offenders.push(`${daemon.name}: does not call bindProjectEndpoint`);
        continue;
      }
      if (/\bserver\.listen\s*\(|\blistener\.listen\s*\(/u.test(source)) {
        offenders.push(`${daemon.name}: still calls listen() directly`);
      }
      // The reclaim decision belongs to the primitive. A daemon that inspects
      // EADDRINUSE itself is re-deriving the ladder and can get it wrong again.
      if (source.includes('EADDRINUSE')) {
        offenders.push(`${daemon.name}: handles EADDRINUSE outside the primitive`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('opens the store only after winning the endpoint election', async () => {
    // The election is the shared `bindProjectEndpoint` primitive; a losing
    // contender exits before it can open storage. Only the mailbox owner
    // constructs its store directly on that path today — the others open
    // storage lazily elsewhere — so this is asserted where it is structurally
    // checkable and extended per migration.
    const owner = 'packages/core/src/coordination/mailbox-project-server.ts';
    const source = await fs.readFile(path.join(ROOT, owner), 'utf8');
    const elects = source.indexOf('bindProjectEndpoint(');
    const opensStore = source.indexOf('new SqliteMailbox');

    expect(elects).toBeGreaterThanOrEqual(0);
    expect(opensStore).toBeGreaterThan(elects);

    const kanbanOwner = await fs.readFile(
      path.join(ROOT, 'packages/kanban/src/server/project-server.ts'),
      'utf8',
    );
    const kanbanListen = kanbanOwner.indexOf('bindProjectEndpoint(');
    // Match the call, not one particular argument list — the owner passes a
    // mutation callback, and pinning the full signature makes this assert the
    // shape of an unrelated API instead of the ordering it cares about.
    const kanbanOpen = kanbanOwner.indexOf('SqliteKanbanStorage.open(');
    expect(kanbanListen).toBeGreaterThanOrEqual(0);
    expect(kanbanOpen).toBeGreaterThan(kanbanListen);
  });

  it('routes chronicle telemetry into SQLite rather than a JSONL journal', async () => {
    const identity = await readSource('packages/core/src/chronicle/identity.ts');
    const writesJsonl = /\.events\.jsonl/u.test(identity);

    // Chronicle is the one subsystem whose primary stream is still JSONL —
    // `metrics.db` only holds derived rollups. Remove it from KNOWN_NON_SQLITE
    // together with the migration and this starts demanding SQLite for real.
    expect(writesJsonl).toBe(KNOWN_NON_SQLITE.has('chronicle'));
  });
});
