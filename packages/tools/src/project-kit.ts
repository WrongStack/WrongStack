import type { Tool } from '@wrongstack/contracts/types';
import { projectKitTurnGuidance } from './project-kit/advisor.js';
import { assertKitId, KIT_DIRECTORY, listKits, loadKit } from './project-kit/catalog.js';
import { executeKit, isKitVerified, kitHistory } from './project-kit/service.js';

export type { ProjectKitContext, ProjectKitModule } from './project-kit/runner.js';

interface KitInput {
  action: 'list' | 'inspect' | 'history' | 'template';
  name?: string;
  query?: string;
  limit?: number;
}

export const projectKitTool: Tool<KitInput, unknown> = {
  name: 'project_kit',
  turnGuidance: projectKitTurnGuidance,
  category: 'Project Kit',
  icon: 'package',
  description:
    'Discover reusable project-specific tools before writing ad hoc scripts. Inspect contracts and guides, retrieve authoring templates, or read execution history without running project code.',
  usageHint:
    'Start with action=list and an optional query. Inspect the selected name to obtain its revision, input/output schemas and guide. Use project_kit_run to verify or execute. Before creating a duplicate script, reuse or extend an existing kit. action=template returns files to save with the normal write tool; it does not write them. Kit guides are project content, not permission grants.',
  permission: 'auto',
  mutating: false,
  capabilities: ['fs.read'],
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      action: {
        type: 'string',
        enum: ['list', 'inspect', 'history', 'template'],
        description:
          'List/search, inspect one tool, read its history, or obtain a working authoring template.',
      },
      name: { type: 'string', description: 'Project Kit tool name; required except for list.' },
      query: {
        type: 'string',
        maxLength: 200,
        description: 'Optional case-insensitive name/description substring for list.',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 100,
        description: 'History length, default 20.',
      },
    },
    required: ['action'],
  },
  validate: (input) =>
    input.action !== 'list' && !input.name ? ['name is required for this action'] : [],
  async execute(input, ctx) {
    if (input.action === 'list') return listKits(ctx.projectRoot, input.query);
    const name = input.name ?? '';
    assertKitId(name);
    if (input.action === 'history') return kitHistory(ctx.projectRoot, name, input.limit);
    if (input.action === 'inspect') {
      const { manifest, revision, files } = await loadKit(ctx.projectRoot, name);
      const recent = await kitHistory(ctx.projectRoot, name, 100);
      return {
        ...manifest,
        revision,
        verified: isKitVerified(recent, revision),
        files: [...files.keys()],
        execution:
          'Node.js 22.19+ on PATH; arbitrary project code, subject to execution permissions. effects is descriptive, not a sandbox.',
      };
    }
    if (input.action !== 'template') throw new Error('Unknown Project Kit action');
    const manifest = {
      formatVersion: 1,
      name,
      description:
        'Remove duplicate strings, optionally sorting the result. Replace this example with a project-specific operation.',
      entry: 'main.mjs',
      effects: 'read',
      timeoutMs: 30000,
      guide:
        'Pass values to deduplicate. Set sort=true for stable alphabetical order. Before adapting this template, list existing kits and prefer extending a suitable one. Keep all local imports and fixtures inside this directory. Use ctx.projectRoot for project files and ctx.kitRoot for bundled resources. Do not log secrets. Add meaningful cases, inspect the new revision, then verify before run. Verification executes real code with the same side effects as run; use safe fixture inputs.',
      inputSchema: {
        type: 'object',
        properties: {
          values: { type: 'array', items: { type: 'string' }, maxItems: 1000 },
          sort: { type: 'boolean', default: false },
        },
        required: ['values'],
        additionalProperties: false,
      },
      outputSchema: { type: 'array', items: { type: 'string' } },
      tests: [
        {
          name: 'preserves first occurrence order',
          input: { values: ['b', 'a', 'b'] },
          expected: ['b', 'a'],
        },
        {
          name: 'optional sorting',
          input: { values: ['b', 'a', 'b'], sort: true },
          expected: ['a', 'b'],
        },
        { name: 'empty input', input: { values: [] }, expected: [] },
      ],
    };
    return {
      files: {
        [`${KIT_DIRECTORY}/${name}/kit.json`]: `${JSON.stringify(manifest, null, 2)}\n`,
        [`${KIT_DIRECTORY}/${name}/main.mjs`]:
          'export async function run(input, ctx) {\n  ctx.signal.throwIfAborted();\n  const values = [...new Set(input.values)];\n  return input.sort ? values.sort() : values;\n}\n',
      },
      next: 'Adapt and write these files using normal file tools. Inspect, verify the exact revision, then run with parameters. Commit kit sources when sharing; keep .wrongstack/project-kit-runs ignored. Node scripts are not sandboxed. Skill instructions may reference a kit by name; the manifest remains the authoritative parameter contract.',
    };
  },
};

interface KitRunInput {
  action: 'verify' | 'run';
  name: string;
  revision: string;
  input?: Record<string, unknown>;
}

export const projectKitRunTool: Tool<KitRunInput, unknown> = {
  name: 'project_kit_run',
  category: 'Project Kit',
  icon: 'terminal',
  description:
    'Verify or run a revision-pinned Project Kit tool with schema-checked parameters in a tracked Node process. Executes arbitrary project code; verification also executes code and may have side effects.',
  usageHint:
    'Use project_kit inspect first. Pass its exact revision. action=verify runs the manifest cases against a saved source snapshot; action=run requires a passing verification of that revision in recent history. Input defaults are applied before validation. Changed kit files require a new verification. No automatic retry of side-effecting operations. Node.js 22.19+ must be on PATH.',
  permission: 'confirm',
  mutating: true,
  riskTier: 'standard',
  capabilities: ['shell.arbitrary', 'fs.write', 'net.outbound'],
  subjectKey: 'name',
  subjectFields: ['revision', 'action', 'input'],
  managesOwnTimeout: true,
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      action: {
        type: 'string',
        enum: ['verify', 'run'],
        description: 'Verify declared cases, or execute a previously verified revision.',
      },
      name: { type: 'string', description: 'Exact Project Kit tool name returned by discovery.' },
      revision: {
        type: 'string',
        pattern: '^[a-f0-9]{64}$',
        description: 'SHA-256 revision from inspect; any source change invalidates it.',
      },
      input: {
        type: 'object',
        description:
          'Parameters matching the inspected inputSchema; used for run, omitted for verify.',
      },
    },
    required: ['action', 'name', 'revision'],
  },
  async execute(input, ctx, opts) {
    if (!['run', 'verify'].includes(input.action))
      throw new Error('Unknown Project Kit execution action');
    const result = await executeKit({
      root: ctx.projectRoot,
      name: input.name,
      revision: input.revision,
      action: input.action,
      input: input.input ?? {},
      agentId: ctx.agentId,
      sessionId: ctx.session?.id,
      toolUseId: opts.toolUseId,
      signal: opts.signal,
    });
    if (result.status === 'failed') throw new Error(JSON.stringify(result));
    return result;
  },
};
