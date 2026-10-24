import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  missingRequiredRuntimeTools,
  RUNTIME_CAPABILITY_MANIFEST,
  runtimeToolReferencesFromText,
} from '@wrongstack/contracts/types/runtime-capability-manifest';
import { describe, expect, it } from 'vitest';
import { stripFrontmatter } from '../../src/skills/frontmatter.js';

/**
 * Skill bodies are re-scanned for tool-shaped references when the prompt is
 * built: a backticked canonical tool name, or "use/run/call" followed by a
 * backticked name, counts as a required tool. A name that is no tool at all can
 * never be satisfied, so the skill silently vanishes from eager and compact
 * prompts — node-modern nearly shipped that way with "use `import`".
 *
 * Hand-off lists rot the same quietly: output-standards pointed at an
 * `architect` skill and auto-review at `shadow-agent`, neither of which ships.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const bundledDir = path.resolve(here, '..', '..', 'skills');
const everyTool = RUNTIME_CAPABILITY_MANIFEST.flatMap((capability) => [...capability.tools]);

async function bundledSkills(): Promise<Array<{ name: string; body: string }>> {
  const entries = await fs.readdir(bundledDir, { withFileTypes: true });
  const skills: Array<{ name: string; body: string }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const raw = await fs.readFile(path.join(bundledDir, entry.name, 'SKILL.md'), 'utf8');
      skills.push({ name: entry.name, body: stripFrontmatter(raw) });
    } catch {
      // A directory without SKILL.md is not a skill; the loader skips it too.
    }
  }
  return skills.sort((left, right) => left.name.localeCompare(right.name));
}

describe('bundled skill bodies', () => {
  it('reference only tools that exist', async () => {
    const problems: string[] = [];
    for (const skill of await bundledSkills()) {
      const missing = missingRequiredRuntimeTools(
        runtimeToolReferencesFromText(skill.body),
        everyTool,
      );
      if (missing.length > 0) problems.push(`${skill.name}: ${missing.join(', ')}`);
    }
    expect(problems, `\n${problems.join('\n')}\n`).toEqual([]);
  });

  it('hand off only to skills that ship', async () => {
    const skills = await bundledSkills();
    const names = new Set(skills.map((skill) => skill.name));
    const problems: string[] = [];
    for (const skill of skills) {
      const section =
        /^## (?:Skills in scope|Related skills)\s*$([\s\S]*?)(?=^## |(?![\s\S]))/im.exec(
          skill.body,
        );
      if (!section) continue;
      for (const match of (section[1] ?? '').matchAll(/^- `([a-z0-9-]+)`/gm)) {
        const target = match[1] ?? '';
        if (!names.has(target)) problems.push(`${skill.name} → ${target}`);
      }
    }
    expect(problems, `\n${problems.join('\n')}\n`).toEqual([]);
  });
});
