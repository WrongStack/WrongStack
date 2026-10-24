import * as fs from 'node:fs/promises';
import { hqAuthAuditPath, hqAuthContentHash, hqAuthFilePath, readHqAuthFile } from '@wrongstack/hq';
import type { SubcommandDeps } from '../contracts.js';

// ── --ttl parsing ──────────────────────────────────────────────────────────
//
// Delegates to the shared `parseTokenTtlValue` from utils/hq-ttl.ts so the
// same syntax (1h, 7d, 3600s, bare ms) is accepted here and in the
// server-startup `--hq-token-ttl` flag.

import { resolveDataDir } from './hq-data-dir.js';

/**
 * `wstack hq audit verify` — re-derive the contentHash from the current
 * on-disk `auth.json` and print it so an operator can compare against a
 * `contentHash` field in an audit entry. This closes the forensic
 * tie-back loop without requiring the operator to write a script: copy
 * the hash from the audit log, run this command, eyeball (or `diff`)
 * the two values.
 *
 * Prints:
 *   - the resolved `auth.json` path (so the operator knows which file
 *     was hashed)
 *   - the SHA-256 contentHash, or `(unavailable)` if the file is
 *     missing/unreadable
 *   - the `auth-audit.jsonl` path (so the operator knows where to look
 *     for entries to compare against)
 *
 * Exit codes:
 *   0 — hash computed and printed
 *   1 — `auth.json` missing or unreadable (hash unavailable); the
 *       audit-log path is still printed so the operator can inspect
 *       historical entries
 */
export async function hqAuditCmd(args: string[], deps: SubcommandDeps): Promise<number> {
  const action = args[0];

  // `wstack hq audit --help` / `wstack hq audit help` → focused audit help.
  if (deps.flags?.['help'] === true || action === 'help' || action === '--help') {
    printAuditHelp(deps);
    return 0;
  }

  if (action === 'verify' || action === undefined) {
    return hqAuditVerify(deps);
  }

  deps.renderer.writeError(`Unknown hq audit subcommand: ${action ?? '(none)'}\n`);
  printAuditHelp(deps);
  return 1;
}

async function hqAuditVerify(deps: SubcommandDeps): Promise<number> {
  const dataDir = resolveDataDir(deps);
  const authPath = hqAuthFilePath(dataDir);
  const auditPath = hqAuthAuditPath(dataDir);

  deps.renderer.write(`auth file:   ${authPath}\n`);
  deps.renderer.write(`audit log:   ${auditPath}\n`);

  // readHqAuthFile returns a synthetic default when auth.json is missing
  // (it doesn't throw), so hqAuthContentHash would still produce a hash
  // over that default — which is misleading: no audit entry corresponds
  // to a file that isn't on disk. Check existence directly so the
  // operator gets an honest "unavailable" when there's nothing to hash.
  const fileExists = await fileExistsQuiet(authPath);
  if (!fileExists) {
    deps.renderer.write(`contentHash: (unavailable — auth.json does not exist)\n`);
    deps.renderer.write(
      `Compare historical entries in the audit log above against a known-good hash.\n`,
    );
    return 1;
  }

  const authFile = await readHqAuthFile(dataDir, {
    warn: (msg) => deps.renderer.writeWarning(`${msg}\n`),
  });

  const hash = hqAuthContentHash(authFile);
  if (hash === undefined) {
    deps.renderer.write(`contentHash: (unavailable — auth.json is unreadable or malformed)\n`);
    deps.renderer.write(
      `Compare historical entries in the audit log above against a known-good hash.\n`,
    );
    return 1;
  }

  deps.renderer.write(`contentHash: ${hash}\n`);
  deps.renderer.write('\n');
  deps.renderer.write(
    `Compare this value against the 'contentHash' field of entries in the audit log.\n`,
  );
  deps.renderer.write(
    `A match means the redacted projection of auth.json is identical to when that\n`,
  );
  deps.renderer.write(
    `entry was emitted (secrets may differ — only the non-secret shape is hashed).\n`,
  );
  return 0;
}

async function fileExistsQuiet(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Re-read the persisted `auth.json` and return a conditional
 * `contentHash` field for embedding in an audit entry. This closes the
 * forensic tie-back loop: an operator reviewing `auth-audit.jsonl` can
 * compare the `contentHash` against the current on-disk file via
 * `wstack hq audit verify`.
 *
 * Re-reads rather than hashing the in-memory post-mutation snapshot
 * because `writeHqAuthFile` re-stamps `updatedAt` on the persisted
 * payload — hashing the in-memory `next` would diverge from what
 * `verify` computes. Matches the pattern established by the `first-run`
 * and `expired-prune` emitters in `auth-store.ts` / `hq-server.ts`.
 *
 * Returns `{}` (no `contentHash` key) when the file is unreadable, so
 * the audit entry still records the event without a tie-back — the
 * absence itself is meaningful. Conditional spread preserves
 * `exactOptionalPropertyTypes`.
 */
export async function computeAuditHashField(
  dataDir: string,
  warn: (msg: string) => void,
): Promise<{ contentHash?: string }> {
  const persisted = await readHqAuthFile(dataDir, { warn });
  const hash = hqAuthContentHash(persisted);
  return hash !== undefined ? { contentHash: hash } : {};
}

/** Focused help for `wstack hq audit --help`. */
function printAuditHelp(deps: SubcommandDeps): void {
  deps.renderer.write(`Usage: wstack hq audit <verify>\n`);
  deps.renderer.write('\n');
  deps.renderer.write(
    `  wstack hq audit verify   Re-derive the SHA-256 contentHash from the current\n`,
  );
  deps.renderer.write(
    `                           on-disk auth.json and print it so an operator can compare\n`,
  );
  deps.renderer.write(
    `                           it against a contentHash field in an audit-log entry.\n`,
  );
  deps.renderer.write('\n');
  deps.renderer.write(`Flags:\n`);
  deps.renderer.write(
    `  --data-dir <path>   Override HQ data directory (default ~/.wrongstack/hq).\n`,
  );
  deps.renderer.write('\n');
  deps.renderer.write(`Run \`wstack hq --help\` for the full HQ command list.\n`);
}
