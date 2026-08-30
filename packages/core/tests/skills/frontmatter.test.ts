import { describe, expect, it } from 'vitest';
import {
  isValidSkillNameFormat,
  parseSkillFrontmatter,
  stripFrontmatter,
  validateSkillName,
} from '../../src/skills/frontmatter.js';

describe('parseSkillFrontmatter', () => {
  it('parses scalar fields + a block-scalar description', () => {
    const raw = `---
name: docker-deploy
description: |
  Use this skill when deploying Docker.
  Triggers: user says "docker".
version: 1.2.0
license: MIT
compatibility: Requires Docker 24+
---
body`;
    const fm = parseSkillFrontmatter(raw);
    expect(fm.name).toBe('docker-deploy');
    expect(fm.description).toBe(
      'Use this skill when deploying Docker.\nTriggers: user says "docker".',
    );
    expect(fm.version).toBe('1.2.0');
    expect(fm.license).toBe('MIT');
    expect(fm.compatibility).toBe('Requires Docker 24+');
  });

  it('parses a metadata map', () => {
    const fm = parseSkillFrontmatter(`---
name: x
description: d
metadata:
  author: jane
  tier: 2
---
b`);
    expect(fm.metadata).toEqual({ author: 'jane', tier: '2' });
  });

  it('parses allowed-tools into an array', () => {
    const fm = parseSkillFrontmatter(`---
name: x
description: d
allowed-tools: Bash Edit Read
---
b`);
    expect(fm.allowedTools).toEqual(['Bash', 'Edit', 'Read']);
  });

  it('parses required and optional runtime capabilities', () => {
    const fm = parseSkillFrontmatter(`---
name: x
description: d
required-capabilities: [filesystem.read, code.inspect]
required-tools: [read, codebase-search]
optional-capabilities: browser.interact mcp.dynamic
---
b`);
    expect(fm.requiredCapabilities).toEqual(['filesystem.read', 'code.inspect']);
    expect(fm.requiredTools).toEqual(['read', 'codebase-search']);
    expect(fm.optionalCapabilities).toEqual(['browser.interact', 'mcp.dynamic']);
  });

  it('parses multi-line bullet list arrays for capabilities and tools', () => {
    const fm = parseSkillFrontmatter(`---
name: x
description: d
required-capabilities:
  - "filesystem.read"
  - code.inspect
required-tools:
  - read
  - codebase-search
---
b`);
    expect(fm.requiredCapabilities).toEqual(['filesystem.read', 'code.inspect']);
    expect(fm.requiredTools).toEqual(['read', 'codebase-search']);
  });

  it('returns {} for missing or unclosed frontmatter', () => {
    expect(parseSkillFrontmatter('no frontmatter here')).toEqual({});
    expect(parseSkillFrontmatter('---\nname: x\nnever closes')).toEqual({});
  });

  it('parses CRLF line endings (Windows-authored skills)', () => {
    const raw =
      '---\r\nname: docker-deploy\r\ndescription: Deploy docker.\r\nlicense: MIT\r\n---\r\nbody\r\n';
    const fm = parseSkillFrontmatter(raw);
    expect(fm.name).toBe('docker-deploy');
    expect(fm.description).toBe('Deploy docker.');
    expect(fm.license).toBe('MIT');
  });

  it('strips surrounding quotes from scalar values (YAML quoted strings)', () => {
    const fm = parseSkillFrontmatter(
      '---\nname: "ghost-scan-secrets"\ndescription: \'a skill\'\nlicense: "MIT"\n---\nbody',
    );
    expect(fm.name).toBe('ghost-scan-secrets');
    expect(fm.description).toBe('a skill');
    expect(fm.license).toBe('MIT');
  });

  it('tolerates comma-separated allowed-tools', () => {
    const fm = parseSkillFrontmatter(
      '---\nname: x\ndescription: d\nallowed-tools: Read, Glob, Grep\n---\nb',
    );
    expect(fm.allowedTools).toEqual(['Read', 'Glob', 'Grep']);
  });

  it('parses an optional explicit trigger field (single-line and block scalar)', () => {
    const single = parseSkillFrontmatter(
      '---\nname: x\ndescription: d\ntrigger: Use when scanning for bugs\n---\nb',
    );
    expect(single.trigger).toBe('Use when scanning for bugs');
    const block = parseSkillFrontmatter(
      '---\nname: x\ndescription: d\ntrigger: |\n  Use when deploying.\n  Triggers: "docker".\n---\nb',
    );
    expect(block.trigger).toBe('Use when deploying.\nTriggers: "docker".');
    // Absent when not declared.
    expect(parseSkillFrontmatter('---\nname: x\ndescription: d\n---\nb').trigger).toBeUndefined();
  });
});

describe('validateSkillName / isValidSkillNameFormat', () => {
  it('accepts spec-compliant names', () => {
    expect(isValidSkillNameFormat('docker-deploy')).toBe(true);
    expect(isValidSkillNameFormat('a')).toBe(true);
    expect(isValidSkillNameFormat('skill-123-abc')).toBe(true);
  });

  it('rejects non-compliant names', () => {
    expect(isValidSkillNameFormat('MySkill')).toBe(false);
    expect(isValidSkillNameFormat('-leading')).toBe(false);
    expect(isValidSkillNameFormat('trailing-')).toBe(false);
    expect(isValidSkillNameFormat('double--hyphen')).toBe(false);
    expect(isValidSkillNameFormat('under_score')).toBe(false);
    expect(isValidSkillNameFormat('a'.repeat(65))).toBe(false);
  });

  it('reports a parent-directory mismatch', () => {
    expect(validateSkillName('docker-deploy', 'docker-deploy')).toEqual([]);
    expect(validateSkillName('foo', 'bar').some((e) => e.includes('parent directory'))).toBe(true);
  });
});

describe('stripFrontmatter (canonical implementation)', () => {
  it('removes a leading frontmatter block and returns the body', () => {
    expect(stripFrontmatter('---\nname: x\ndescription: d\n---\nbody text')).toBe('body text');
  });

  it('returns input unchanged when there is no frontmatter', () => {
    expect(stripFrontmatter('# just a body\nline')).toBe('# just a body\nline');
  });

  it('returns input unchanged when the frontmatter is unclosed', () => {
    expect(stripFrontmatter('---\nname: x\nnever closes')).toBe('---\nname: x\nnever closes');
  });

  it('normalizes CRLF so the body has no stray carriage returns', () => {
    expect(stripFrontmatter('---\r\nname: x\r\ndescription: d\r\n---\r\nbody\r\n')).toBe('body\n');
  });

  it('preserves --- lines that appear inside the body after the frontmatter', () => {
    expect(stripFrontmatter('---\nname: x\ndescription: d\n---\nbody\n---\nmore')).toBe(
      'body\n---\nmore',
    );
  });
});
