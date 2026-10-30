import assert from 'node:assert/strict';
import path from 'node:path';
import { expect } from '@playwright/test';

export async function checkOverlayLayout(browser, base, output, errors) {
  const results = [];
  const failures = [];
  for (const theme of ['light', 'dark']) {
    for (const width of [1440, 768, 390, 320]) {
      const page = await browser.newPage({ viewport: { width, height: 640 }, colorScheme: theme });
      page.on('pageerror', (error) => errors.push(error.message));
      await page.emulateMedia({ reducedMotion: 'reduce' });
      const check = async (name, run) => {
        try {
          await run();
          results.push({ theme, width, name, result: 'PASS' });
        } catch (error) {
          failures.push(`${theme}/${width}/${name}: ${error.message}`);
        }
      };
      try {
        await page.goto(`${base}?overlay-review=1&theme=${theme}`);
        await expect(page.getByTestId('overlay-review')).toBeVisible();
        for (const long of [false, true]) {
          await check(long ? 'long dialog content' : 'short dialog control', async () => {
            await page
              .getByRole('button', {
                name: long ? 'Review long artifact' : 'Review workspace',
                exact: true,
              })
              .click();
            const dialog = page.getByRole('dialog');
            await expect(dialog).toBeVisible();
            await page.evaluate(() => document.fonts.ready);
            const size = await dialog.evaluate((el) => ({
              width: el.clientWidth,
              content: el.scrollWidth,
            }));
            assert(
              size.content <= size.width + 1,
              `EXPECTED dialog content to fit; ACTUAL ${JSON.stringify(size)}`,
            );
            const heading = await dialog.getByRole('heading').boundingBox();
            const close = await dialog
              .getByRole('button', { name: 'Close', exact: true })
              .boundingBox();
            assert(
              !(
                heading.x < close.x + close.width &&
                heading.x + heading.width > close.x &&
                heading.y < close.y + close.height &&
                heading.y + heading.height > close.y
              ),
              'EXPECTED heading clear of Close; ACTUAL overlapping title',
            );
          });
          await page.screenshot({
            animations: 'disabled',
            path: path.join(
              output,
              `overlay-dialog-${long ? 'long' : 'short'}-${theme}-${width}.png`,
            ),
          });
          await page.keyboard.press('Escape');
        }
        for (const clipped of [false, true]) {
          await check(
            clipped ? 'model picker in scroll panel' : 'model picker control',
            async () => {
              const group = page.getByTestId(
                clipped ? 'review-picker-clipped' : 'review-picker-control',
              );
              const trigger = group.getByRole('button', { expanded: false });
              await trigger.click();
              const popup = page.locator('.ws-picker-popover');
              await expect(popup.locator('input')).toBeFocused();
              const option = popup.getByRole('button', { name: /Workspace review model/ });
              const reachable = await option.evaluate((el) => {
                const rect = el.getBoundingClientRect();
                return el.contains(
                  document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2),
                );
              });
              assert(
                reachable,
                'EXPECTED model option pointer reachable; ACTUAL popup clipped or covered',
              );
              const lastReachable = await popup
                .getByRole('button')
                .last()
                .evaluate((el) => {
                  const rect = el.getBoundingClientRect();
                  return el.contains(
                    document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2),
                  );
                });
              assert(
                lastReachable,
                'EXPECTED last model option pointer reachable; ACTUAL menu bottom clipped',
              );
              await page.screenshot({
                animations: 'disabled',
                path: path.join(
                  output,
                  `overlay-picker-${clipped ? 'clipped' : 'control'}-${theme}-${width}.png`,
                ),
              });
              await option.click();
              await expect(popup).toHaveCount(0);
              await expect(trigger).toContainText('review-model');
              await expect(trigger).toBeFocused({ timeout: 1500 });
            },
          );
          await page.keyboard.press('Escape');
        }
        for (const height of [640, 420]) {
          await page.setViewportSize({ width, height });
          await check(`notification menu at height ${height}`, async () => {
            await page.getByTestId('notification-menu-trigger').filter({ visible: true }).click();
            const menu = page.getByRole('menu');
            await expect(menu).toBeVisible();
            await page.screenshot({
              animations: 'disabled',
              path: path.join(output, `overlay-notifications-${theme}-${width}.png`),
            });
            const header = menu.locator('> div').first();
            const size = await header.evaluate((el) => ({
              width: el.clientWidth,
              content: el.scrollWidth,
            }));
            assert(
              size.content <= size.width + 1,
              `EXPECTED notification actions to fit; ACTUAL ${JSON.stringify(size)}`,
            );
            const last = menu.getByRole('list').getByRole('menuitem').last();
            await menu.getByRole('list').evaluate((el) => {
              el.scrollTop = el.scrollHeight;
            });
            const button = last.getByRole('button', { name: 'Remove notification', exact: true });
            const reachable = await button.evaluate((el) => {
              const rect = el.getBoundingClientRect();
              return el.contains(
                document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2),
              );
            });
            assert(
              reachable,
              'EXPECTED last notification action reachable; ACTUAL menu list clipped',
            );
            const count = await menu.getByRole('list').getByRole('menuitem').count();
            await button.click();
            await expect(menu.getByRole('list').getByRole('menuitem')).toHaveCount(count - 1);
          });
          await page.keyboard.press('Escape');
        }
        await page.setViewportSize({ width, height: 640 });
        await check('model picker in dialog', async () => {
          await page.getByRole('button', { name: 'Configure task model', exact: true }).click();
          const group = page.getByTestId('review-picker-dialog');
          await group.getByRole('button', { expanded: false }).click();
          const popup = page.locator('.ws-picker-popover');
          await expect(popup.locator('input')).toBeFocused({ timeout: 1500 });
          await popup
            .getByRole('button', { name: /Workspace review model/ })
            .click({ timeout: 1500 });
          await expect(group.getByRole('button')).toContainText('review-model');
          await expect(group.getByRole('button')).toBeFocused({ timeout: 1500 });
        });
        await page.keyboard.press('Escape');
        await page.keyboard.press('Escape');
        await page.goto(`${base}?overlay-review=1&views=1&view=chronicle&theme=${theme}`);
        const dashboard = page.getByTestId('chronicle-dashboard');
        const row = dashboard.getByRole('button').filter({ hasText: 'tool.call.completed' });
        await expect(row).toBeVisible();
        await row.click();
        const detail = page.locator(
          '[data-testid="chronicle-dashboard"] aside, [data-chronicle-detail]',
        );
        await expect(detail).toBeVisible();
        await check('Chronicle populated detail', async () => {
          await page.screenshot({
            animations: 'disabled',
            path: path.join(output, `overlay-chronicle-detail-${theme}-${width}.png`),
          });
          const box = await detail.boundingBox();
          assert(
            box.width >= Math.min(320, width - 48),
            `EXPECTED readable evidence detail width; ACTUAL ${box.width}`,
          );
          const header = detail.locator('> div').first();
          const size = await header.evaluate((el) => ({
            width: el.clientWidth,
            content: el.scrollWidth,
          }));
          assert(
            size.content <= size.width + 1,
            `EXPECTED event ID and Close inside detail; ACTUAL ${JSON.stringify(size)}`,
          );
          assert(box.x >= 0 && box.x + box.width <= width + 1, 'Detail leaves viewport');
          await detail.getByRole('button', { name: 'Close', exact: true }).focus();
          await page.keyboard.press('Escape');
          await expect(detail).toHaveCount(0, { timeout: 1500 });
          await expect(row).toBeFocused({ timeout: 1500 });
        });
      } finally {
        await page.close();
      }
    }
  }
  for (const failure of failures) console.error('PROBLEM CONFIRMED', failure);
  assert.deepEqual(failures, [], 'Overlay layout contracts');
  console.log('FIX VERIFIED: overlay layouts', results.length);
  return results;
}
