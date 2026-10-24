import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { ToolProgressEvent } from '@wrongstack/contracts/types';
import { bunTypecheckInvocation } from '../_bun-typechecker.js';
import { type SpawnStreamResult, spawnStream } from '../_spawn-stream.js';
import { normalizeCommandOutput } from '../_util.js';
import {
  diagnosticsForInternalSyntax,
  parseLanguageDiagnostics,
  parsePackageReports,
} from './diagnostics.js';
import { validateCommandPlan } from './plan.js';
import { languageProfileRegistry } from './registry.js';
import type {
  CommandPlan,
  DetectedWorkspace,
  LanguagePackageMutation,
  LanguagePackageOutcome,
  LanguagePackageVulnerability,
  LanguageRunResult,
  LanguageRunSummary,
} from './types.js';

const MAX_INTERNAL_SOURCE_BYTES = 1_500_000;

export interface ExecuteLanguagePlanOptions {
  projectRoot: string;
  workspace: DetectedWorkspace;
  plan: CommandPlan;
  signal: AbortSignal;
}

export async function* executeLanguagePlan(
  options: ExecuteLanguagePlanOptions,
): AsyncGenerator<ToolProgressEvent, LanguageRunResult> {
  const { plan, workspace } = options;
  if (options.signal.aborted) {
    return terminalResult(options, 'cancelled', options.signal.reason);
  }
  const profile = languageProfileRegistry.get(plan.profileId);
  if (!profile) return unavailableResult(options, `Unknown language profile: ${plan.profileId}`);
  if (workspace.id !== plan.workspaceId || workspace.language !== plan.profileId) {
    return unavailableResult(options, 'Plan and workspace identity do not match.');
  }
  const validation = validateCommandPlan(plan, profile, options.projectRoot);
  if (validation.length > 0) {
    return unavailableResult(options, `Plan failed execution validation: ${validation.join('; ')}`);
  }
  const containmentError = await validatePlanRealpaths(plan, options.projectRoot);
  if (containmentError) return unavailableResult(options, containmentError);
  if (plan.operation.startsWith('package-') || plan.network) {
    return terminalNonPackageResult(
      options,
      'Package and network plans require the separate language_package tool (Phase 3).',
    );
  }

  const startedAt = Date.now();
  yield {
    type: 'log',
    text:
      plan.kind === 'internal'
        ? `Running ${plan.parser}…`
        : `${plan.command} ${plan.args.join(' ')}`,
    data: { language: plan.profileId, operation: plan.operation, workspace: workspace.root },
  };

  if (plan.kind === 'internal') {
    try {
      return await executeInternal(options, startedAt);
    } catch (error) {
      return unavailableResult(options, error instanceof Error ? error.message : String(error));
    }
  }

  const timeoutController = new AbortController();
  const timer = setTimeout(
    () => timeoutController.abort(new Error('language plan timed out')),
    plan.timeoutMs,
  );
  timer.unref?.();
  const signal = AbortSignal.any([options.signal, timeoutController.signal]);
  let spawned: SpawnStreamResult;
  let diagnosticCwd = workspace.root;
  try {
    const invocation =
      plan.command === 'bun' && plan.args[0] === 'check'
        ? await bunTypecheckInvocation(plan.cwd, plan.args.slice(1), { signal })
        : { cmd: plan.command!, args: [...plan.args], cwd: plan.cwd };
    diagnosticCwd = invocation.cwd;
    const stream = spawnStream({
      ...invocation,
      signal,
      maxBytes: plan.outputLimitBytes,
    });
    for (;;) {
      const next = await stream.next();
      if (next.done) {
        spawned = next.value;
        break;
      }
      yield next.value;
    }
  } catch (error) {
    const timedOut = timeoutController.signal.aborted && !options.signal.aborted;
    const cancelled = options.signal.aborted;
    return {
      status: timedOut ? 'timed_out' : cancelled ? 'cancelled' : 'failed',
      language: plan.profileId,
      workspace,
      plan,
      exitCode: null,
      durationMs: Date.now() - startedAt,
      diagnostics: Object.freeze([]),
      omittedDiagnostics: 0,
      summary: emptySummary(),
      output: '',
      truncated: false,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }

  const parsed = parseLanguageDiagnostics(
    plan.parser,
    spawned.stdout,
    spawned.stderr,
    diagnosticCwd,
  );
  const timedOut = timeoutController.signal.aborted && !options.signal.aborted;
  const cancelled = options.signal.aborted;
  const spawnUnavailable = Boolean(
    spawned.error && /ENOENT|not found|cannot find/i.test(spawned.error),
  );
  const status: LanguageRunResult['status'] = timedOut
    ? 'timed_out'
    : cancelled
      ? 'cancelled'
      : spawnUnavailable
        ? 'unavailable'
        : spawned.exitCode === 0
          ? 'passed'
          : 'failed';
  const raw = [spawned.stdout, spawned.stderr, spawned.error].filter(Boolean).join('\n');
  return {
    status,
    language: plan.profileId,
    workspace,
    plan,
    exitCode: spawned.exitCode,
    durationMs: Date.now() - startedAt,
    diagnostics: parsed.diagnostics,
    omittedDiagnostics: parsed.omitted,
    summary: parsed.summary,
    output: normalizeCommandOutput(raw, { maxBytes: plan.outputLimitBytes }),
    truncated: spawned.truncated,
    ...(spawned.spoolPath ? { spoolPath: spawned.spoolPath } : {}),
    ...(spawned.error ? { error: spawned.error } : {}),
  };
}

async function executeInternal(
  options: ExecuteLanguagePlanOptions,
  startedAt: number,
): Promise<LanguageRunResult> {
  const target = options.plan.evidence.find((item) => item.kind === 'target')?.path;
  if (!target) return unavailableResult(options, 'Internal syntax plan has no target evidence.');
  const safeTarget = await assertContainedFile(target, options.projectRoot);
  const stat = await fs.stat(safeTarget);
  if (stat.size > MAX_INTERNAL_SOURCE_BYTES) {
    return unavailableResult(
      options,
      `Internal syntax target exceeds ${MAX_INTERNAL_SOURCE_BYTES} bytes.`,
    );
  }
  const source = await fs.readFile(safeTarget, 'utf8');
  const parsed = await diagnosticsForInternalSyntax(options.plan.profileId, safeTarget, source);
  return {
    status: parsed.summary.errors > 0 ? 'failed' : 'passed',
    language: options.plan.profileId,
    workspace: options.workspace,
    plan: options.plan,
    exitCode: parsed.summary.errors > 0 ? 1 : 0,
    durationMs: Date.now() - startedAt,
    diagnostics: parsed.diagnostics,
    omittedDiagnostics: parsed.omitted,
    summary: parsed.summary,
    output:
      parsed.summary.errors > 0
        ? `${parsed.summary.errors} syntax error(s) found.`
        : 'Syntax check passed.',
    truncated: false,
  };
}

async function validatePlanRealpaths(
  plan: CommandPlan,
  projectRoot: string,
): Promise<string | undefined> {
  const realRoot = await fs.realpath(projectRoot);
  let realCwd: string;
  try {
    realCwd = await fs.realpath(plan.cwd);
  } catch (error) {
    return `Plan cwd is unavailable: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (!isRealInside(realCwd, realRoot)) return 'Plan cwd resolves outside project root.';
  for (const argument of plan.args) {
    if (!path.isAbsolute(argument)) continue;
    try {
      const realArgument = await fs.realpath(argument);
      if (!isRealInside(realArgument, realRoot)) {
        return `Plan argument resolves outside project root: ${argument}`;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        return `Plan argument could not be resolved safely: ${argument}`;
      }
    }
  }
  return undefined;
}

function isRealInside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  // Canonical escape test: a legal in-root first segment like `..hidden` must
  // not read as an escape (bare startsWith('..') over-rejects it).
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

async function assertContainedFile(candidate: string, projectRoot: string): Promise<string> {
  const realRoot = await fs.realpath(projectRoot);
  const realTarget = await fs.realpath(candidate);
  const relative = path.relative(realRoot, realTarget);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Internal syntax target resolves outside project root: ${candidate}`);
  }
  return realTarget;
}

function terminalResult(
  options: ExecuteLanguagePlanOptions,
  status: 'cancelled' | 'timed_out',
  reason: unknown,
): LanguageRunResult {
  const message = reason instanceof Error ? reason.message : reason ? String(reason) : status;
  return {
    status,
    language: options.plan.profileId,
    workspace: options.workspace,
    plan: options.plan,
    exitCode: null,
    durationMs: 0,
    diagnostics: Object.freeze([]),
    omittedDiagnostics: 0,
    summary: emptySummary(),
    output: '',
    truncated: false,
    error: message,
  };
}

function unavailableResult(options: ExecuteLanguagePlanOptions, reason: string): LanguageRunResult {
  return {
    status: 'unavailable',
    language: options.plan.profileId,
    workspace: options.workspace,
    plan: options.plan,
    exitCode: null,
    durationMs: 0,
    diagnostics: Object.freeze([]),
    omittedDiagnostics: 0,
    summary: emptySummary(),
    output: reason,
    truncated: false,
    error: reason,
  };
}

function emptySummary(): LanguageRunSummary {
  return { errors: 0, warnings: 0, infos: 0 };
}

function terminalNonPackageResult(
  options: ExecuteLanguagePlanOptions,
  reason: string,
): LanguageRunResult {
  return {
    status: 'unavailable',
    language: options.plan.profileId,
    workspace: options.workspace,
    plan: options.plan,
    exitCode: null,
    durationMs: 0,
    diagnostics: Object.freeze([]),
    omittedDiagnostics: 0,
    summary: emptySummary(),
    output: reason,
    truncated: false,
    error: reason,
  };
}

export interface ExecutePackagePlanOptions {
  projectRoot: string;
  workspace: DetectedWorkspace;
  plan: CommandPlan;
  packages: readonly string[];
  signal: AbortSignal;
}

export async function* executePackagePlan(
  options: ExecutePackagePlanOptions,
): AsyncGenerator<ToolProgressEvent, LanguagePackageOutcome> {
  const { plan, workspace } = options;
  const startedAt = Date.now();
  if (options.signal.aborted) {
    yield { type: 'log', text: 'Run cancelled before execution.' };
    return terminalPackageResult(options, 'cancelled', startedAt);
  }
  const profile = languageProfileRegistry.get(plan.profileId);
  if (!profile) {
    yield { type: 'warning', text: `Unknown language profile: ${plan.profileId}` };
    return terminalPackageResult(options, 'unavailable', startedAt, 'Unknown language profile.');
  }
  if (workspace.id !== plan.workspaceId || workspace.language !== plan.profileId) {
    return terminalPackageResult(
      options,
      'unavailable',
      startedAt,
      'Plan and workspace identity do not match.',
    );
  }
  const validation = validateCommandPlan(plan, profile, options.projectRoot);
  if (validation.length > 0) {
    return terminalPackageResult(
      options,
      'unavailable',
      startedAt,
      `Plan failed execution validation: ${validation.join('; ')}`,
    );
  }
  const containmentError = await validatePlanRealpaths(plan, options.projectRoot);
  if (containmentError) {
    return terminalPackageResult(options, 'unavailable', startedAt, containmentError);
  }

  const manifestsBefore = await snapshotPaths(workspace.manifests);
  const lockfilePaths = collectLockfilePaths(workspace);
  const lockfilesBefore = await snapshotPaths(lockfilePaths);
  const manifestSizesBefore = await snapshotSizes(workspace.manifests);
  const lockfileSizesBefore = await snapshotSizes(lockfilePaths);

  yield {
    type: 'log',
    text:
      plan.kind === 'process'
        ? `${plan.command} ${plan.args.join(' ')}`
        : `${plan.parser}: ${plan.operation}`,
    data: {
      language: plan.profileId,
      operation: plan.operation,
      workspace: workspace.root,
      packages: [...options.packages],
    },
  };

  const timeoutController = new AbortController();
  const timer = setTimeout(
    () => timeoutController.abort(new Error('language package plan timed out')),
    plan.timeoutMs,
  );
  timer.unref?.();
  const signal = AbortSignal.any([options.signal, timeoutController.signal]);
  let spawned: SpawnStreamResult | undefined;
  let run: LanguageRunResult | undefined;
  let status: LanguagePackageOutcome['status'] = 'unavailable';
  let error: string | undefined;
  try {
    if (plan.kind !== 'process') {
      return terminalPackageResult(
        options,
        'unavailable',
        startedAt,
        'Package operations require an executable plan; internal plans cannot mutate the manifest.',
      );
    }
    const stream = spawnStream({
      cmd: plan.command!,
      args: [...plan.args],
      cwd: plan.cwd,
      signal,
      maxBytes: plan.outputLimitBytes,
    });
    for (;;) {
      const next = await stream.next();
      if (next.done) {
        spawned = next.value;
        break;
      }
      yield next.value;
    }
  } catch (error_) {
    error = error_ instanceof Error ? error_.message : String(error_);
  } finally {
    clearTimeout(timer);
  }

  if (spawned) {
    const parsed = parseLanguageDiagnostics(
      plan.parser,
      spawned.stdout,
      spawned.stderr,
      workspace.root,
    );
    const timedOut = timeoutController.signal.aborted && !options.signal.aborted;
    const cancelled = options.signal.aborted;
    const spawnUnavailable = Boolean(
      spawned.error && /ENOENT|not found|cannot find/i.test(spawned.error),
    );
    status = timedOut
      ? 'timed_out'
      : cancelled
        ? 'cancelled'
        : spawnUnavailable
          ? 'unavailable'
          : spawned.exitCode === 0
            ? 'passed'
            : 'failed';
    // Report commands exit non-zero exactly when they HAVE findings (`npm
    // audit`/`npm outdated` exit 1, pip-audit and cargo audit too). A report
    // that parsed into findings is a successful run, not a failure to drop.
    if (
      status === 'failed' &&
      spawned.exitCode !== null &&
      (plan.operation === 'package-audit' || plan.operation === 'package-outdated')
    ) {
      const reports = parsePackageReports(plan.parser, spawned.stdout, spawned.stderr);
      if (reports.vulnerabilities.length > 0 || reports.outdated.length > 0) status = 'passed';
    }
    error ??= spawned.error;
    const raw = [spawned.stdout, spawned.stderr, spawned.error].filter(Boolean).join('\n');
    run = {
      status,
      language: plan.profileId,
      workspace,
      plan,
      exitCode: spawned.exitCode,
      durationMs: Date.now() - startedAt,
      diagnostics: parsed.diagnostics,
      omittedDiagnostics: parsed.omitted,
      summary: parsed.summary,
      output: normalizeCommandOutput(raw, { maxBytes: plan.outputLimitBytes }),
      truncated: spawned.truncated,
      ...(spawned.spoolPath ? { spoolPath: spawned.spoolPath } : {}),
      ...(spawned.error ? { error: spawned.error } : {}),
    };
  } else {
    status = options.signal.aborted
      ? 'cancelled'
      : timeoutController.signal.aborted
        ? 'timed_out'
        : 'failed';
  }

  if (status !== 'passed') {
    return terminalPackageResult(
      options,
      status,
      startedAt,
      error,
      run,
      manifestsBefore,
      lockfilesBefore,
    );
  }

  const manifestsAfter = await snapshotPaths(workspace.manifests);
  const lockfilesAfter = await snapshotPaths(lockfilePaths);
  const manifestSizesAfter = await snapshotSizes(workspace.manifests);
  const lockfileSizesAfter = await snapshotSizes(lockfilePaths);
  const manifestsChanged = await changedPaths(
    manifestsBefore,
    manifestsAfter,
    manifestSizesBefore,
    manifestSizesAfter,
  );
  const lockfilesChanged = await changedPaths(
    lockfilesBefore,
    lockfilesAfter,
    lockfileSizesBefore,
    lockfileSizesAfter,
  );
  const reports = parsePackageReports(plan.parser, spawned?.stdout ?? '', spawned?.stderr ?? '');
  const mutations = packageMutationsFromInputs(options.packages, reports.outdated);
  return {
    workspace,
    language: plan.profileId,
    operation: plan.operation,
    status,
    ...(run ? { run } : {}),
    durationMs: Date.now() - startedAt,
    manifestsBefore,
    lockfilesBefore,
    manifestsAfter,
    lockfilesAfter,
    mutations,
    vulnerabilities: reports.vulnerabilities,
    outdated: reports.outdated,
    manifestsChanged: Object.freeze(manifestsChanged),
    lockfilesChanged: Object.freeze(lockfilesChanged),
  };
}

function packageMutationsFromInputs(
  inputs: readonly string[],
  outdated: readonly LanguagePackageMutation[],
): readonly LanguagePackageMutation[] {
  const outdatedNames = new Set(outdated.map((entry) => entry.name));
  return inputs
    .filter((name) => !outdatedNames.has(name))
    .map<LanguagePackageMutation>((name) => ({ name, requested: name, kind: 'runtime' }));
}

async function snapshotPaths(paths: readonly string[]): Promise<readonly string[]> {
  const existing: string[] = [];
  for (const candidate of paths) {
    try {
      const stat = await fs.stat(candidate);
      if (!stat.isFile()) continue;
      existing.push(candidate);
    } catch {
      // Missing path is fine.
    }
  }
  return Object.freeze(existing);
}

async function changedPaths(
  before: readonly string[],
  after: readonly string[],
  beforeSizes?: ReadonlyMap<string, number>,
  afterSizes?: ReadonlyMap<string, number>,
): Promise<string[]> {
  const beforeSet = new Set(before);
  const afterSet = new Set(after);
  const changed = new Set<string>();
  for (const path of after) {
    if (!beforeSet.has(path)) changed.add(path);
  }
  for (const path of before) {
    if (!afterSet.has(path)) changed.add(path);
  }
  if (beforeSizes && afterSizes) {
    for (const path of after) {
      if (beforeSizes.get(path) !== afterSizes.get(path)) changed.add(path);
    }
  }
  return [...changed].sort();
}

async function snapshotSizes(paths: readonly string[]): Promise<ReadonlyMap<string, number>> {
  const sizes = new Map<string, number>();
  for (const candidate of paths) {
    try {
      const stat = await fs.stat(candidate);
      if (stat.isFile()) sizes.set(candidate, stat.size);
    } catch {
      // Skip missing files.
    }
  }
  return sizes;
}

function collectLockfilePaths(workspace: DetectedWorkspace): readonly string[] {
  const explicit = workspace.evidence
    .filter((evidence) => evidence.kind === 'lockfile')
    .map((evidence) => evidence.path);
  const detected =
    LOCKFILE_NAMES_BY_PROFILE.get(workspace.language)?.map((name) =>
      path.join(workspace.root, name),
    ) ?? [];
  const merged = new Set<string>();
  for (const candidate of [...explicit, ...detected]) merged.add(candidate);
  return Object.freeze([...merged]);
}

const LOCKFILE_NAMES_BY_PROFILE: ReadonlyMap<DetectedWorkspace['language'], readonly string[]> =
  new Map([
    ['typescript', ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb']],
    ['javascript', ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb']],
    ['go', ['go.sum']],
    ['rust', ['Cargo.lock']],
    ['php', ['composer.lock']],
    ['csharp', ['packages.lock.json']],
  ]);

function terminalPackageResult(
  options: ExecutePackagePlanOptions,
  status: LanguagePackageOutcome['status'],
  startedAt: number,
  error?: string,
  run?: LanguageRunResult,
  manifestsBefore: readonly string[] = [],
  lockfilesBefore: readonly string[] = [],
): LanguagePackageOutcome {
  return {
    workspace: options.workspace,
    language: options.plan.profileId,
    operation: options.plan.operation,
    status,
    ...(run ? { run } : {}),
    durationMs: Date.now() - startedAt,
    manifestsBefore,
    lockfilesBefore,
    manifestsAfter: manifestsBefore,
    lockfilesAfter: lockfilesBefore,
    manifestsChanged: Object.freeze([]),
    lockfilesChanged: Object.freeze([]),
    mutations: Object.freeze([]),
    vulnerabilities: Object.freeze([]) as readonly LanguagePackageVulnerability[],
    outdated: Object.freeze([]) as readonly LanguagePackageMutation[],
    ...(error ? { error } : {}),
  };
}
