import assert from 'node:assert/strict';
import path from 'node:path';
import { expect } from '@playwright/test';
import en from '../../src/i18n/locales/en/activity.json' with { type: 'json' };
import tr from '../../src/i18n/locales/tr/activity.json' with { type: 'json' };

export async function checkInspectionLayout(browser, base, output, errors) {
  const results = [];
  const failures = [];
  for (const theme of ['light', 'dark']) {
    for (const lang of ['en', 'tr']) {
      for (const width of [1440, 768, 390, 320]) {
        const page = await browser.newPage({
          viewport: { width, height: 900 },
          colorScheme: theme,
        });
        page.on('pageerror', (error) => errors.push(error.message));
        await page.emulateMedia({ reducedMotion: 'reduce' });
        const l = (lang === 'en' ? en : tr).sessionInspect;
        const check = async (name, run) => {
          try {
            await run();
            results.push({ theme, lang, width, name, result: 'PASS' });
          } catch (error) {
            failures.push(`${theme}/${lang}/${width}/${name}: ${error.message}`);
          }
        };
        const fit = async (element, what) => {
          const size = await element.evaluate((el) => ({
            width: el.clientWidth,
            content: el.scrollWidth,
          }));
          assert(
            size.content <= size.width + 1,
            `EXPECTED ${what} to fit; ACTUAL ${JSON.stringify(size)}`,
          );
        };
        try {
          await page.goto(
            `${base}?inspection-review=1&view=session-inspect&theme=${theme}&lang=${lang}`,
          );
          const panel = page.getByTestId('inspection-panel');
          await expect(panel.getByRole('heading', { name: 'Workspace inspection' })).toBeVisible();
          await page.evaluate(() => document.fonts.ready);
          const timeline = panel
            .locator('section')
            .filter({ has: page.getByRole('heading', { name: l.eventTimeline, exact: true }) });
          await check('short inspection control', () =>
            fit(panel.locator('header').first(), 'short inspection header'),
          );
          await check('metric icons retain their dimensions', async () => {
            const widths = await panel
              .locator('.grid-cols-2')
              .first()
              .locator('svg')
              .evaluateAll((icons) => icons.map((icon) => icon.getBoundingClientRect().width));
            assert(
              widths.length === 7 && widths.every((width) => Math.abs(width - 12) < 0.1),
              `EXPECTED seven 12px icons; ACTUAL ${widths.join(',')}`,
            );
            const labels = await panel
              .locator('.grid-cols-2 > div > div:first-child > span')
              .evaluateAll((els) =>
                els
                  .filter((el) => !el.textContent.trim().includes(' '))
                  .map((el) => ({
                    text: el.textContent,
                    height: el.getBoundingClientRect().height,
                    line: parseFloat(getComputedStyle(el).lineHeight),
                  })),
              );
            assert(
              labels.every((label) => label.height <= label.line + 1),
              `EXPECTED readable metric labels; ACTUAL ${JSON.stringify(labels)}`,
            );
          });
          await check('timeline toolbar fits', () =>
            fit(timeline.locator('div').first(), 'timeline toolbar'),
          );
          await page.screenshot({
            animations: 'disabled',
            path: path.join(output, `inspection-short-${theme}-${lang}-${width}.png`),
          });
          await check('event filtering and empty result control', async () => {
            const filter = panel.getByRole('searchbox', { name: l.filterEvents });
            await filter.fill('tool_call');
            await expect(timeline.getByText('Read source file', { exact: true })).toBeVisible();
            await expect(timeline.getByText('Review workspace', { exact: true })).toHaveCount(0);
            await filter.fill('no-such-inspection-event');
            await expect(timeline.getByText(l.noEventsMatchTheFilter)).toBeVisible();
            await filter.fill('');
          });
          await check('timeline collapses and expands', async () => {
            const toggle = timeline.getByRole('button').first();
            await toggle.click();
            await expect(timeline.getByText('Read source file', { exact: true })).toHaveCount(0);
            await toggle.click();
            await expect(timeline.getByText('Read source file', { exact: true })).toBeVisible();
          });
          await page.getByRole('button', { name: 'Inspect long content', exact: true }).click();
          await expect(
            panel.getByRole('heading', {
              name: 'Workspace_review_evidence_'.repeat(6),
              exact: true,
            }),
          ).toBeVisible();
          await check('long header fits', async () => {
            const header = panel.locator('header').first();
            await fit(header, 'long inspection header');
            const box = await header.boundingBox();
            assert(box.height <= 240, `EXPECTED compact sticky header; ACTUAL ${box.height}px`);
          });
          await check('long body fits', async () => {
            await fit(panel.locator('aside'), 'long tools/files aside');
            await fit(panel.locator(':scope > div'), 'complete inspection view');
          });
          await page.screenshot({
            animations: 'disabled',
            path: path.join(output, `inspection-long-${theme}-${lang}-${width}.png`),
          });
          await check('refresh control', async () => {
            await panel.getByTitle(l.refresh).click();
            await expect(
              panel.getByRole('heading', {
                name: 'Workspace_review_evidence_'.repeat(6),
                exact: true,
              }),
            ).toBeVisible();
          });
          for (const cancelDefault of [false, true]) {
            await check(
              `focused Enter overrides ${cancelDefault ? 'cancel' : 'confirm'} default`,
              async () => {
                await page
                  .getByRole('button', {
                    name: cancelDefault ? 'Cancel default' : 'Confirm default',
                    exact: true,
                  })
                  .click();
                const dialog = page.getByRole('dialog');
                await expect(dialog).toBeVisible();
                const button = dialog.getByRole('button', {
                  name: cancelDefault ? 'Remove record' : 'Keep record',
                  exact: true,
                });
                await button.focus();
                await button.press('Enter');
                await expect(page.getByTestId('confirmation-result')).toHaveText(
                  cancelDefault ? 'confirm' : 'cancel',
                  { timeout: 1000 },
                );
                await expect(dialog).toHaveCount(0);
              },
            );
            if (await page.getByRole('dialog').count()) await page.keyboard.press('Escape');
          }
          await check('pointer cancel control', async () => {
            await page.getByRole('button', { name: 'Confirm default', exact: true }).click();
            await page
              .getByRole('dialog')
              .getByRole('button', { name: 'Keep record', exact: true })
              .click();
            await expect(page.getByTestId('confirmation-result')).toHaveText('cancel');
          });
        } finally {
          await page.close();
        }
      }
    }
  }
  console.log(`INSPECTION CHECKS: ${results.length} passed`);
  if (failures.length) console.error(failures.join('\n'));
  assert.deepEqual(failures, [], 'PROBLEM CONFIRMED: inspection/confirmation defects');
  console.log('PROBLEM NOT REPRODUCED; FIX VERIFIED');
  return results;
}
