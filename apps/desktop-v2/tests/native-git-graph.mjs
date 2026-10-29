import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** A real side branch merged with --no-ff is drawn in its own lane and joins at the merge. */
export async function exerciseNativeGitGraph({ page, project, artifactDir }) {
  const git = (...args) =>
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Native Test',
        '-c',
        'user.email=native@example.invalid',
        '-c',
        'core.hooksPath=disabled',
        ...args,
      ],
      { cwd: project.root, encoding: 'utf8', windowsHide: true },
    ).trim();
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
  const commit = async (file, message) => {
    await writeFile(join(project.root, file), `${message}\n`);
    git('add', '--', file);
    git('commit', '-m', message, '--', file);
  };
  git('checkout', '-b', 'native-graph-side');
  await commit('graph-side.txt', 'Graph side change');
  git('checkout', branch);
  await commit('graph-main.txt', 'Graph main change');
  git('merge', '--no-ff', 'native-graph-side', '-m', 'Graph merge');

  await page
    .getByRole('navigation', { name: `${project.name} workspace` })
    .getByRole('button', { name: 'Changes', exact: true })
    .click();
  await page.getByRole('button', { name: 'History', exact: true }).click();
  const row = (subject) =>
    page.getByRole('button', { name: `Inspect commit ${subject}`, exact: true });
  await row('Graph merge').waitFor();
  const node = (subject) => row(subject).locator('circle.git-graph-node');
  assert.equal(await row('Graph merge').locator('circle.git-graph-merge').count(), 1);
  assert.equal(await node('Graph merge').getAttribute('cx'), '6');
  assert.equal(
    await node('Graph main change').getAttribute('cx'),
    '6',
    'First parent keeps lane 0',
  );
  assert.equal(await node('Graph side change').getAttribute('cx'), '18', 'Merged branch in lane 1');
  assert.equal(await row('Graph merge').locator('svg').getAttribute('width'), '24');
  await page.screenshot({ path: join(artifactDir, 'native-git-graph.png'), fullPage: true });
  // A search filters rows, so lanes would lie; plain markers are shown instead.
  await page.getByLabel('Search loaded commits', { exact: true }).fill('Graph');
  await row('Graph side change').waitFor();
  assert.equal(await page.locator('.git-graph-cell').count(), 0);
  await page.getByLabel('Search loaded commits', { exact: true }).fill('');
  console.log('PASS: native Git history graph: --no-ff merge lanes, merge marker and plain search');
}
