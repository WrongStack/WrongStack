import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { access, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { exerciseNativeConflictVariants } from './native-conflict-variants.mjs';
import { exerciseNativeFileBulk } from './native-file-bulk.mjs';
import { exerciseVersionBoundSave } from './native-file-save.mjs';
import { exerciseNativeFileTreeScale } from './native-file-tree-scale.mjs';
export async function exerciseNativeFiles({ page, waitFor, artifactDir, project, rpc }) {
  const tool = (name) =>
    page
      .getByRole('navigation', { name: `${project.name} workspace` })
      .getByRole('button', { name, exact: true });
  await page.locator('.project-item').filter({ hasText: project.name }).click();
  await tool('Files').click();
  await page.getByRole('treeitem', { name: 'packages', exact: true }).click();
  await page.getByRole('treeitem', { name: 'packages/alpha', exact: true }).click();
  await page.getByRole('treeitem', { name: 'packages/alpha/src', exact: true }).click();
  await page.getByRole('treeitem', { name: 'packages/alpha/src/index.ts', exact: true }).click();
  const source = page.getByRole('region', {
    name: 'Source of packages/alpha/src/index.ts',
    exact: true,
  });
  await source.waitFor();
  // Find in the read-only view marks matching lines and steps through them.
  await source.focus();
  await page.keyboard.press('Control+f');
  const viewerFind = page.getByRole('region', { name: 'Find in read-only source', exact: true });
  await viewerFind.getByLabel('Find in source', { exact: true }).fill('shared');
  await viewerFind.getByText('2 matches on 2 lines', { exact: true }).waitFor();
  assert.equal(await source.locator('.file-source-line.find-match').count(), 2);
  await viewerFind.getByLabel('Find in source', { exact: true }).press('Enter');
  await source.locator('.find-current[data-source-line="1"]').waitFor();
  await viewerFind.getByRole('button', { name: 'Next matching line', exact: true }).click();
  await source.locator('.find-current[data-source-line="2"]').waitFor();
  await viewerFind.getByLabel('Find in source', { exact: true }).press('Shift+Enter');
  await source.locator('.find-current[data-source-line="1"]').waitFor();
  await viewerFind.getByLabel('Find in source', { exact: true }).press('Escape');
  await viewerFind.waitFor({ state: 'detached' });
  assert.equal(await source.locator('.find-match').count(), 0);
  const drawer = () => page.getByRole('region', { name: 'File details panel', exact: true });
  await drawer().waitFor();
  const resize = page.getByRole('separator', { name: 'Resize file details', exact: true });
  const initialDrawerHeight = Number(await resize.getAttribute('aria-valuenow'));
  await resize.focus();
  await page.keyboard.press('ArrowUp');
  assert.equal(Number(await resize.getAttribute('aria-valuenow')), initialDrawerHeight + 20);
  await drawer().getByRole('button', { name: 'Memory', exact: true }).click();
  await page
    .locator('.file-related-memories')
    .getByText('Native SAGE proposal keeps file boundaries explicit.', { exact: true })
    .waitFor();
  await drawer().getByRole('button', { name: 'Structure', exact: true }).click();
  await page.locator('.file-structure pre').filter({ hasText: 'feature' }).waitFor();
  await drawer().getByRole('button', { name: 'Activity', exact: true }).click();
  await page.locator('.file-event-list').waitFor();
  await drawer().getByRole('button', { name: 'Overview', exact: true }).click();
  await page.screenshot({
    path: join(artifactDir, 'native-files-tree-drawer.png'),
    fullPage: true,
  });
  await page.getByRole('button', { name: 'Search contents', exact: true }).click();
  const contentSearch = page.getByRole('dialog', { name: 'Search project contents', exact: true });
  await contentSearch.getByLabel('Find text in project', { exact: true }).fill('FEATURE()');
  await contentSearch.getByLabel('Content search folder', { exact: true }).fill('packages/alpha');
  await contentSearch.getByLabel('Match case', { exact: true }).check();
  const searchContents = async () => {
    await contentSearch.getByRole('button', { name: 'Search contents', exact: true }).click();
    await waitFor(
      async () =>
        !(await contentSearch
          .getByRole('button', { name: 'Search contents', exact: true })
          .isDisabled()),
      'Native content search acknowledged',
    );
  };
  await searchContents();
  await contentSearch
    .getByText('No matching lines in the searched scope.', { exact: true })
    .waitFor();
  await contentSearch.getByLabel('Match case', { exact: true }).uncheck();
  await searchContents();
  await contentSearch
    .getByRole('button', { name: 'Open packages/alpha/src/index.ts line 2', exact: true })
    .waitFor();
  await page.screenshot({
    path: join(artifactDir, 'native-file-content-search.png'),
    fullPage: true,
  });
  await contentSearch.getByLabel('Content search folder', { exact: true }).fill('..');
  await searchContents();
  await contentSearch.getByRole('alert').waitFor();
  await contentSearch.getByLabel('Content search folder', { exact: true }).fill('packages/alpha');
  await searchContents();
  await contentSearch
    .getByRole('button', { name: 'Open packages/alpha/src/index.ts line 2', exact: true })
    .click();
  await page
    .locator('.file-source-line.search-match')
    .filter({ hasText: 'export function feature()' })
    .waitFor();
  await writeFile(
    join(project.root, 'native-content-search.ts'),
    'native-search-many\n'.repeat(205),
  );
  try {
    await page.getByRole('button', { name: 'Search contents', exact: true }).click();
    await contentSearch
      .getByLabel('Find text in project', { exact: true })
      .fill('native-search-many');
    await contentSearch.getByLabel('Content search folder', { exact: true }).fill('');
    await searchContents();
    await contentSearch.getByRole('status').filter({ hasText: 'Partial results' }).waitFor();
    assert.equal(
      await contentSearch
        .getByRole('region', { name: 'Project content search results', exact: true })
        .getByRole('button')
        .count(),
      200,
    );
    await page.setViewportSize({ width: 800, height: 640 });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    await page.screenshot({
      path: join(artifactDir, 'native-file-content-search-compact.png'),
      fullPage: true,
    });
    await page.setViewportSize({ width: 1480, height: 960 });
    await contentSearch.getByRole('button', { name: 'Close content search', exact: true }).click();
  } finally {
    await unlink(join(project.root, 'native-content-search.ts'));
  }
  await page.getByRole('button', { name: 'Collapse file details', exact: true }).click();
  await page.getByRole('button', { name: 'Expand file details', exact: true }).click();
  await page.getByRole('button', { name: 'New folder', exact: true }).click();
  await page.getByLabel('Project-relative path', { exact: true }).fill('desktop-notes');
  await page
    .getByRole('dialog', { name: 'Create folder', exact: true })
    .getByRole('button', { name: 'Create folder', exact: true })
    .click();
  await page
    .getByRole('dialog', { name: 'Create folder', exact: true })
    .waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: 'New file', exact: true }).click();
  await page.getByLabel('Project-relative path', { exact: true }).fill('desktop-notes/native.ts');
  await page
    .getByRole('dialog', { name: 'Create file', exact: true })
    .getByRole('button', { name: 'Create file', exact: true })
    .click();
  await page.getByRole('dialog', { name: 'Create file', exact: true }).waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: 'Edit file', exact: true }).click();
  const editor = () =>
    page.getByRole('textbox', { name: 'Edit desktop-notes/native.ts', exact: true });
  await editor().fill('export const desktop = 1;\n');
  await page.keyboard.press('Control+s');
  await waitFor(
    async () =>
      (await readFile(join(project.root, 'desktop-notes/native.ts'), 'utf8')) ===
      'export const desktop = 1;\n',
    'Native file save to real disk',
  );
  await page.getByRole('button', { name: 'Save', exact: true }).waitFor({ state: 'visible' });
  await waitFor(
    async () => !(await page.getByRole('button', { name: 'Save', exact: true }).isEnabled()),
    'Saved file acknowledgement',
  );
  // Find and replace edits only the editor text; undo restores it and the disk is untouched.
  await editor().focus();
  await page.keyboard.press('Control+f');
  const finder = page.getByRole('region', { name: 'Find and replace', exact: true });
  await finder.getByLabel('Find in file', { exact: true }).fill('desktop');
  await finder.getByText('1 matches', { exact: true }).waitFor();
  await finder.getByLabel('Replace with', { exact: true }).fill('native');
  await finder.getByRole('button', { name: 'Replace all', exact: true }).click();
  await finder.getByText('Replaced 1 match.', { exact: true }).waitFor();
  assert.equal(await editor().inputValue(), 'export const native = 1;\n');
  assert.equal(
    await readFile(join(project.root, 'desktop-notes/native.ts'), 'utf8'),
    'export const desktop = 1;\n',
    'Replacing does not write the file',
  );
  await finder.getByRole('button', { name: 'Undo replace all', exact: true }).click();
  assert.equal(await editor().inputValue(), 'export const desktop = 1;\n');
  await finder.getByLabel('Find in file', { exact: true }).press('Escape');
  await finder.waitFor({ state: 'detached' });
  // Enter keeps indentation and opens a bracket pair; Shift+Tab outdents the selected lines.
  await editor().fill('function x() {}');
  await editor().evaluate((input) => input.setSelectionRange(14, 14));
  await page.keyboard.press('Enter');
  await page.keyboard.type('a');
  await page.keyboard.press('Enter');
  await page.keyboard.type('b');
  assert.equal(await editor().inputValue(), 'function x() {\n  a\n  b\n}');
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Shift+Tab');
  assert.equal(await editor().inputValue(), 'function x() {\na\nb\n}');
  // These edits stay in the textarea's own undo history.
  await page.keyboard.press('Control+z');
  assert.equal(await editor().inputValue(), 'function x() {\n  a\n  b\n}');
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Tab');
  assert.equal(await editor().inputValue(), '  function x() {\n    a\n    b\n  }');
  await editor().fill('export const unsaved = true;\n');
  await waitFor(async () => {
    const drafts = await page.evaluate(
      async (projectId) =>
        window.__TAURI_INTERNALS__.invoke('host_request', {
          method: 'file-drafts.list',
          params: { projectId },
        }),
      project.id,
    );
    return drafts.drafts.some((draft) => draft.path === 'desktop-notes/native.ts');
  }, 'File draft persisted in the native project registry');
  await page.reload();
  await tool('Files').click();
  await page.getByText('1 local file drafts · saved on this device', { exact: true }).click();
  await page.getByRole('button', { name: 'desktop-notes/native.ts', exact: true }).click();
  await editor().waitFor();
  assert.equal(await editor().inputValue(), 'export const unsaved = true;\n');
  await tool('Memory').click();
  await tool('Files').click();
  await editor().waitFor();
  assert.equal(
    await editor().inputValue(),
    'export const unsaved = true;\n',
    'Open file tabs and local edits survive project-tool navigation',
  );
  assert.equal(
    await readFile(join(project.root, 'desktop-notes/native.ts'), 'utf8'),
    'export const desktop = 1;\n',
  );
  await page.screenshot({
    path: join(artifactDir, 'native-file-draft-recovered.png'),
    fullPage: true,
  });
  await page.evaluate(async (projectId) => {
    const path = 'desktop-notes/native.ts';
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(path));
    const formKey = `file-draft:${Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, '0')).join('')}`;
    const invoke = (method, params) =>
      window.__TAURI_INTERNALS__.invoke('host_request', {
        method,
        params: { projectId, formKey, ...params },
      });
    const current = await invoke('form-draft.get', {});
    await invoke('form-draft.save', {
      expectedRevision: current.revision,
      value: { ...current.value, content: 'export const peer = true;\n' },
    });
  }, project.id);
  await editor().fill('export const local = true;\n');
  const conflict = page.getByRole('dialog', {
    name: 'File draft changed in another window',
    exact: true,
  });
  await conflict.waitFor();
  assert.equal(
    await conflict.getByLabel('Stored draft', { exact: true }).inputValue(),
    'export const peer = true;\n',
  );
  assert.equal(
    await conflict.getByLabel('Your editor', { exact: true }).inputValue(),
    'export const local = true;\n',
  );
  await page.screenshot({
    path: join(artifactDir, 'native-file-draft-comparison.png'),
    fullPage: true,
  });
  await page.setViewportSize({ width: 800, height: 640 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({
    path: join(artifactDir, 'native-file-draft-comparison-compact.png'),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1480, height: 960 });
  await conflict.getByRole('button', { name: 'Use stored draft', exact: true }).click();
  await conflict.waitFor({ state: 'hidden' });
  await waitFor(
    async () => (await editor().inputValue()) === 'export const peer = true;\n',
    'Explicit stored file draft recovery',
  );
  await editor().fill('export const unsaved = true;\n');
  await page.getByRole('button', { name: 'Close desktop-notes/native.ts', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Unsaved changes', exact: true })
    .getByRole('button', { name: 'Cancel', exact: true })
    .click();
  assert.equal(await editor().inputValue(), 'export const unsaved = true;\n');
  await writeFile(join(project.root, 'desktop-notes/native.ts'), 'export const external = true;\n');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'File changed on disk', exact: true })
    .getByRole('button', { name: 'Reload from disk', exact: true })
    .click();
  await page
    .getByRole('dialog', { name: 'File changed on disk', exact: true })
    .waitFor({ state: 'hidden' });
  assert.equal(await editor().inputValue(), 'export const external = true;\n');
  await editor().fill('export const resolved = true;\n');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await waitFor(
    async () =>
      (await readFile(join(project.root, 'desktop-notes/native.ts'), 'utf8')) ===
      'export const resolved = true;\n',
    'Save after external edit review',
  );
  await waitFor(
    async () => !(await page.getByRole('button', { name: 'Save', exact: true }).isEnabled()),
    'Resolved save acknowledgement',
  );
  await exerciseVersionBoundSave({ page, editor, waitFor, project, rpc, artifactDir });
  await page.getByRole('button', { name: 'File actions', exact: true }).click();
  await page
    .locator('.file-context-menu')
    .getByRole('button', { name: 'Rename', exact: true })
    .click();
  await page.getByLabel('Project-relative path', { exact: true }).fill('desktop-notes/renamed.ts');
  await page
    .getByRole('dialog', { name: 'Rename item', exact: true })
    .getByRole('button', { name: 'Rename item', exact: true })
    .click();
  await page.getByRole('dialog', { name: 'Rename item', exact: true }).waitFor({ state: 'hidden' });
  assert.equal(
    await readFile(join(project.root, 'desktop-notes/renamed.ts'), 'utf8'),
    'export const resolved = true;\n',
  );
  await page.getByRole('button', { name: 'File actions', exact: true }).click();
  await page
    .locator('.file-context-menu')
    .getByRole('button', { name: 'Move to folder', exact: true })
    .click();
  await page.getByLabel('Destination folder', { exact: true }).fill('.');
  await page
    .getByRole('dialog', { name: 'Move item', exact: true })
    .getByRole('button', { name: 'Move item', exact: true })
    .click();
  await page.getByRole('dialog', { name: 'Move item', exact: true }).waitFor({ state: 'hidden' });
  assert.equal(
    await readFile(join(project.root, 'renamed.ts'), 'utf8'),
    'export const resolved = true;\n',
  );
  await page.getByRole('button', { name: 'File actions', exact: true }).click();
  await page
    .locator('.file-context-menu')
    .getByRole('button', { name: 'Delete', exact: true })
    .click();
  await page
    .getByRole('dialog', { name: 'Delete item', exact: true })
    .getByRole('button', { name: 'Delete item', exact: true })
    .click();
  await page.getByRole('dialog', { name: 'Delete item', exact: true }).waitFor({ state: 'hidden' });
  await assert.rejects(access(join(project.root, 'renamed.ts')));
  await tool('Changes').click();
  await page.getByRole('button', { name: 'Review review-fixture.ts', exact: true }).click();
  await page.locator('.diff-line-remove').filter({ hasText: 'reviewed = 1' }).waitFor();
  await page.locator('.diff-line-add').filter({ hasText: 'reviewed = 2' }).waitFor();
  await page.getByRole('button', { name: 'Side by side diff', exact: true }).click();
  await page.locator('.diff-split').waitFor();
  await page.getByRole('button', { name: 'Unified diff', exact: true }).click();
  await page
    .locator('.diff-line-add')
    .getByRole('button', { name: 'Review line 1', exact: true })
    .click();
  await page
    .getByLabel('Review note', { exact: true })
    .fill('Confirm the new value against the project requirement.');
  await page
    .getByRole('dialog', { name: 'Add review note', exact: true })
    .getByRole('button', { name: 'Add review note', exact: true })
    .click();
  await page
    .locator('.file-review-tray')
    .getByText('Confirm the new value against the project requirement.', { exact: true })
    .waitFor();
  await page.getByRole('button', { name: 'Stage review-fixture.ts', exact: true }).click();
  await page.getByRole('button', { name: 'Unstage review-fixture.ts', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Unstage review-fixture.ts', exact: true }).click();
  await page.getByRole('button', { name: 'Stage review-fixture.ts', exact: true }).waitFor();
  const invokeForm = (method, params) =>
    page.evaluate(
      ({ method, params }) => window.__TAURI_INTERNALS__.invoke('host_request', { method, params }),
      { method, params },
    );
  const reviewText = 'Confirm the new value against the project requirement.';
  await page.reload();
  await page.locator('.project-item').filter({ hasText: project.name }).click();
  await tool('Changes').click();
  await page.locator('.file-review-tray').getByText(reviewText, { exact: true }).waitFor();
  const savedNotes = await invokeForm('form-draft.get', {
    projectId: project.id,
    formKey: 'git-review-notes',
  });
  assert.ok(savedNotes.value.notes.some((note) => note.text === reviewText));
  await invokeForm('form-draft.save', {
    projectId: project.id,
    formKey: 'git-review-notes',
    expectedRevision: savedNotes.revision,
    value: {
      version: 1,
      notes: [
        ...savedNotes.value.notes,
        { path: 'review-fixture.ts', line: 1, text: 'Peer review note' },
      ],
    },
  });
  await page.getByRole('button', { name: 'Remove review note 1', exact: true }).click();
  await page
    .locator('.file-review-tray')
    .getByRole('alert')
    .filter({ hasText: 'Another window' })
    .waitFor();
  assert.ok(
    (
      await invokeForm('form-draft.get', { projectId: project.id, formKey: 'git-review-notes' })
    ).value.notes.some((note) => note.text === reviewText),
  );
  await page.getByRole('button', { name: 'Reload saved review notes', exact: true }).click();
  await page.locator('.file-review-tray').getByText('Peer review note', { exact: true }).waitFor();
  const tray = page.locator('.file-review-tray');
  const firstNote = tray.locator('article').filter({ hasText: reviewText });
  await firstNote.getByRole('button', { name: 'Reply', exact: true }).click();
  await tray
    .getByRole('textbox', { name: 'Reply to review note 1', exact: true })
    .fill('Checked against the requirement.');
  await tray.getByRole('button', { name: 'Add reply', exact: true }).click();
  await tray
    .getByRole('list', { name: 'Replies to review note 1', exact: true })
    .getByText('Checked against the requirement.', { exact: true })
    .waitFor();
  await tray.getByRole('button', { name: 'Resolve review note 1', exact: true }).click();
  await tray.getByText('1 open review notes · 1 resolved', { exact: true }).waitFor();
  assert.equal(await tray.getByText(reviewText, { exact: true }).count(), 0);
  const discussed = await invokeForm('form-draft.get', {
    projectId: project.id,
    formKey: 'git-review-notes',
  });
  assert.equal(discussed.value.version, 2);
  assert.deepEqual(
    discussed.value.notes.map((note) => [
      note.text,
      note.resolved ?? false,
      note.replies?.length ?? 0,
    ]),
    [
      [reviewText, true, 1],
      ['Peer review note', false, 0],
    ],
  );
  await page.reload();
  await page.locator('.project-item').filter({ hasText: project.name }).click();
  await tool('Changes').click();
  await tray.getByText('1 open review notes · 1 resolved', { exact: true }).waitFor();
  await tray.getByLabel('Show resolved', { exact: true }).check();
  await firstNote.getByText('Checked against the requirement.', { exact: true }).waitFor();
  await page.screenshot({
    path: join(artifactDir, 'native-review-discussion.png'),
    fullPage: true,
  });
  await tray.getByRole('button', { name: 'Reopen review note 1', exact: true }).click();
  await tray.getByText('2 open review notes', { exact: true }).waitFor();

  const git = (...args) =>
    execFileSync('git', args, { cwd: project.root, encoding: 'utf8', windowsHide: true });
  const original = Array.from({ length: 45 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
  await writeFile(join(project.root, 'native-hunks.txt'), original);
  git('add', '--', 'native-hunks.txt');
  git(
    '-c',
    'user.name=Native Test',
    '-c',
    'user.email=native@example.invalid',
    '-c',
    'core.hooksPath=disabled',
    'commit',
    '-m',
    'Native hunk fixture',
    '--',
    'native-hunks.txt',
  );
  const edited = original
    .replace('line 3\n', 'first change\n')
    .replace('line 39\n', 'second change\n');
  await writeFile(join(project.root, 'native-hunks.txt'), edited);
  await tool('Files').click();
  await tool('Changes').click();
  await page.getByRole('button', { name: 'Refresh file manager', exact: true }).click();
  await page.getByRole('button', { name: 'Review native-hunks.txt', exact: true }).click();
  await page.getByRole('button', { name: 'Review & stage hunks', exact: true }).click();
  const hunks = page.getByRole('dialog', { name: 'Stage individual hunks', exact: true });
  await hunks.getByRole('button', { name: 'Stage hunk 2', exact: true }).waitFor();
  await page.screenshot({ path: join(artifactDir, 'native-git-hunks.png'), fullPage: true });
  await page.setViewportSize({ width: 800, height: 640 });
  assert.equal(await hunks.evaluate((element) => element.scrollWidth > element.clientWidth), false);
  await page.screenshot({
    path: join(artifactDir, 'native-git-hunks-compact.png'),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1480, height: 960 });
  await hunks.getByRole('button', { name: 'Stage hunk 1', exact: true }).click();
  await waitFor(
    () => git('show', ':native-hunks.txt') === original.replace('line 3\n', 'first change\n'),
    'Only the selected hunk enters the real index',
  );
  assert.equal(await readFile(join(project.root, 'native-hunks.txt'), 'utf8'), edited);
  await waitFor(
    async () =>
      !(await hunks.getByRole('status').count()) &&
      (await hunks.getByRole('button', { name: 'Stage hunk 1', exact: true }).count()) === 1 &&
      (await hunks.getByRole('button', { name: 'Stage hunk 1', exact: true }).isEnabled()) &&
      !(await hunks.getByRole('button', { name: 'Stage hunk 2', exact: true }).count()),
    'Hunks refresh after staging',
  );
  await writeFile(
    join(project.root, 'native-hunks.txt'),
    edited.replace('second change', 'newer change'),
  );
  await hunks.getByRole('button', { name: 'Stage hunk 1', exact: true }).click();
  await hunks.getByRole('alert').filter({ hasText: 'changed since review' }).waitFor();
  await hunks
    .getByRole('combobox', { name: 'Hunk review layer', exact: true })
    .selectOption('staged');
  await hunks.getByRole('button', { name: 'Unstage hunk 1', exact: true }).click();
  await waitFor(
    () => git('show', ':native-hunks.txt') === original,
    'Only the selected hunk leaves the real index',
  );
  assert.ok(
    (await readFile(join(project.root, 'native-hunks.txt'), 'utf8')).includes('newer change'),
  );
  await hunks.getByRole('button', { name: 'Close hunk review', exact: true }).click();
  console.log(
    'PASS: native hunk stage/unstage, real index/disk readback, stale diff refusal, compact review, durable project notes and stale-window protection',
  );
  await page.screenshot({ path: join(artifactDir, 'native-diff-review.png'), fullPage: true });
  await page.getByRole('button', { name: 'Switch to dark mode', exact: true }).click();
  await page.screenshot({ path: join(artifactDir, 'native-diff-review-dark.png'), fullPage: true });
  await page.getByRole('button', { name: 'Review & stage hunks', exact: true }).click();
  await hunks.getByRole('button', { name: 'Stage hunk 1', exact: true }).waitFor();
  await page.screenshot({ path: join(artifactDir, 'native-git-hunks-dark.png'), fullPage: true });
  await hunks.getByRole('button', { name: 'Close hunk review', exact: true }).click();
  await page.setViewportSize({ width: 800, height: 640 });
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
    false,
    'File review fits a compact native window',
  );
  await page.screenshot({
    path: join(artifactDir, 'native-files-review-compact.png'),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1480, height: 960 });
  await page.getByRole('button', { name: 'Switch to light mode', exact: true }).click();
  const branch = git('branch', '--show-current').trim();
  const commitMergeFixture = (message) =>
    git(
      '-c',
      'user.name=Native Test',
      '-c',
      'user.email=native@example.invalid',
      '-c',
      'core.hooksPath=disabled',
      'commit',
      '-m',
      message,
      '--',
      'native-merge.txt',
    );
  await writeFile(join(project.root, 'native-merge.txt'), 'common base\n');
  git('add', '--', 'native-merge.txt');
  commitMergeFixture('Native merge base');
  git('checkout', '-b', 'native-merge-other');
  await writeFile(join(project.root, 'native-merge.txt'), 'theirs side\n');
  commitMergeFixture('Native merge theirs');
  git('checkout', branch);
  await writeFile(join(project.root, 'native-merge.txt'), 'ours side\n');
  commitMergeFixture('Native merge ours');
  assert.throws(() =>
    git(
      '-c',
      'user.name=Native Test',
      '-c',
      'user.email=native@example.invalid',
      '-c',
      'core.hooksPath=disabled',
      'merge',
      '--no-edit',
      'native-merge-other',
    ),
  );
  await page.getByRole('button', { name: 'Refresh file manager', exact: true }).click();
  await page.getByRole('button', { name: 'Review native-merge.txt', exact: true }).click();
  await page.getByRole('button', { name: 'Resolve merge conflict', exact: true }).click();
  const merge = page.getByRole('dialog', { name: 'Resolve merge conflict', exact: true });
  await merge
    .getByRole('region', { name: 'Common base content', exact: true })
    .waitFor({ timeout: 60000 });
  assert.ok(
    (await merge.getByRole('region', { name: 'Ours content', exact: true }).innerText()).includes(
      'ours side',
    ),
  );
  assert.ok(
    (await merge.getByRole('region', { name: 'Theirs content', exact: true }).innerText()).includes(
      'theirs side',
    ),
  );
  assert.equal(
    await merge.getByRole('button', { name: 'Save & mark resolved', exact: true }).isDisabled(),
    true,
  );
  await page.screenshot({ path: join(artifactDir, 'native-merge-conflict.png'), fullPage: true });
  await page.setViewportSize({ width: 800, height: 640 });
  assert.equal(await merge.evaluate((element) => element.scrollWidth > element.clientWidth), false);
  await page.screenshot({
    path: join(artifactDir, 'native-merge-conflict-compact.png'),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1480, height: 960 });
  await merge.getByRole('button', { name: 'Use ours', exact: true }).click();
  await merge.getByRole('button', { name: 'Close conflict resolver', exact: true }).click();
  await merge.getByText('Discard the unsaved merge draft?', { exact: true }).waitFor();
  await merge.getByRole('button', { name: 'Keep editing merge', exact: true }).click();
  const conflictedDisk = await readFile(join(project.root, 'native-merge.txt'), 'utf8');
  assert.ok(conflictedDisk.includes('<<<<<<<'));
  await writeFile(join(project.root, 'native-merge.txt'), conflictedDisk + '\nexternal change\n');
  await merge.getByRole('button', { name: 'Save & mark resolved', exact: true }).click();
  await merge.getByRole('alert').filter({ hasText: 'changed since review' }).waitFor();
  assert.ok(
    (await merge.getByLabel('Merged conflict result', { exact: true }).inputValue()).includes(
      'ours side',
    ),
  );
  assert.ok(git('ls-files', '-u', '--', 'native-merge.txt').length > 0);
  await merge
    .getByRole('button', { name: 'Reload conflict (discard merge draft)', exact: true })
    .click();
  await waitFor(
    async () =>
      (await merge.getByLabel('Merged conflict result', { exact: true }).inputValue()).includes(
        'external change',
      ),
    'Conflict reload preserves actual disk snapshot',
  );
  await merge
    .getByLabel('Merged conflict result', { exact: true })
    .fill('reviewed merged result\n');
  await merge.getByRole('button', { name: 'Save & mark resolved', exact: true }).click();
  await merge.waitFor({ state: 'hidden', timeout: 60000 });
  assert.equal(
    await readFile(join(project.root, 'native-merge.txt'), 'utf8'),
    'reviewed merged result\n',
  );
  assert.equal(git('show', ':native-merge.txt'), 'reviewed merged result\n');
  assert.equal(git('ls-files', '-u', '--', 'native-merge.txt'), '');
  assert.ok(
    git('rev-parse', '--verify', 'MERGE_HEAD').trim(),
    'Resolution stages a file without creating a merge commit',
  );
  console.log(
    'PASS: native three-way conflict review, markers/close guard, stale disk refusal with retained draft, reload and explicit real-file/index resolution without committing',
  );
  await exerciseNativeConflictVariants({ page, project, artifactDir });
  await exerciseNativeFileTreeScale({ page, project, tool, waitFor, artifactDir });
  await exerciseNativeFileBulk({ page, project, tool, waitFor });
  assert.equal(
    (await rpc('snapshot')).sessions.length,
    0,
    'Files and repository review do not create desktop sessions',
  );
  console.log(
    'PASS: native file tree/evidence, bounded scoped literal content search and source-line navigation, durable draft/reload/navigation/peer comparison, create/edit/save/disk conflict/rename/move/delete, unified/split Git diff, line review and stage/unstage',
  );
}
