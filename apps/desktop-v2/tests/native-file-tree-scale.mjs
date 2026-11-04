import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * A folder with thousands of files renders a bounded window of rows, scrolls and
 * keyboard-navigates to its end, and still finds a deep match by search.
 */
export async function exerciseNativeFileTreeScale({ page, project, tool, waitFor, artifactDir }) {
  const count = 3000;
  const folder = join(project.root, 'bulk-tree');
  await mkdir(folder, { recursive: true });
  await Promise.all(
    Array.from({ length: count }, (_, index) =>
      writeFile(join(folder, `item-${String(index).padStart(4, '0')}.txt`), `${index}\n`),
    ),
  );
  try {
    await tool('Files').click();
    await page.getByRole('button', { name: 'Refresh file manager', exact: true }).click();
    const tree = page.getByRole('tree', { name: 'Project directory tree', exact: true });
    await tree.getByRole('treeitem', { name: 'bulk-tree', exact: true }).click();
    const first = tree.getByRole('treeitem', { name: 'bulk-tree/item-0000.txt', exact: true });
    await first.waitFor();
    // The first row can appear before the whole listing has arrived.
    const total = await waitFor(async () => {
      const size = Number(await first.getAttribute('aria-setsize'));
      return size > count ? size : null;
    }, 'The full row count is announced to assistive technology');
    const mounted = await tree.getByRole('treeitem').count();
    assert.ok(mounted < 150, `Only a window of rows is mounted (${mounted} of ${total})`);

    // The folder listing beside the tree pages instead of mounting every file.
    const folderRows = page.locator('.file-folder-row');
    await waitFor(async () => (await folderRows.count()) === 200, 'First folder page');
    await page.getByRole('button', { name: /^Show 200 more · 2800 not shown$/ }).click();
    await waitFor(async () => (await folderRows.count()) === 400, 'Second folder page');

    await first.focus();
    await page.keyboard.press('End');
    const lastPath = await waitFor(async () => {
      const path = await page.evaluate(() =>
        document.activeElement?.getAttribute('data-tree-path'),
      );
      return path && path !== 'bulk-tree/item-0000.txt' ? path : null;
    }, 'End moves focus to the last mounted row');
    assert.equal(
      Number(
        await tree
          .getByRole('treeitem', { name: lastPath, exact: true })
          .getAttribute('aria-posinset'),
      ),
      total,
      'End reaches the last row of the whole tree',
    );
    await page.keyboard.press('Home');
    await waitFor(
      async () =>
        (await page.evaluate(() => document.activeElement?.getAttribute('aria-posinset'))) === '1',
      'Home returns to the first row',
    );
    await page.screenshot({
      path: join(artifactDir, 'native-file-tree-scale.png'),
      fullPage: true,
    });

    await page.getByLabel('Search project files', { exact: true }).fill('item-2999');
    await tree.getByRole('treeitem', { name: 'bulk-tree/item-2999.txt', exact: true }).waitFor();
    assert.ok((await tree.getByRole('treeitem').count()) <= 3, 'Search keeps only matches');
    await page.getByLabel('Search project files', { exact: true }).fill('');
    await tree.getByRole('treeitem', { name: 'bulk-tree', exact: true }).click();
    console.log(
      `PASS: native file tree scale: ${count} files, ${mounted} mounted rows, End/Home across the full tree and search`,
    );
  } finally {
    await rm(folder, { recursive: true, force: true });
    await page.getByRole('button', { name: 'Refresh file manager', exact: true }).click();
  }
}
