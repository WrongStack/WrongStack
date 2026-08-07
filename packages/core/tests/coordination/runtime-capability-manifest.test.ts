import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ALL_AGENT_DEFINITIONS,
  BUNDLED_AGENT_SKILLS,
  inferRuntimeCapabilities,
  isDeprecatedRuntimeToolAlias,
  isKnownRuntimeCapability,
  normalizeRuntimeToolName,
  RUNTIME_CAPABILITY_MANIFEST,
  runtimeCapabilityForTool,
  toolsForRuntimeCapabilities,
} from '../../src/coordination/agents/index.js';
import { parseSkillFrontmatter } from '../../src/skills/frontmatter.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..', '..');

async function skillFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(abs);
      else if (entry.name === 'SKILL.md') found.push(abs);
    }
  };
  await walk(root);
  return found;
}

async function typescriptSourceFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(abs);
      else if (/\.tsx?$/.test(entry.name)) found.push(abs);
    }
  };
  await walk(root);
  return found;
}

function regexEscape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

describe('runtime capability manifest', () => {
  it('has unique capability ids and tool ownership', () => {
    const ids = RUNTIME_CAPABILITY_MANIFEST.map((entry) => entry.id);
    const tools = RUNTIME_CAPABILITY_MANIFEST.flatMap((entry) => entry.tools);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(tools).size).toBe(tools.length);
  });

  it('maps every canonical tool name to a first-party implementation declaration', async () => {
    const packageRoot = path.join(repoRoot, 'packages');
    const files = await typescriptSourceFiles(packageRoot);
    const sources: Array<{ file: string; raw: string }> = [];
    const implementationFiles = files.filter((file) => !file.endsWith('capability-manifest.ts'));
    for (let offset = 0; offset < implementationFiles.length; offset += 32) {
      sources.push(
        ...(await Promise.all(
          implementationFiles.slice(offset, offset + 32).map(async (file) => ({
            file,
            raw: await fs.readFile(file, 'utf8'),
          })),
        )),
      );
    }
    for (const tool of RUNTIME_CAPABILITY_MANIFEST.flatMap((entry) => entry.tools)) {
      const escaped = regexEscape(tool);
      const declaration = new RegExp(
        `(?:\\bname\\s*:\\s*['"]${escaped}['"]|\\b[A-Z][A-Z0-9_]*(?:TOOL_NAME|_NAME)\\s*=\\s*['"]${escaped}['"]|\\(\\s*['"]${escaped}['"])`,
      );
      const owners = sources.filter(({ raw }) => declaration.test(raw)).map(({ file }) => file);
      expect(
        owners.length,
        `${tool} has no first-party implementation declaration`,
      ).toBeGreaterThan(0);
    }
  });

  it('normalizes legacy provider names without putting them in the roster', () => {
    expect(normalizeRuntimeToolName('playwright_navigate')).toBe('browser_navigate');
    expect(toolsForRuntimeCapabilities(['mcp.dynamic'])).toEqual(['mcp_use']);
  });

  it('keeps skill ids and provider-specific names out of roster tool slots', () => {
    const skillNames = new Set<string>(BUNDLED_AGENT_SKILLS);
    for (const definition of ALL_AGENT_DEFINITIONS) {
      const tools = definition.config.tools ?? [];
      for (const tool of tools) {
        expect(skillNames.has(tool), `${definition.config.role}: skill used as tool: ${tool}`).toBe(
          false,
        );
        expect(
          isDeprecatedRuntimeToolAlias(tool),
          `${definition.config.role}: provider-specific tool: ${tool}`,
        ).toBe(false);
        expect(
          runtimeCapabilityForTool(tool),
          `${definition.config.role}: tool has no capability owner: ${tool}`,
        ).toBeDefined();
      }
      expect(definition.config.capabilities).toEqual(inferRuntimeCapabilities(tools));
    }
  });

  it('keeps concrete tool calls in each maintained role prompt inside that role tool slice', async () => {
    const knownTools = new Set<string>(RUNTIME_CAPABILITY_MANIFEST.flatMap((entry) => entry.tools));
    const rolePromptLeaks: string[] = [];
    for (const definition of ALL_AGENT_DEFINITIONS) {
      const role = definition.config.role ?? '';
      const promptPath = path.join(
        repoRoot,
        'packages',
        'core',
        'instructions',
        'agents',
        `${role}.md`,
      );
      const prompt = await fs.readFile(promptPath, 'utf8').catch(() => '');
      const referenced = new Set<string>();
      for (const match of prompt.matchAll(/`([a-z][a-z0-9_-]+)`/gi)) {
        if (knownTools.has(match[1] ?? '')) referenced.add(match[1] ?? '');
      }
      for (const match of prompt.matchAll(/(?:live|use|call)\s+`([a-z][a-z0-9_-]+)`/gi)) {
        if (knownTools.has(match[1] ?? '')) referenced.add(match[1] ?? '');
      }
      for (const match of prompt.matchAll(/\b([a-z][a-z0-9_-]+)\s*\(/g)) {
        if (knownTools.has(match[1] ?? '')) referenced.add(match[1] ?? '');
      }
      const available = new Set(definition.config.tools ?? []);
      const missing = [...referenced].filter((tool) => !available.has(tool));
      for (const tool of missing) rolePromptLeaks.push(`${role}: ${tool}`);
    }
    expect(rolePromptLeaks, 'role prompts reference tools outside their assigned slice').toEqual(
      [],
    );
  });

  it('requires every maintained skill to declare only known runtime capabilities', async () => {
    const files = [
      ...(await skillFiles(path.join(repoRoot, 'packages', 'core', 'skills'))),
      ...(await skillFiles(path.join(repoRoot, '.wrongstack', 'skills'))),
    ];
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const raw = await fs.readFile(file, 'utf8');
      const fm = parseSkillFrontmatter(raw);
      expect(
        fm.requiredCapabilities,
        `${path.relative(repoRoot, file)} must declare required-capabilities`,
      ).toBeDefined();
      expect(
        fm.requiredTools,
        `${path.relative(repoRoot, file)} must declare required-tools`,
      ).toBeDefined();
      for (const id of [...(fm.requiredCapabilities ?? []), ...(fm.optionalCapabilities ?? [])]) {
        expect(isKnownRuntimeCapability(id), `${path.relative(repoRoot, file)}: ${id}`).toBe(true);
      }
      const knownTools = new Set<string>(
        RUNTIME_CAPABILITY_MANIFEST.flatMap((entry) => entry.tools),
      );
      const declaredToolReferences = [...raw.matchAll(/`([a-z][a-z0-9_-]+)`\s+tool\b/gi)].map(
        (match) => match[1] ?? '',
      );
      for (const tool of declaredToolReferences) {
        expect(
          knownTools.has(tool),
          `${path.relative(repoRoot, file)} calls unknown tool: ${tool}`,
        ).toBe(true);
      }
      const referencedTools = [
        ...new Set(
          [...raw.matchAll(/`([a-z][a-z0-9_-]+)`/gi)]
            .map((match) => normalizeRuntimeToolName(match[1] ?? ''))
            .filter((tool) => knownTools.has(tool)),
        ),
      ].sort();
      const requiredTools = [...new Set(fm.requiredTools ?? [])].sort();
      for (const tool of requiredTools) {
        expect(knownTools.has(tool), `${path.relative(repoRoot, file)}: unknown ${tool}`).toBe(
          true,
        );
      }
      expect(
        requiredTools,
        `${path.relative(repoRoot, file)} required-tools must exactly cover canonical tool references`,
      ).toEqual(referencedTools);
      const unknownImperativeReferences = [
        ...new Set(
          [...raw.matchAll(/\b(?:call|use|invoke|run)\s+`([a-z][a-z0-9_-]+)`/gi)]
            .map((match) => normalizeRuntimeToolName(match[1] ?? ''))
            .filter((tool) => !knownTools.has(tool)),
        ),
      ];
      expect(
        unknownImperativeReferences,
        `${path.relative(repoRoot, file)} has an ambiguous imperative tool reference`,
      ).toEqual([]);
      expect(raw).not.toMatch(/\b(?:playwright_|mcp__ssh__)/);
    }
  });
});
