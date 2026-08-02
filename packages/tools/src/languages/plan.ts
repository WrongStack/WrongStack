import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { detectLanguageWorkspaces } from './detect.js';
import { languageProfileRegistry } from './registry.js';
import type {
  CommandPlan,
  DetectedWorkspace,
  LanguageOperation,
  LanguageProfile,
  PlanLanguageOptions,
  PlanLanguageResult,
  ProfileContext,
} from './types.js';

const MAX_ARGUMENTS = 128;
const MAX_ARGUMENT_LENGTH = 4_096;
const PACKAGE_NAME_RE = /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+(?:@[a-z0-9*+._~^<>=|-]+)?$/i;
const COMPOSER_PACKAGE_RE = /^[a-z0-9_.-]+\/[a-z0-9_.-]+(?::[a-z0-9*+._~^<>=|-]+)?$/i;
// Host labels must exclude `.` so the separator is unambiguous. Allowing `.` inside
// the label classes made this `(a+)+` — a 106-dot name stayed under the 214-char cap
// while backtracking without bound, wedging the event loop synchronously (WS-073).
const GO_MODULE_RE = /^(?:[a-z0-9-]+\.)+[a-z0-9-]+\/[a-z0-9._~+/@-]+$/i;
const PYTHON_PACKAGE_RE = /^[a-z0-9._-]+(?:\[[a-z0-9._,-]+\])?==[a-z0-9*+._!~-]+$/i;

export async function planLanguageOperation(
  options: PlanLanguageOptions,
): Promise<PlanLanguageResult> {
  validateOperationOptions(options.operation, options.operationOptions?.packages);
  validateFilterOption(options.operationOptions?.filter);
  const detection = await detectLanguageWorkspaces(options);
  const candidates = detection.workspaces.filter((workspace) =>
    workspace.capabilities.includes(options.operation),
  );
  const selected = selectWorkspace(candidates, options);
  if (selected.status !== 'selected') return selected.result;

  const profile = (options.profiles ?? languageProfileRegistry.list()).find(
    (item) => item.id === selected.workspace.language,
  );
  if (!profile) {
    return {
      status: 'not_found',
      reason: `Profile ${selected.workspace.language} is unavailable.`,
      candidates,
    };
  }
  if (
    (profile.id === 'typescript' || profile.id === 'javascript') &&
    options.operation !== 'syntax' &&
    selected.workspace.packageManager === undefined &&
    new Set(
      selected.workspace.evidence
        .filter((evidence) => evidence.kind === 'lockfile')
        .map((evidence) => evidence.value.toLowerCase()),
    ).size > 1
  ) {
    return {
      status: 'unavailable',
      workspace: selected.workspace,
      unavailable: {
        status: 'unavailable',
        profileId: profile.id,
        workspaceId: selected.workspace.id,
        operation: options.operation,
        reason: 'Conflicting Node lockfiles make the package manager ambiguous.',
      },
    };
  }
  const resolver = profile.operations[options.operation];
  if (!resolver) {
    return {
      status: 'unavailable',
      workspace: selected.workspace,
      unavailable: {
        status: 'unavailable',
        profileId: profile.id,
        workspaceId: selected.workspace.id,
        operation: options.operation,
        reason: `${profile.displayName} does not define ${options.operation}.`,
      },
    };
  }
  const canonicalCwd = options.cwd
    ? path.isAbsolute(options.cwd)
      ? options.cwd
      : path.resolve(detection.projectRoot, options.cwd)
    : detection.projectRoot;
  const target = options.target
    ? await canonicalTarget(canonicalCwd, options.target, detection.projectRoot)
    : undefined;
  const ctx: ProfileContext = {
    projectRoot: detection.projectRoot,
    workspace: selected.workspace,
    ...(target ? { target } : {}),
    mode: options.mode ?? 'standard',
    options: options.operationOptions ?? {},
    platform: process.platform,
    pathExists: async (candidate) => {
      try {
        await fs.access(path.resolve(detection.projectRoot, candidate));
        return true;
      } catch {
        return false;
      }
    },
  };
  const result = await resolver(ctx);
  if ('status' in result) {
    return { status: 'unavailable', workspace: selected.workspace, unavailable: result };
  }
  const errors = validateCommandPlan(result, profile, detection.projectRoot);
  if (errors.length > 0) {
    return {
      status: 'unavailable',
      workspace: selected.workspace,
      unavailable: {
        status: 'unavailable',
        profileId: profile.id,
        workspaceId: selected.workspace.id,
        operation: options.operation,
        reason: `Generated plan failed validation: ${errors.join('; ')}`,
      },
    };
  }
  return { status: 'planned', workspace: selected.workspace, plan: Object.freeze(result) };
}

export function validateCommandPlan(
  plan: CommandPlan,
  profile: LanguageProfile,
  projectRoot: string,
): string[] {
  const errors: string[] = [];
  if (plan.profileId !== profile.id) errors.push('profile id does not match');
  if (!isInside(plan.cwd, projectRoot)) errors.push('cwd is outside project root');
  if (plan.args.length > MAX_ARGUMENTS) errors.push(`argument count exceeds ${MAX_ARGUMENTS}`);
  if (plan.args.some((arg) => arg.length > MAX_ARGUMENT_LENGTH || /[\r\n\0]/.test(arg))) {
    errors.push('arguments contain an invalid or oversized value');
  }
  if (!Number.isFinite(plan.timeoutMs) || plan.timeoutMs < 1 || plan.timeoutMs > 600_000) {
    errors.push('timeout is outside 1..600000ms');
  }
  if (
    !Number.isFinite(plan.outputLimitBytes) ||
    plan.outputLimitBytes < 1 ||
    plan.outputLimitBytes > 1_000_000
  ) {
    errors.push('output limit is outside 1..1000000 bytes');
  }
  if (plan.kind === 'internal') {
    if (plan.command !== null || plan.args.length !== 0)
      errors.push('internal plans cannot declare a command');
  } else {
    if (!plan.command || !profile.executables.includes(plan.command)) {
      errors.push(`executable "${plan.command ?? ''}" is not allowlisted by the profile`);
    }
  }
  if (Object.keys(plan.env).length > 0)
    errors.push('Phase 1 plans cannot override environment variables');
  return errors;
}

function selectWorkspace(
  candidates: readonly DetectedWorkspace[],
  options: PlanLanguageOptions,
):
  | { status: 'selected'; workspace: DetectedWorkspace }
  | { status: 'result'; result: PlanLanguageResult } {
  if (candidates.length === 0) {
    return {
      status: 'result',
      result: {
        status: 'not_found',
        reason: `No workspace supports ${options.operation}.`,
        candidates: [],
      },
    };
  }
  if (options.workspace) {
    const requested = path.isAbsolute(options.workspace)
      ? path.resolve(options.workspace)
      : path.resolve(options.projectRoot, options.workspace);
    const matches = candidates.filter(
      (item) => item.id === options.workspace || path.resolve(item.root) === requested,
    );
    if (matches.length === 1) return { status: 'selected', workspace: matches[0]! };
    return {
      status: 'result',
      result: {
        status: 'not_found',
        reason: `Requested workspace "${options.workspace}" was not detected.`,
        candidates: [...candidates],
      },
    };
  }
  if (options.target) {
    const base = options.cwd
      ? path.isAbsolute(options.cwd)
        ? path.resolve(options.cwd)
        : path.resolve(options.projectRoot, options.cwd)
      : path.resolve(options.projectRoot);
    const target = path.isAbsolute(options.target)
      ? path.resolve(options.target)
      : path.resolve(base, options.target);
    const targeted = candidates
      .filter((item) => item.evidence.some((evidence) => evidence.kind === 'target'))
      .sort(
        (a, b) =>
          workspaceDepth(b.root, options.projectRoot) -
            workspaceDepth(a.root, options.projectRoot) || compareCandidates(a, b),
      );
    if (targeted[0]) return { status: 'selected', workspace: targeted[0] };
    const containing = candidates
      .filter((item) => isInside(target, item.root))
      .sort(
        (a, b) =>
          workspaceDepth(b.root, options.projectRoot) -
            workspaceDepth(a.root, options.projectRoot) || compareCandidates(a, b),
      );
    if (containing[0]) return { status: 'selected', workspace: containing[0] };
  }
  const sorted = [...candidates].sort(compareCandidates);
  const first = sorted[0]!;
  const firstDepth = workspaceDepth(first.root, options.projectRoot);
  const tied = sorted.filter(
    (item) =>
      item.confidence === first.confidence &&
      workspaceDepth(item.root, options.projectRoot) === firstDepth,
  );
  if (tied.length > 1) {
    return {
      status: 'result',
      result: {
        status: 'ambiguous',
        reason:
          'Multiple workspaces have equal confidence; provide target, language, or workspace.',
        candidates: tied,
      },
    };
  }
  return { status: 'selected', workspace: first };
}

function compareCandidates(a: DetectedWorkspace, b: DetectedWorkspace): number {
  return (
    b.confidence - a.confidence ||
    a.language.localeCompare(b.language) ||
    a.root.localeCompare(b.root)
  );
}

function workspaceDepth(workspaceRoot: string, projectRoot: string): number {
  const relative = path.relative(path.resolve(projectRoot), path.resolve(workspaceRoot));
  return relative === '' ? 0 : relative.split(path.sep).length;
}

/**
 * Reject a test filter that a runner would parse as an option.
 *
 * `filter` is model-supplied. Most profiles pass it behind a flag (`-run`,
 * `--filter`), which contains it, but the Rust profile passes it as a bare
 * positional: `cargo test <filter>`. `validateCommandPlan` never rejected
 * leading dashes — it cannot, since profile-authored args legitimately start
 * with one — so `--config target.…runner=[…]` reached cargo and chose the
 * program used to run the test binary (WS-091).
 *
 * Checked at the source rather than per profile, so a profile that starts
 * forwarding `filter` positionally cannot reopen this.
 */
function validateFilterOption(filter: string | undefined): void {
  if (filter === undefined) return;
  if (filter.startsWith('-') || filter.includes(' --')) {
    throw new Error(`Invalid test filter (parsed as a runner option): "${filter}"`);
  }
  if (filter.length > MAX_ARGUMENT_LENGTH || /[\r\n\0]/.test(filter)) {
    throw new Error('Invalid test filter (oversized or contains a control character)');
  }
}

function validateOperationOptions(
  operation: LanguageOperation,
  packages?: readonly string[],
): void {
  if (!operation.startsWith('package-') || !packages) return;
  for (const value of packages) {
    if (!value || value.length > 214 || value.startsWith('-') || /[\r\n\0;&|`$<>\\]/.test(value)) {
      throw new Error(`Invalid package identifier "${value}"`);
    }
    if (
      value.startsWith('.') ||
      value.startsWith('/') ||
      /^[A-Za-z]:/.test(value) ||
      value.includes('://')
    ) {
      throw new Error(`Package paths and URLs are not supported: "${value}"`);
    }
    if (
      !PACKAGE_NAME_RE.test(value) &&
      !COMPOSER_PACKAGE_RE.test(value) &&
      !GO_MODULE_RE.test(value) &&
      !PYTHON_PACKAGE_RE.test(value)
    ) {
      throw new Error(`Invalid package identifier "${value}"`);
    }
  }
}

async function canonicalTarget(cwd: string, target: string, projectRoot: string): Promise<string> {
  const resolved = path.isAbsolute(target) ? path.resolve(target) : path.resolve(cwd, target);
  let real: string;
  try {
    real = await fs.realpath(resolved);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const parent = await fs.realpath(path.dirname(resolved));
    real = path.join(parent, path.basename(resolved));
  }
  if (!isInside(real, projectRoot)) throw new Error(`target is outside project root: ${target}`);
  return real;
}

function isInside(candidate: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
