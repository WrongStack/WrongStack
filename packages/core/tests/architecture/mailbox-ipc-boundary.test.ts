/**
 * The mailbox has exactly one mode.
 *
 * One detached server per project owns the only SQLite handle; every other
 * process — CLI, TUI, WebUI, HQ, the HTTP bridge, external agents — reaches it
 * over the deterministic IPC endpoint. There is no in-process store, no env
 * var that selects one, and no direct-filesystem implementation left to fall
 * back to.
 *
 * That last clause is the one that needs a test. The system previously shipped
 * BOTH: a `_mailbox.sqlite` behind the daemon that every UI read, and a
 * `_mailbox.jsonl` that the agent loop wrote through `getSharedMailbox()`.
 * Nothing errored. Messages simply stopped being shared, agents never appeared
 * in any surface, and 105 MB of orphaned temp files accumulated. The old
 * version of this file missed it because it only searched for
 * `new GlobalMailbox(` and the leak went through a factory function.
 *
 * So: assert on the absence of the implementations, not on the spelling of one
 * constructor.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const SCAN_ROOTS = ['packages', 'apps', 'scripts'];

/** The single process permitted to open the store. */
const SQLITE_OWNER = 'packages/core/src/coordination/mailbox-project-server.ts';

/**
 * Modules allowed to name the on-disk layout: the store itself (schema plus
 * the one-shot legacy import that retires the old files) and the path helper
 * that spells them.
 */
const STORAGE_AUTHORITIES = new Set([
  'packages/core/src/coordination/sqlite-mailbox.ts',
  'packages/core/src/coordination/global-mailbox-paths.ts',
  'packages/core/src/coordination/mailbox-credential-store.ts',
  'packages/core/src/coordination/remote-mailbox.ts',
]);

/**
 * Deleted with the JSONL mailbox. Listed by path so a re-added file fails here
 * rather than quietly becoming a second store.
 */
const DELETED_LEGACY_MODULES = [
  'packages/core/src/coordination/mailbox.ts',
  'packages/core/src/coordination/global-mailbox.ts',
  'packages/core/src/coordination/global-mailbox-ack.ts',
  'packages/core/src/coordination/global-mailbox-actor-methods.ts',
  'packages/core/src/coordination/global-mailbox-agents.ts',
  'packages/core/src/coordination/global-mailbox-auto-compact.ts',
  'packages/core/src/coordination/global-mailbox-clear.ts',
  'packages/core/src/coordination/global-mailbox-clients.ts',
  'packages/core/src/coordination/global-mailbox-purge-stale.ts',
  'packages/core/src/coordination/global-mailbox-singleton-cache.ts',
  'packages/core/src/coordination/mailbox-message-cache.ts',
  'packages/core/src/coordination/mailbox-message-file-stat.ts',
  'packages/core/src/coordination/mailbox-cache-index.ts',
  'packages/core/src/coordination/mailbox-query-candidates.ts',
  'packages/core/src/coordination/mailbox-registry-file.ts',
  'packages/core/src/coordination/mailbox-registry-utils.ts',
  'packages/core/src/coordination/mailbox-version-fence.ts',
];

/**
 * Symbols that only ever named a direct-filesystem mailbox. `JsonlCredentialStore`
 * and its synchronous authorizer are covered separately below: they were the
 * file-based half of the bridge's auth, dead in production long before this,
 * and credentials now live in the same store behind the same owner.
 */
const LEGACY_SYMBOLS =
  /\b(?:GlobalMailbox|DefaultMailbox|getSharedMailbox|_clearMailboxSingletons)\b/u;

/** Prose about the retired path is fine; only executable references count. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/^\s*\/\/.*$/gmu, '');
}

async function productionSourceFiles(root: string): Promise<string[]> {
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name === 'dist' || entry.name === 'node_modules' || entry.name === 'tests') continue;
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...(await productionSourceFiles(absolute)));
    else if (entry.isFile() && /\.(?:[cm]?[jt]s|tsx)$/u.test(entry.name)) files.push(absolute);
  }
  return files;
}

async function exists(relative: string): Promise<boolean> {
  try {
    await fs.access(path.join(ROOT, relative));
    return true;
  } catch {
    return false;
  }
}

describe('mailbox IPC ownership boundary', () => {
  it('lets exactly one module open the store, and no module reach a legacy one', async () => {
    const files = (
      await Promise.all(
        SCAN_ROOTS.map((directory) => productionSourceFiles(path.join(ROOT, directory))),
      )
    ).flat();
    const violations: string[] = [];

    for (const file of files) {
      const relative = path.relative(ROOT, file).replaceAll('\\', '/');
      const source = await fs.readFile(file, 'utf8');
      const executableSource = stripComments(source);

      if (relative !== SQLITE_OWNER && /new\s+SqliteMailbox\s*\(/u.test(executableSource)) {
        violations.push(`${relative}: opens the store directly instead of connecting over IPC`);
      }
      // Constructor AND factory: the leak this file exists for went through a
      // factory, so matching only `new X(` is not enough.
      if (LEGACY_SYMBOLS.test(executableSource)) {
        violations.push(`${relative}: references a direct-filesystem mailbox`);
      }
      if (/JsonlCredentialStore|authorizeMailboxCredential/u.test(executableSource)) {
        violations.push(`${relative}: references the deleted file-based credential store`);
      }
      if (
        !STORAGE_AUTHORITIES.has(relative) &&
        /(?:readFile|writeFile|appendFile|unlink|rm|open|DatabaseSync)[\s\S]{0,180}_mailbox(?:\.(?:jsonl|registry\.json|clients\.json|sqlite)|_credentials\.json)/u.test(
          executableSource,
        )
      ) {
        violations.push(`${relative}: directly accesses mailbox persistence`);
      }
    }

    expect(violations).toEqual([]);
  });

  it('keeps the direct-filesystem implementation deleted', async () => {
    const resurrected: string[] = [];
    for (const relative of DELETED_LEGACY_MODULES) {
      if (await exists(relative)) resurrected.push(relative);
    }
    expect(resurrected).toEqual([]);
  });

  it('offers no env var that turns the server off', async () => {
    // `WRONGSTACK_MAILBOX_INLINE` and `WRONGSTACK_MAILBOX_SERVER=0` used to
    // select an in-process store. A missing build is now an error, not a
    // fallback — reintroducing either would restore the silent split.
    const files = (
      await Promise.all(
        SCAN_ROOTS.map((directory) => productionSourceFiles(path.join(ROOT, directory))),
      )
    ).flat();
    const offenders: string[] = [];
    for (const file of files) {
      const relative = path.relative(ROOT, file).replaceAll('\\', '/');
      const source = stripComments(await fs.readFile(file, 'utf8'));
      // `WRONGSTACK_MAILBOX_SERVER_IDLE_MS` / `_CLIENT_LEASE_MS` tune the
      // owner's lifetime and are fine; the kill switches are not.
      if (/WRONGSTACK_MAILBOX_INLINE|WRONGSTACK_MAILBOX_SERVER(?![_A-Z])/u.test(source)) {
        offenders.push(relative);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('opens SQLite only after the IPC endpoint ownership election succeeds', async () => {
    const source = await fs.readFile(path.join(ROOT, SQLITE_OWNER), 'utf8');
    const listening = source.indexOf("server.on('listening'");
    const open = source.indexOf('new SqliteMailbox');
    expect(listening).toBeGreaterThanOrEqual(0);
    expect(open).toBeGreaterThan(listening);
    expect(source.slice(0, listening)).not.toContain('new SqliteMailbox');
  });

  it('keeps the agent loop on the server-backed mailbox', async () => {
    // Regression pin for the original defect: the composition glue behind the
    // agent loop's registration, heartbeat, delivery and ack.
    const source = await fs.readFile(path.join(ROOT, 'packages/core/src/mailbox-attach.ts'), 'utf8');
    expect(source).toContain('getSharedProjectMailbox');
    expect(stripComments(source)).not.toMatch(LEGACY_SYMBOLS);
  });

  it('does not expose the concrete SQLite store through public barrels', async () => {
    const barrels = await Promise.all([
      fs.readFile(path.join(ROOT, 'packages/core/src/index.ts'), 'utf8'),
      fs.readFile(path.join(ROOT, 'packages/core/src/coordination/index.ts'), 'utf8'),
    ]);
    expect(barrels.join('\n')).not.toMatch(/export\s+\{[^}]*SqliteMailbox/u);
  });
});
