import assert from 'node:assert/strict';
import { join } from 'node:path';
import { openProjectView } from './native-project-navigation.mjs';

/** SMART_CANVAS_NODE_LIMIT in packages/project-surfaces/src/atlas/codemap-model.ts. */
const SMART_CANVAS_NODES = 96;

/**
 * The desktop's Code Atlas is the WebUI's shared map (`@wrongstack/project-surfaces/atlas`):
 * a code tree, the dependency canvas and the relation inspector, with the desktop's subsystem,
 * dependency matrix and change impact views as atlas view tabs and its file evidence (SAGE
 * knowledge, history, "Open in file workspace") under the inspector.
 */
export async function exerciseNativeAtlas({
  page,
  rpc,
  project,
  waitFor,
  artifactDir,
  boundariesOnly = false,
}) {
  await openProjectView(page, project, 'Code Atlas');
  const atlas = page.locator('.atlas-surface');
  const tree = atlas.locator('.ws-code-sidebar');
  const canvas = atlas.locator('.ws-code-canvas');
  const inspector = atlas.locator('.ws-code-inspector');
  const breadcrumb = atlas.getByRole('navigation', { name: 'Code map breadcrumb', exact: true });
  const view = (name) =>
    atlas
      .getByRole('tablist', { name: 'Atlas views', exact: true })
      .getByRole('tab', { name, exact: true });
  const counter = canvas.getByRole('button', { name: /^SMART \d+\/\d+$/ });
  const counterText = async () => (await counter.textContent())?.trim();

  await tree.getByRole('button', { name: 'Expand @fixture/alpha', exact: true }).waitFor();
  // Double-clicking a package in the code tree enters its file map.
  await tree.getByRole('button').filter({ hasText: '@fixture/large' }).dblclick();
  await breadcrumb.getByRole('button', { name: '@fixture/large', exact: true }).waitFor();
  const canonical = await rpc('project.http', {
    projectId: project.id,
    method: 'GET',
    resource: `/api/codemap/files?package=${encodeURIComponent('@fixture/large')}`,
  });
  const total = canonical.data.nodes.length;
  assert.ok(total > 160, 'Large fixture exercises the old truncation boundary');
  await canvas.getByRole('button', { name: 'ALL', exact: true }).click();
  await waitFor(
    async () => (await counterText()) === `SMART ${total}/${total}`,
    'All renders every indexed file node beyond the Smart budget',
  );
  await counter.click();
  await waitFor(
    async () => (await counterText()) === `SMART ${SMART_CANVAS_NODES}/${total}`,
    'Explicit Smart node budget',
  );
  // The tree keeps every loaded file reachable: past its first 80 rows, "Show N more files".
  await tree.getByRole('button', { name: 'Expand @fixture/large', exact: true }).click();
  await tree.getByRole('button', { name: /^Show \d+ more files$/ }).click();
  await tree.getByRole('button').filter({ hasText: 'late-180.ts' }).click();
  // The inspector names the selection first; relation rows below it carry titles too.
  await inspector
    .getByTitle(/late-180\.ts$/)
    .first()
    .waitFor();
  // The canvas draws only what is in view and cannot zoom out far enough to show a large scope
  // whole, so the selection is proven by the inspector above; that Smart scope keeps a selected
  // node is the shared map model's own rule.
  await page.screenshot({
    path: join(artifactDir, 'native-atlas-large-scope.png'),
    fullPage: true,
  });

  await view('Subsystems').click();
  const largeMap = atlas.getByRole('region', { name: 'Collapsible subsystem map', exact: true });
  await largeMap.waitFor();
  await waitFor(
    async () => (await largeMap.locator('.graph-node').count()) === 1,
    'Large package collapses into one subsystem',
  );
  await largeMap.getByRole('button', { name: 'Expand @fixture/large', exact: true }).click();
  await waitFor(
    async () => (await largeMap.locator('.graph-node').count()) === 160,
    'Expanded subsystem honors the boundary map budget',
  );
  await largeMap.getByText(/^Smart map shows up to 160 nodes\./).waitFor();
  await largeMap.getByRole('button', { name: 'Collapse all subsystems', exact: true }).click();
  await waitFor(
    async () => (await largeMap.locator('.graph-node').count()) === 1,
    'Collapse all returns the large package to one subsystem',
  );

  // Back to the package map; the subsystem view follows the scope.
  await breadcrumb.getByRole('button', { name: 'workspace', exact: true }).click();
  await atlas.getByRole('region', { name: 'Atlas subsystems', exact: true }).waitFor();
  const boundaries = atlas.getByRole('region', { name: 'Collapsible subsystem map', exact: true });
  await boundaries.getByRole('heading', { name: 'Boundary map', exact: true }).waitFor();
  const expansion = boundaries.getByRole('group', {
    name: 'Subsystem expansion controls',
    exact: true,
  });
  await expansion.getByRole('button', { name: 'Expand @fixture/alpha', exact: true }).waitFor();
  assert.ok((await atlas.locator('.atlas-subsystem-card').count()) > 0);
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
  await boundaries.getByRole('button', { name: 'Collapse all subsystems', exact: true }).click();
  assert.equal(await boundaries.locator('.graph-node').count(), groupCount);
  assert.equal(await boundaryDetail.count(), 0);
  // Communities inferred from stored references are opt-in here (the index stored packages).
  const grouping = atlas.getByRole('group', { name: 'Group nodes by', exact: true });
  await grouping.getByRole('button', { name: 'Inferred communities', exact: true }).click();
  await atlas.getByText('Inferred communities are computed here', { exact: false }).waitFor();
  const inferredNames = await atlas.locator('.atlas-subsystem-card h3').allInnerTexts();
  assert.ok(
    inferredNames.length > 0 &&
      inferredNames.every((name) => name.startsWith('Inferred: ') || name === 'Unconnected'),
    inferredNames.join(' | '),
  );
  await grouping.getByRole('button', { name: 'Stored subsystems', exact: true }).click();
  await waitFor(
    async () => (await boundaries.locator('.graph-node').count()) === groupCount,
    'Stored subsystems return',
  );
  await page.screenshot({ path: join(artifactDir, 'native-atlas-subsystems.png'), fullPage: true });
  if (boundariesOnly) {
    assert.equal(
      (await rpc('snapshot')).sessions.length,
      0,
      'Boundary exploration creates no desktop conversations',
    );
    console.log(
      'PASS: actual indexed boundary collapse/expand, directed reference inspector, selected real member, compact view and zero conversations',
    );
    return;
  }
  await view('Dependency matrix').click();
  await atlas.getByRole('region', { name: 'Atlas dependency matrix', exact: true }).waitFor();
  assert.ok((await atlas.locator('.matrix-reference').count()) > 0);
  await page.screenshot({ path: join(artifactDir, 'native-atlas-matrix.png'), fullPage: true });
  await view('Change impact').click();
  await atlas
    .getByLabel('Impact starting node', { exact: true })
    .selectOption({ label: '@fixture/beta' });
  await atlas.getByLabel('Impact direction', { exact: true }).selectOption('incoming');
  await atlas
    .getByRole('region', { name: 'Atlas impact analysis', exact: true })
    .locator('.atlas-impact-ring strong')
    .filter({ hasText: /^@fixture\/alpha$/ })
    .waitFor();
  await page.screenshot({ path: join(artifactDir, 'native-atlas-impact.png'), fullPage: true });

  await view('Map').click();
  const toolbar = canvas.locator('.ws-code-toolbar');
  for (const layout of ['Relations', 'Subsystems', 'Layers']) {
    await toolbar.getByRole('button', { name: layout, exact: true }).click();
    await canvas.locator('.react-flow__minimap').waitFor();
    await waitFor(
      async () => (await canvas.locator('.react-flow__node').count()) >= 2,
      `${layout} layout renders the package map`,
    );
  }
  await inspector.getByRole('button', { name: 'Tour', exact: true }).click();
  await inspector.getByText(/^Step 1\/\d+ • /).waitFor();
  await inspector.getByRole('button', { name: 'Next tour step', exact: true }).click();
  await inspector.getByText(/^Step 2\/\d+ • /).waitFor();
  // The tour button shows the current stop; pressing it again ends the tour.
  await inspector.getByRole('button', { name: /^2\/\d+$/ }).click();
  await inspector.getByRole('button', { name: 'Tour', exact: true }).waitFor();

  const largeBranch = tree.getByRole('button', { name: 'Collapse @fixture/large', exact: true });
  if (await largeBranch.count()) await largeBranch.click();
  await tree.getByRole('button', { name: 'Expand @fixture/alpha', exact: true }).click();
  await tree.getByRole('button', { name: 'Expand index.ts', exact: true }).click();
  // A symbol picked in the tree opens its file's symbol map with the symbol selected.
  await tree
    .getByRole('button')
    .filter({ hasText: /^feature/ })
    .click();
  await canvas.getByRole('button', { name: 'symbol feature', exact: true }).waitFor();
  await inspector.getByTitle('feature', { exact: true }).first().waitFor();
  await inspector
    .getByLabel('Trace shortest path to target node', { exact: true })
    .selectOption({ label: 'shared' });
  const pathFinder = inspector
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Path & Flow Finder', exact: true }) });
  await waitFor(
    async () =>
      (await pathFinder.getByRole('button', { name: /^(feature|shared)$/ }).count()) === 2,
    'Directed dependency path feature → shared',
  );
  await inspector
    .locator('.atlas-institutional-memory')
    .getByText('Native SAGE proposal keeps file boundaries explicit.', { exact: true })
    .waitFor();
  await inspector.getByRole('button', { name: 'File history & actors' }).click();
  await inspector.locator('.atlas-history-toggle[aria-expanded="true"]').waitFor();
  await page.screenshot({ path: join(artifactDir, 'native-atlas-analysis.png'), fullPage: true });
  await inspector.getByRole('button', { name: 'Open in file workspace' }).click();
  await page.locator('.native-file-content').filter({ hasText: 'feature' }).waitFor();
  assert.equal((await rpc('snapshot')).sessions.length, 0, 'Atlas analysis is project-owned');
  console.log(
    'PASS: native Atlas Smart/All canvas budget, tree reveal, subsystem view/dependency matrix/change impact, three layouts/minimap/tour/dependency path/SAGE provenance/history/file workspace',
  );
}
