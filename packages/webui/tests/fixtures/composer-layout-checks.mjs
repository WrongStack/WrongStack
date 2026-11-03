import assert from 'node:assert/strict';
import path from 'node:path';
import { expect } from '@playwright/test';
import { assertSquareCorners } from './square-corner-check.mjs';

/** Exercise real composer controls; only the connected transport is stubbed. */
export async function checkComposerLayout(browser, base, output, errors) {
  const results = [];
  for (const theme of ['light', 'dark']) {
    for (const width of [1440, 768, 390, 320]) {
      const page = await browser.newPage({ viewport: { width, height: 980 }, colorScheme: theme });
      page.on('pageerror', (error) => errors.push(error.message));
      try {
        await page.goto(`${base}?theme=${theme}&composer=1`);
        const input = page.locator('[data-chat-textarea]');
        await expect(input).toBeEnabled();
        await input.fill('Review the workspace layout and keyboard controls.');
        await expect(input).toBeFocused();
        await expect(page.getByTestId('send-submit')).toBeEnabled();
        if (width < 768) await page.getByRole('button', { name: 'Run settings' }).click();
        const companions = page.getByTestId('composer-companions-button').filter({ visible: true });
        await expect
          .poll(async () => (await companions.boundingBox()).height)
          .toBeGreaterThanOrEqual(width < 640 ? 36 : 32);
        await companions.click();
        const switches = page.getByTestId(/^composer-companion-switch-/);
        await expect(switches).toHaveCount(3);
        for (const toggle of await switches.all()) {
          await expect(toggle).toBeVisible();
          assert.equal(
            await toggle.evaluate((el) => el.getBoundingClientRect().height),
            20,
            'Popover switches must keep their compact track height inside the composer toolbar',
          );
          const previous = await toggle.getAttribute('aria-checked');
          await toggle.click();
          await expect(toggle).toHaveAttribute('aria-checked', String(previous !== 'true'));
          await toggle.click();
          await expect(toggle).toHaveAttribute('aria-checked', previous);
        }
        await page.screenshot({
          animations: 'disabled',
          path: path.join(output, `composer-companions-${theme}-${width}.png`),
        });
        await page.keyboard.press('Escape');
        await expect(switches).toHaveCount(0);
        if (width < 768) {
          await page.keyboard.press('Escape');
          await expect(page.getByRole('dialog')).toHaveCount(0);
        }
        await input.focus();
        // Long user-configured model names must fit without a document scrollbar.
        await page.evaluate(() => {
          window.fixture.config.setState({
            model: 'workspace-model-with-a-very-long-name-'.repeat(8),
          });
        });
        for (const chromeLevel of ['calm', 'full']) {
          await page.evaluate((level) => {
            window.fixture.prefs.getState().set({ chromeLevel: level });
            window.fixture.chat.setState({ isLoading: level === 'full' });
          }, chromeLevel);
          const composer = page.locator('.ws-composer');
          await expect(input).toBeFocused();
          assert.equal(
            await composer.evaluate((el) => getComputedStyle(el).outlineStyle),
            'solid',
            'The outer composer must retain a visible keyboard focus indicator',
          );
          if (chromeLevel === 'full') {
            await expect(composer).toHaveAttribute('data-running', 'true');
            await expect(page.getByTestId('send-steer')).toBeVisible();
            await expect(page.getByTestId('send-queue')).toBeVisible();
          }
          assert(
            await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
            `Composer options overflow at ${width} / ${chromeLevel}`,
          );
          const actions = page.locator('.ws-composer-actions');
          assert(
            await actions.evaluate((el) => el.scrollWidth <= el.clientWidth),
            `Composer actions require hidden scrolling at ${width} / ${chromeLevel}`,
          );
          for (const button of await actions.locator('button').all()) {
            const box = await button.boundingBox();
            assert(box && box.x >= 0 && box.x + box.width <= width + 1, 'Action leaves viewport');
            assert(box.height >= 44 && box.width >= 44, 'Action must retain its touch target');
          }
          if (width < 640) {
            assert(
              Number.parseFloat(await input.evaluate((el) => getComputedStyle(el).fontSize)) >= 16,
              'Mobile text input must not trigger automatic zoom',
            );
          }
          await assertSquareCorners(page);
          await page.screenshot({
            animations: 'disabled',
            path: path.join(output, `composer-${theme}-${width}-${chromeLevel}.png`),
          });
        }
        results.push({ theme, width, idle: 'PASS', running: 'PASS', longModel: 'PASS' });
        console.log('composer layout passed', theme, width);
      } finally {
        await page.close();
      }
    }
  }
  return results;
}
