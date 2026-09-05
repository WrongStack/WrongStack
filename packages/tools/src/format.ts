import type { Tool, ToolStreamEvent } from '@wrongstack/core/types';
import { ToolValidationError } from '@wrongstack/core/types';
import { spawnStream } from './_spawn-stream.js';
import { normalizeCommandOutput, safeResolveReal } from './_util.js';
import { tryLegacyCodeOperation } from './languages/legacy-bridge.js';

interface FormatInput {
  files?: string | string[] | undefined;
  fixer?: 'biome' | 'prettier' | 'auto' | undefined;
  check?: boolean | undefined;
  cwd?: string | undefined;
}

interface FormatOutput {
  fixer: string;
  /** Parsed from formatter output when confidently available; undefined otherwise. */
  files_checked: number | undefined;
  /** Parsed from formatter output when confidently available; undefined otherwise. */
  files_changed: number | undefined;
  output: string;
  truncated: boolean;
}

type FormatContext = Parameters<Tool<FormatInput, FormatOutput>['execute']>[1];

export const formatTool = {
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
  writeTargets(input: FormatInput): string[] {
    if (input?.check) return [];
    if (!input?.files) return [];
    const rawFiles = Array.isArray(input.files) ? input.files : input.files.split(',');
    return [
      ...new Set(
        rawFiles
          .filter((f): f is string => typeof f === 'string')
          .map((f) => f.trim().replace(/\\/g, '/'))
          .filter(Boolean),
      ),
    ];
  },
  async execute(input: FormatInput, ctx: FormatContext, opts?: { signal: AbortSignal }) {
    let final: FormatOutput | undefined;
    const executeStream = formatTool.executeStream;
    if (!executeStream) throw new Error('formatTool: stream execution unavailable');
    for await (const ev of executeStream(input, ctx, opts)) {
      if (ev.type === 'final') final = ev.output;
    }
    if (!final) throw new Error('format: stream ended without final event');
    return final;
  },
  async *executeStream(
    input: FormatInput,
    ctx: FormatContext,
    opts?: { signal: AbortSignal },
  ): AsyncGenerator<ToolStreamEvent<FormatOutput>> {
    const cwd = input.cwd ? await safeResolveReal(input.cwd, ctx) : ctx.cwd;
    const signal = opts?.signal ?? ctx.signal ?? new AbortController().signal;
    signal.throwIfAborted();
    const VALID_FIXERS: ReadonlySet<string> = new Set(['biome', 'prettier', 'auto']);
    if (input.fixer !== undefined && !VALID_FIXERS.has(input.fixer)) {
      throw new ToolValidationError({
        message: `format: unsupported fixer "${input.fixer}". Allowed fixers: biome, prettier, auto`,
        field: 'fixer',
      });
    }
    const fixer = input.fixer ?? 'auto';

    // Delegate to the language planner for non-JS ecosystems (Go, Rust, PHP, C#).
    if (fixer === 'auto' && !input.files) {
      const op = input.check ? 'format-check' : 'format-write';
      const bridge = await tryLegacyCodeOperation(op, {
        cwd,
        projectRoot: ctx.projectRoot,
        signal,
      });
      if (bridge?.run) {
        const run = bridge.run;
        yield {
          type: 'final',
          output: {
            fixer: bridge.language,
            // Language-bridge runs don't report per-file counts.
            files_checked: undefined,
            files_changed: undefined,
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

    const fileList = input.files
      ? [
          ...new Set(
            (Array.isArray(input.files) ? input.files : input.files.split(','))
              .filter((f): f is string => typeof f === 'string')
              .map((f) => f.trim().replace(/\\/g, '/'))
              .filter(Boolean),
          ),
        ]
      : [];

    let args: string[];
    if (detected === 'prettier') {
      // Prettier's CLI is `prettier --write <files|.>` / `prettier --check <files|.>`
      // — it has no `format` subcommand.
      args = [input.check ? '--check' : '--write'];
      args.push(...(fileList.length > 0 ? fileList : ['.']));
    } else {
      args = ['format', input.check ? '--check' : '--write'];
      if (fileList.length > 0) args.push('--', ...fileList);
    }

    const result = yield* spawnStream({
      cmd: detected,
      args,
      cwd,
      signal,
      maxBytes: 100_000,
    });

    const combinedOut = `${result.stdout}\n${result.stderr}`;
    const counts = parseFormatterCounts(detected, combinedOut, !!input.check);
    const rawOutput =
      result.stdout && result.stderr
        ? `${result.stdout}\n${result.stderr}`
        : result.stdout || result.stderr || result.error || '';

    yield {
      type: 'final',
      output: {
        fixer: detected,
        files_checked: counts.checked,
        files_changed: counts.changed,
        output: normalizeCommandOutput(rawOutput),
        truncated: result.truncated,
      },
    };
  },
} satisfies Tool<FormatInput, FormatOutput>;

/**
 * Extract file counts from real formatter output. Biome prints stable summary
 * lines ("Checked 12 files in 30ms. Fixed 3 files."); anything else (including
 * prettier's per-file listing, whose shape varies by version and flags) yields
 * `undefined` rather than a guessed number.
 */
export function parseFormatterCounts(
  fixer: string,
  output: string,
  isCheck = false,
): { checked: number | undefined; changed: number | undefined } {
  if (fixer !== 'biome') return { checked: undefined, changed: undefined };
  const checkedMatch = /\b(?:Checked|Formatted)\s+(\d+)\s+files?\b/i.exec(output);
  const fixedMatch = /\bFixed\s+(\d+)\s+files?\b/i.exec(output);
  const formattedCountMatch = /\bFormatted\s+(\d+)\s+files?\b/i.exec(output);
  let changed: number | undefined;
  if (isCheck) {
    changed = 0;
  } else if (fixedMatch?.[1] !== undefined) {
    changed = Number(fixedMatch[1]);
  } else if (formattedCountMatch?.[1] !== undefined) {
    changed = Number(formattedCountMatch[1]);
  }
  return {
    checked: checkedMatch?.[1] !== undefined ? Number(checkedMatch[1]) : undefined,
    changed,
  };
}

export async function detectFixer(cwd: string): Promise<string | null> {
  const fs = await import('node:fs/promises');
  const { join } = await import('node:path');
  const exists = async (file: string): Promise<boolean> => {
    try {
      await fs.stat(join(cwd, file));
      return true;
    } catch {
      return false;
    }
  };

  if ((await exists('biome.json')) || (await exists('biome.jsonc'))) return 'biome';

  const PRETTIER_CONFIGS = [
    '.prettierrc',
    '.prettierrc.json',
    '.prettierrc.json5',
    '.prettierrc.yml',
    '.prettierrc.yaml',
    '.prettierrc.toml',
    '.prettierrc.js',
    '.prettierrc.cjs',
    '.prettierrc.mjs',
    'prettier.config.js',
    'prettier.config.cjs',
    'prettier.config.mjs',
    'prettier.config.ts',
  ];
  for (const cfg of PRETTIER_CONFIGS) {
    if (await exists(cfg)) return 'prettier';
  }
  // package.json#prettier counts as a prettier config too.
  try {
    const raw = await fs.readFile(join(cwd, 'package.json'), 'utf8');
    const pkg = JSON.parse(raw) as Record<string, unknown>;
    if (pkg['prettier'] !== undefined) return 'prettier';
  } catch {
    /* no readable package.json — fall through */
  }
  return 'biome';
}
