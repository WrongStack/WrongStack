import assert from 'node:assert/strict';
import { join } from 'node:path';

const ACCEPTED = 'Native SAGE proposal keeps file boundaries explicit.';
const REJECTED = 'Native SAGE proposal that should be rejected.';

/**
 * The desktop's project memory is the WebUI's shared SAGE surface (`@wrongstack/project-surfaces/sage`):
 * lenses for all memories, audience-scoped guidance and vector memory; the library has Active,
 * Review, Deleted and Health views beside the record detail.
 */
export async function exerciseNativeSage({ page, waitFor, artifactDir, project, rpc }) {
  const tools = () => page.getByRole('navigation', { name: `${project.name} workspace` });
  await page.locator('.project-item').filter({ hasText: project.name }).click();
  await tools().getByRole('button', { name: 'Memory', exact: true }).click();
  const sage = page.locator('[data-workbench-view="memory"]');
  const lens = (name) =>
    sage
      .getByRole('tablist', { name: 'SAGE memory lenses', exact: true })
      .getByRole('tab', { name: new RegExp(`^${name}`) });
  const library = sage.getByRole('region', { name: 'Memory library', exact: true });
  const view = (name) =>
    library
      .getByRole('tablist', { name: 'Memory view', exact: true })
      .getByRole('tab', { name: new RegExp(`^${name}`) });
  const list = library.getByRole('region', { name: 'Memories', exact: true });
  const card = (text) => list.locator('.ws-memory-card').filter({ hasText: text });
  const detail = sage.getByRole('region', { name: 'Memory detail', exact: true });

  // Review queue: Apply accepts a proposal into memory, Keep rejects it; both leave the queue.
  await view('Review').click();
  const accepted = library.getByRole('listitem').filter({ hasText: ACCEPTED });
  await accepted.getByRole('button', { name: 'Apply', exact: true }).click();
  await accepted.waitFor({ state: 'detached' });
  const rejected = library.getByRole('listitem').filter({ hasText: REJECTED });
  await rejected.getByRole('button', { name: 'Keep', exact: true }).click();
  await rejected.waitFor({ state: 'detached' });
  await page.screenshot({ path: join(artifactDir, 'native-sage-review.png'), fullPage: true });
  // The accepted proposal is now a project memory; the rejected one never became one.
  await view('Active').click();
  await sage.getByRole('button', { name: 'Refresh memories', exact: true }).click();
  await card(ACCEPTED).waitFor();
  assert.equal(await card(REJECTED).count(), 0, 'A rejected proposal is not stored as memory');

  await view('Health').click();
  const checks = library.getByRole('list', { name: 'Health checks', exact: true });
  await waitFor(
    async () => (await checks.getByRole('listitem').count()) > 0,
    'Live SAGE doctor checks',
    45000,
  );
  // Running the doctor again reports a fresh result.
  await library.getByRole('button', { name: 'Refresh', exact: true }).click();
  await waitFor(
    async () => (await checks.getByRole('listitem').count()) > 0,
    'SAGE doctor re-run',
    45000,
  );
  await page.screenshot({ path: join(artifactDir, 'native-sage-health.png'), fullPage: true });

  await lens('Audience-scoped').click();
  const audience = sage.getByRole('region', { name: 'Audience Memory', exact: true });
  await audience.getByLabel('Search audience memories', { exact: true }).fill('reviewer');
  const scoped = audience.getByRole('listitem').filter({ hasText: ACCEPTED });
  await scoped.getByRole('button', { name: 'role:reviewer', exact: true }).waitFor();
  await page.screenshot({ path: join(artifactDir, 'native-sage-audience.png'), fullPage: true });

  // The accepted memory takes an applicability condition through the record editor.
  await lens('All memories').click();
  await card(ACCEPTED).click();
  await detail.getByRole('button', { name: 'Edit', exact: true }).click();
  await detail
    .getByLabel('Valid when', { exact: true })
    .fill('Applies when reviewing the alpha package.');
  await detail.getByRole('button', { name: 'Save changes', exact: true }).click();
  await sage.getByRole('status').filter({ hasText: 'Memory updated.' }).waitFor();
  await detail
    .getByRole('region', { name: 'Valid when', exact: true })
    .getByText('Applies when reviewing the alpha package.', { exact: true })
    .waitFor();
  await page.screenshot({
    path: join(artifactDir, 'native-sage-record-details.png'),
    fullPage: true,
  });

  // Ranked retrieval over the whole store, beside the library.
  await library.getByLabel('Search memories', { exact: true }).fill('vault');
  const ranked = library.getByRole('region', { name: 'Ranked SAGE results', exact: true });
  await waitFor(
    async () => (await ranked.getByRole('listitem').getByRole('button').count()) > 0,
    'Ranked SAGE retrieval',
  );
  await page.screenshot({ path: join(artifactDir, 'native-sage-retrieval.png'), fullPage: true });
  await library.getByRole('button', { name: 'Clear search', exact: true }).click();

  await lens('Vector memory').click();
  await sage.getByRole('heading', { name: 'Vector Memory', exact: true }).waitFor();
  await sage
    .getByText('Disabled — the webui-server host does not have a vector memory store wired.', {
      exact: true,
    })
    .waitFor();
  await lens('All memories').click();
  assert.equal(
    (await rpc('snapshot')).sessions.length,
    0,
    'SAGE review, doctor, audience, retrieval and vector status never create desktop sessions',
  );
  console.log(
    'PASS: canonical SAGE candidate accept/reject, doctor re-run, audience routing, applicability edit, ranked retrieval and separate vector status',
  );
}
