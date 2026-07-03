import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { parseSkillFrontmatter } from '../../src/skills/frontmatter.js';
import {
  bodyLineAdvisory,
  extractSkillFromPrompt,
  generateSkillSkeleton,
  validateSkillNameAvailable,
  writeSkeletonSkill,
} from '../../src/skills/skill-generator.js';
import { WrongStackError } from '../../src/types/errors.js';

let tmpSeq = 0;
async function tmpDir(): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), `skill-gen-${tmpSeq++}-`));
  return d;
}

// ── validateSkillNameAvailable ────────────────────────────────────────────

describe('validateSkillNameAvailable', () => {
  it('passes a clean kebab-case name with no loader', async () => {
    const r = await validateSkillNameAvailable('my-cool-skill');
    expect(r.ok).toBe(true);
    expect(r.formatViolations).toEqual([]);
    expect(r.conflicts).toEqual([]);
  });

  it('reports format violations for non-kebab names', async () => {
    const r = await validateSkillNameAvailable('My_Skill');
    expect(r.ok).toBe(false);
    expect(r.formatViolations.length).toBeGreaterThan(0);
  });

  it('flags a collision with a same-layer skill', async () => {
    const loader = {
      listEntries: vi
        .fn()
        .mockResolvedValue([{ name: 'taken', source: 'project', trigger: 't', scope: [] }]),
    } as never;
    const r = await validateSkillNameAvailable('taken', loader);
    expect(r.ok).toBe(false);
    expect(r.conflicts).toHaveLength(1);
  });

  it('allows shadowing a foreign/bundled skill (intended override)', async () => {
    const loader = {
      listEntries: vi
        .fn()
        .mockResolvedValue([{ name: 'git-flow', source: 'bundled', trigger: 't', scope: [] }]),
    } as never;
    const r = await validateSkillNameAvailable('git-flow', loader);
    expect(r.ok).toBe(true);
    expect(r.conflicts).toHaveLength(1); // surfaced, but not blocking
  });

  it('rejects an empty name', async () => {
    const r = await validateSkillNameAvailable('');
    expect(r.ok).toBe(false);
  });
});

// ── generateSkillSkeleton ─────────────────────────────────────────────────

describe('generateSkillSkeleton', () => {
  it('produces frontmatter that round-trips through parseSkillFrontmatter', () => {
    const body = generateSkillSkeleton({
      name: 'my-skill',
      description: 'Use this skill when X.',
      triggerKeywords: ['foo', 'bar'],
    });
    const fm = parseSkillFrontmatter(body);
    expect(fm.name).toBe('my-skill');
    expect(fm.description).toContain('Use this skill when X.');
    expect(fm.description).toContain('Triggers: user says "foo", "bar"');
    expect(fm.version).toBe('1.0.0');
  });

  it('includes the standard sections', () => {
    const body = generateSkillSkeleton({ name: 'demo', description: 'd' });
    expect(body).toContain('## Overview');
    expect(body).toContain('## Rules');
    expect(body).toContain('## Patterns');
    expect(body).toContain('## Skills in scope');
  });

  it('omits the Triggers line when no keywords given', () => {
    const body = generateSkillSkeleton({ name: 'demo', description: 'd' });
    expect(body).not.toMatch(/Triggers:/);
  });

  it('throws on an invalid name', () => {
    expect(() => generateSkillSkeleton({ name: 'Bad_Name', description: 'd' })).toThrow(
      WrongStackError,
    );
  });

  it('honors a custom version', () => {
    const body = generateSkillSkeleton({ name: 'demo', description: 'd', version: '2.3.1' });
    expect(body).toContain('version: 2.3.1');
  });

  it('title-cases the name for the H1', () => {
    const body = generateSkillSkeleton({ name: 'react-testing', description: 'd' });
    expect(body).toContain('# React Testing');
  });
});

// ── extractSkillFromPrompt ────────────────────────────────────────────────

describe('extractSkillFromPrompt', () => {
  it('derives a kebab name from a markdown heading', () => {
    const draft = extractSkillFromPrompt('# React Component Generator\n\nBody here.');
    expect(draft.suggestedName).toBe('react-component-generator');
    expect(draft.description).toContain('React Component Generator');
  });

  it('falls back to the first line when there is no heading', () => {
    const draft = extractSkillFromPrompt('Docker Deployment Guide\n\nMore text.');
    expect(draft.suggestedName).toBe('docker-deployment-guide');
  });

  it('collects quoted tokens as trigger keywords', () => {
    const draft = extractSkillFromPrompt('# X\n\nUse when "deploy" or "ship".');
    expect(draft.triggerKeywords).toContain('deploy');
    expect(draft.triggerKeywords).toContain('ship');
  });

  it('returns empty fields for an empty prompt', () => {
    const draft = extractSkillFromPrompt('   ');
    expect(draft.suggestedName).toBe('');
    expect(draft.description).toBe('');
  });

  it('puts paragraphs after the first into body', () => {
    const draft = extractSkillFromPrompt('# Title\n\nFirst paragraph.\n\nSecond paragraph.');
    // paragraphs[0] = "# Title" → description; the rest → body.
    expect(draft.body).toContain('First paragraph.');
    expect(draft.body).toContain('Second paragraph.');
    expect(draft.description).toContain('Title');
  });
});

// ── writeSkeletonSkill ────────────────────────────────────────────────────

describe('writeSkeletonSkill', () => {
  it('writes <dir>/<name>/SKILL.md and returns the path', async () => {
    const dir = await tmpDir();
    const body = generateSkillSkeleton({ name: 'writable', description: 'd' });
    const written = await writeSkeletonSkill(dir, body);
    expect(written).toBe(path.join(dir, 'writable', 'SKILL.md'));
    const onDisk = await fs.readFile(written, 'utf8');
    expect(onDisk).toBe(body);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('refuses to overwrite an existing skill without --force', async () => {
    const dir = await tmpDir();
    const body = generateSkillSkeleton({ name: 'guard', description: 'd' });
    await writeSkeletonSkill(dir, body);
    await expect(writeSkeletonSkill(dir, body)).rejects.toBeInstanceOf(WrongStackError);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('overwrites when overwrite=true', async () => {
    const dir = await tmpDir();
    const body = generateSkillSkeleton({ name: 'overwrite-me', description: 'first' });
    await writeSkeletonSkill(dir, body);
    const body2 = generateSkillSkeleton({ name: 'overwrite-me', description: 'second' });
    await expect(writeSkeletonSkill(dir, body2, { overwrite: true })).resolves.toBeTruthy();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('throws when the body has no valid name', async () => {
    const dir = await tmpDir();
    await expect(writeSkeletonSkill(dir, '---\nname: Bad_Name\n---\n')).rejects.toBeInstanceOf(
      WrongStackError,
    );
    await fs.rm(dir, { recursive: true, force: true });
  });
});

// ── bodyLineAdvisory ──────────────────────────────────────────────────────

describe('bodyLineAdvisory', () => {
  it('reports under-limit bodies as not over', () => {
    const a = bodyLineAdvisory('one\ntwo\nthree');
    expect(a.lines).toBe(3);
    expect(a.over).toBe(false);
  });

  it('flags bodies over 500 lines', () => {
    const long = Array.from({ length: 501 }, () => 'x').join('\n');
    const a = bodyLineAdvisory(long);
    expect(a.over).toBe(true);
  });
});
