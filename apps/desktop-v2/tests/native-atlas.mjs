import assert from 'node:assert/strict';
import { join } from 'node:path';
export async function exerciseNativeAtlas({
  page,
  rpc,
  project,
  waitFor,
  artifactDir,
  boundariesOnly = false,
}) {
  const tool = (name) =>
    page
      .getByRole('navigation', { name: `${project.name} workspace` })
      .getByRole('button', { name, exact: true });
  await tool('Code Atlas').click();
  await page.getByRole('button', { name: 'Select @fixture/alpha', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Select @fixture/large', exact: true }).dblclick();
  const canonical = await rpc('project.http', {
    projectId: project.id,
    method: 'GET',
    resource: `/api/codemap/files?package=${encodeURIComponent('@fixture/large')}`,
  });
  assert.ok(
    canonical.data.nodes.length > 160,
    'Large fixture exercises the old truncation boundary',
  );
  await page.getByRole('button', { name: 'All nodes', exact: true }).click();
  await waitFor(
    async () => (await page.locator('.graph-node').count()) === canonical.data.nodes.length,
    'All indexed file nodes render beyond the previous 160-node cut',
  );
  await page.getByRole('button', { name: 'Smart scope', exact: true }).click();
  await waitFor(
    async () => (await page.locator('.graph-node').count()) === 160,
    'Explicit Smart node budget',
  );
  await page.getByLabel('Sort atlas nodes', { exact: true }).selectOption('name');
  await page.getByRole('button', { name: 'Show more nodes', exact: true }).click();
  await page.getByRole('button', { name: 'Select late-180.ts', exact: true }).click();
  await page.locator('.graph-node').getByText('late-180.ts', { exact: true }).waitFor();
  await page.screenshot({
    path: join(artifactDir, 'native-atlas-large-scope.png'),
    fullPage: true,
  });
  const views = page.getByRole('navigation', { name: 'Atlas views', exact: true });
  await views.getByRole('button').filter({ hasText: 'Subsystems' }).click();
  const largeMap = page.getByRole('region', { name: 'Collapsible subsystem map', exact: true });
  assert.equal(await largeMap.locator('.graph-node').count(), 1);
  await largeMap.getByRole('button', { name: 'Expand @fixture/large', exact: true }).click();
  assert.equal(await largeMap.locator('.graph-node').count(), 160);
  await page.getByRole('button', { name: 'All nodes', exact: true }).click();
  await waitFor(
    async () => (await largeMap.locator('.graph-node').count()) === canonical.data.nodes.length,
    'Expanded boundary honors All nodes beyond 160',
  );
  await largeMap.getByRole('button', { name: 'Collapse all subsystems', exact: true }).click();
  assert.equal(await largeMap.locator('.graph-node').count(), 1);
  await views.getByRole('button').filter({ hasText: 'Architecture' }).click();
  await page.getByRole('button', { name: 'Smart scope', exact: true }).click();
  await page.getByRole('button', { name: 'Packages', exact: true }).click();
  await page.getByRole('button', { name: 'Select @fixture/alpha', exact: true }).waitFor();
  await views.getByRole('button').filter({ hasText: 'Subsystems' }).click();
  await page.getByRole('region', { name: 'Atlas subsystems', exact: true }).waitFor();
  assert.ok((await page.locator('.atlas-subsystem-card').count()) > 0);
  const boundaries = page.getByRole('region', { name: 'Collapsible subsystem map', exact: true });
  await boundaries.getByRole('heading', { name: 'Boundary map', exact: true }).waitFor();
  const expansion = boundaries.getByRole('group', {
    name: 'Subsystem expansion controls',
    exact: true,
  });
  const groupCount = await expansion.getByRole('button').count();
  assert.ok(groupCount > 0);
  assert.equal(await boundaries.locator('.graph-node').count(), groupCount);
  for (const button of await expansion.getByRole('button').all()) await button.click();
  await boundaries.getByRole('button', { name: '@fixture/alpha', exact: true }).click();
  const boundaryDetail = boundaries.getByRole('complementary', {
    name: 'Selected subsystem boundary',
    exact: true,
  });
  assert.ok((await boundaryDetail.innerText()).includes('@fixture/beta'));
  assert.ok((await boundaryDetail.innerText()).includes('stored weight'));
  await page.screenshot({
    path: join(artifactDir, 'native-atlas-expanded-boundaries.png'),
    fullPage: true,
  });
  await page.setViewportSize({ width: 800, height: 640 });
  await boundaries
    .getByRole('region', { name: 'Subsystem boundary graph', exact: true })
    .scrollIntoViewIfNeeded();
  assert.equal(
    await boundaries.evaluate((element) => element.scrollWidth > element.clientWidth),
    false,
  );
  await page.screenshot({
    path: join(artifactDir, 'native-atlas-boundaries-compact.png'),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1480, height: 960 });
  const darkMode = page.getByRole('button', { name: 'Switch to dark mode', exact: true });
  if (await darkMode.count()) {
    await darkMode.click();
    await page.screenshot({
      path: join(artifactDir, 'native-atlas-boundaries-dark.png'),
      fullPage: true,
    });
    await page.getByRole('button', { name: 'Switch to light mode', exact: true }).click();
  }
  await boundaries.getByRole('button', { name: 'Collapse all subsystems', exact: true }).click();
  assert.equal(await boundaries.locator('.graph-node').count(), groupCount);
  assert.equal(await boundaryDetail.count(), 0);
  // Communities inferred from stored references are opt-in here (the index stored packages).
  const grouping = page.getByRole('group', { name: 'Group nodes by', exact: true });
  await grouping.getByRole('button', { name: 'Inferred communities', exact: true }).click();
  await page.getByText('Inferred communities are computed here', { exact: false }).waitFor();
  const inferredNames = await page.locator('.atlas-subsystem-card h3').allInnerTexts();
  assert.ok(
    inferredNames.length > 0 &&
      inferredNames.every((name) => name.startsWith('Inferred: ') || name === 'Unconnected'),
    inferredNames.join(' | '),
  );
  await grouping.getByRole('button', { name: 'Stored subsystems', exact: true }).click();
  assert.equal(await boundaries.locator('.graph-node').count(), groupCount);
  await page.getByLabel('Search code atlas', { exact: true }).fill('no-boundary-match');
  await boundaries
    .getByText('No indexed nodes match the current filters.', { exact: true })
    .waitFor();
  assert.equal(await boundaries.locator('.graph-node').count(), 0);
  await page.getByLabel('Search code atlas', { exact: true }).fill('');
  await boundaries.locator('.graph-node').first().waitFor();
  await page.screenshot({ path: join(artifactDir, 'native-atlas-subsystems.png'), fullPage: true });
  if (boundariesOnly) {
    assert.equal(
      (await rpc('snapshot')).sessions.length,
      0,
      'Boundary exploration creates no desktop conversations',
    );
    console.log(
      'PASS: actual indexed boundary collapse/expand, directed reference inspector, selected real member, empty filter, compact/dark views and zero conversations',
    );
    return;
  }
  await views.getByRole('button').filter({ hasText: 'Dependency matrix' }).click();
  await page.getByRole('region', { name: 'Atlas dependency matrix', exact: true }).waitFor();
  assert.ok((await page.locator('.matrix-reference').count()) > 0);
  await page.screenshot({ path: join(artifactDir, 'native-atlas-matrix.png'), fullPage: true });
  await views.getByRole('button').filter({ hasText: 'Change impact' }).click();
  await page
    .getByLabel('Impact starting node', { exact: true })
    .selectOption({ label: '@fixture/beta' });
  await page.getByLabel('Impact direction', { exact: true }).selectOption('incoming');
  await page
    .getByRole('region', { name: 'Atlas impact analysis', exact: true })
    .locator('.atlas-impact-ring strong')
    .filter({ hasText: /^@fixture\/alpha$/ })
    .waitFor();
  await page.screenshot({ path: join(artifactDir, 'native-atlas-impact.png'), fullPage: true });
  await views.getByRole('button').filter({ hasText: 'Architecture' }).click();
  for (const layout of ['orbit', 'clusters', 'layers']) {
    await page.getByLabel('Atlas layout').selectOption(layout);
    await page.getByLabel('Graph overview', { exact: true }).waitFor();
    assert.ok((await page.locator('.graph-node').count()) >= 2);
  }
  await page.getByRole('button', { name: 'Guided tour', exact: true }).click();
  await page.getByRole('region', { name: 'Guided architecture tour' }).waitFor();
  await page.getByRole('button', { name: 'Next architecture tour stop', exact: true }).click();
  await page.getByRole('button', { name: 'Close architecture tour', exact: true }).click();
  await page.getByRole('button', { name: 'Select @fixture/alpha', exact: true }).dblclick();
  const alphaSource = page
    .locator('.atlas-explorer section')
    .filter({ has: page.getByRole('heading', { name: 'packages/alpha/src', exact: true }) })
    .getByRole('button', { name: 'Select index.ts', exact: true });
  await alphaSource.waitFor();
  await alphaSource.dblclick();
  await page.getByRole('button', { name: 'Select feature', exact: true }).click();
  await page.getByLabel('Sort atlas nodes').selectOption('name');
  await page.getByLabel('Dependency path target').selectOption({ label: 'shared' });
  await page.getByRole('button', { name: 'Find shortest path', exact: true }).click();
  await waitFor(
    async () => (await page.locator('.graph-path-node').count()) === 2,
    'Directed dependency path highlight',
  );
  await page
    .locator('.atlas-institutional-memory')
    .getByText('Native SAGE proposal keeps file boundaries explicit.', { exact: true })
    .waitFor();
  await page.getByRole('button', { name: 'File history & actors', exact: false }).click();
  await page.getByRole('button', { name: 'Read source', exact: true }).click();
  await page.locator('.atlas-source pre').filter({ hasText: 'feature' }).waitFor();
  await page.screenshot({ path: join(artifactDir, 'native-atlas-analysis.png'), fullPage: true });
  await page.getByRole('button', { name: 'Open in file workspace', exact: false }).click();
  await page.locator('.native-file-content').filter({ hasText: 'feature' }).waitFor();
  assert.equal((await rpc('snapshot')).sessions.length, 0, 'Atlas analysis is project-owned');
  console.log(
    'PASS: native Atlas subsystem view/dependency matrix/change impact, three layouts/minimap/tour/dependency path/SAGE provenance/history/source/file workspace',
  );
}
