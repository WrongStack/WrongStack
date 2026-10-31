import assert from 'node:assert/strict';
import { join } from 'node:path';
import { openProjectView } from './native-project-navigation.mjs';

export async function exerciseNativeChronicleInsights({ page, rpc, project, artifactDir }) {
  await openProjectView(page, project, 'Chronicle');
  const insights = page.locator('.chronicle-insights');
  await insights.locator('summary').click();
  await insights
    .getByText('fixture-provider / fixture-model', { exact: true })
    .waitFor({ timeout: 60000 });
  await insights.getByRole('button', { name: 'tasks', exact: true }).click();
  await insights.getByText('fixture-task', { exact: true }).waitFor({ timeout: 60000 });
  await insights.getByRole('button', { name: 'files', exact: true }).click();
  await insights
    .getByText('review-fixture.ts', { exact: true })
    .first()
    .waitFor({ timeout: 60000 });
  await insights.getByRole('button', { name: 'Open project file', exact: true }).first().waitFor();
  await page.screenshot({
    path: join(artifactDir, 'native-chronicle-insights.png'),
    fullPage: true,
  });
  await page.setViewportSize({ width: 800, height: 640 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.equal((await rpc('snapshot')).sessions.length, 0, 'Insights are project-owned');
  console.log('PASS: project Chronicle provider, task and file insights without a conversation');
}
