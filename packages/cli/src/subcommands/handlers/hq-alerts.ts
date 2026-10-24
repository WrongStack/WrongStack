import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  type HqAlert,
  HqAlertEngine,
  type HqAlertRuleConfig,
  type HqSnapshot,
  readHqAlertsConfig,
} from '@wrongstack/hq';
import type { SubcommandDeps } from '../contracts.js';

// ── --ttl parsing ──────────────────────────────────────────────────────────
//
// Delegates to the shared `parseTokenTtlValue` from utils/hq-ttl.ts so the
// same syntax (1h, 7d, 3600s, bare ms) is accepted here and in the
// server-startup `--hq-token-ttl` flag.

import { resolveDataDir } from './hq-data-dir.js';

// ──────────────────────────────────────────────────────────────────────────
// W2 #6 (RFC hq-improvements-2026-09.md): `wstack hq alerts` subcommand.
//
// Subcommand tree:
//   wstack hq alerts eval [--snapshot <path>]   Run HqAlertEngine against a
//                                              snapshot file or the live HQ
//                                              snapshot. Pure-function dry
//                                              run; no server required.
//
// The handler mirrors `hqAuditCmd`/`hqTokenCmd` conventions: focused help
// for `--help`/`help`, a single action that defaults when no action is
// given, and a clear error for unknown actions.
// ──────────────────────────────────────────────────────────────────────────

export async function hqAlertsCmd(args: string[], deps: SubcommandDeps): Promise<number> {
  const action = args[0];

  // `wstack hq alerts --help` / `wstack hq alerts help` → focused alerts help.
  if (deps.flags?.['help'] === true || action === 'help' || action === '--help') {
    printAlertsHelp(deps);
    return 0;
  }

  if (action === 'eval' || action === undefined) {
    return hqAlertsEval(args.slice(1), deps);
  }

  deps.renderer.writeError(`Unknown hq alerts subcommand: ${action ?? '(none)'}\n`);
  printAlertsHelp(deps);
  return 1;
}

/**
 * W2 #6: `wstack hq alerts eval` — run `HqAlertEngine.evaluate()` against
 * a snapshot file or the live HQ snapshot.
 *
 * Defaults to `<dataDir>/snapshot.json`. Operators can pass
 * `--snapshot <path>` to evaluate against any historical snapshot.
 *
 * Exits 0 when no rules fire, 1 when rules fire (so the command is
 * usable in CI as a smoke test: "fail the build if the fleet is
 * currently over budget"). Exits 2 on argument or file errors.
 */
async function hqAlertsEval(_args: string[], deps: SubcommandDeps): Promise<number> {
  const flags = deps.flags ?? {};
  const snapshotArg =
    typeof flags['snapshot'] === 'string' ? (flags['snapshot'] as string) : undefined;

  // Resolve the snapshot path. When no --snapshot is given, default to
  // the live snapshot.json under the HQ data dir.
  let snapshotPath: string;
  try {
    if (snapshotArg !== undefined) {
      snapshotPath = path.resolve(snapshotArg);
    } else {
      const dataDir = resolveDataDir(deps);
      snapshotPath = path.join(dataDir, 'snapshot.json');
    }
  } catch (err) {
    deps.renderer.writeError(`Failed to resolve snapshot path: ${(err as Error).message}\n`);
    return 2;
  }

  let raw: string;
  try {
    raw = await fs.readFile(snapshotPath, 'utf8');
  } catch (err) {
    deps.renderer.writeError(
      `Cannot read snapshot at ${snapshotPath}: ${(err as Error).message}\n` +
        'Pass --snapshot <path> to evaluate against a specific file.\n',
    );
    return 2;
  }

  let snapshot: unknown;
  try {
    snapshot = JSON.parse(raw);
  } catch (err) {
    deps.renderer.writeError(
      `Snapshot at ${snapshotPath} is not valid JSON: ${(err as Error).message}\n`,
    );
    return 2;
  }

  // Load any persisted thresholds (the operator's tuning) so the eval
  // matches what the running engine would use.
  const dataDir = resolveDataDir(deps);
  let thresholds: HqAlertRuleConfig | undefined;
  try {
    const config = await readHqAlertsConfig(dataDir);
    thresholds = config.thresholds;
  } catch {
    // Best-effort: a missing or unreadable alerts-config falls back to
    // the engine's built-in defaults. The user will see "no thresholds"
    // in the eval output, which is itself a useful diagnostic.
  }

  const engine = new HqAlertEngine({
    onAlert: () => {
      /* eval prints; no callback needed */
    },
  });

  let fired: HqAlert[];
  try {
    fired = engine.evaluate(snapshot as HqSnapshot | null, thresholds);
  } catch (err) {
    deps.renderer.writeError(`Alert evaluation failed: ${(err as Error).message}\n`);
    return 2;
  }

  if (fired.length === 0) {
    deps.renderer.write(`No alert rules fired against ${snapshotPath}.\n`);
    if (thresholds === undefined) {
      deps.renderer.write(
        '(No persisted thresholds; using built-in defaults. Run `wstack hq alerts` with a populated alerts-config.json to override.)\n',
      );
    }
    return 0;
  }

  deps.renderer.write(`${fired.length} alert rule(s) fired against ${snapshotPath}:\n`);
  for (const alert of fired) {
    deps.renderer.write(`  [${alert.severity}] ${alert.ruleId}: ${alert.message}\n`);
  }
  // Non-zero exit when alerts fire, so a CI smoke test can `wstack hq alerts eval`
  // as a budget guard.
  return 1;
}

/** Focused help for `wstack hq alerts --help`. */
function printAlertsHelp(deps: SubcommandDeps): void {
  deps.renderer.write(`Usage: wstack hq alerts <eval>\n`);
  deps.renderer.write('\n');
  deps.renderer.write(
    `  wstack hq alerts eval [--snapshot <path>]   Run HqAlertEngine.evaluate() against a\n`,
  );
  deps.renderer.write(
    `                                            snapshot file (or the live <dataDir>/\n`,
  );
  deps.renderer.write(
    `                                            snapshot.json). Pure-function dry run;\n`,
  );
  deps.renderer.write(
    `                                            no server required. Exits 0 when no\n`,
  );
  deps.renderer.write(
    `                                            rules fire, 1 when rules fire, 2 on errors.\n`,
  );
  deps.renderer.write('\n');
  deps.renderer.write(
    `Persisted thresholds (<dataDir>/alerts-config.json) are loaded automatically when\n`,
  );
  deps.renderer.write(
    `present; otherwise the engine's built-in defaults apply. Snoozes are NOT honored\n`,
  );
  deps.renderer.write(
    `by this command — eval is a "what would fire RIGHT NOW if there were no snoozes"\n`,
  );
  deps.renderer.write(`probe.\n`);
  deps.renderer.write('\n');
  deps.renderer.write(`Flags:\n`);
  deps.renderer.write(
    `  --snapshot <path>   Evaluate against this snapshot file instead of the live one.\n`,
  );
  deps.renderer.write(
    `  --data-dir <path>   Override HQ data directory (default ~/.wrongstack/hq).\n`,
  );
  deps.renderer.write('\n');
  deps.renderer.write(`Run \`wstack hq --help\` for the full HQ command list.\n`);
}
