/**
 * Machine-evidence contract for Chimera cascade fix agents (P0-3).
 *
 * Cascade agents (security-scanner / bug-hunter) must apply fixes and then
 * run the project's real verification commands (typecheck / lint / tests),
 * returning a structured JSON evidence block:
 *
 * ```json
 * {
 *   "verification_evidence": {
 *     "typecheck": { "command": "pnpm typecheck", "exitCode": 0 },
 *     "lint":      { "command": "pnpm lint", "exitCode": 0 },
 *     "tests":     { "command": "pnpm test --filter affected", "exitCode": 0 }
 *   }
 * }
 * ```
 *
 * The cascade handler extracts this block and, before the re-review step,
 * re-runs the claimed commands against the working tree with a safe runner
 * (plain spawn, no shell, allowlisted executables) and compares the observed
 * exit codes. A fix only counts as verified when every claimed check ran and
 * its exit code matches reality.
 *
 * @module chimera-cascade-evidence
 */

import { spawn } from 'node:child_process';
import type { CascadeEvidenceCheckResult, CascadeEvidenceStatus } from '@wrongstack/core/plugin';

// Re-exported so execution-chimera-cascade.ts and tests consume the shared
// core shapes (produced here, persisted by the report store) — the element
// shape must not drift between producer and consumer.
export type {
  CascadeEvidenceCheckResult,
  CascadeEvidenceStatus,
} from '@wrongstack/core/plugin';

// ---------------------------------------------------------------------------
// Evidence shape
// ---------------------------------------------------------------------------

/** One claimed verification check: the exact command and its observed exit code. */
interface CascadeEvidenceCheck {
  command: string;
  exitCode: number;
  /** Optional truncated output the agent chose to include (informational). */
  output?: string | undefined;
}

/** The three standard verification checks a cascade agent can claim. */
export interface CascadeEvidence {
  typecheck?: CascadeEvidenceCheck | undefined;
  lint?: CascadeEvidenceCheck | undefined;
  tests?: CascadeEvidenceCheck | undefined;
}

/** Result of verifying a cascade agent's claimed evidence. */
interface CascadeEvidenceVerification {
  status: CascadeEvidenceStatus;
  checks: CascadeEvidenceCheckResult[];
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

const JSON_BLOCK_RE = /```(?:json)?\s*([\s\S]*?)```/gi;

function tryParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    try {
      // Strip trailing commas before closing braces/brackets
      const cleaned = raw.replace(/,\s*([}\]])/g, '$1');
      return JSON.parse(cleaned);
    } catch {
      return null;
    }
  }
}

/**
 * Extract a `verification_evidence` block from a cascade agent's response.
 *
 * Scans every fenced code block in the text and returns the first that
 * parses as an object with a `verification_evidence` member whose value is an
 * object of `{command, exitCode}` checks. Any malformed JSON fence is ignored
 * (the agent may have used a fence for something else); when the evidence is
 * genuinely absent, returns null so the caller can treat it as `missing`.
 *
 * The returned evidence is validated but NOT sanitized here — command safety
 * is enforced by the verification runner (allowlist + no shell).
 */
export function extractCascadeEvidence(text: string | null | undefined): CascadeEvidence | null {
  if (!text) return null;
  for (const match of text.matchAll(JSON_BLOCK_RE)) {
    const body = match[1]?.trim();
    if (!body) continue;
    const parsed = tryParseJson(body);
    if (!parsed) continue;
    const evidence = parseEvidenceObject(parsed);
    if (evidence) return evidence;
  }
  return null;
}

function parseEvidenceObject(parsed: unknown): CascadeEvidence | null {
  if (typeof parsed !== 'object' || parsed === null) return null;
  const root = parsed as Record<string, unknown>;
  const raw = root.verification_evidence;
  if (typeof raw !== 'object' || raw === null) return null;
  const checks = raw as Record<string, unknown>;

  const out: CascadeEvidence = {};
  let found = false;
  for (const key of ['typecheck', 'lint', 'tests'] as const) {
    const check = parseSingleCheck(checks[key]);
    if (check) {
      out[key] = check;
      found = true;
    }
  }
  return found ? out : null;
}

function parseSingleCheck(raw: unknown): CascadeEvidenceCheck | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const check = raw as Record<string, unknown>;
  const command = check.command;
  const exitCode = check.exitCode;
  if (typeof command !== 'string' || command.trim().length === 0) return undefined;
  if (
    typeof exitCode !== 'number' ||
    !Number.isInteger(exitCode) ||
    exitCode < 0 ||
    exitCode > 255
  ) {
    return undefined;
  }
  const output = typeof check.output === 'string' ? truncateOutput(check.output) : undefined;
  return { command: command.trim(), exitCode, output };
}

const MAX_EVIDENCE_OUTPUT_CHARS = 2_000;

function truncateOutput(output: string): string {
  return output.length > MAX_EVIDENCE_OUTPUT_CHARS
    ? `${output.slice(0, MAX_EVIDENCE_OUTPUT_CHARS)}\n… (truncated)`
    : output;
}

// ---------------------------------------------------------------------------
// Safe command runner
// ---------------------------------------------------------------------------

/** Executables the orchestrator will re-run to verify cascade evidence. */
const SAFE_EXECUTABLES = new Set([
  'pnpm',
  'npm',
  'yarn',
  'npx',
  'bun',
  'node',
  'tsc',
  'biome',
  'eslint',
  'vitest',
  'jest',
]);

/**
 * Maximum wall-clock per verification command. Verification must never turn
 * the cascade re-review into an unbounded wait, so a hung command is killed
 * and reported as a mismatch (like a non-zero exit).
 */
export const CASCADE_EVIDENCE_COMMAND_TIMEOUT_MS = 120_000;

/** Exit code used when the re-run is refused (unsafe command). */
const CASCADE_EVIDENCE_UNSAFE_EXIT = 126;

/** Exit code used when the re-run times out or cannot execute. */
const CASCADE_EVIDENCE_RUN_ERROR_EXIT = 127;

interface RunCommandResult {
  exitCode: number;
}

type RunCommandFn = (
  command: string,
  cwd: string,
  timeoutMs: number,
) => Promise<RunCommandResult>;

/**
 * Validate a claimed command against the safety contract: first token must be
 * an allowlisted executable and every token must be a bare word/path (no shell
 * metacharacters). Shell-free spawning is the second layer — even a validated
 * command is run with `shell: false`.
 */
function isSafeCascadeCommand(command: string): boolean {
  if (!command || command.length > 500) return false;
  const tokens = command.trim().split(/\s+/);
  if (tokens.length === 0) return false;
  if (!SAFE_EXECUTABLES.has(tokens[0]!)) return false;
  // Bare tokens only: no shell operators, redirection, expansion, or quoting
  // tricks. Paths and flag values (e.g. --filter @wrongstack/core) are fine.
  return tokens.every((token) => /^[A-Za-z0-9@/._:=~+*?[\]-]+$/.test(token));
}

/**
 * Run a single verification command against the working tree without a shell.
 * Never throws — every failure mode (unsafe, timeout, spawn error) resolves to
 * an exit code so the caller's comparison stays uniform.
 */
const runCascadeVerificationCommand: RunCommandFn = (
  command,
  cwd,
  timeoutMs,
): Promise<RunCommandResult> => {
  if (!isSafeCascadeCommand(command)) {
    return Promise.resolve({ exitCode: CASCADE_EVIDENCE_UNSAFE_EXIT });
  }
  const tokens = command.trim().split(/\s+/);
  const executable = tokens[0]!;
  const args = tokens.slice(1);
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(executable, args, {
        cwd,
        stdio: 'ignore',
        windowsHide: true,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      resolve({ exitCode: CASCADE_EVIDENCE_RUN_ERROR_EXIT });
      return;
    }
    child.on('error', () => resolve({ exitCode: CASCADE_EVIDENCE_RUN_ERROR_EXIT }));
    child.on('close', (code) => resolve({ exitCode: code ?? CASCADE_EVIDENCE_RUN_ERROR_EXIT }));
  });
};

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

/**
 * Verify a cascade agent's claimed evidence by re-running each command against
 * the working tree and comparing exit codes.
 *
 * Verdict rules:
 *  - `missing`   — no evidence block was extracted (agent returned no checks).
 *  - `verified`  — every claimed check re-ran, actual exit code matched the
 *                  claim, and the claimed exit code was 0 (a passing check).
 *  - `failed`    — any check was refused (unsafe), could not run, timed out,
 *                  claimed a non-zero exit code, or actual ≠ claimed.
 *
 * An unsafe command is refused rather than executed — a cascade agent cannot
 * make the orchestrator run arbitrary shell through a fabricated evidence
 * block.
 */
export async function verifyCascadeEvidence(
  evidence: CascadeEvidence | null | undefined,
  cwd: string,
  runCommand: RunCommandFn = runCascadeVerificationCommand,
  timeoutMs: number = CASCADE_EVIDENCE_COMMAND_TIMEOUT_MS,
): Promise<CascadeEvidenceVerification> {
  if (!evidence) return { status: 'missing', checks: [] };
  // The contract requires a real typecheck. A block that claims only lint/tests
  // is present but incomplete, so it is a failed verification rather than
  // missing evidence.
  if (!evidence.typecheck) return { status: 'failed', checks: [] };

  const checks: CascadeEvidenceCheckResult[] = [];
  for (const name of ['typecheck', 'lint', 'tests'] as const) {
    const claimed = evidence[name];
    if (!claimed) continue;
    const actual = await runCommand(claimed.command, cwd, timeoutMs);
    const ok = claimed.exitCode === 0 && actual.exitCode === claimed.exitCode;
    checks.push({
      name,
      command: claimed.command,
      claimedExitCode: claimed.exitCode,
      actualExitCode: actual.exitCode,
      ok,
    });
  }

  if (checks.length === 0) return { status: 'missing', checks };
  const status: CascadeEvidenceStatus = checks.every((c) => c.ok) ? 'verified' : 'failed';
  return { status, checks };
}
