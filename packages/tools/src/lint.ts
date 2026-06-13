import type { Tool, ToolStreamEvent } from '@wrongstack/core';
import { spawnStream } from './_spawn-stream.js';
import { normalizeCommandOutput, safeResolve } from './_util.js';

interface LintInput {
  files?: string | string[] | undefined;
  fix?: boolean | undefined;
  linter?: 'biome' | 'eslint' | 'tslint' | 'auto' | undefined;
  cwd?: string | undefined;
}

interface LintOutput {
  linter: string;
  files_checked: number;
  errors: number;
  warnings: number;
  output: string;
  fix_applied: boolean;
  truncated: boolean;
}

export const lintTool: Tool<LintInput, LintOutput> = {
  name: 'lint',
  category: 'Code Quality',
  description:
    'Run the project linter (primarily Biome in this repo). Detects style violations, potential bugs, and formatting issues.',
  usageHint:
    'RUN OFTEN DURING DEVELOPMENT:\n\n' +
    '- `fix: true` will automatically correct what it can.\n' +
    '- Target specific files or globs when you only want to check part of the project.\n' +
    'This is a fast and important quality gate. Use it before typecheck in most workflows.',
  permission: 'confirm',
  mutating: false,
  timeoutMs: 60_000,
  capabilities: ['shell.restricted'],
  inputSchema: {
    type: 'object',
    properties: {
      files: {
        type: 'string',
        description:
          'Files/patterns: single path, comma-separated list, or glob (e.g. "src/**/*.ts")',
      },
      fix: { type: 'boolean', description: 'Auto-fix fixable issues (default: false)' },
      linter: {
        type: 'string',
        enum: ['biome', 'eslint', 'tslint', 'auto'],
        description: 'Linter to use (default: auto-detect)',
      },
      cwd: { type: 'string', description: 'Working directory (default: cwd)' },
    },
  },
  async execute(input, ctx, opts) {
    let final: LintOutput | undefined;
    const executeStream = lintTool.executeStream;
    if (!executeStream) throw new Error('lintTool: stream execution unavailable');
    for await (const ev of executeStream(input, ctx, opts)) {
      if (ev.type === 'final') final = ev.output;
    }
    if (!final) throw new Error('lint: stream ended without final event');
    return final;
  },
  async *executeStream(input, ctx, opts): AsyncGenerator<ToolStreamEvent<LintOutput>> {
    const cwd = input.cwd ? safeResolve(input.cwd, ctx) : ctx.cwd;
    const linter = input.linter ?? 'auto';

    const detected = linter === 'auto' ? await detectLinter(cwd) : linter;
    if (!detected) {
      yield {
        type: 'final',
        output: {
          linter: 'none',
          files_checked: 0,
          errors: 0,
          warnings: 0,
          output: 'No linter found (biome.json, .eslintrc, tslint.json)',
          fix_applied: false,
          truncated: false,
        },
      };
      return;
    }

    yield { type: 'log', text: `Running ${detected}…`, data: { linter: detected } };

    const args: string[] = ['lint'];
    if (input.fix) args.push('--write');
    if (input.files) {
      const files = Array.isArray(input.files) ? input.files : input.files.split(',');
      args.push('--', ...files.map((f) => f.trim()));
    }

    const cmd = detected === 'biome' ? 'biome' : detected;
    const result = yield* spawnStream({ cmd, args, cwd, signal: opts.signal, maxBytes: 100_000 });

    const errors = (result.stdout.match(/error/g) || []).length;
    const warnings = (result.stdout.match(/warning/g) || []).length;

    yield {
      type: 'final',
      output: {
        linter: detected,
        files_checked: input.files
          ? Array.isArray(input.files)
            ? input.files.length
            : input.files.split(',').length
          : 0,
        errors,
        warnings,
        output: normalizeCommandOutput(result.stdout),
        fix_applied: input.fix ?? false,
        truncated: result.truncated,
      },
    };
  },
};

async function detectLinter(cwd: string): Promise<string | null> {
  const { stat } = await import('node:fs/promises');
  const checks = ['biome.json', '.eslintrc.json', 'tslint.json', '.eslintrc.js', 'tsconfig.json'];
  for (const f of checks) {
    try {
      await stat(`${cwd}/${f}`);
      if (f.includes('biome')) return 'biome';
      if (f.includes('eslint')) return 'eslint';
      if (f.includes('tslint')) return 'tslint';
    } catch {
      // continue
    }
  }
  return 'biome';
}
