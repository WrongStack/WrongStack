import assert from 'node:assert/strict';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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

    // Bulk copy: text is copied from the saved file; an existing target is never overwritten.
    await writeFile(join(source, 'b.txt'), 'existing b\n');
    await page.getByRole('button', { name: 'Refresh file manager', exact: true }).click();
    await tree.getByRole('treeitem', { name: 'bulk-dest', exact: true }).click();
    await page.getByRole('button', { name: 'Select bulk-dest/a.txt', exact: true }).click();
    await page.getByRole('button', { name: 'Select bulk-dest/b.txt', exact: true }).click();
    await bar.getByRole('button', { name: 'Copy selected…', exact: true }).click();
    const copyDialog = page.getByRole('dialog', { name: 'Copy 2 selected items', exact: true });
    await copyDialog.getByLabel('Bulk copy destination', { exact: true }).fill('bulk-ops');
    await copyDialog.getByRole('button', { name: 'Copy 2 to bulk-ops', exact: true }).click();
    await page.getByText(/^Copied 1 of 2 items\. Failed: bulk-dest\/b\.txt \(/).waitFor();
    assert.equal(await readFile(join(source, 'a.txt'), 'utf8'), 'a.txt\n', 'Copied text');
    assert.equal(await readFile(join(target, 'a.txt'), 'utf8'), 'a.txt\n', 'Source kept');
    assert.equal(await readFile(join(source, 'b.txt'), 'utf8'), 'existing b\n', 'Not overwritten');
    await bar.getByRole('button', { name: 'Clear selection', exact: true }).click();
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
    await rename.getByRole('button', { name: 'Rename 3', exact: true }).click();
    await page.getByText(/^Renamed 2 of 3 items\. Failed: bulk-ops\/f-old\.txt \(/).waitFor();
    for (const name of ['d-new.txt', 'e-new.txt', 'f-old.txt'])
      assert.equal(await exists(join(source, name)), true, `${name} exists after the rename`);
    for (const name of ['d-old.txt', 'e-old.txt'])
      assert.equal(await exists(join(source, name)), false, `${name} was renamed`);
    assert.equal(await readFile(join(source, 'f-new.txt'), 'utf8'), 'f-new.txt\n');
    await bar.getByText('1 selected', { exact: true }).waitFor();
    await bar.getByRole('button', { name: 'Clear selection', exact: true }).click();

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
    await page.getByRole('button', { name: 'Refresh file manager', exact: true }).click();
  }
}
