import type { Tool, ToolStreamEvent } from '@wrongstack/core/types';
import { safeResolveReal } from '../_util.js';
import { executeLanguagePlan } from './execute.js';
import { planLanguageOperation } from './plan.js';
import type {
  LanguageDiagnostic,
  LanguageOperation,
  LanguageOperationOptions,
  LanguageProfileId,
  LanguageRunResult,
} from './types.js';

interface LanguageToolInput {
  action: 'check' | 'lint' | 'format' | 'test' | 'build' | 'debug';
  cwd?: string | undefined;
  target?: string | undefined;
  language?: LanguageProfileId | undefined;
  workspace?: string | undefined;
  mode?: 'fast' | 'standard' | 'thorough' | undefined;
  check?: 'syntax' | 'semantic' | 'all' | undefined;
  formatCheck?: boolean | undefined;
  filter?: string | undefined;
  coverage?: boolean | undefined;
  noRun?: boolean | undefined;
  debug?: 'compile' | 'test' | 'runtime' | 'race' | undefined;
}

interface LanguageToolOutput {
  status: 'passed' | 'failed' | 'unavailable' | 'cancelled' | 'timed_out';
  language?: LanguageProfileId | undefined;
  workspace?: string | undefined;
  runs: LanguageRunResult[];
  diagnostics: readonly LanguageDiagnostic[];
  summary: {
    runs: number;
    passed: number;
    failed: number;
    errors: number;
    warnings: number;
  };
  output: string;
}

const LANGUAGE_IDS: LanguageProfileId[] = [
  'typescript',
  'javascript',
  'go',
  'rust',
  'php',
  'csharp',
  'python',
  'java',
  'ruby',
  'c',
  'cpp',
  'swift',
  'dart',
  'elixir',
  'deno',
  'shell',
];

export const languageTool: Tool<LanguageToolInput, LanguageToolOutput> = {
  name: 'language',
  category: 'Code Quality',
  description:
    'Execute predefined language-specific checks, linters, formatters, tests, builds, and debugging evidence.',
  usageHint:
    'Use this instead of constructing compiler or test commands manually. The tool detects the workspace, ' +
    'builds an allowlisted argv plan, revalidates it, executes without a shell, and returns normalized diagnostics. ' +
    'Package and network operations are intentionally excluded.',
  selection: {
    doNotUseWhen: 'You only need workspace detection/planning, or need to modify dependencies.',
    useInstead: ['language_info', 'install', 'audit', 'outdated'],
  },
  permission: 'confirm',
  // WS-046: gives permission decisions something to key on.
  // The action performed (build/test/lint); the cwd is where, not what.
  subjectKey: 'action',
  mutating: true,
  riskTier: 'standard',
  capabilities: ['shell.restricted', 'fs.write'],
  icon: 'code',
  timeoutMs: 600_000,
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['check', 'lint', 'format', 'test', 'build', 'debug'],
        description: 'Language operation to execute.',
      },
      cwd: { type: 'string', description: 'Directory inside the project.' },
      target: { type: 'string', description: 'Optional target file for workspace selection.' },
      language: { type: 'string', enum: LANGUAGE_IDS, description: 'Optional language filter.' },
      workspace: { type: 'string', description: 'Detected workspace id or root.' },
      mode: { type: 'string', enum: ['fast', 'standard', 'thorough'] },
      check: { type: 'string', enum: ['syntax', 'semantic', 'all'] },
      formatCheck: {
        type: 'boolean',
        description: 'Verify formatting without writing (default true).',
      },
      filter: {
        type: 'string',
        description: 'Validated test/debug filter passed to profile adapters.',
      },
      coverage: { type: 'boolean' },
      noRun: { type: 'boolean', description: 'Compile tests without running when supported.' },
      debug: { type: 'string', enum: ['compile', 'test', 'runtime', 'race'] },
    },
    required: ['action'],
    additionalProperties: false,
  },
  validate(input) {
    const errors: string[] = [];
    if (input.action !== 'check' && input.check)
      errors.push('check is only valid when action=check');
    if (input.action !== 'format' && input.formatCheck !== undefined)
      errors.push('formatCheck is only valid when action=format');
    if (input.action !== 'debug' && input.debug)
      errors.push('debug is only valid when action=debug');
    if (input.coverage) errors.push('coverage collection is not implemented in Phase 2');
    if (input.noRun && input.action !== 'test') errors.push('noRun is only valid when action=test');
    if (
      input.filter &&
      (input.filter.length > 500 ||
        input.filter.startsWith('-') ||
        /[\r\n\0;&|`$<>]/.test(input.filter))
    )
      errors.push(
        'filter must be at most 500 characters, not start with "-", and contain no shell/control characters',
      );
    return errors;
  },
  async execute(input, ctx, opts) {
    let final: LanguageToolOutput | undefined;
    const stream = languageTool.executeStream;
    if (!stream) throw new Error('languageTool: stream execution unavailable');
    for await (const event of stream(input, ctx, opts)) {
      if (event.type === 'final') final = event.output;
    }
    if (!final) throw new Error('language: stream ended without final event');
    return final;
  },
  async *executeStream(input, ctx, opts): AsyncGenerator<ToolStreamEvent<LanguageToolOutput>> {
    const cwd = input.cwd ? await safeResolveReal(input.cwd, ctx) : (ctx.workingDir ?? ctx.cwd);
    const signal = opts?.signal ?? ctx.signal ?? new AbortController().signal;
    const operations = operationsFor(input);
    const runs: LanguageRunResult[] = [];
    const unavailableReasons: string[] = [];
    for (const operation of operations) {
      signal.throwIfAborted();
      const planResult = await planLanguageOperation({
        projectRoot: ctx.projectRoot,
        cwd,
        operation,
        ...(input.target ? { target: input.target } : {}),
        ...(input.language ? { language: input.language } : {}),
        ...(input.workspace ? { workspace: input.workspace } : {}),
        ...(input.mode ? { mode: input.mode } : {}),
        operationOptions: operationOptions(input),
        signal,
      });
      if (planResult.status !== 'planned') {
        const reason =
          planResult.status === 'unavailable' ? planResult.unavailable.reason : planResult.reason;
        if (runs.length === 0) {
          return yield {
            type: 'final',
            output: unavailableOutput(reason),
          };
        }
        unavailableReasons.push(`${operation}: ${reason}`);
        yield { type: 'warning', text: `${operation}: ${reason}` };
        continue;
      }
      const runner = executeLanguagePlan({
        projectRoot: ctx.projectRoot,
        workspace: planResult.workspace,
        plan: planResult.plan,
        signal,
      });
      for (;;) {
        const next = await runner.next();
        if (next.done) {
          runs.push(next.value);
          if (next.value.plan.kind === 'process') {
            ctx.recordSideEffect?.({
              toolUseId: `language-${Date.now()}-${runs.length}`,
              toolName: 'language',
              ts: new Date().toISOString(),
              input: {
                language: next.value.language,
                operation: next.value.plan.operation,
                command: next.value.plan.command,
                args: next.value.plan.args,
                cwd: next.value.plan.cwd,
              },
              outcome: `${next.value.status}${next.value.exitCode === null ? '' : ` (exit ${next.value.exitCode})`}`,
              risk: 'shell',
            });
          }
          break;
        }
        yield next.value;
      }
      const last = runs.at(-1)!;
      if (last.status === 'cancelled' || last.status === 'timed_out') break;
      if (last.status === 'failed' && input.mode !== 'thorough') break;
    }
    yield { type: 'final', output: aggregateRuns(runs, unavailableReasons) };
  },
  serialize(output) {
    const lines = [
      `status=${output.status} runs=${output.summary.runs} passed=${output.summary.passed} failed=${output.summary.failed}`,
      `diagnostics: ${output.summary.errors} error(s), ${output.summary.warnings} warning(s)`,
    ];
    for (const diagnostic of output.diagnostics.slice(0, 20)) {
      const location = diagnostic.file
        ? `${diagnostic.file}${diagnostic.range ? `:${diagnostic.range.start.line}:${diagnostic.range.start.column}` : ''}`
        : diagnostic.source;
      lines.push(
        `${diagnostic.severity.toUpperCase()} ${location}${diagnostic.code ? ` ${diagnostic.code}` : ''}: ${diagnostic.message}`,
      );
    }
    if (output.diagnostics.length > 20)
      lines.push(`… ${output.diagnostics.length - 20} more diagnostic(s)`);
    if (output.output) lines.push(output.output);
    return lines.join('\n');
  },
};

function operationsFor(input: LanguageToolInput): LanguageOperation[] {
  switch (input.action) {
    case 'check':
      return input.check === 'syntax'
        ? ['syntax']
        : input.check === 'semantic'
          ? ['semantic']
          : ['syntax', 'semantic'];
    case 'lint':
      return ['lint'];
    case 'format':
      return [input.formatCheck === false ? 'format-write' : 'format-check'];
    case 'test':
      return [input.noRun ? 'test-compile' : 'test'];
    case 'build':
      return ['build'];
    case 'debug':
      if (input.debug === 'race') return ['debug-race'];
      if (input.debug === 'test') return ['test-compile', 'test'];
      if (input.debug === 'runtime') return ['semantic', 'build', 'test'];
      return ['semantic'];
  }
}

function operationOptions(input: LanguageToolInput): LanguageOperationOptions {
  return {
    ...(input.target ? { target: input.target } : {}),
    ...(input.filter ? { filter: input.filter } : {}),
    ...(input.coverage !== undefined ? { coverage: input.coverage } : {}),
    ...(input.noRun !== undefined ? { noRun: input.noRun } : {}),
  };
}

function unavailableOutput(reason: string): LanguageToolOutput {
  return {
    status: 'unavailable',
    runs: [],
    diagnostics: Object.freeze([]),
    summary: { runs: 0, passed: 0, failed: 0, errors: 0, warnings: 0 },
    output: reason,
  };
}

function aggregateRuns(
  runs: LanguageRunResult[],
  unavailableReasons: readonly string[],
): LanguageToolOutput {
  if (runs.length === 0)
    return unavailableOutput(
      unavailableReasons.join('\n') || 'No executable language operations were planned.',
    );
  const diagnostics = Object.freeze(runs.flatMap((run) => [...run.diagnostics]));
  const failed = runs.filter((run) => run.status === 'failed').length;
  const terminal = runs.find((run) => run.status === 'cancelled' || run.status === 'timed_out');
  const unavailable = runs.filter((run) => run.status === 'unavailable').length;
  const status: LanguageToolOutput['status'] =
    terminal?.status ??
    (failed > 0
      ? 'failed'
      : unavailableReasons.length > 0 || unavailable === runs.length
        ? 'unavailable'
        : 'passed');
  return {
    status,
    language: runs[0]!.language,
    workspace: runs[0]!.workspace.root,
    runs,
    diagnostics,
    summary: {
      runs: runs.length,
      passed: runs.filter((run) => run.status === 'passed').length,
      failed,
      errors: diagnostics.filter((item) => item.severity === 'error').length,
      warnings: diagnostics.filter((item) => item.severity === 'warning').length,
    },
    output: [
      ...runs.map(
        (run) => `${run.plan.operation}: ${run.status}${run.output ? `\n${run.output}` : ''}`,
      ),
      ...unavailableReasons,
    ].join('\n\n'),
  };
}
