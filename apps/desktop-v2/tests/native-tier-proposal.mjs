import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixtureModel } from './local-provider.mjs';

/**
 * A leader in `propose` mode asks the real leader_tier_set for a cheaper tier: the engine changes
 * nothing, the conversation shows the proposal, and accepting it switches only this conversation.
 */
export async function exerciseNativeTierProposal({
  page,
  rpc,
  project,
  waitFor,
  artifactDir,
  configPath,
  providerFixture,
  sessionIds,
}) {
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  const provider = config.providers['desktop-local'];
  await writeFile(
    configPath,
    JSON.stringify({
      ...config,
      // Start on the premium rung; an earlier scenario may have left the cheaper model selected.
      provider: 'desktop-local',
      model: fixtureModel,
      providers: {
        ...config.providers,
        'desktop-local': {
          ...provider,
          models: [...new Set([...provider.models, 'alternate-refiner'])],
        },
      },
      // Declaration order is the ladder: budget is the cheaper rung.
      modelTiers: {
        enabled: true,
        levels: {
          budget: { provider: 'desktop-local', model: 'alternate-refiner' },
          premium: { provider: 'desktop-local', model: fixtureModel },
        },
        leader: { mode: 'propose' },
      },
    }),
  );
  const title = 'Tier owner';
  const owner = await rpc('session.open', { projectId: project.id, kind: 'agent', title });
  sessionIds.push(owner.id);
  await waitFor(
    async () => Boolean((await rpc('engine.identity', { id: owner.id })).sessionId),
    'Tier session engine',
    100000,
  );
  await page.locator('.tree-session').filter({ hasText: title }).click();
  const input = page.getByRole('textbox', { name: 'Message WrongStack', exact: true });
  await input.fill('[native-tier-proposal] Use the cheaper tier for the rest of this work.');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();

  const notices = page.getByRole('region', { name: 'Conversation notices', exact: true });
  const proposal = notices
    .getByRole('status')
    .filter({ hasText: 'WrongStack proposes the budget tier: desktop-local/alternate-refiner.' });
  await proposal.waitFor({ timeout: 60000 });
  const result = providerFixture.toolResults.find((item) => item.challenge === 'tier-proposal');
  assert.ok(result, 'The real leader_tier_set answered the leader');
  assert.match(JSON.stringify(result.content), /Proposed/);
  assert.match(JSON.stringify(result.content), /NOT been changed/);
  // A proposal changes nothing until accepted.
  assert.equal(JSON.parse(await readFile(configPath, 'utf8')).model, fixtureModel);
  await page.screenshot({ path: join(artifactDir, 'native-tier-proposal.png'), fullPage: true });

  await proposal.getByRole('button', { name: 'Switch to budget', exact: true }).click();
  await proposal.waitFor({ state: 'detached' });
  await page.locator('.composer-chip').filter({ hasText: 'alternate-refiner' }).first().waitFor();
  await waitFor(
    async () => JSON.parse(await readFile(configPath, 'utf8')).model === 'alternate-refiner',
    'Accepted tier reaches the saved selection',
    15000,
  );
  await page.screenshot({
    path: join(artifactDir, 'native-tier-proposal-accepted.png'),
    fullPage: true,
  });
  console.log('PASS: leader tier proposal shown, unchanged until accepted, then switched');
}
