/**
 * Tests for coordination/agents/project-agent-files.ts — project-level
 * agent customization file management (learned, identity, config, knowledge,
 * reset, refresh, list).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  listProjectAgentRoles,
  refreshProjectAgentIdentity,
  resetProjectAgentIdentity,
  updateProjectAgentConfig,
  updateProjectAgentIdentity,
  updateProjectAgentKnowledge,
  updateProjectAgentLearned,
} from '../../src/coordination/agents/project-agent-files.js';

let tempRoot: string;

beforeAll(() => {
  tempRoot = path.join(os.tmpdir(), `wstack-agent-files-test-${Date.now()}`);
  fs.mkdirSync(tempRoot, { recursive: true });
});

afterAll(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

function freshProject(): string {
  const dir = path.join(tempRoot, `proj-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

describe('updateProjectAgentLearned', () => {
  it('creates learned.md with content', () => {
    const proj = freshProject();
    const filePath = updateProjectAgentLearned('bug-hunter', '# Lessons\n\nBe careful.', proj);
    expect(fs.existsSync(filePath)).toBe(true);
    expect(fs.readFileSync(filePath, 'utf8')).toContain('Be careful.');
  });

  it('appends to existing learned.md by default', () => {
    const proj = freshProject();
    updateProjectAgentLearned('bug-hunter', 'First entry', proj);
    updateProjectAgentLearned('bug-hunter', 'Second entry', proj);
    const dir = path.join(proj, '.wrongstack', 'agents', 'bug-hunter');
    const content = fs.readFileSync(path.join(dir, 'learned.md'), 'utf8');
    expect(content).toContain('First entry');
    expect(content).toContain('Second entry');
    expect(content).toContain('---');
  });

  it('replaces content in replace mode', () => {
    const proj = freshProject();
    updateProjectAgentLearned('bug-hunter', 'Old content', proj);
    updateProjectAgentLearned('bug-hunter', 'New content', proj, 'replace');
    const dir = path.join(proj, '.wrongstack', 'agents', 'bug-hunter');
    const content = fs.readFileSync(path.join(dir, 'learned.md'), 'utf8');
    expect(content).toContain('New content');
    expect(content).not.toContain('Old content');
  });
});

describe('updateProjectAgentIdentity', () => {
  it('creates identity.md', () => {
    const proj = freshProject();
    const filePath = updateProjectAgentIdentity('critic', '# Identity\n\nBe critical.', proj);
    expect(fs.existsSync(filePath)).toBe(true);
    expect(fs.readFileSync(filePath, 'utf8')).toContain('Be critical.');
  });

  it('replaces existing identity.md', () => {
    const proj = freshProject();
    updateProjectAgentIdentity('critic', 'Old identity', proj);
    updateProjectAgentIdentity('critic', 'New identity', proj);
    const dir = path.join(proj, '.wrongstack', 'agents', 'critic');
    const content = fs.readFileSync(path.join(dir, 'identity.md'), 'utf8');
    expect(content).toContain('New identity');
    expect(content).not.toContain('Old identity');
  });
});

describe('updateProjectAgentConfig', () => {
  it('creates config.json with validated config', () => {
    const proj = freshProject();
    const filePath = updateProjectAgentConfig('bug-hunter', { model: 'gpt-4o' }, proj);
    expect(fs.existsSync(filePath)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    expect(parsed.model).toBe('gpt-4o');
  });
});

describe('updateProjectAgentKnowledge', () => {
  it('creates knowledge.json', () => {
    const proj = freshProject();
    const manifest = { version: 1, entries: [] };
    const filePath = updateProjectAgentKnowledge('bug-hunter', manifest as never, proj);
    expect(fs.existsSync(filePath)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    expect(parsed.version).toBe(1);
  });
});

describe('resetProjectAgentIdentity', () => {
  it('removes a specific role directory', () => {
    const proj = freshProject();
    updateProjectAgentLearned('bug-hunter', 'content', proj);
    const dir = path.join(proj, '.wrongstack', 'agents', 'bug-hunter');
    expect(fs.existsSync(dir)).toBe(true);
    const removed = resetProjectAgentIdentity('bug-hunter', proj);
    expect(removed).toHaveLength(1);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('removes all roles with wildcard', () => {
    const proj = freshProject();
    updateProjectAgentLearned('bug-hunter', 'content', proj);
    updateProjectAgentLearned('critic', 'content', proj);
    const removed = resetProjectAgentIdentity('*', proj);
    expect(removed).toHaveLength(1);
    expect(fs.existsSync(path.join(proj, '.wrongstack', 'agents'))).toBe(false);
  });

  it('returns empty array when nothing to remove', () => {
    const proj = freshProject();
    const removed = resetProjectAgentIdentity('nonexistent', proj);
    expect(removed).toHaveLength(0);
  });
});

describe('refreshProjectAgentIdentity', () => {
  it('resets and re-scaffolds identity files', () => {
    const proj = freshProject();
    updateProjectAgentLearned('bug-hunter', 'old learned content', proj);
    updateProjectAgentIdentity('bug-hunter', 'old identity', proj);
    const result = refreshProjectAgentIdentity('bug-hunter', proj);
    expect(result).toContain('refreshed');
    const dir = path.join(proj, '.wrongstack', 'agents', 'bug-hunter');
    const learned = fs.readFileSync(path.join(dir, 'learned.md'), 'utf8');
    expect(learned).not.toContain('old learned content');
    const identity = fs.readFileSync(path.join(dir, 'identity.md'), 'utf8');
    expect(identity).toContain('bug-hunter');
    expect(identity).not.toContain('old identity');
  });
});

describe('listProjectAgentRoles', () => {
  it('lists roles with customization files', () => {
    const proj = freshProject();
    updateProjectAgentLearned('bug-hunter', 'content', proj);
    updateProjectAgentIdentity('critic', 'content', proj);
    const roles = listProjectAgentRoles(proj);
    expect(roles).toContain('bug-hunter');
    expect(roles).toContain('critic');
  });

  it('returns empty array when no agents dir', () => {
    const proj = freshProject();
    const roles = listProjectAgentRoles(proj);
    expect(roles).toEqual([]);
  });

  it('skips directories without recognized files', () => {
    const proj = freshProject();
    const dir = path.join(proj, '.wrongstack', 'agents', 'empty-role');
    fs.mkdirSync(dir, { recursive: true });
    const roles = listProjectAgentRoles(proj);
    expect(roles).not.toContain('empty-role');
  });
});
