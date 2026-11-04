import { describe, expect, it } from 'vitest';
import { projectRelativePath, workspaceFilePath } from '../src/file-model';
import {
  skillInstructions,
  skillSource,
  skillSourceLink,
  skillUpdateSummary,
  skillWritable,
} from '../src/skill-model';

describe('desktop skill ownership and document preview', () => {
  it('reads canonical installer result arrays and stored GitHub provenance', () => {
    expect(
      skillUpdateSummary({
        updated: [{ name: 'review', oldRef: 'a', newRef: 'b' }],
        unchanged: ['checks'],
        errors: [{ name: 'lint', error: 'Unavailable' }],
      }),
    ).toBe('1 updated · 1 unchanged · 1 failed.');
    expect(skillSourceLink('github:WrongStack/WrongStack')).toBe(
      'https://github.com/WrongStack/WrongStack',
    );
    expect(skillSourceLink('https://github.com/example/skill')).toBe(
      'https://github.com/example/skill',
    );
    expect(skillSourceLink('javascript:alert(1)')).toBe('');
  });
  it('keeps only the owning project/profile sources writable', () => {
    expect(skillWritable('project', 'project')).toBe(true);
    expect(skillWritable('user', 'profile')).toBe(true);
    for (const source of ['bundled', 'foreign', 'extra', 'claude-user', 'claude-project'])
      expect(skillWritable(source, 'project')).toBe(false);
    expect(skillWritable('user', 'project')).toBe(false);
    expect(skillSource('user')).toBe('WrongStack profile');
  });
  it('hides document metadata from the reading view without damaging source', () => {
    expect(skillInstructions('---\r\nname: demo\r\n---\r\n# Workflow\r\nRead first.')).toBe(
      '# Workflow\nRead first.',
    );
    expect(skillInstructions('# No metadata\n---\nRead first.')).toBe(
      '# No metadata\n---\nRead first.',
    );
    expect(skillInstructions('---\nname: incomplete')).toBe('---\nname: incomplete');
  });
  it('reveals namespaced Windows file links using the project-relative identity', () => {
    expect(projectRelativePath('C:/repo/src/a.ts', '\\\\?\\C:\\repo')).toBe('src/a.ts');
    expect(projectRelativePath('c:/REPO/src/a.ts', 'C:/repo')).toBe('src/a.ts');
    expect(projectRelativePath('C:/repo-other/a.ts', 'C:/repo')).toBe('C:/repo-other/a.ts');
    expect(projectRelativePath('/repo/src/a.ts', '/repo')).toBe('src/a.ts');
    expect(projectRelativePath('/REPO/src/a.ts', '/repo')).toBe('/REPO/src/a.ts');
    expect(workspaceFilePath('src/a.ts', 'C:/repo', 'C:/repo/packages/app')).toBe(
      'packages/app/src/a.ts',
    );
    expect(workspaceFilePath('../shared/a.ts', 'C:/repo', 'C:/repo/packages/app')).toBe(
      'packages/shared/a.ts',
    );
    expect(workspaceFilePath('../../outside.txt', 'C:/repo', 'C:/repo')).toBe('../../outside.txt');
  });
});

it('words the update summary through the given words', () => {
  expect(
    skillUpdateSummary(
      { updated: ['a'], unchanged: [], errors: ['x', 'y'] },
      (updated, unchanged, failed) => `${updated}/${unchanged}/${failed}`,
    ),
  ).toBe('1/0/2');
});
