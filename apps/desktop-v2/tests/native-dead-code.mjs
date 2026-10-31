import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { openProjectView, revealProjectTools } from './native-project-navigation.mjs';

export async function exerciseNativeDeadCode({
  page,
  rpc,
  project,
  otherProject,
  root,
  waitFor,
  artifactDir,
}) {
  const folder = join(root, 'dead-proof');
  await mkdir(join(folder, 'src'), { recursive: true });
  await writeFile(
    join(folder, 'package.json'),
    JSON.stringify({ name: 'native-dead-proof', private: true, main: './src/main.ts' }),
  );
  await writeFile(
    join(folder, 'src/main.ts'),
    "import { kept } from './lib';\nconsole.log(kept());\n",
  );
  const source =
    "export function kept() { return 'kept'; }\nexport function removeNativeDead() { return 'unused'; }\n";
  const file = join(folder, 'src/lib.ts');
  await writeFile(file, source);
  const open = async (owner) => {
    await page.locator('.project-item').filter({ hasText: owner.name }).click();
    await revealProjectTools(page, owner);
    await openProjectView(page, owner, 'Dead Code');
    await page.getByRole('region', { name: 'Project dead-code workspace' }).waitFor();
  };
  const count = (await rpc('snapshot')).sessions.length;
  await open(project);
  let screen = page.getByRole('region', { name: 'Project dead-code workspace' });
  await screen
    .getByRole('textbox', { name: 'Dead-code report scope', exact: true })
    .fill('dead-proof');
  await screen.getByRole('button', { name: 'Scan dead code', exact: true }).click();
  const finding = screen
    .locator('.dead-code-findings article')
    .filter({ hasText: 'removeNativeDead' });
  await finding.waitFor({ timeout: 100000 });
  assert.equal((await rpc('snapshot')).sessions.length, count);
  await finding.getByRole('checkbox').check();
  await screen.getByRole('button', { name: 'Preview selected fixes', exact: true }).click();
  await screen.getByRole('heading', { name: 'Review the exact changes', exact: true }).waitFor();
  assert.equal(await readFile(file, 'utf8'), source, 'Preview does not change project files');
  await screen.getByRole('button', { name: 'Review cleanup execution', exact: true }).click();
  await screen.getByRole('button', { name: 'Keep reviewing changes', exact: true }).click();
  assert.equal(
    await readFile(file, 'utf8'),
    source,
    'Cancelling confirmation leaves source intact',
  );
  await screen
    .getByRole('heading', { name: 'Review the exact changes', exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: join(artifactDir, 'native-dead-code-preview.png'),
    fullPage: true,
  });
  // Explicitly exercise the unverified mode; this does not claim typecheck success.
  await screen
    .getByRole('checkbox', { name: 'Run typecheck and roll back failed changes', exact: true })
    .uncheck();
  await screen.getByRole('button', { name: 'Review cleanup execution', exact: true }).click();
  await screen.getByRole('button', { name: 'Apply reviewed fixes', exact: true }).click();
  await screen
    .getByRole('heading', { name: 'Cleanup completed', exact: true })
    .waitFor({ timeout: 100000 });
  await waitFor(
    async () => !(await readFile(file, 'utf8')).includes('removeNativeDead'),
    'Native dead-code applied source',
  );
  assert.ok((await readFile(file, 'utf8')).includes('kept'));
  await screen.getByRole('heading', { name: /Recovery backups \(1\)/ }).waitFor();
  // Results and backups belong to the project even after its component has been replaced.
  await open(otherProject);
  await page
    .getByRole('heading', { name: 'Find the code your project no longer reaches.', exact: true })
    .waitFor();
  assert.equal(
    await page.getByRole('heading', { name: 'Cleanup completed', exact: true }).count(),
    0,
  );
  await open(project);
  screen = page.getByRole('region', { name: 'Project dead-code workspace' });
  await screen.getByRole('heading', { name: 'Cleanup completed', exact: true }).waitFor();
  assert.equal(
    await screen.getByRole('textbox', { name: 'Dead-code report scope', exact: true }).inputValue(),
    'dead-proof',
  );
  await screen.getByRole('button', { name: 'Review restore backup', exact: true }).first().click();
  await screen.getByRole('button', { name: 'Keep current files', exact: true }).click();
  assert.ok(!(await readFile(file, 'utf8')).includes('removeNativeDead'));
  // A newer source edit must refuse ordinary restoration before an explicit overwrite.
  await writeFile(file, `${await readFile(file, 'utf8')}// newer edit\n`);
  await screen.getByRole('button', { name: 'Review restore backup', exact: true }).first().click();
  await screen
    .getByRole('button', { name: 'Restore selected cleanup backup', exact: true })
    .click();
  await screen.getByRole('heading', { name: 'Files changed after cleanup', exact: true }).waitFor();
  assert.ok((await readFile(file, 'utf8')).includes('// newer edit'));
  await screen
    .getByRole('button', { name: 'Overwrite conflicts from backup', exact: true })
    .click();
  await screen.getByText('1 file restored.', { exact: true }).waitFor();
  assert.equal(await readFile(file, 'utf8'), source);
  await screen.getByRole('heading', { name: 'Dead Code.', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({
    path: join(artifactDir, 'native-dead-code-recovery.png'),
    fullPage: true,
  });
  await page.setViewportSize({ width: 800, height: 640 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({
    path: join(artifactDir, 'native-dead-code-compact.png'),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1480, height: 960 });
  assert.equal((await rpc('snapshot')).sessions.length, count);
  console.log(
    'PASS: native dead-code real scan/selection/exact preview/cancel, explicit unverified apply, retained project result, backups, conflict refusal/confirmed overwrite restoration without conversations',
  );
}
