import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { builtinTools } from '../packages/tools/dist/builtin.js';
import { BUILTIN_TIER_COUNTS } from '../packages/tools/dist/tool-tier.js';
import {
  TOOL_TIER_COUNTS,
  type ToolCategory,
  toolCatalog,
} from '../website/src/data/runtime-catalog.ts';
import type { ToolDetail, ToolParamDetail } from '../website/src/data/tool-detail-types.ts';
import { toolDetails } from '../website/src/data/tool-details.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const write = process.argv.includes('--write');

type JsonSchema = {
  type?: string | string[];
  enum?: unknown[];
  oneOf?: JsonSchema[];
  anyOf?: JsonSchema[];
  items?: JsonSchema;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  description?: string;
};

function quoted(value: unknown): string {
  return typeof value === 'string' ? `'${value.replaceAll("'", "\\'")}'` : String(value);
}

function schemaType(schema: JsonSchema | undefined): string {
  if (!schema) return 'unknown';
  if (schema.enum?.length) return schema.enum.map(quoted).join(' | ');
  const alternatives = schema.oneOf ?? schema.anyOf;
  if (alternatives?.length) {
    return [...new Set(alternatives.map(schemaType))].join(' | ');
  }
  if (schema.type === 'array') {
    const itemType = schemaType(schema.items);
    return itemType.includes(' | ') ? `Array<${itemType}>` : `${itemType}[]`;
  }
  if (Array.isArray(schema.type)) return schema.type.join(' | ');
  return schema.type ?? 'unknown';
}

function paramsFromSchema(schema: JsonSchema): ToolParamDetail[] {
  const required = new Set(schema.required ?? []);
  return Object.entries(schema.properties ?? {}).map(([name, property]) => ({
    name,
    type: schemaType(property),
    ...(required.has(name) ? { required: true } : {}),
    ...(property.description ? { description: property.description } : {}),
  }));
}

function selectionList(value: string | string[] | undefined): string[] | undefined {
  if (!value) return undefined;
  return Array.isArray(value) ? value : [value];
}

const runtimeByName = new Map(builtinTools.map((tool) => [tool.name, tool]));
const websiteNames = new Set<string>();
const duplicateWebsiteNames = new Set<string>();
for (const tool of toolCatalog) {
  if (websiteNames.has(tool.name)) duplicateWebsiteNames.add(tool.name);
  websiteNames.add(tool.name);
}
const runtimeNames = new Set(builtinTools.map((tool) => tool.name));
/** Explicit categories for newly registered tools; generated output stays writer-owned. */
const newToolCategories: Readonly<Record<string, ToolCategory>> = {
  present_artifact: 'Work & state',
  'dead-code-fix': 'Discovery & index',
  'codebase-read-symbol': 'Discovery & index',
};
const newEntries = builtinTools
  .filter((tool) => !websiteNames.has(tool.name) && Object.hasOwn(newToolCategories, tool.name))
  .map((tool) => ({ name: tool.name, category: newToolCategories[tool.name]! }));
const missingCategories = builtinTools
  .filter((tool) => !websiteNames.has(tool.name) && !Object.hasOwn(newToolCategories, tool.name))
  .map((tool) => tool.name);
const removedRuntimeTools = toolCatalog
  .filter((tool) => !runtimeNames.has(tool.name))
  .map((tool) => tool.name);

if (duplicateWebsiteNames.size || missingCategories.length || removedRuntimeTools.length) {
  console.error(
    [
      duplicateWebsiteNames.size
        ? `Duplicate website tool names: ${[...duplicateWebsiteNames].join(', ')}`
        : '',
      missingCategories.length
        ? `Website tools missing a category: ${missingCategories.join(', ')}`
        : '',
      removedRuntimeTools.length
        ? `Website tools absent from runtime: ${removedRuntimeTools.join(', ')}`
        : '',
    ]
      .filter(Boolean)
      .join('\n'),
  );
  process.exitCode = 1;
} else {
  const expectedCatalog = [...toolCatalog, ...newEntries].map((entry) => {
    const runtime = runtimeByName.get(entry.name);
    if (!runtime) throw new Error(`Missing runtime tool ${entry.name}`);
    return {
      name: runtime.name,
      summary: runtime.description,
      permission: runtime.permission,
      mutating: runtime.mutating,
      category: entry.category,
    };
  });

  const expectedDetails = Object.fromEntries(
    expectedCatalog.map(({ name }) => {
      const runtime = runtimeByName.get(name);
      if (!runtime) throw new Error(`Missing runtime tool ${name}`);
      const current = toolDetails[name];
      const selection = runtime.selection as
        | { doNotUseWhen?: string | string[]; useInstead?: string | string[] }
        | undefined;
      const detail: ToolDetail = {
        longDescription: runtime.description,
        params: paramsFromSchema(runtime.inputSchema as JsonSchema),
        ...(selectionList(selection?.doNotUseWhen)
          ? { doNotUseWhen: selectionList(selection?.doNotUseWhen) }
          : {}),
        ...(selectionList(selection?.useInstead)
          ? { useInstead: selectionList(selection?.useInstead) }
          : {}),
        ...(current?.notes?.length ? { notes: current.notes } : {}),
      };
      return [name, detail];
    }),
  );

  const comparableDetails = Object.fromEntries(
    Object.entries(toolDetails).map(([name, detail]) => [
      name,
      {
        longDescription: detail.longDescription,
        params: detail.params,
        ...(detail.doNotUseWhen?.length ? { doNotUseWhen: detail.doNotUseWhen } : {}),
        ...(detail.useInstead?.length ? { useInstead: detail.useInstead } : {}),
        ...(detail.notes?.length ? { notes: detail.notes } : {}),
      },
    ]),
  );

  if (!write) {
    const catalogMatches = JSON.stringify(toolCatalog) === JSON.stringify(expectedCatalog);
    const detailsMatch = JSON.stringify(comparableDetails) === JSON.stringify(expectedDetails);
    const tierCountsMatch =
      JSON.stringify(TOOL_TIER_COUNTS) === JSON.stringify(BUILTIN_TIER_COUNTS);
    if (!catalogMatches || !detailsMatch || !tierCountsMatch) {
      const mismatches = [
        !catalogMatches ? 'Website tool catalog differs from the runtime registry.' : '',
        !detailsMatch ? 'Website tool details differ from runtime schemas.' : '',
        !tierCountsMatch
          ? `Website token-saving tier counts differ from the runtime. ` +
            `website: ${JSON.stringify(TOOL_TIER_COUNTS)}; ` +
            `runtime: ${JSON.stringify(BUILTIN_TIER_COUNTS)}.`
          : '',
        'Run `pnpm website:tools:write` to refresh the projections.',
      ].filter(Boolean);
      process.stderr.write(`${mismatches.join('\n')}\n`);
      process.exitCode = 1;
    } else {
      console.log(`Website tool catalog is current (${expectedCatalog.length} tools).`);
    }
  } else {
    const catalogPath = path.join(root, 'website/src/data/runtime-catalog.ts');
    const catalogSource = await readFile(catalogPath, 'utf8');
    const start = catalogSource.indexOf('export const toolCatalog = [');
    const endMarker = '] as const;';
    const end = catalogSource.indexOf(endMarker, start);
    if (start < 0 || end < 0) throw new Error('Could not locate toolCatalog in runtime-catalog.ts');
    const catalogBlock = `export const toolCatalog = ${JSON.stringify(expectedCatalog, null, 2)} as const;`;
    await writeFile(
      catalogPath,
      `${catalogSource.slice(0, start)}${catalogBlock}${catalogSource.slice(end + endMarker.length)}`,
    );

    // Tier counts are derived from BUILTIN_TIER_COUNTS, never retyped here.
    const afterCatalog = await readFile(catalogPath, 'utf8');
    const tierMarker = '// generated:tool-tier-counts';
    const tierStart = afterCatalog.indexOf(tierMarker);
    const tierEndMarker = '} as const;';
    const tierEnd = afterCatalog.indexOf(tierEndMarker, tierStart);
    if (tierStart < 0 || tierEnd < 0) {
      throw new Error('Could not locate TOOL_TIER_COUNTS in runtime-catalog.ts');
    }
    const tierBlock = `${tierMarker}\nexport const TOOL_TIER_COUNTS = ${JSON.stringify(
      BUILTIN_TIER_COUNTS,
      null,
      2,
    )} as const;`;
    await writeFile(
      catalogPath,
      `${afterCatalog.slice(0, tierStart)}${tierBlock}${afterCatalog.slice(tierEnd + tierEndMarker.length)}`,
    );

    const chunkSize = Math.ceil(expectedCatalog.length / 4);
    for (let index = 0; index < 4; index += 1) {
      const names = expectedCatalog
        .slice(index * chunkSize, (index + 1) * chunkSize)
        .map((entry) => entry.name);
      const entries = Object.fromEntries(names.map((name) => [name, expectedDetails[name]]));
      const part = index + 1;
      const source = `// Per-tool detail data for the built-in tool detail pages.\n// Generated by scripts/generate-website-tool-catalog.ts from @wrongstack/tools.\n// Run \`pnpm website:tools:write\` after changing a built-in tool contract.\n\nimport type { ToolDetail } from './tool-detail-types';\n\nexport const toolDetailsPart${part}: Record<string, ToolDetail> = ${JSON.stringify(entries, null, 2)};\n`;
      await writeFile(path.join(root, `website/src/data/tool-details-part-${part}.ts`), source);
    }
    console.log(`Updated website projections for ${expectedCatalog.length} tools.`);
  }
}
