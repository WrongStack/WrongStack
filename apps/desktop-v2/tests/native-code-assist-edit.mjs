import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * An editing Code Assist run really writes the file; the panel compares it with the content
 * read before the run, refuses to restore over a newer disk edit, and restores exactly.
 */
export async function exerciseNativeCodeAssistEdit({ page, waitFor, artifactDir, projectRoot }) {
  const file = join(projectRoot, 'README.md');
  const original = await readFile(file, 'utf8');
  await page
    .getByRole('navigation', { name: 'Agent workspace views' })
    .getByRole('button', { name: 'Files', exact: true })
    .click();
  await page.getByRole('treeitem', { name: 'README.md', exact: true }).click();
  if (await page.getByRole('button', { name: 'Expand file details', exact: true }).count())
    await page.getByRole('button', { name: 'Expand file details', exact: true }).click();
  await page
    .locator('.file-evidence-drawer')
    .getByRole('button', { name: 'Ask AI', exact: true })
    .click();
  await page.getByLabel('Code analysis preset', { exact: true }).selectOption('custom');
  await page
    .getByLabel('Question about code', { exact: true })
    .fill('[native-code-assist-edit] Rewrite the heading of this file.');
  await page.getByLabel('Allow changes to project files', { exact: true }).check();
  await page.getByRole('button', { name: 'Run analysis', exact: true }).click();
  const review = page.getByRole('region', { name: 'Changes from this run', exact: true });
  await review.getByText('Changed by this run or since it started', { exact: true }).waitFor({
    timeout: 60000,
  });
  assert.equal((await readFile(file, 'utf8')).trim(), '# Native Code Assist edit');
  await review.locator('.diff-code-lines').filter({ hasText: 'Native Code Assist edit' }).waitFor();
  await page.screenshot({ path: join(artifactDir, 'native-code-assist-edit.png'), fullPage: true });
  // A newer disk edit is never overwritten by the restore.
  const edited = await readFile(file, 'utf8');
  await writeFile(file, 'A newer edit after the run\n');
  await review
    .getByRole('button', { name: 'Restore content from before this run', exact: true })
    .click();
  await review.getByRole('alert').filter({ hasText: 'Nothing was restored' }).waitFor();
  assert.equal(await readFile(file, 'utf8'), 'A newer edit after the run\n');
  await writeFile(file, edited);
  await review
    .getByRole('button', { name: 'Restore content from before this run', exact: true })
    .click();
  await review.getByRole('status').filter({ hasText: 'Restored the content' }).waitFor();
  await waitFor(async () => (await readFile(file, 'utf8')) === original, 'Original restored');
  console.log(
    'PASS: native Code Assist edit: real write, before/after comparison, refused stale restore and exact restore',
  );
}
