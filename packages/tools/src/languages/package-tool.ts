import type { Tool, ToolStreamEvent } from '@wrongstack/core/types';
import { safeResolveReal } from '../_util.js';
import { executePackagePlan } from './execute.js';
import { planLanguageOperation } from './plan.js';
import type {
  LanguageOperation,
  LanguagePackageMutation,
  LanguagePackageOutcome,
  LanguagePackageVulnerability,
  LanguageProfileId,
} from './types.js';

export interface LanguagePackageInput {
  operation: 'install' | 'add' | 'remove' | 'update' | 'audit' | 'outdated';
  cwd?: string | undefined;
  language?: LanguageProfileId | undefined;
  workspace?: string | undefined;
  names?: string[] | undefined;
  scope?: 'runtime' | 'development' | 'optional' | undefined;
  dryRun?: boolean | undefined;
  allowScripts?: boolean | undefined;
}

export interface LanguagePackageToolOutput {
  status: 'passed' | 'failed' | 'unavailable' | 'cancelled' | 'timed_out';
  language?: LanguageProfileId | undefined;
  workspace?: string | undefined;
  operation?: LanguageOperation | undefined;
  outcome?: LanguagePackageOutcome | undefined;
  mutations: readonly LanguagePackageMutation[];
  vulnerabilities: readonly LanguagePackageVulnerability[];
  outdated: readonly LanguagePackageMutation[];
  manifestsChanged: string[];
  lockfilesChanged: string[];
  output: string;
  error?: string | undefined;
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

const SUPPORTED_OPERATIONS = new Set<LanguagePackageInput['operation']>([
  'install',
  'add',
  'remove',
  'update',
  'audit',
  'outdated',
]);

const OPERATION_TO_PLAN: Record<LanguagePackageInput['operation'], LanguageOperation> = {
  install: 'package-install',
  add: 'package-add',
  remove: 'package-remove',
  update: 'package-update',
  audit: 'package-audit',
  outdated: 'package-outdated',
};

export const languagePackageTool: Tool<LanguagePackageInput, LanguagePackageToolOutput> = {
  name: 'language_package',
  category: 'Package Management',
  description:
    'Restore, mutate, audit, or report outdated packages via predefined ecosystem-specific plans.',
  usageHint:
    'Use this instead of the legacy `install`/`audit`/`outdated` tools. The tool detects the workspace, ' +
    'builds an allowlisted argv plan with lifecycle scripts disabled, runs it, and records manifest/lockfile changes.',
  selection: {
    doNotUseWhen:
      'You only need to inspect or plan, or need to compile/test/lint without touching dependencies.',
    useInstead: ['language_info', 'language', 'install', 'audit', 'outdated'],
  },
  permission: 'confirm',
  // WS-046: gives permission decisions something to key on.
  // The package operation performed — install/remove are not interchangeable.
  subjectKey: 'operation',
  mutating: true,
  riskTier: 'destructive',
  capabilities: ['shell.restricted', 'fs.write', 'net.outbound', 'package.install'],
  icon: 'package',
  timeoutMs: 600_000,
  inputSchema: {
    type: 'object',
    properties: {
      operation: {
        type: 'string',
        enum: ['install', 'add', 'remove', 'update', 'audit', 'outdated'],
        description: 'Package management operation to perform.',
      },
      cwd: { type: 'string', description: 'Directory inside the project.' },
      language: {
        type: 'string',
        enum: LANGUAGE_IDS,
        description: 'Optional language profile filter.',
      },
      workspace: { type: 'string', description: 'Detected workspace id or root.' },
      names: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Validated package names. Required for add/remove/update; optional for install.',
      },
      scope: {
        type: 'string',
        enum: ['runtime', 'development', 'optional'],
        description: 'Where to record the dependency (add/update).',
      },
      dryRun: {
        type: 'boolean',
        description: 'Preview the install without modifying the workspace.',
      },
      allowScripts: {
        type: 'boolean',
        description:
          'Opt in to running package lifecycle scripts (preinstall/install/postinstall). Default false.',
      },
    },
    required: ['operation'],
    additionalProperties: false,
  },
  validate(input) {
    const errors: string[] = [];
    if (!SUPPORTED_OPERATIONS.has(input.operation))
      errors.push(`Unsupported package operation: ${String(input.operation)}`);
    if (
      (input.operation === 'add' || input.operation === 'remove') &&
      (!input.names || input.names.length === 0)
    ) {
      errors.push(`operation=${input.operation} requires at least one name in names`);
    }
    for (const name of input.names ?? []) {
      if (typeof name !== 'string' || !name) {
        errors.push('names must contain only non-empty strings');
        break;
      }
    }
    return errors;
  },
  async execute(input, ctx, opts) {
    let final: LanguagePackageToolOutput | undefined;
    const stream = languagePackageTool.executeStream;
    if (!stream) throw new Error('languagePackageTool: stream execution unavailable');
    for await (const event of stream(input, ctx, opts)) {
      if (event.type === 'final') final = event.output;
    }
    if (!final) throw new Error('language_package: stream ended without final event');
    return final;
  },
  async *executeStream(
    input,
    ctx,
    opts,
  ): AsyncGenerator<ToolStreamEvent<LanguagePackageToolOutput>> {
    const cwd = input.cwd ? await safeResolveReal(input.cwd, ctx) : (ctx.workingDir ?? ctx.cwd);
    const signal = opts?.signal ?? ctx.signal ?? new AbortController().signal;
    const planOperation = OPERATION_TO_PLAN[input.operation];
    const operationOptions = {
      ...(input.names ? { packages: input.names } : {}),
      ...(input.scope ? { packageScope: input.scope } : {}),
      ...(input.allowScripts !== undefined ? { allowScripts: input.allowScripts } : {}),
    };
    const planResult = await planLanguageOperation({
      projectRoot: ctx.projectRoot,
      cwd,
      operation: planOperation,
      ...(input.language ? { language: input.language } : {}),
      ...(input.workspace ? { workspace: input.workspace } : {}),
      operationOptions,
      signal,
    });
    if (planResult.status !== 'planned') {
      const reason =
        planResult.status === 'unavailable' ? planResult.unavailable.reason : planResult.reason;
      yield {
        type: 'final',
        output: {
          status: 'unavailable',
          mutations: [],
          vulnerabilities: [],
          outdated: [],
          manifestsChanged: [],
          lockfilesChanged: [],
          output: reason,
          error: reason,
        },
      };
      return;
    }
    if (input.dryRun) {
      yield {
        type: 'final',
        output: {
          status: 'passed',
          language: planResult.workspace.language,
          workspace: planResult.workspace.root,
          operation: planResult.plan.operation,
          mutations: [],
          vulnerabilities: [],
          outdated: [],
          manifestsChanged: [],
          lockfilesChanged: [],
          output:
            `Dry run: ${planResult.plan.command ?? 'internal'} ${planResult.plan.args.join(' ')}`.trim(),
        },
      };
      return;
    }
    const runner = executePackagePlan({
      projectRoot: ctx.projectRoot,
      workspace: planResult.workspace,
      plan: planResult.plan,
      packages: input.names ?? [],
      signal,
    });
    let outcome: LanguagePackageOutcome | undefined;
    for (;;) {
      const next = await runner.next();
      if (next.done) {
        outcome = next.value;
        break;
      }
      yield next.value;
    }
    if (!outcome) {
      yield {
        type: 'final',
        output: {
          status: 'unavailable',
          mutations: [],
          vulnerabilities: [],
          outdated: [],
          manifestsChanged: [],
          lockfilesChanged: [],
          output: 'Language package plan produced no outcome.',
        },
      };
      return;
    }
    const final = aggregateOutcome(outcome);
    if (outcome.run?.plan.kind === 'process') {
      ctx.recordSideEffect?.({
        toolUseId: `language_package-${Date.now()}`,
        toolName: 'language_package',
        ts: new Date().toISOString(),
        input: {
          language: outcome.language,
          operation: outcome.operation,
          command: outcome.run.plan.command,
          args: outcome.run.plan.args,
          cwd: outcome.run.plan.cwd,
          dryRun: input.dryRun ?? false,
        },
        outcome: `${final.status}${outcome.run.exitCode === null ? '' : ` (exit ${outcome.run.exitCode})`}`,
        risk: 'package',
      });
    }
    yield { type: 'final', output: final };
  },
  serialize(output) {
    const lines = [
      `status=${output.status} operation=${output.operation ?? 'unknown'} mutations=${output.mutations.length} vulnerabilities=${output.vulnerabilities.length} outdated=${output.outdated.length}`,
      `manifestsChanged: ${output.manifestsChanged.join(', ') || '∅'}`,
      `lockfilesChanged: ${output.lockfilesChanged.join(', ') || '∅'}`,
    ];
    for (const mutation of output.mutations) {
      lines.push(`+ ${mutation.name}${mutation.resolved ? `@${mutation.resolved}` : ''}`);
    }
    for (const outdated of output.outdated) {
      lines.push(`= ${outdated.name}: ${outdated.previous ?? '?'} → ${outdated.resolved ?? '?'}`);
    }
    for (const vuln of output.vulnerabilities) {
      lines.push(`! ${vuln.package} (${vuln.severity}) ${vuln.advisory ?? ''}`);
    }
    if (output.output) lines.push(output.output);
    return lines.join('\n');
  },
};

function aggregateOutcome(outcome: LanguagePackageOutcome): LanguagePackageToolOutput {
  return {
    status: outcome.status,
    language: outcome.language,
    workspace: outcome.workspace.root,
    operation: outcome.operation,
    outcome,
    mutations: Object.freeze([...outcome.mutations]),
    vulnerabilities: Object.freeze([...outcome.vulnerabilities]),
    outdated: Object.freeze([...outcome.outdated]),
    manifestsChanged: [...outcome.manifestsChanged],
    lockfilesChanged: [...outcome.lockfilesChanged],
    output: outputSummary(outcome),
    ...(outcome.run?.output ? { error: undefined } : {}),
  };
}

function outputSummary(outcome: LanguagePackageOutcome): string {
  const lines = [
    `${outcome.operation} on ${outcome.workspace.root}: ${outcome.status}`,
    `manifestsChanged: ${outcome.manifestsChanged.join(', ') || '∅'}`,
    `lockfilesChanged: ${outcome.lockfilesChanged.join(', ') || '∅'}`,
  ];
  for (const mutation of outcome.mutations) {
    lines.push(`+ ${mutation.name}${mutation.resolved ? `@${mutation.resolved}` : ''}`);
  }
  for (const vuln of outcome.vulnerabilities) {
    lines.push(`! ${vuln.package} (${vuln.severity})${vuln.advisory ? ` ${vuln.advisory}` : ''}`);
  }
  for (const outdated of outcome.outdated) {
    lines.push(`= ${outdated.name}: ${outdated.previous ?? '?'} → ${outdated.resolved ?? '?'}`);
  }
  if (outcome.run?.output) lines.push(outcome.run.output);
  return lines.join('\n');
}
