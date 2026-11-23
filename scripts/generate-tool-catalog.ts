import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { LEAN_BENCH_TOOL_NAMES } from '../packages/bench/src/isolation.ts';
import { browserTools, liveBrowser } from '../packages/browser-tools/dist/index.js';
import { providerToolSurfaceForVariant } from '../packages/core/dist/core/index.js';
import { ToolRegistry } from '../packages/core/dist/registry/index.js';
import {
  compactToolDefinitionForWire,
  measureToolSchemas,
} from '../packages/core/dist/utils/index.js';
import {
  browserTools as compatibilityBrowserTools,
  liveBrowser as compatibilityLiveBrowser,
} from '../packages/tools/dist/browser/index.js';
import { builtinTools } from '../packages/tools/dist/builtin.js';
import { createBuiltinToolCatalog } from '../packages/tools/dist/tool-catalog.js';
import { selectBuiltinToolsForTier } from '../packages/tools/dist/tool-tier.js';

const root = new URL('../', import.meta.url);
const write = process.argv.includes('--write');
const adoptBudget = process.argv.includes('--adopt-budget');
const catalog = createBuiltinToolCatalog();
// Existing long descriptions are bounded exceptions, never a global relaxed cap.
const longDescriptions: Record<string, { max: number; reason: string }> = {
  tool_script: { max: 634, reason: 'Composition, permission and output boundaries.' },
  'codebase-repo-map': { max: 325, reason: 'Output scope and token limit.' },
  'codebase-context': { max: 304, reason: 'Graph search selection boundary.' },
  design_reference: { max: 518, reason: 'Reference extraction, comparison and inspection modes.' },
};
const problems: string[] = [];
if (browserTools !== compatibilityBrowserTools || liveBrowser !== compatibilityLiveBrowser) {
  problems.push('The browser compatibility entry must share the Browser package suite and state.');
}
for (const tool of catalog.tools) {
  problems.push(...tool.issues.map((issue) => `${tool.name}: ${issue}`));
  const max = longDescriptions[tool.name]?.max ?? 300;
  if (tool.description.length > max)
    problems.push(`${tool.name}: description exceeds ${max} characters`);
  if (/\(e\.g\.\s*$/i.test(tool.description))
    problems.push(`${tool.name}: dangling example fragment`);
  if ((tool.permission === 'confirm' || tool.mutating) && !tool.usageHint?.trim())
    problems.push(`${tool.name}: MISSING_USAGE_HINT`);
  if (tool.icon === 'fallback') problems.push(`${tool.name}: MISSING_ICON`);
}
if (problems.length) throw new Error(problems.join('\n'));

const tiers = ['off', 'minimal', 'light', 'medium', 'aggressive'] as const;
const measurements = Object.fromEntries(
  tiers.map((tier) => [tier, measureToolSchemas(selectBuiltinToolsForTier(tier, builtinTools))]),
);
const lean = LEAN_BENCH_TOOL_NAMES;
measurements['lean'] = measureToolSchemas(builtinTools.filter((tool) => lean.includes(tool.name)));
const registry = new ToolRegistry();
registry.registerAllOrThrow(builtinTools, 'builtin');
const mediumNames = selectBuiltinToolsForTier('medium', builtinTools).map((tool) => tool.name);
registry.setProviderToolNames(mediumNames, 'medium');
const { tools: mediumV1 } = providerToolSurfaceForVariant(registry, 'pro', undefined, undefined, {
  providerToolSchemaVersion: 1,
});
measurements['mediumV1'] = measureToolSchemas(mediumV1);
const quickProfiles = {
  quickLegacy: undefined,
  quickV1: { quickToolSchemaVersion: 1 },
  quickBash: { quickToolSchemaVersion: 2, quickShellTool: 'bash' },
  quickPwsh: { quickToolSchemaVersion: 2, quickShellTool: 'pwsh' },
} as const;
const quickFingerprints = Object.fromEntries(
  Object.entries(quickProfiles).map(([profile, session]) => {
    const { tools } = providerToolSurfaceForVariant(
      registry,
      'quick',
      undefined,
      undefined,
      session,
    );
    measurements[profile] = measureToolSchemas(tools);
    return [
      profile,
      {
        declarations: sha256(tools.map((tool) => compactToolDefinitionForWire(tool))),
        usageHints: sha256(tools.map((tool) => tool.usageHint ?? '')),
      },
    ] as const;
  }),
);

function sha256(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

const budgetUrl = new URL('architecture/tool-schema-budget.json', root);
if (adoptBudget) {
  if (!write) throw new Error('--adopt-budget requires --write');
  await writeFile(
    budgetUrl,
    `${JSON.stringify({ schemaVersion: 1, scope: 'Built-in schemas using the shared provider-wire projection; Quick also fingerprints direct usage hints. Excludes provider-specific wrappers and host additions.', estimator: 'runtime heuristic, not billed tokens', profiles: measurements, quickFingerprints }, null, 2)}\n`,
  );
}
const budget = JSON.parse(await readFile(budgetUrl, 'utf8'));
for (const [profile, fingerprints] of Object.entries(quickFingerprints)) {
  for (const field of ['declarations', 'usageHints'] as const) {
    if (budget.quickFingerprints?.[profile]?.[field] !== fingerprints[field]) {
      problems.push(
        `${profile}.${field}: Quick cache prefix input changed (SHA-256 ${fingerprints[field]}). Preserve the existing projection or review a new session version before adopting the fingerprint.`,
      );
    }
  }
}
for (const [profile, measured] of Object.entries(measurements)) {
  for (const metric of ['count', 'wireBytes', 'estimatedTokens'] as const) {
    const limit = budget.profiles?.[profile]?.[metric];
    if (typeof limit !== 'number' || measured[metric] > limit)
      problems.push(
        `${profile}.${metric}: ${measured[metric]} exceeds budget ${limit ?? 'missing'}`,
      );
  }
}

const coverage = {
  descriptions: catalog.tools.filter((tool) => tool.description.trim()).length,
  icons: catalog.tools.filter((tool) => tool.icon !== 'fallback').length,
  selection: catalog.tools.filter((tool) => tool.selection).length,
  outputSchemas: catalog.tools.filter((tool) => tool.outputSchema).length,
  usageHints: catalog.tools.filter((tool) => tool.usageHint).length,
};
const artifact = { ...catalog, coverage, schemaMeasurements: measurements };
const reference = [
  '# Built-in tool reference',
  '',
  'Generated by `bun run tools:catalog:write`. Do not edit this file by hand.',
  '',
  `Scope: ${catalog.tools.length} built-in tools. A running host may register more plugin, memory, coordination or MCP tools. Export its current registry with \`wstack tools catalog --json\`. Metadata does not grant execution permission.`,
  '',
  ...catalog.tools.flatMap((tool) => [
    `## ${tool.name}`,
    '',
    tool.description,
    '',
    `Permission: \`${tool.permission}\`; mutating: \`${tool.mutating}\`; icon: \`${tool.icon}\`; color: \`${tool.color}\`.`,
    '',
    ...(tool.aliases?.length
      ? [`Aliases: ${tool.aliases.map((name) => `\`${name}\``).join(', ')}.`, '']
      : []),
    ...(tool.usageHint ? ['### Usage', '', tool.usageHint, ''] : []),
    ...(tool.selection
      ? [
          '### Selection',
          '',
          tool.selection.doNotUseWhen,
          '',
          ...(tool.selection.useInstead?.length
            ? [`Prefer: ${tool.selection.useInstead.join(', ')}.`, '']
            : []),
        ]
      : []),
    '### Input schema',
    '',
    '```json',
    JSON.stringify(tool.inputSchema, null, 2),
    '```',
    '',
    ...(tool.outputSchema
      ? ['### Output schema', '', '```json', JSON.stringify(tool.outputSchema, null, 2), '```', '']
      : []),
  ]),
].join('\n');

for (const [relative, expected] of [
  ['architecture/tool-catalog.json', `${JSON.stringify(artifact, null, 2)}\n`],
  ['docs/tool-reference.md', reference],
] as const) {
  const target = new URL(relative, root);
  if (write) await writeFile(target, expected);
  else {
    const actual = await readFile(target, 'utf8').catch(() => '');
    const matches =
      relative.endsWith('.json') && actual
        ? JSON.stringify(JSON.parse(actual)) === JSON.stringify(JSON.parse(expected))
        : actual.replaceAll('\r\n', '\n') === expected;
    if (!matches) problems.push(`${relative} is stale; run bun run tools:catalog:write`);
  }
}
if (problems.length) throw new Error(problems.join('\n'));
console.log(
  `Tool catalog: ${catalog.tools.length} built-ins; ${coverage.icons} icons; ${coverage.selection} selection contracts. Schema budgets passed (${Object.keys(measurements).join(', ')}). Root: ${fileURLToPath(root)}`,
);
