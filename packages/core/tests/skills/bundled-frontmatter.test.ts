import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseSkillFrontmatter } from '../../src/skills/frontmatter.js';

/**
 * The frontmatter parser is deliberately small: it understands `|` and `>`
 * block scalars, a fixed set of scalar keys, and a fixed set of list keys.
 * Everything else is silently ignored — which is the failure mode this guard
 * exists for. `wrongstack-kanban` shipped with `description: >-` and
 * `triggers:` (plural); the first parsed to the literal string `">-"` and the
 * second was dropped whole. Both loaded without error and both were wrong.
 *
 * These assertions run against every bundled skill so the next one cannot
 * repeat it.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const bundledDir = path.resolve(here, '..', '..', 'skills');

/** Leftovers a mis-parsed block scalar leaves in a scalar field. */
const BLOCK_SCALAR_ARTIFACTS = new Set(['|', '|-', '|+', '>', '>-', '>+']);

async function bundledSkillFiles(): Promise<Array<{ name: string; file: string }>> {
  const entries = await fs.readdir(bundledDir, { withFileTypes: true });
  const found: Array<{ name: string; file: string }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const file = path.join(bundledDir, entry.name, 'SKILL.md');
    try {
      await fs.stat(file);
      found.push({ name: entry.name, file });
    } catch {
      // A directory without SKILL.md is not a skill; the loader skips it too.
    }
  }
  return found.sort((left, right) => left.name.localeCompare(right.name));
}

describe('bundled skill frontmatter', () => {
  it('finds the bundled skills', async () => {
    const skills = await bundledSkillFiles();
    expect(skills.length).toBeGreaterThan(0);
    expect(skills.map((skill) => skill.name)).toContain('wrongstack-kanban');
  });

  it('parses every bundled SKILL.md into a usable manifest', async () => {
    const skills = await bundledSkillFiles();
    const problems: string[] = [];

    for (const skill of skills) {
      const raw = await fs.readFile(skill.file, 'utf8');
      const parsed = parseSkillFrontmatter(raw);

      if (!parsed.name?.trim()) {
        problems.push(`${skill.name}: missing "name"`);
      }

      const description = parsed.description?.trim() ?? '';
      if (!description) {
        problems.push(`${skill.name}: missing "description"`);
      } else if (BLOCK_SCALAR_ARTIFACTS.has(description)) {
        problems.push(
          `${skill.name}: "description" parsed to the block-scalar marker "${description}" — ` +
            'the parser only understands `|` and `>`, so `>-` / `|-` fall through to the scalar branch.',
        );
      }

      // Plural/unknown keys are dropped without a word. `trigger` is the
      // singular key the parser actually reads.
      for (const plural of ['triggers', 'required-capability', 'required-tool', 'allowed-tool']) {
        if (new RegExp(`^${plural}:`, 'm').test(frontmatterBlock(raw))) {
          problems.push(
            `${skill.name}: "${plural}:" is not a recognized key and is silently ignored`,
          );
        }
      }
    }

    expect(problems, `\n${problems.join('\n')}\n`).toEqual([]);
  });

  it('keeps wrongstack-kanban reachable outside the Director surface', async () => {
    const raw = await fs.readFile(path.join(bundledDir, 'wrongstack-kanban', 'SKILL.md'), 'utf8');
    const parsed = parseSkillFrontmatter(raw);

    // `kanban_queue` is registered only by the Director toolset and is stripped
    // from spawned subagents, so requiring it made the whole skill unloadable
    // everywhere else — including the surfaces the skill is actually about.
    expect(parsed.requiredTools ?? []).not.toContain('kanban_queue');
    expect(parsed.requiredTools ?? []).toContain('kanban');

    // The body is re-scanned for backticked tool names and gated the same way,
    // so naming an unavailable tool in backticks re-introduces the same block.
    expect(raw).not.toContain('`kanban_queue`');
  });
});

/** The frontmatter block only — body text must not be searched for key-like lines. */
function frontmatterBlock(raw: string): string {
  const normalized = raw.replace(/^﻿/, '');
  if (!normalized.startsWith('---')) return '';
  const end = normalized.indexOf('\n---', 3);
  return end === -1 ? '' : normalized.slice(normalized.indexOf('\n') + 1, end);
}
