import type { Tool, ToolStreamEvent } from '@wrongstack/core/types';
import { spawnStream } from './_spawn-stream.js';
import { normalizeCommandOutput, safeResolveReal } from './_util.js';
import { tryLegacyCodeOperation } from './languages/legacy-bridge.js';

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
  icon: 'code',
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
    const cwd = input.cwd ? await safeResolveReal(input.cwd, ctx) : ctx.cwd;
    const signal = opts?.signal ?? ctx.signal ?? new AbortController().signal;
    const linter = input.linter ?? 'auto';

    // Delegate to the language planner for non-JS ecosystems (Go, Rust, PHP, C#).
    if (linter === 'auto' && !input.files) {
      const bridge = await tryLegacyCodeOperation('lint', {
        cwd,
        projectRoot: ctx.projectRoot,
        signal,
      });
      if (bridge?.run) {
        const run = bridge.run;
        yield {
          type: 'final',
          output: {
            linter: bridge.language,
            files_checked: 0,
            errors: run.summary.errors,
            warnings: run.summary.warnings,
            output: normalizeCommandOutput(run.output || run.error || ''),
            fix_applied: false,
            truncated: run.truncated,
          },
        };
        return;
      }
    }

    const detected = linter === 'auto' ? await detectLinter(cwd) : linter;
    /* v8 ignore start -- detectLinter always falls back to 'biome' (never null) and explicit linters are truthy; this is defensive. */
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
    /* v8 ignore stop */

    yield { type: 'log', text: `Running ${detected}…`, data: { linter: detected } };

    const args: string[] = ['lint'];
    if (input.fix) args.push('--write');
    if (input.files) {
      const files = Array.isArray(input.files) ? input.files : input.files.split(',');
      args.push('--', ...files.map((f) => f.trim()));
    }

    const cmd = detected === 'biome' ? 'biome' : detected;
    const result = yield* spawnStream({ cmd, args, cwd, signal, maxBytes: 100_000 });

    const errors = [...result.stdout.matchAll(/\berror\b/gi)].length;
    const warnings = [...result.stdout.matchAll(/\bwarning\b/gi)].length;

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
