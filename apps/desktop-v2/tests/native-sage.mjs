import assert from 'node:assert/strict';
import { join } from 'node:path';
export async function exerciseNativeSage({ page, waitFor, artifactDir, project, rpc }) {
  const tools = () => page.getByRole('navigation', { name: `${project.name} workspace` });
  await page.locator('.project-item').filter({ hasText: project.name }).click();
  await tools().getByRole('button', { name: 'Memory', exact: true }).click();
  const nav = () => page.getByRole('navigation', { name: 'SAGE workspace' });
  await nav().getByRole('button', { name: 'Review queue', exact: true }).click();
  const accepted = page
    .locator('.sage-candidate-card')
    .filter({ hasText: 'Native SAGE proposal keeps file boundaries explicit.' });
  await accepted.waitFor();
  await accepted.getByRole('button', { name: 'Review & accept', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Accept SAGE proposal' })
    .getByRole('button', { name: 'Confirm action' })
    .click();
  await accepted.waitFor({ state: 'detached' });
  const rejected = page
    .locator('.sage-candidate-card')
    .filter({ hasText: 'Native SAGE proposal that should be rejected.' });
  await rejected.getByRole('button', { name: 'Reject proposal', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Keep or reject SAGE proposal' })
    .getByRole('button', { name: 'Confirm action' })
    .click();
  await rejected.waitFor({ state: 'detached' });
  await page.getByRole('checkbox', { name: 'Include resolved proposals', exact: true }).check();
  await page.locator('.sage-candidate-status').filter({ hasText: 'accepted' }).waitFor();
  await page.locator('.sage-candidate-status').filter({ hasText: 'rejected' }).waitFor();
  await page.screenshot({ path: join(artifactDir, 'native-sage-review.png'), fullPage: true });
  await nav().getByRole('button', { name: 'Health & maintenance', exact: true }).click();
  await page.getByRole('heading', { name: 'Findings', exact: true }).waitFor();
  await waitFor(
    async () => (await page.locator('.sage-health-check').count()) > 0,
    'Live SAGE doctor checks',
    45000,
  );
  await page
    .locator('.sage-maintenance')
    .getByRole('button')
    .filter({ hasText: 'Rebuild text search' })
    .click();
  await page
    .getByRole('dialog', { name: 'Apply SAGE repair' })
    .getByRole('button', { name: 'Confirm action' })
    .click();
  await page.getByRole('dialog', { name: 'Apply SAGE repair' }).waitFor({ state: 'hidden' });
  await page.screenshot({ path: join(artifactDir, 'native-sage-health.png'), fullPage: true });
  await nav().getByRole('button', { name: 'Audience', exact: true }).click();
  await page.getByLabel('Filter SAGE agent role', { exact: true }).selectOption('reviewer');
  await page
    .locator('.sage-audience-cards')
    .getByRole('button')
    .filter({ hasText: 'Native SAGE proposal keeps file boundaries explicit.' })
    .click();
  await page.getByRole('heading', { name: 'Memory record', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Edit memory', exact: true }).click();
  await page.getByText('Retention, evidence & audience', { exact: true }).click();
  await page.getByLabel('Memory retention', { exact: true }).selectOption('permanent');
  await page
    .getByLabel('Memory applicability', { exact: true })
    .fill('Applies when reviewing the alpha package.');
  await page.getByRole('button', { name: 'Save memory', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Saved to project memory.' }).waitFor();
  await page.locator('.sage-record-badges').getByText('permanent', { exact: true }).waitFor();
  await page.screenshot({
    path: join(artifactDir, 'native-sage-record-details.png'),
    fullPage: true,
  });
  await nav().getByRole('button', { name: 'Retrieval analysis', exact: true }).click();
  await page.getByLabel('SAGE retrieval query', { exact: true }).fill('vault');
  await page.getByRole('button', { name: 'Analyze retrieval', exact: true }).click();
  await waitFor(
    async () => (await page.locator('.sage-search-hits>button').count()) > 0,
    'SAGE retrieval channel breakdown',
  );
  await page.screenshot({ path: join(artifactDir, 'native-sage-retrieval.png'), fullPage: true });
  await page
    .getByRole('navigation', { name: 'Project memory systems' })
    .getByRole('button')
    .filter({ hasText: 'Vector Memory' })
    .click();
  await page.getByRole('heading', { name: 'Vector Memory', exact: true }).waitFor();
  await page
    .getByRole('heading', { name: 'Vector Memory is not enabled for this project.', exact: true })
    .waitFor();
  await page
    .getByRole('navigation', { name: 'Project memory systems' })
    .getByRole('button')
    .filter({ hasText: 'SAGE Memory' })
    .click();
  assert.equal(
    (await rpc('snapshot')).sessions.length,
    0,
    'SAGE review, doctor, audience, retrieval and vector status never create desktop sessions',
  );
  console.log(
    'PASS: canonical SAGE candidate accept/reject, doctor/repair, audience, protected retention/evidence edit, retrieval breakdown and separate vector status',
  );
}
