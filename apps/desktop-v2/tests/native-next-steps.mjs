import assert from 'node:assert/strict';
import { join } from 'node:path';

/** Completed engine suggestions are editable draft content, never automatic execution. */
export async function exerciseNativeNextSteps({ page, artifactDir, waitFor, providerFixture }) {
  await page
    .getByRole('navigation', { name: 'Agent workspace views' })
    .getByRole('button', { name: /^Chat/ })
    .click();
  const input = page.getByRole('textbox', { name: 'Message WrongStack', exact: true });
  await page.getByRole('combobox', { name: 'Message delivery mode' }).selectOption('btw');
  await input.fill('[native-composer-nextsteps] Suggest follow-up work.');
  await page.locator('.composer-send').click();
  const panel = page.locator('details.next-steps-panel');
  await panel.getByText('Suggested next steps').waitFor({ timeout: 60000 });
  await panel.locator('summary').click();
  await panel.getByText('[native-composer-nextstep-selected] Inspect the result').waitFor();
  // Continue automatically (with YOLO) offers a cancellable countdown; cancelling sends nothing.
  const mode = page.getByRole('combobox', { name: 'Continuation mode', exact: true });
  const quiet = providerFixture.calls.length;
  await mode.selectOption('auto');
  const countdown = page.locator('.auto-continue');
  await countdown.filter({ hasText: /^Continuing in \d s with:/ }).waitFor();
  await countdown.getByRole('button', { name: 'Cancel', exact: true }).click();
  await countdown.waitFor({ state: 'detached' });
  await page.waitForTimeout(6000);
  assert.equal(providerFixture.calls.length, quiet, 'A cancelled countdown sends nothing');
  await mode.selectOption('off');
  await input.fill('Keep this constraint.');
  await panel.getByLabel('[native-composer-nextstep-selected] Inspect the result').check();
  const before = providerFixture.calls.length;
  await panel.getByRole('button', { name: 'Add selected to draft' }).click();
  assert.match(
    await input.inputValue(),
    /Keep this constraint\.[\s\S]*\[native-composer-nextstep-selected\] Inspect the result/,
  );
  assert.equal(providerFixture.calls.length, before, 'Selecting a suggestion does not send it');
  await page.screenshot({ path: join(artifactDir, 'native-next-steps.png'), fullPage: true });
  await page.getByRole('combobox', { name: 'Message delivery mode' }).selectOption('queue');
  await page.locator('.composer-send').click();
  await waitFor(
    () =>
      providerFixture.calls.some((call) =>
        call.composerPrompt.includes('[native-composer-nextstep-selected]'),
      ),
    'Selected next step reaches the provider',
    60000,
  );
  await waitFor(
    async () => !(await page.getByRole('button', { name: 'Stop run', exact: true }).count()),
    'Next-step turn settles',
    60000,
  );
  await page.getByRole('combobox', { name: 'Message delivery mode' }).selectOption('btw');
  console.log('PASS: completed next steps, explicit draft selection and normal queued submission');
}
