import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { projectHash, resolveWstackPaths } from '../../src/utils/wstack-paths.js';

describe('wstack-paths', () => {
  it('projectHash is stable for the same absolute path', () => {
    const a = projectHash('/some/project');
    const b = projectHash('/some/project');
    expect(a).toBe(b);
  });

  it('projectHash differs across paths', () => {
    expect(projectHash('/a')).not.toBe(projectHash('/b'));
  });

  it('resolves global + project dirs under user home', () => {
    const paths = resolveWstackPaths({
      userHome: '/home/dev',
      projectRoot: '/work/x',
    });
    expect(paths.globalRoot).toBe(path.join('/home/dev', '.wrongstack'));
    expect(paths.modelsCache).toContain('cache');
    expect(paths.projectDir).toContain('projects');
    expect(paths.projectDir).toContain(paths.projectHash);
  });

  it('only AGENTS.md and skills are project-local', () => {
    const paths = resolveWstackPaths({
      userHome: '/home/dev',
      projectRoot: '/work/x',
    });
    const sep = path.sep;
    const projSeg = `${sep}work${sep}x`;
    expect(paths.inProjectAgentsFile).toContain(projSeg);
    expect(paths.inProjectSkills).toContain(projSeg);
    expect(paths.projectSessions).not.toContain(projSeg);
    expect(paths.projectTrust).not.toContain(projSeg);
    expect(paths.projectMemory).not.toContain(projSeg);
  });

  it('keeps AutoPhase state under the per-project dir', () => {
    const paths = resolveWstackPaths({
      userHome: '/home/dev',
      projectRoot: '/work/x',
    });
    expect(paths.projectAutophase).toBe(path.join(paths.projectDir, 'autophase'));
    expect(paths.projectAutophase).toContain(paths.projectHash);
  });
});
