/**
 * Legacy-to-language bridge: lets `typecheck`, `lint`, `format`, `test`,
 * `install`, `audit`, and `outdated` delegate through the deterministic
 * language planner when the workspace is a non-JavaScript ecosystem
 * (Go, Rust, PHP, C#).
 *
 * When the workspace IS JavaScript/TypeScript (or has no detected
 * language marker), the bridge returns `null` and the legacy tool
 * continues on its existing code path unchanged. This preserves 100 %
 * backward compatibility for the TS/JS ecosystem where these tools
 * originated.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { executeLanguagePlan, executePackagePlan, planLanguageOperation } from './index.js';
import type {
  LanguageOperation,
  LanguagePackageOutcome,
  LanguageProfileId,
  LanguageRunResult,
} from './types.js';

const NON_JS_MARKERS: ReadonlyArray<{ filename: string; language: LanguageProfileId }> = [
  { filename: 'go.mod', language: 'go' },
  { filename: 'go.work', language: 'go' },
  { filename: 'Cargo.toml', language: 'rust' },
  { filename: 'composer.json', language: 'php' },
];

const NON_JS_SUFFIXES: ReadonlyArray<{ suffix: string; language: LanguageProfileId }> = [
  { suffix: '.csproj', language: 'csharp' },
  { suffix: '.fsproj', language: 'csharp' },
];

interface LegacyBridgeContext {
  cwd: string;
  projectRoot: string;
  signal: AbortSignal;
  target?: string | undefined;
}

/**
 * Quick check: does the cwd (or any parent up to projectRoot) contain a
 * non-JS ecosystem marker? Returns the detected language or `null`.
 */
export async function detectNonJsEcosystem(
  cwd: string,
  projectRoot: string,
): Promise<LanguageProfileId | null> {
  try {
    let dir = path.resolve(cwd);
    const root = path.resolve(projectRoot);

    for (let depth = 0; depth <= 4 && dir.startsWith(root); depth++) {
      for (const marker of NON_JS_MARKERS) {
        try {
          const s = await fs.stat(path.join(dir, marker.filename));
          if (s.isFile()) return marker.language;
        } catch {
          // not present
        }
      }
      try {
        const entries = await fs.readdir(dir);
        for (const entry of entries) {
          for (const suffix of NON_JS_SUFFIXES) {
            if (entry.toLowerCase().endsWith(suffix.suffix)) return suffix.language;
          }
        }
      } catch {
        // not a directory or not readable
      }
      if (dir === root) break;
      dir = path.dirname(dir);
    }
  } catch {
    // Module mocks or unusual environments may not provide all fs methods.
    // Return null so the legacy tool falls back to its existing path.
  }
  return null;
}

interface LegacyBridgeResult {
  language: LanguageProfileId;
  run?: LanguageRunResult;
  outcome?: LanguagePackageOutcome;
}

/**
 * Attempt to plan and execute a code-quality operation through the language
 * system. Returns the result or `null` when the workspace is JS/TS or the
 * planner has no plan.
 */
export async function tryLegacyCodeOperation(
  operation: LanguageOperation,
  ctx: LegacyBridgeContext,
): Promise<LegacyBridgeResult | null> {
  const language = await detectNonJsEcosystem(ctx.cwd, ctx.projectRoot);
  if (!language) return null;

  const planResult = await planLanguageOperation({
    projectRoot: ctx.projectRoot,
    cwd: ctx.cwd,
    operation,
    language,
    ...(ctx.target ? { target: ctx.target } : {}),
    signal: ctx.signal,
  });
  if (planResult.status !== 'planned') return null;

  const runner = executeLanguagePlan({
    projectRoot: ctx.projectRoot,
    workspace: planResult.workspace,
    plan: planResult.plan,
    signal: ctx.signal,
  });
  for (;;) {
    const next = await runner.next();
    if (next.done) return { language, run: next.value };
  }
}

/**
 * Attempt to plan and execute a package operation through the language
 * system. Returns the result or `null` when the workspace is JS/TS.
 */
export async function tryLegacyPackageOperation(
  operation: LanguageOperation,
  ctx: LegacyBridgeContext,
  packages: readonly string[] = [],
): Promise<LegacyBridgeResult | null> {
  const language = await detectNonJsEcosystem(ctx.cwd, ctx.projectRoot);
  if (!language) return null;

  const planResult = await planLanguageOperation({
    projectRoot: ctx.projectRoot,
    cwd: ctx.cwd,
    operation,
    language,
    signal: ctx.signal,
    ...(packages.length > 0 ? { operationOptions: { packages: [...packages] } } : {}),
  });
  if (planResult.status !== 'planned') return null;

  const runner = executePackagePlan({
    projectRoot: ctx.projectRoot,
    workspace: planResult.workspace,
    plan: planResult.plan,
    packages,
    signal: ctx.signal,
  });
  for (;;) {
    const next = await runner.next();
    if (next.done) return { language, outcome: next.value };
  }
}
