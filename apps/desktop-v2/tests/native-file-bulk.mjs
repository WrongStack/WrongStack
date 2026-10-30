import assert from 'node:assert/strict';
import { access, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const exists = (path) =>
  access(path).then(
    () => true,
    () => false,
  );

/** Picked folder-listing items are moved and deleted on disk, one engine operation each. */
export async function exerciseNativeFileBulk({ page, project, tool, waitFor }) {
  const source = join(project.root, 'bulk-ops'),
    target = join(project.root, 'bulk-dest');
  await mkdir(source, { recursive: true });
  await mkdir(target, { recursive: true });
  for (const name of [
    'a.txt',
    'b.txt',
    'c.txt',
    'd-old.txt',
    'e-old.txt',
    'f-old.txt',
    'f-new.txt',
  ])
    await writeFile(join(source, name), `${name}\n`);
  try {
    await tool('Files').click();
    await page.getByRole('button', { name: 'Refresh file manager', exact: true }).click();
    const tree = page.getByRole('tree', { name: 'Project directory tree', exact: true });
    await tree.getByRole('treeitem', { name: 'bulk-ops', exact: true }).click();
    await page.getByRole('button', { name: 'Open bulk-ops/a.txt', exact: true }).waitFor();

    await page.getByRole('button', { name: 'Select items', exact: true }).click();
    await page.getByRole('button', { name: 'Select bulk-ops/a.txt', exact: true }).click();
    await page.getByRole('button', { name: 'Select bulk-ops/b.txt', exact: true }).click();
    const bar = page.getByRole('toolbar', { name: 'Selected items', exact: true });
    await bar.getByText('2 selected', { exact: true }).waitFor();
    // Closing a dialog with Escape returns focus to the control that opened it.
    await bar.getByRole('button', { name: 'Move selected…', exact: true }).click();
    await page.getByRole('dialog', { name: 'Move 2 selected items', exact: true }).waitFor();
    await page.keyboard.press('Escape');
    await page
      .getByRole('dialog', { name: 'Move 2 selected items', exact: true })
      .waitFor({ state: 'detached' });
    assert.equal(
      await page.evaluate(() => document.activeElement?.textContent?.trim()),
      'Move selected…',
      'Focus returns to the opener',
    );
    // A click on the backdrop closes the dialog like Escape.
    await bar.getByRole('button', { name: 'Move selected…', exact: true }).click();
    await page.getByRole('dialog', { name: 'Move 2 selected items', exact: true }).waitFor();
    await page.mouse.click(5, 5);
    await page
      .getByRole('dialog', { name: 'Move 2 selected items', exact: true })
      .waitFor({ state: 'detached' });
    await bar.getByRole('button', { name: 'Move selected…', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Move 2 selected items', exact: true });
    await dialog.getByLabel('Bulk move destination', { exact: true }).fill('bulk-dest');
    await dialog.getByRole('button', { name: 'Move 2 to bulk-dest', exact: true }).click();
    await page.getByText('Moved 2 of 2 items.', { exact: true }).waitFor();
    for (const name of ['a.txt', 'b.txt']) {
      assert.equal(await exists(join(target, name)), true, `${name} moved into bulk-dest`);
      assert.equal(await exists(join(source, name)), false, `${name} left bulk-ops`);
    }
    assert.equal(await bar.count(), 0, 'Moved items leave the selection');

    // Bulk copy is all or nothing: one existing target refuses the batch and copies nothing.
    await writeFile(join(source, 'b.txt'), 'existing b\n');
    await page.getByRole('button', { name: 'Refresh file manager', exact: true }).click();
    await tree.getByRole('treeitem', { name: 'bulk-dest', exact: true }).click();
    await page.getByRole('button', { name: 'Select bulk-dest/a.txt', exact: true }).click();
    await page.getByRole('button', { name: 'Select bulk-dest/b.txt', exact: true }).click();
    await bar.getByRole('button', { name: 'Copy selected…', exact: true }).click();
    const batchCopy = page.getByRole('dialog', { name: 'Copy 2 selected items', exact: true });
    await batchCopy.getByText(/or none is/).waitFor();
    await batchCopy.getByLabel('Bulk copy destination', { exact: true }).fill('bulk-ops');
    await batchCopy.getByRole('button', { name: 'Copy 2 to bulk-ops', exact: true }).click();
    await batchCopy.getByText(/already exists\. No item was changed\.$/).waitFor();
    assert.equal(await exists(join(source, 'a.txt')), false, 'A refused batch copies nothing');
    assert.equal(await readFile(join(source, 'b.txt'), 'utf8'), 'existing b\n', 'Not overwritten');
    await batchCopy.getByRole('button', { name: 'Cancel', exact: true }).click();
    await bar.getByRole('button', { name: 'Clear selection', exact: true }).click();
    // Without the conflict both items copy, with no hidden copy left beside them.
    await rm(join(source, 'b.txt'));
    await page.getByRole('button', { name: 'Refresh file manager', exact: true }).click();
    await page.getByRole('button', { name: 'Select bulk-dest/a.txt', exact: true }).click();
    await page.getByRole('button', { name: 'Select bulk-dest/b.txt', exact: true }).click();
    await bar.getByRole('button', { name: 'Copy selected…', exact: true }).click();
    const copyAll = page.getByRole('dialog', { name: 'Copy 2 selected items', exact: true });
    await copyAll.getByLabel('Bulk copy destination', { exact: true }).fill('bulk-ops');
    await copyAll.getByRole('button', { name: 'Copy 2 to bulk-ops', exact: true }).click();
    await page.getByText('Copied 2 of 2 items.', { exact: true }).waitFor();
    assert.equal(await readFile(join(source, 'b.txt'), 'utf8'), 'b.txt\n', 'Copied b');
    assert.equal(await readFile(join(target, 'a.txt'), 'utf8'), 'a.txt\n', 'Source kept');
    assert.deepEqual(
      (await readdir(source)).filter((name) => name.startsWith('.wrongstack-copy-')),
      [],
      'No hidden copy remains',
    );
    assert.equal(await bar.count(), 0, 'Copied items leave the selection');
    // A text-only folder copies with its nested structure.
    await mkdir(join(target, 'tree', 'inner'), { recursive: true });
    await writeFile(join(target, 'tree', 'one.txt'), 'one\n');
    await writeFile(join(target, 'tree', 'inner', 'two.txt'), 'two\n');
    await page.getByRole('button', { name: 'Refresh file manager', exact: true }).click();
    await page.getByRole('button', { name: 'Select bulk-dest/tree', exact: true }).click();
    await bar.getByRole('button', { name: 'Copy selected…', exact: true }).click();
    const folderCopy = page.getByRole('dialog', { name: 'Copy 1 selected item', exact: true });
    await folderCopy.getByLabel('Bulk copy destination', { exact: true }).fill('bulk-ops');
    await folderCopy.getByRole('button', { name: 'Copy 1 to bulk-ops', exact: true }).click();
    await page.getByText('Copied 1 of 1 items.', { exact: true }).waitFor();
    assert.equal(await readFile(join(source, 'tree', 'inner', 'two.txt'), 'utf8'), 'two\n');
    assert.equal(await readFile(join(source, 'tree', 'one.txt'), 'utf8'), 'one\n');
    await tree.getByRole('treeitem', { name: 'bulk-ops', exact: true }).click();

    // Bulk rename: literal text in names; an existing target is refused, never overwritten.
    for (const name of ['d-old.txt', 'e-old.txt', 'f-old.txt'])
      await page.getByRole('button', { name: `Select bulk-ops/${name}`, exact: true }).click();
    await bar.getByRole('button', { name: 'Rename selected…', exact: true }).click();
    const rename = page.getByRole('dialog', { name: 'Rename 3 selected items', exact: true });
    await rename.getByLabel('Find in names', { exact: true }).fill('-old');
    await rename.getByLabel('Replace in names', { exact: true }).fill('-new');
    await rename
      .getByRole('list', { name: 'Rename preview', exact: true })
      .getByText('bulk-ops/d-old.txt → d-new.txt', { exact: true })
      .waitFor();
    // The batch is all or nothing: one existing target refuses it and nothing is renamed.
    await rename.getByRole('button', { name: 'Rename 3', exact: true }).click();
    await rename.getByText(/f-new\.txt already exists\. No item was changed\.$/).waitFor();
    for (const name of ['d-old.txt', 'e-old.txt', 'f-old.txt'])
      assert.equal(await exists(join(source, name)), true, `${name} was not renamed`);
    assert.equal(await readFile(join(source, 'f-new.txt'), 'utf8'), 'f-new.txt\n');
    await rename.getByRole('button', { name: 'Cancel', exact: true }).click();
    // Without the conflict all three are renamed and leave the selection.
    await rm(join(source, 'f-new.txt'));
    await bar.getByText('3 selected', { exact: true }).waitFor();
    await bar.getByRole('button', { name: 'Rename selected…', exact: true }).click();
    const renameAll = page.getByRole('dialog', { name: 'Rename 3 selected items', exact: true });
    await renameAll.getByLabel('Find in names', { exact: true }).fill('-old');
    await renameAll.getByLabel('Replace in names', { exact: true }).fill('-new');
    await renameAll.getByRole('button', { name: 'Rename 3', exact: true }).click();
    await page.getByText('Renamed 3 of 3 items.', { exact: true }).waitFor();
    for (const name of ['d', 'e', 'f']) {
      assert.equal(await exists(join(source, `${name}-old.txt`)), false, `${name}-old renamed`);
      assert.equal(await readFile(join(source, `${name}-new.txt`), 'utf8'), `${name}-old.txt\n`);
    }
    assert.equal(await bar.count(), 0, 'Renamed items leave the selection');

    // Ctrl-click picks an item outside selection mode.
    await page.getByRole('button', { name: 'Done selecting', exact: true }).click();
    await page
      .getByRole('button', { name: 'Open bulk-ops/c.txt', exact: true })
      .click({ modifiers: ['Control'] });
    await bar.getByText('1 selected', { exact: true }).waitFor();
    await bar.getByRole('button', { name: 'Delete selected…', exact: true }).click();
    await page
      .getByRole('dialog', { name: 'Delete 1 selected item', exact: true })
      .getByRole('button', { name: 'Delete 1', exact: true })
      .click();
    await page.getByText('Deleted 1 of 1 items.', { exact: true }).waitFor();
    await waitFor(async () => !(await exists(join(source, 'c.txt'))), 'Selected file deleted');
    console.log(
      'PASS: native bulk file actions: move two picked files, rename three with one refused existing target, Ctrl-click delete',
    );
  } finally {
    await rm(source, { recursive: true, force: true });
    await rm(target, { recursive: true, force: true });
    // A dialog left open by a failed step must not replace that failure with a cleanup timeout;
    // its message is printed first so the failure stays diagnosable.
    const open = page.locator('dialog[open] .session-error, dialog[open] [role="alert"]');
    for (const text of await open.allInnerTexts().catch(() => []))
      console.error(`Bulk dialog message: ${text}`);
    await page.keyboard.press('Escape').catch(() => {});
    await page
      .getByRole('button', { name: 'Refresh file manager', exact: true })
      .click({ timeout: 5000 })
      .catch(() => {});
  }
}
