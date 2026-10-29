import assert from 'node:assert/strict';
import { join } from 'node:path';
export async function exerciseNativeEvidence({ page, rpc, project, waitFor, artifactDir }) {
  const tool = (name) =>
    page
      .getByRole('navigation', { name: `${project.name} workspace` })
      .getByRole('button', { name, exact: true });
  await tool('Changes').click();
  await page.getByRole('button', { name: 'History', exact: true }).click();
  await page
    .getByRole('button', { name: 'Inspect commit Native file review baseline', exact: true })
    .click();
  await page.getByRole('heading', { name: 'Native file review baseline', exact: true }).waitFor();
  await page
    .getByRole('button', { name: 'View committed diff review-fixture.ts', exact: true })
    .click();
  await page
    .locator('.git-commit-diff .diff-code-lines')
    .filter({ hasText: 'reviewed = 1' })
    .waitFor();
  await page.getByRole('button', { name: 'Side by side diff', exact: true }).click();
  await page.locator('.git-commit-diff .diff-split').waitFor();
  await page.getByLabel('History branch or tag').selectOption('refs/heads/main');
  await page
    .getByRole('button', { name: 'Inspect commit Native file review baseline', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'View committed diff review-fixture.ts', exact: true })
    .click();
  await page.locator('.git-commit-diff .diff-code-lines').waitFor();
  await page.screenshot({ path: join(artifactDir, 'native-git-history.png'), fullPage: true });
  await page.locator('.git-commit-diff').scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(artifactDir, 'native-git-commit-diff.png'), fullPage: true });
  await page.setViewportSize({ width: 800, height: 640 });
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
    false,
    'Commit history fits a compact desktop',
  );
  await page.setViewportSize({ width: 1480, height: 960 });
  await page.getByRole('button', { name: 'Open working file', exact: true }).click();
  await page.locator('.native-file-content').filter({ hasText: 'reviewed = 2' }).waitFor();
  await tool('Chronicle').click();
  const insights = page.locator('.chronicle-insights');
  await insights.locator('summary').click();
  await insights.getByText('fixture-provider / fixture-model', { exact: true }).waitFor();
  await insights.getByRole('button', { name: 'tasks', exact: true }).click();
  await insights.getByText('fixture-task', { exact: true }).waitFor();
  await insights.getByRole('button', { name: 'files', exact: true }).click();
  await insights.getByText('review-fixture.ts', { exact: true }).first().waitFor();
  await insights.getByRole('button', { name: 'Open project file', exact: true }).first().waitFor();
  await page.screenshot({
    path: join(artifactDir, 'native-chronicle-insights.png'),
    fullPage: true,
  });
  await insights.locator('summary').click();
  await page.getByLabel('Search Chronicle', { exact: true }).fill('Native Chronicle');
  await page.getByRole('button', { name: 'Apply filters', exact: true }).click();
  await page.getByRole('button', { name: 'Load older events', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Load older events', exact: true }).click();
  await waitFor(
    async () => (await page.locator('.chronicle-events > button').count()) === 105,
    'Chronicle cursor pagination',
  );
  // A provider request event shows the prompt manifest it recorded as structured sections.
  await page.getByLabel('Search Chronicle', { exact: true }).fill('');
  await page.getByLabel('Chronicle eventType').selectOption('provider.attempt.started');
  await page.getByRole('button', { name: 'Apply filters', exact: true }).click();
  await waitFor(
    async () => (await page.locator('.chronicle-events > button').count()) === 1,
    'Chronicle provider event filtering',
  );
  await page.getByRole('button', { name: 'Inspect Metrics fixture', exact: true }).click();
  const manifest = page.getByRole('region', { name: 'Prompt manifest', exact: true });
  await manifest.waitFor();
  assert.deepEqual(
    await manifest
      .getByRole('table', { name: 'System prompt composition', exact: true })
      .locator('tbody td:first-child')
      .allInnerTexts(),
    ['identity', 'project-instructions'],
  );
  await manifest.getByText('9 earlier messages are not itemised', { exact: false }).waitFor();
  assert.ok((await manifest.innerText()).includes('read, edit'));
  await page.getByLabel('Search Chronicle', { exact: true }).fill('Native Chronicle');
  await page.getByLabel('Chronicle eventType').selectOption('tool.completed');
  await page.getByRole('button', { name: 'Apply filters', exact: true }).click();
  await waitFor(
    async () => (await page.locator('.chronicle-events > button').count()) === 1,
    'Chronicle canonical event filtering',
  );
  await page
    .getByRole('button', { name: 'Inspect Native Chronicle review completed', exact: true })
    .click();
  await page
    .getByLabel('Chronicle event details')
    .getByRole('heading', { name: 'Recorded evidence', exact: true })
    .waitFor();
  await page.screenshot({
    path: join(artifactDir, 'native-chronicle-timeline.png'),
    fullPage: true,
  });
  await page.getByRole('button', { name: 'Trace related events', exact: true }).click();
  await waitFor(
    async () =>
      (await page
        .getByLabel('Chronicle evidence lineage', { exact: true })
        .locator('.graph-node')
        .count()) >= 3,
    'Chronicle actual evidence graph',
  );
  await page.getByLabel('Chronicle evidence lineage', { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({
    path: join(artifactDir, 'native-chronicle-lineage.png'),
    fullPage: true,
  });
  await page.getByRole('button', { name: 'Switch to dark mode', exact: true }).click();
  await page.setViewportSize({ width: 800, height: 640 });
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
    false,
    'Chronicle fits a compact desktop',
  );
  assert.equal(
    await page
      .locator('.project-page-content')
      .evaluate((element) => element.scrollWidth > element.clientWidth + 1),
    false,
    'Chronicle content has no hidden horizontal overflow',
  );
  await page.screenshot({
    path: join(artifactDir, 'native-chronicle-compact-dark.png'),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1480, height: 960 });
  await page.getByRole('button', { name: 'Switch to light mode', exact: true }).click();
  await page.getByRole('button', { name: 'Open project file', exact: true }).click();
  await page.locator('.native-file-content').filter({ hasText: 'reviewed = 2' }).waitFor();
  assert.equal(
    (await rpc('snapshot')).sessions.length,
    0,
    'Chronicle and repository history need no conversation',
  );
  console.log(
    'PASS: native commit history/ref/file diff and project Chronicle filters/pagination/evidence graph/file navigation without sessions',
  );
}
