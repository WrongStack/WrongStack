import * as testNodeFs from 'node:fs';
/**
 * Tests for coordination/agents/project-agent-files.ts — project-level
 * agent customization file management (learned, identity, config, knowledge,
 * reset, refresh, list).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { captureLearnedFromAgentOutputDetailed } from '../../src/coordination/agents/project-agent-capture.js';
import {
  readRawLearnedEntries,
  saveProjectAgentConsolidated,
} from '../../src/coordination/agents/project-agent-consolidation.js';
import {
  listProjectAgentRoles,
  refreshProjectAgentIdentity,
  resetProjectAgentIdentity,
  updateProjectAgentConfig,
  updateProjectAgentIdentity,
  updateProjectAgentKnowledge,
  updateProjectAgentLearned,
} from '../../src/coordination/agents/project-agent-files.js';
import { recordProjectAgentOptimizePass } from '../../src/coordination/agents/project-agent-learning-policy.js';
import {
  appendQuarantine,
  quarantinePath,
} from '../../src/coordination/agents/project-agent-quarantine.js';
import {
  projectSkillAffinityPath,
  recordSkillLearned,
  setSkillPinned,
} from '../../src/coordination/agents/project-agent-skill-layer.js';

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

  it('never re-renders learned.md over lessons it cannot read right now', () => {
    // Teach and capture rebuild the file from what they read; an EBUSY read
    // used to come back as '' and every stored lesson was deleted.
    const proj = freshProject();
    const filePath = updateProjectAgentLearned(
      'bug-hunter',
      'Always run the focused vitest file from the repository root.',
      proj,
    );
    const before = fs.readFileSync(filePath, 'utf8');
    const nodeFs = testNodeFs as typeof import('node:fs');
    let nodeFs_readFileSync_spy: { mockRestore(): void } | undefined;
    const realReadFileSync = nodeFs.readFileSync;
    nodeFs_readFileSync_spy = vi.spyOn(nodeFs, 'readFileSync').mockImplementation(((
      p: unknown,
      ...rest: unknown[]
    ) => {
      if (String(p) === filePath) {
        throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
      }
      return (realReadFileSync as (...a: unknown[]) => unknown)(p, ...rest);
    }) as typeof nodeFs.readFileSync);

    try {
      const lesson = 'Never pass a possibly empty file list to vitest because it runs everything.';
      expect(() => updateProjectAgentLearned('bug-hunter', lesson, proj)).toThrow(/EBUSY/);
      expect(() =>
        captureLearnedFromAgentOutputDetailed(
          `## LEARNED\n- ${lesson}\n`,
          'bug-hunter',
          proj,
          true,
        ),
      ).toThrow(/EBUSY/);
    } finally {
      nodeFs_readFileSync_spy?.mockRestore();
    }
    expect(fs.readFileSync(filePath, 'utf8')).toBe(before);
  });

  it('never turns learning back on over a policy file it cannot read', () => {
    // The policy update merged into the defaults ({ enabled: true }) when the
    // read failed and wrote them back over the user's switch.
    const proj = freshProject();
    const dir = path.join(proj, '.wrongstack', 'agents', 'bug-hunter');
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, 'learning.json');
    fs.writeFileSync(filePath, JSON.stringify({ enabled: false, lifetimeCaptureCount: 7 }));
    const nodeFs = testNodeFs as typeof import('node:fs');
    let nodeFs_readFileSync_spy: { mockRestore(): void } | undefined;
    const realReadFileSync = nodeFs.readFileSync;
    nodeFs_readFileSync_spy = vi.spyOn(nodeFs, 'readFileSync').mockImplementation(((
      p: unknown,
      ...rest: unknown[]
    ) => {
      if (String(p) === filePath) {
        throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
      }
      return (realReadFileSync as (...a: unknown[]) => unknown)(p, ...rest);
    }) as typeof nodeFs.readFileSync);

    try {
      recordProjectAgentOptimizePass('bug-hunter', proj);
    } finally {
      nodeFs_readFileSync_spy?.mockRestore();
    }
    expect(JSON.parse(fs.readFileSync(filePath, 'utf8'))).toEqual({
      enabled: false,
      lifetimeCaptureCount: 7,
    });
  });

  it('never rewrites skill affinity or the quarantine log over a file it cannot read', () => {
    // Both rebuilt the file from an empty stand-in for an unreadable one: the
    // user's skill pins and the retired-directive audit log were dropped.
    const proj = freshProject();
    setSkillPinned('bug-hunter', 'testing', true, proj);
    const retired = (what: string) =>
      [{ key: what, what, how: '', why: '', category: 'process', capturedAt: '' }] as never;
    appendQuarantine('bug-hunter', retired('older retired directive'), 'then', proj);
    const affinityPath = projectSkillAffinityPath('bug-hunter', proj);
    const logPath = quarantinePath('bug-hunter', proj);
    const before = [fs.readFileSync(affinityPath, 'utf8'), fs.readFileSync(logPath, 'utf8')];
    const nodeFs = testNodeFs as typeof import('node:fs');
    let nodeFs_readFileSync_spy: { mockRestore(): void } | undefined;
    const realReadFileSync = nodeFs.readFileSync;
    nodeFs_readFileSync_spy = vi.spyOn(nodeFs, 'readFileSync').mockImplementation(((
      p: unknown,
      ...rest: unknown[]
    ) => {
      if (String(p) === affinityPath || String(p) === logPath) {
        throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
      }
      return (realReadFileSync as (...a: unknown[]) => unknown)(p, ...rest);
    }) as typeof nodeFs.readFileSync);

    try {
      recordSkillLearned('bug-hunter', 'git-workflow', proj);
      expect(() =>
        appendQuarantine('bug-hunter', retired('newer retired directive'), 'now', proj),
      ).toThrow(/EBUSY/);
    } finally {
      nodeFs_readFileSync_spy?.mockRestore();
    }
    expect([fs.readFileSync(affinityPath, 'utf8'), fs.readFileSync(logPath, 'utf8')]).toEqual(
      before,
    );
  });

  it('a pruning consolidation never resets a learned.md it cannot read', () => {
    // The prune keeps the directives the synthesis never saw; with the buffer
    // read as '' it archived nothing and reset learned.md to empty.
    const proj = freshProject();
    updateProjectAgentLearned('bug-hunter', 'Always run vitest from the repository root.', proj);
    const sourceKeys = readRawLearnedEntries('bug-hunter', proj).map((entry) => entry.key);
    const filePath = updateProjectAgentLearned(
      'bug-hunter',
      'Never pass a possibly empty file list to vitest because it runs everything.',
      proj,
    );
    const before = fs.readFileSync(filePath, 'utf8');
    const nodeFs = testNodeFs as typeof import('node:fs');
    let nodeFs_readFileSync_spy: { mockRestore(): void } | undefined;
    const realReadFileSync = nodeFs.readFileSync;
    nodeFs_readFileSync_spy = vi.spyOn(nodeFs, 'readFileSync').mockImplementation(((
      p: unknown,
      ...rest: unknown[]
    ) => {
      if (String(p) === filePath) {
        throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
      }
      return (realReadFileSync as (...a: unknown[]) => unknown)(p, ...rest);
    }) as typeof nodeFs.readFileSync);

    try {
      expect(() =>
        saveProjectAgentConsolidated('bug-hunter', '- synthesized rule', proj, {
          prune: true,
          sourceKeys,
        }),
      ).toThrow(/EBUSY/);
    } finally {
      nodeFs_readFileSync_spy?.mockRestore();
    }
    expect(fs.readFileSync(filePath, 'utf8')).toBe(before);
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

vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
}));
