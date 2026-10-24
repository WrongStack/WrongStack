import * as path from 'node:path';
import type { Tool, ToolStreamEvent } from '@wrongstack/contracts/types';
import { ToolValidationError } from '@wrongstack/contracts/types';
import { toErrorMessage } from '@wrongstack/core/utils';
import { bunTypecheckInvocation } from './_bun-typechecker.js';
import { spawnStream } from './_spawn-stream.js';
import { normalizeCommandOutput, safeResolveReal } from './_util.js';
import { tryLegacyCodeOperation } from './languages/legacy-bridge.js';

export interface TypecheckInput {
  project?: string | undefined;
  cwd?: string | undefined;
  strict?: boolean | undefined;
  all?: boolean | undefined;
}

export interface TypecheckOutput {
  project: string;
  exit_code: number;
  errors: number;
  warnings: number;
  output: string;
  truncated: boolean;
}

export type TypecheckContext = Parameters<Tool<TypecheckInput, TypecheckOutput>['execute']>[1];

export const typecheckTool: Tool<TypecheckInput, TypecheckOutput> = {
  name: 'typecheck',
  category: 'Code Quality',
  description:
    "Run Bun's TypeScript type checker without emitting files. Requires a working Bun checker and provisions the pinned runtime if needed. Other languages use their native checker.",
  usageHint:
    'ALWAYS RUN BEFORE CONSIDERING WORK COMPLETE:\n\n' +
    '- Use this to catch type errors early.\n' +
    '- In monorepos, `all: true` will check every package.\n' +
    '- This is one of the most important quality gates in this project.\n' +
    'Never claim a task is done without a clean typecheck (unless the user explicitly says otherwise).',
  permission: 'confirm',
  mutating: false,
  timeoutMs: 120_000,
  capabilities: ['shell.restricted'],
  icon: 'code',
  inputSchema: {
    type: 'object',
    properties: {
      project: { type: 'string', description: 'Path to tsconfig.json (default: auto-detect)' },
      cwd: { type: 'string', description: 'Working directory (default: cwd)' },
      strict: {
        type: 'boolean',
        description: 'Add --strict flag for maximum type checking (default: false)',
      },
      all: {
        type: 'boolean',
        description:
          'Type-check the workspace with Bun, following tsconfig project references (default: false)',
      },
    },
  },
  async execute(input, ctx, opts) {
    let final: TypecheckOutput | undefined;
    const executeStream = typecheckTool.executeStream;
    if (!executeStream) throw new Error('typecheckTool: stream execution unavailable');
    for await (const ev of executeStream(input, ctx, opts)) {
      if (ev.type === 'final') final = ev.output;
    }
    if (!final) throw new Error('typecheck: stream ended without final event');
    return final;
  },
  async *executeStream(input, ctx, opts): AsyncGenerator<ToolStreamEvent<TypecheckOutput>> {
    const cwd =
      input.cwd || ctx.workingDir
        ? await safeResolveReal(input.cwd ?? ctx.workingDir!, ctx)
        : ctx.cwd;
    const signal = opts?.signal ?? ctx.signal ?? new AbortController().signal;
    signal.throwIfAborted();

    if (input.all && input.project !== undefined) {
      throw new ToolValidationError({
        message: 'typecheck: cannot specify both "all: true" and "project"',
        field: 'project',
      });
    }

    if (input.project !== undefined) {
      if (typeof input.project !== 'string' || !input.project.trim()) {
        throw new ToolValidationError({
          message: 'typecheck: "project" must be a non-empty string path',
          field: 'project',
        });
      }
    }

    // Delegate to the language planner for non-JS ecosystems (Go, Rust, PHP, C#).
    const bridge = await tryLegacyCodeOperation('semantic', {
      cwd,
      projectRoot: ctx.projectRoot,
      signal,
    });
    if (bridge?.run) {
      const run = bridge.run;
      // Checker could not be launched: exitCode is null and would otherwise
      // read as a clean typecheck.
      if (run.status === 'unavailable') {
        throw new Error(
          `typecheck: ${bridge.language} checker unavailable: ${run.error || run.output || 'no detail'}`,
        );
      }
      // A timed-out, cancelled or crashed check also has no exit code, and its
      // empty diagnostics summary is NOT "no type errors" — it never finished.
      // Same rule as lint/format: the check did not run, so the call fails.
      if (run.status === 'cancelled') signal.throwIfAborted();
      if (run.exitCode === null) {
        throw new Error(
          `typecheck: ${bridge.language} checker did not finish (${run.status})${run.error ? `: ${run.error}` : ''}`,
        );
      }
      yield {
        type: 'final',
        output: {
          project: `${bridge.language} workspace`,
          exit_code: run.exitCode,
          errors: run.summary.errors,
          warnings: run.summary.warnings,
          output: normalizeCommandOutput(run.output || run.error || ''),
          truncated: run.truncated,
        },
      };
      return;
    }

    const checkArgs = ['--noEmit'];
    if (input.strict) checkArgs.push('--strict');
    let project: string;
    if (input.all) {
      project = 'workspace';
      checkArgs.push('-b');
      const tsconfig = await findTsConfig(cwd);
      if (tsconfig) checkArgs.push('--project', tsconfig);
    } else {
      const tsconfig = input.project
        ? await safeResolveReal(input.project.trim(), ctx)
        : await findTsConfig(cwd);
      if (tsconfig) checkArgs.push('--project', tsconfig);
      project = tsconfig ?? 'default';
    }

    yield { type: 'log', text: 'Preparing Bun type checking…', data: { project } };
    let invocation: Awaited<ReturnType<typeof bunTypecheckInvocation>>;
    try {
      invocation = await bunTypecheckInvocation(cwd, checkArgs, { signal });
    } catch (err) {
      signal.throwIfAborted();
      // No checker ran (missing project dir, runtime not provisionable): a
      // failed start, never a fabricated result.
      throw new Error(`typecheck: failed to start: ${toErrorMessage(err)}`);
    }
    yield {
      type: 'log',
      text: `${invocation.cmd} ${invocation.args.join(' ')}`,
      data: { project },
    };

    const result = yield* spawnStream({
      ...invocation,
      signal,
      maxBytes: 200_000,
    });

    // Spawn failure: no type check ran, so this is a
    // failed call rather than a fabricated "1 error" result.
    if (result.error) {
      throw new Error(`typecheck: failed to start ${invocation.cmd}: ${result.error}`);
    }

    // Count real TypeScript diagnostic lines ("file(1,2): error TS1234: …"), not every
    // occurrence of the word "error" — messages quoting the word inflated the
    // old \berror\b count.
    const combined = [result.stdout, result.stderr].filter(Boolean).join('\n');
    let errors = [...combined.matchAll(/^.*\berror TS\d+:/gim)].length;
    const warnings = [...combined.matchAll(/^.*\bwarning TS\d+:/gim)].length;
    if (errors === 0 && result.exitCode !== 0) {
      errors = 1;
    }

    const rawOutput =
      result.stdout && result.stderr
        ? `${result.stdout}\n${result.stderr}`
        : result.stdout || result.stderr || '';

    yield {
      type: 'final',
      output: {
        project,
        exit_code: result.exitCode,
        errors,
        warnings,
        output: normalizeCommandOutput(rawOutput),
        truncated: result.truncated,
      },
    };
  },
};

async function findTsConfig(cwd: string): Promise<string | null> {
  const { stat } = await import('node:fs/promises');
  const candidates = [
    'tsconfig.json',
    'tsconfig.base.json',
    'tsconfig.build.json',
    'tsconfig.app.json',
    'tsconfig.node.json',
    'tsconfig.lib.json',
  ];
  for (const f of candidates) {
    try {
      const s = await stat(path.join(cwd, f));
      if (s.isFile()) return path.join(cwd, f);
    } catch {
      // continue
    }
  }
  return null;
}
