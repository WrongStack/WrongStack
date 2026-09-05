import type { Tool } from '@wrongstack/core/types';
import { safeResolveReal } from '../_util.js';
import { detectLanguageWorkspaces } from './detect.js';
import { planLanguageOperation } from './plan.js';
import { languageProfileRegistry } from './registry.js';
import type { LanguageOperation, LanguageOperationOptions, LanguageProfileId } from './types.js';

export interface LanguageInfoInput {
  action: 'detect' | 'plan' | 'capabilities';
  cwd?: string | undefined;
  target?: string | undefined;
  language?: LanguageProfileId | undefined;
  workspace?: string | undefined;
  operation?: LanguageOperation | undefined;
  mode?: 'fast' | 'standard' | 'thorough' | undefined;
  options?: LanguageOperationOptions | undefined;
}

export interface LanguageCapabilitiesOutput {
  action: 'capabilities';
  profiles: Array<{
    id: LanguageProfileId;
    displayName: string;
    extensions: readonly string[];
    operations: string[];
    packageManagers: readonly string[];
  }>;
}

export type LanguageInfoOutput =
  | ({ action: 'detect' } & Awaited<ReturnType<typeof detectLanguageWorkspaces>>)
  | ({ action: 'plan' } & Awaited<ReturnType<typeof planLanguageOperation>>)
  | LanguageCapabilitiesOutput;

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

const OPERATIONS: LanguageOperation[] = [
  'syntax',
  'semantic',
  'lint',
  'format-check',
  'format-write',
  'test-compile',
  'test',
  'build',
  'run',
  'debug-compile',
  'debug-test',
  'debug-runtime',
  'debug-race',
  'package-install',
  'package-add',
  'package-remove',
  'package-update',
  'package-audit',
  'package-outdated',
];

export const languageInfoTool: Tool<LanguageInfoInput, LanguageInfoOutput> = {
  name: 'language_info',
  category: 'Code Quality',
  description:
    'Detect language workspaces and preview predefined language-specific command plans without executing them.',
  usageHint:
    'Use `detect` to find TypeScript/JavaScript, Go, Rust, PHP, and C# workspaces. ' +
    'Use `plan` to obtain an exact, validated argv plan before choosing an execution tool. ' +
    'This tool never spawns a process or modifies files.',
  selection: {
    doNotUseWhen: 'You need to execute a compiler, test runner, formatter, or package manager.',
    useInstead: ['exec', 'typecheck', 'lint', 'format', 'test', 'install'],
  },
  permission: 'auto',
  mutating: false,
  riskTier: 'safe',
  capabilities: ['fs.read'],
  icon: 'code',
  timeoutMs: 30_000,
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['detect', 'plan', 'capabilities'],
        description: 'Read-only action to perform.',
      },
      cwd: { type: 'string', description: 'Directory inside the project to inspect.' },
      target: { type: 'string', description: 'Optional target file used for workspace selection.' },
      language: {
        type: 'string',
        enum: LANGUAGE_IDS,
        description: 'Optional language profile filter.',
      },
      workspace: { type: 'string', description: 'Workspace id or root returned by detect.' },
      operation: {
        type: 'string',
        enum: OPERATIONS,
        description: 'Operation to preview when action=plan.',
      },
      mode: {
        type: 'string',
        enum: ['fast', 'standard', 'thorough'],
        description: 'Planning mode.',
      },
      options: {
        type: 'object',
        properties: {
          target: { type: 'string' },
          filter: { type: 'string' },
          coverage: { type: 'boolean' },
          noRun: { type: 'boolean' },
          packages: { type: 'array', items: { type: 'string' } },
          packageScope: { type: 'string', enum: ['runtime', 'development', 'optional'] },
          allowScripts: { type: 'boolean' },
        },
        additionalProperties: false,
      },
    },
    required: ['action'],
    additionalProperties: false,
  },
  validate(input) {
    const errors: string[] = [];
    if (input.action === 'plan' && !input.operation)
      errors.push('operation is required when action=plan');
    if (input.action !== 'plan' && input.operation)
      errors.push('operation is only valid when action=plan');
    if (input.action !== 'plan' && input.options)
      errors.push('options are only valid when action=plan');
    return errors;
  },
  async execute(input, ctx, opts) {
    if (input.action === 'capabilities') {
      return {
        action: 'capabilities',
        profiles: languageProfileRegistry.list().map((profile) => ({
          id: profile.id,
          displayName: profile.displayName,
          extensions: profile.extensions,
          operations: Object.keys(profile.operations).sort(),
          packageManagers: profile.packageManagers,
        })),
      };
    }
    const cwd = input.cwd ? await safeResolveReal(input.cwd, ctx) : (ctx.workingDir ?? ctx.cwd);
    const signal = opts?.signal ?? ctx.signal ?? new AbortController().signal;
    const common = {
      projectRoot: ctx.projectRoot,
      cwd,
      ...(input.target ? { target: input.target } : {}),
      ...(input.language ? { language: input.language } : {}),
      signal,
    };
    if (input.action === 'detect') {
      return { action: 'detect', ...(await detectLanguageWorkspaces(common)) };
    }
    const result = await planLanguageOperation({
      ...common,
      operation: input.operation!,
      ...(input.workspace ? { workspace: input.workspace } : {}),
      ...(input.mode ? { mode: input.mode } : {}),
      ...(input.options ? { operationOptions: input.options } : {}),
    });
    return { action: 'plan', ...result };
  },
};
