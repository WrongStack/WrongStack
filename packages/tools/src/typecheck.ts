import * as path from 'node:path';
import type { Tool, ToolStreamEvent } from '@wrongstack/core/types';
import { ToolValidationError } from '@wrongstack/core/types';
import { spawnStream } from './_spawn-stream.js';
import { detectPackageManager, normalizeCommandOutput, safeResolveReal } from './_util.js';
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
    "Run the project's TypeScript type checker (`tsc --noEmit` or equivalent). Essential for verifying type safety before making changes or committing.",
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
          'Type-check all workspace packages (pnpm workspaces run `pnpm -r exec tsc --noEmit`; other setups run a single `tsc --noEmit` at cwd) (default: false)',
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
    const cwd = input.cwd ? await safeResolveReal(input.cwd, ctx) : ctx.cwd;
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
      yield {
        type: 'final',
        output: {
          project: `${bridge.language} workspace`,
          exit_code: run.exitCode ?? 0,
          errors: run.summary.errors,
          warnings: run.summary.warnings,
          output: normalizeCommandOutput(run.output || run.error || ''),
          truncated: run.truncated,
        },
      };
      return;
    }

    let cmd: string;
    let cmdArgs: string[];
    let project: string;
    if (input.all) {
      project = 'workspace';
      const tscArgs = ['--noEmit'];
      if (input.strict) tscArgs.push('--strict');
      const manager = await detectPackageManager(cwd, ctx.projectRoot);
      if (manager === 'pnpm') {
        // Recursive workspace check; --no-bail keeps going so ALL package
        // errors are collected rather than stopping at the first failure.
        cmd = 'pnpm';
        cmdArgs = ['-r', '--no-bail', 'exec', 'tsc', ...tscArgs];
      } else {
        // npm/yarn have no equivalent recursive-exec baked in; run a single
        // root-level tsc without --project so a solution/base tsconfig applies.
        cmd = 'npx';
        cmdArgs = ['tsc', ...tscArgs];
      }
    } else {
      const tsconfig = input.project
        ? await safeResolveReal(input.project.trim(), ctx)
        : await findTsConfig(cwd);
      const tscArgs = ['--noEmit'];
      if (input.strict) tscArgs.push('--strict');
      if (tsconfig) tscArgs.push('--project', tsconfig);
      project = tsconfig ?? 'default';
      cmd = 'npx';
      cmdArgs = ['tsc', ...tscArgs];
    }

    yield { type: 'log', text: `${cmd} ${cmdArgs.join(' ')}`, data: { project } };

    const result = yield* spawnStream({
      cmd,
      args: cmdArgs,
      cwd,
      signal,
      maxBytes: 200_000,
    });

    // Count real tsc diagnostic lines ("file(1,2): error TS1234: …"), not every
    // occurrence of the word "error" — messages quoting the word inflated the
    // old \berror\b count. Include result.error if present (e.g. spawn failure).
    const combined = [result.stdout, result.stderr, result.error].filter(Boolean).join('\n');
    let errors = [...combined.matchAll(/^.*\berror TS\d+:/gmi)].length;
    const warnings = [...combined.matchAll(/^.*\bwarning TS\d+:/gmi)].length;
    if (errors === 0 && result.exitCode !== 0) {
      errors = 1;
    }

    const rawOutput =
      result.stdout && result.stderr
        ? `${result.stdout}\n${result.stderr}`
        : result.stdout || result.stderr || result.error || '';

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
