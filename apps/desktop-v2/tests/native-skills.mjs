import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { exerciseNativeSkillDrafts } from './native-skill-drafts.mjs';

export async function exerciseNativeSkills({ page, rpc, project, waitFor, artifactDir }) {
  const openLibrary = async () => {
    await page.locator('.project-home-button').click();
    await page.locator('.project-secondary-links button').filter({ hasText: 'Skills' }).click();
    await page.getByRole('heading', { name: 'Skills', exact: true }).waitFor();
  };
  await openLibrary();
  await page.getByLabel('Filter skill source').selectOption('bundled');
  await page.locator('.skill-catalog-list > button').first().click();
  await page.locator('.skill-instructions').waitFor();
  assert.equal(
    await page.getByRole('button', { name: 'Edit skill', exact: true }).count(),
    0,
    'Bundled skill instructions remain read-only',
  );
  await page.screenshot({ path: join(artifactDir, 'native-bundled-skill.png'), fullPage: true });
  await page.getByRole('button', { name: 'New skill', exact: true }).click();
  await page.getByLabel('New skill name').fill('native-desktop-skill');
  await page
    .getByLabel('New skill description')
    .fill('Use when checking the isolated desktop fixture.');
  await page.getByRole('button', { name: 'Create skill', exact: true }).click();
  await page.getByLabel('Skill Markdown source').waitFor();
  const original = await page.getByLabel('Skill Markdown source').inputValue();
  assert.ok(original.includes('name: native-desktop-skill'));
  const updated =
    original +
    '\n\n## Desktop evidence\n\nKeep project capabilities independent of conversations.\n';
  await page.getByLabel('Skill Markdown source').fill(updated);
  await page.getByRole('button', { name: 'Save skill', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Skill saved and verified.' }).waitFor();
  await page
    .locator('.skill-instructions')
    .getByText('Keep project capabilities independent of conversations.', { exact: true })
    .waitFor();
  const skillRoot = join(project.root, '.wrongstack/skills/native-desktop-skill');
  assert.equal(await readFile(join(skillRoot, 'SKILL.md'), 'utf8'), updated);
  await page.getByLabel('Filter skill source').selectOption('project');
  await page.getByRole('button', { name: 'Open skill native-desktop-skill', exact: true }).click();
  await page.getByRole('button', { name: 'Edit skill', exact: true }).click();
  await page.getByLabel('Skill Markdown source').fill('# Missing mandatory skill metadata');
  await page.getByRole('button', { name: 'Save skill', exact: true }).click();
  await page.getByRole('alert').waitFor();
  assert.equal(
    await readFile(join(skillRoot, 'SKILL.md'), 'utf8'),
    updated,
    'Invalid Markdown leaves the original skill intact',
  );
  await page.getByRole('button', { name: 'Cancel editing', exact: true }).click();
  await page.getByRole('button', { name: 'Keep editing', exact: true }).click();
  assert.equal(
    await page.getByLabel('Skill Markdown source').inputValue(),
    '# Missing mandatory skill metadata',
  );
  await page.getByRole('button', { name: 'Cancel editing', exact: true }).click();
  await page.getByRole('button', { name: 'Discard draft', exact: true }).click();
  await page.locator('.skill-instructions').waitFor();
  await mkdir(join(skillRoot, 'references'));
  await writeFile(
    join(skillRoot, 'references/native-guide.md'),
    'Native skill supporting evidence.\n',
  );
  await page.getByRole('button', { name: 'Open skill native-desktop-skill', exact: true }).click();
  await page
    .locator('.skill-evidence')
    .getByRole('button', { name: 'references', exact: true })
    .click();
  await page.locator('.file-folder-row').filter({ hasText: 'native-guide.md' }).waitFor();
  assert.equal(
    await page
      .getByRole('button', { name: 'Show ignored source files', exact: true })
      .getAttribute('aria-pressed'),
    'true',
    'An explicitly linked ignored skill directory is revealed',
  );
  await page.locator('.file-folder-row').filter({ hasText: 'native-guide.md' }).dblclick();
  await page
    .locator('.native-file-content')
    .filter({ hasText: 'Native skill supporting evidence.' })
    .waitFor();
  const revealedFile = page.getByRole('treeitem', {
    name: '.wrongstack/skills/native-desktop-skill/references/native-guide.md',
    exact: true,
  });
  await revealedFile.waitFor();
  assert.equal(
    await revealedFile.getAttribute('aria-selected'),
    'true',
    'Absolute skill links select the canonical relative file',
  );
  await openLibrary();
  await exerciseNativeSkillDrafts({ page, project, openLibrary, skillRoot, artifactDir });
  await openLibrary();
  await page.getByLabel('Search skills').fill('native-desktop-skill');
  await page.getByRole('button', { name: 'Open skill native-desktop-skill', exact: true }).click();
  await page.locator('.skill-instructions').waitFor();
  await page.screenshot({ path: join(artifactDir, 'native-project-skills.png'), fullPage: true });
  await page.getByRole('button', { name: 'Switch to dark mode', exact: true }).click();
  await page.setViewportSize({ width: 800, height: 640 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({
    path: join(artifactDir, 'native-skills-compact-dark.png'),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1480, height: 960 });
  await page.getByRole('button', { name: 'Switch to light mode', exact: true }).click();
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name: 'WrongStack settings', exact: true })
    .click();
  await page
    .getByRole('navigation', { name: 'WrongStack settings sections' })
    .getByRole('button', { name: 'Profile skills', exact: true })
    .click();
  await page.getByRole('button', { name: 'New skill', exact: true }).click();
  await page.getByLabel('New skill name').fill('native-profile-skill');
  await page
    .getByLabel('New skill description')
    .fill('Use for isolated profile-wide desktop verification.');
  await page.getByRole('button', { name: 'Create skill', exact: true }).click();
  await page.getByLabel('Skill Markdown source').waitFor();
  await page.getByRole('button', { name: 'Cancel editing', exact: true }).click();
  await page.getByLabel('Filter skill source').selectOption('user');
  await waitFor(
    async () => (await page.locator('.skill-catalog-list > button').count()) === 1,
    'Isolated profile skill source',
  );
  await page.screenshot({ path: join(artifactDir, 'native-profile-skills.png'), fullPage: true });
  assert.equal(
    (await rpc('snapshot')).sessions.length,
    0,
    'Project and profile skills do not create conversation sessions',
  );
  console.log(
    'PASS: native skill discovery/source ownership/create/edit/readback/validation/draft protection/supporting folder/file navigation and profile creation without sessions',
  );
}
