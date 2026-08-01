import type { Tool, ToolStreamEvent } from '@wrongstack/core/types';
import { spawnStream } from './_spawn-stream.js';
import { normalizeCommandOutput, safeResolve } from './_util.js';
import { tryLegacyCodeOperation } from './languages/legacy-bridge.js';

interface FormatInput {
  files?: string | string[] | undefined;
  fixer?: 'biome' | 'prettier' | 'auto' | undefined;
  check?: boolean | undefined;
  cwd?: string | undefined;
}

interface FormatOutput {
  fixer: string;
  files_checked: number;
  files_changed: number;
  output: string;
  truncated: boolean;
}

export const formatTool: Tool<FormatInput, FormatOutput> = {
  name: 'format',
  category: 'Code Quality',
  description:
    'Format source files according to project style (Biome). Can also run in check-only mode.',
  usageHint:
    'RUN REGULARLY:\n\n' +
    '- Use on changed files before committing.\n' +
    '- `check: true` verifies formatting without making changes (useful in CI-like flows).\n' +
    'This project has very consistent formatting expectations. Always ensure your changes are formatted.',
  permission: 'confirm',
  // WS-046: gives permission decisions something to key on.
  // The files being rewritten are the subject; the fixer is how, not what.
  subjectKey: 'files',
  mutating: true,
  capabilities: ['fs.write', 'shell.restricted'],
  icon: 'code',
  timeoutMs: 60_000,
  inputSchema: {
    type: 'object',
    properties: {
      files: {
        type: 'string',
        description: 'Files/patterns: single path, comma-separated list, or glob',
      },
      fixer: {
        type: 'string',
        enum: ['biome', 'prettier', 'auto'],
        description: 'Formatter to use (default: auto-detect)',
      },
      check: {
        type: 'boolean',
        description: 'Verify only, do not modify files (default: false)',
      },
      cwd: { type: 'string', description: 'Working directory (default: cwd)' },
    },
  },
  async execute(input, ctx, opts) {
    let final: FormatOutput | undefined;
    const executeStream = formatTool.executeStream;
    if (!executeStream) throw new Error('formatTool: stream execution unavailable');
    for await (const ev of executeStream(input, ctx, opts)) {
      if (ev.type === 'final') final = ev.output;
    }
    if (!final) throw new Error('format: stream ended without final event');
    return final;
  },
  async *executeStream(input, ctx, opts): AsyncGenerator<ToolStreamEvent<FormatOutput>> {
    const cwd = input.cwd ? safeResolve(input.cwd, ctx) : ctx.cwd;
    const fixer = input.fixer ?? 'auto';

    // Delegate to the language planner for non-JS ecosystems (Go, Rust, PHP, C#).
    if (fixer === 'auto' && !input.files) {
      const op = input.check ? 'format-check' : 'format-write';
      const bridge = await tryLegacyCodeOperation(op, {
        cwd,
        projectRoot: ctx.projectRoot,
        signal: opts.signal,
      });
      if (bridge?.run) {
        const run = bridge.run;
        yield {
          type: 'final',
          output: {
            fixer: bridge.language,
            files_checked: 0,
            files_changed: run.summary.errors > 0 ? 0 : 1,
            output: normalizeCommandOutput(run.output || run.error || ''),
            truncated: run.truncated,
          },
        };
        return;
      }
    }

    const detected = fixer === 'auto' ? await detectFixer(cwd) : fixer;
    /* v8 ignore start -- detectFixer always falls back to 'biome' (never null) and explicit fixers are truthy; this is defensive. */
    if (!detected) {
      yield {
        type: 'final',
        output: {
          fixer: 'none',
          files_checked: 0,
          files_changed: 0,
          output: 'No formatter found (biome.json, .prettierrc)',
          truncated: false,
        },
      };
      return;
    }
    /* v8 ignore stop */

    yield {
      type: 'log',
      text: `Running ${detected}…`,
      data: { fixer: detected, check: !!input.check },
    };

    const args: string[] = ['format', '--write'];
    if (input.check) args[args.length - 1] = '--check';
    if (input.files) {
      const files = Array.isArray(input.files) ? input.files : input.files.split(',');
      args.push('--', ...files.map((f) => f.trim()));
    }

    const result = yield* spawnStream({
      cmd: detected,
      args,
      cwd,
      signal: opts.signal,
      maxBytes: 100_000,
    });

    const changed = [...result.stdout.matchAll(/\bchanged\b/gi)].length;
    yield {
      type: 'final',
      output: {
        fixer: detected,
        files_checked: 0,
        files_changed: changed,
        output: normalizeCommandOutput(result.stdout || result.stderr || result.error || ''),
        truncated: result.truncated,
      },
    };
  },
};

async function detectFixer(cwd: string): Promise<string | null> {
  const { stat } = await import('node:fs/promises');
  try {
    await stat(`${cwd}/biome.json`);
    return 'biome';
  } catch {
    try {
      await stat(`${cwd}/.prettierrc`);
      return 'prettier';
    } catch {
      return 'biome';
    }
  }
}
