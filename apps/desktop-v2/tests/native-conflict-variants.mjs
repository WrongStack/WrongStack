import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export async function exerciseNativeConflictVariants({ page, project, artifactDir }) {
  assert.ok(
    project.root.includes('wrongstack-desktop-v2-'),
    'Git fixtures stay in the isolated native test project',
  );
  const git = (...args) =>
    execFileSync('git', args, {
      cwd: project.root,
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  const commit = (message, paths = []) =>
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
      ...(paths.length ? ['--', ...paths] : []),
    );
  // Finish the preceding test's already-reviewed merge only as fixture setup.
  commit('Complete preceding native merge fixture');
  const branch = git('branch', '--show-current').trim();
  const apply = async (files) => {
    for (const [path, bytes] of Object.entries(files)) {
      const absolute = join(project.root, path);
      if (bytes === null) await rm(absolute, { force: true });
      else {
        await mkdir(dirname(absolute), { recursive: true });
        await writeFile(absolute, bytes);
      }
    }
    git('add', '-A', '--', ...Object.keys(files));
  };
  const setup = async (name, base, ours, theirs) => {
    const initial = { ['native-' + name + '-seed.txt']: 'seed\n', ...base };
    await apply(initial);
    commit('Base ' + name, Object.keys(initial));
    git('checkout', '-b', 'native-' + name + '-other');
    await apply(theirs);
    commit('Theirs ' + name, Object.keys(theirs));
    git('checkout', branch);
    await apply(ours);
    commit('Ours ' + name, Object.keys(ours));
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
        'native-' + name + '-other',
      ),
    );
    assert.ok(git('ls-files', '-u').length, 'Fixture has real unmerged index stages');
  };
  const dialog = () => page.getByRole('dialog', { name: 'Resolve merge conflict', exact: true });
  const open = async (path) => {
    await page.getByRole('button', { name: 'Refresh file manager', exact: true }).click();
    // A change row is named by its visible text: the file name, then its folder.
    const esc = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const name = path.split('/').at(-1);
    const folder = path.slice(0, -name.length - 1);
    await page
      .getByRole('button', { name: new RegExp(`^${esc(name)} ${folder ? `${esc(folder)} ` : ''}`) })
      .click();
    await page.getByRole('button', { name: 'Resolve merge conflict', exact: true }).click();
    await dialog()
      .getByRole('region', { name: 'Common base content', exact: true })
      .waitFor({ timeout: 60000 });
    return dialog();
  };
  const save = async (deleted = false) => {
    await dialog()
      .getByRole('button', {
        name: deleted ? 'Delete file & mark resolved' : 'Save & mark resolved',
        exact: true,
      })
      .click();
    await dialog().waitFor({ state: 'hidden', timeout: 60000 });
  };

  await setup(
    'add-add',
    {},
    { 'native-added.txt': 'ours added\n' },
    { 'native-added.txt': 'theirs added\n' },
  );
  await open('native-added.txt');
  await dialog()
    .getByRole('region', { name: 'Common base content', exact: true })
    .getByText('Not present in this side.', { exact: true })
    .waitFor();
  await dialog().getByRole('button', { name: 'Use ours', exact: true }).click();
  assert.ok(
    (await readFile(join(project.root, 'native-added.txt'), 'utf8')).includes('<<<<<<<'),
    'Picking a side does not save',
  );
  await page.screenshot({ path: join(artifactDir, 'native-conflict-add-add.png'), fullPage: true });
  await save();
  assert.equal(git('show', ':native-added.txt'), 'ours added\n');
  commit('Complete add/add fixture');

  const deleted = 'native-deleted/entry.txt';
  await setup(
    'modify-delete',
    { [deleted]: 'base\n' },
    { [deleted]: null },
    { [deleted]: 'theirs modified\n' },
  );
  await open(deleted);
  assert.equal(
    await dialog().getByRole('button', { name: 'Use ours', exact: true }).isDisabled(),
    true,
  );
  await dialog()
    .getByRole('region', { name: 'Ours content', exact: true })
    .getByText('Not present in this side.', { exact: true })
    .waitFor();
  await dialog().getByRole('button', { name: 'Resolve by deleting file', exact: true }).click();
  await page.screenshot({
    path: join(artifactDir, 'native-conflict-modify-delete.png'),
    fullPage: true,
  });
  await save(true);
  assert.equal(git('ls-files', '--', deleted), '');
  await assert.rejects(access(join(project.root, deleted)));
  commit('Complete modify/delete fixture');

  const base = Buffer.from([0, 1, 255]),
    ours = Buffer.from([0, 2, 254]),
    theirs = Buffer.from([0, 3, 253]);
  await setup(
    'binary',
    { 'native-asset.bin': base },
    { 'native-asset.bin': ours },
    { 'native-asset.bin': theirs },
  );
  await page.getByRole('button', { name: 'Switch to dark mode', exact: true }).click();
  await open('native-asset.bin');
  assert.equal(await dialog().getByLabel('Merged conflict result', { exact: true }).count(), 0);
  await dialog()
    .getByRole('region', { name: 'Theirs content', exact: true })
    .getByText('Binary file', { exact: true })
    .waitFor();
  assert.equal(
    await dialog().getByRole('button', { name: 'Save & mark resolved', exact: true }).isDisabled(),
    true,
  );
  await dialog().getByRole('button', { name: 'Use theirs', exact: true }).click();
  await page.screenshot({
    path: join(artifactDir, 'native-conflict-binary-dark.png'),
    fullPage: true,
  });
  await page.setViewportSize({ width: 800, height: 640 });
  assert.equal(
    await dialog().evaluate((element) => element.scrollWidth > element.clientWidth),
    false,
  );
  await page.screenshot({
    path: join(artifactDir, 'native-conflict-binary-compact.png'),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1480, height: 960 });
  await save();
  assert.deepEqual(await readFile(join(project.root, 'native-asset.bin')), theirs);
  assert.deepEqual(
    execFileSync('git', ['show', ':native-asset.bin'], { cwd: project.root, windowsHide: true }),
    theirs,
  );
  await page.getByRole('button', { name: 'Switch to light mode', exact: true }).click();
  commit('Complete binary fixture');

  const body = 'Native rename body remains intact.\n';
  await setup(
    'rename-rename',
    { 'native-old.txt': body },
    { 'native-old.txt': null, 'native-ours.txt': body },
    { 'native-old.txt': null, 'native-theirs.txt': body },
  );
  const unselectedRenameBytes = await readFile(join(project.root, 'native-theirs.txt'));
  await open('native-old.txt');
  await dialog()
    .getByRole('region', { name: 'Unresolved project paths', exact: true })
    .getByText('3 unresolved paths in this project', { exact: true })
    .waitFor();
  assert.equal(
    await dialog().getByRole('button', { name: 'Use ours', exact: true }).isDisabled(),
    true,
  );
  assert.equal(
    await dialog().getByRole('button', { name: 'Use theirs', exact: true }).isDisabled(),
    true,
  );
  await page.screenshot({
    path: join(artifactDir, 'native-conflict-rename-paths.png'),
    fullPage: true,
  });
  await dialog().getByRole('button', { name: 'Resolve by deleting file', exact: true }).click();
  await save(true);
  assert.ok(git('ls-files', '-u', '--', 'native-ours.txt').length > 0);
  assert.ok(git('ls-files', '-u', '--', 'native-theirs.txt').length > 0);
  assert.deepEqual(await readFile(join(project.root, 'native-theirs.txt')), unselectedRenameBytes);
  await open('native-ours.txt');
  await dialog().getByRole('button', { name: 'Use ours', exact: true }).click();
  await save();
  await open('native-theirs.txt');
  await dialog().getByRole('button', { name: 'Resolve by deleting file', exact: true }).click();
  await save(true);
  assert.equal(git('ls-files', '-u'), '');
  assert.equal(git('show', ':native-ours.txt'), body);
  assert.equal(git('ls-files', '--', 'native-old.txt', 'native-theirs.txt'), '');
  assert.ok(
    git('rev-parse', '--verify', 'MERGE_HEAD').trim(),
    'The resolver still does not create a commit',
  );
  console.log(
    'PASS: native add/add absence, explicit modify/delete, byte-exact binary choice, dark/compact review and rename/rename path choices without implicit sibling deletion or commits',
  );
}
