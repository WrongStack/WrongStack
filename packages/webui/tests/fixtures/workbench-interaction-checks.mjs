import assert from 'node:assert/strict';
import path from 'node:path';
import { expect } from '@playwright/test';
import { assertSquareCorners } from './square-corner-check.mjs';

export async function checkWorkbenchInteractions(browser, base, output, errors) {
  const results = [];
  for (const theme of ['dark', 'light']) {
    for (const width of [1440, 768, 390, 320]) {
      const page = await browser.newPage({
        viewport: { width, height: 1080 },
        colorScheme: theme,
        permissions: ['clipboard-read', 'clipboard-write'],
      });
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(`${base}?theme=${theme}&interactions=1`);
      await expect(page.getByTestId('interaction-workbench')).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      await expect(page.locator('.ws-session-tab')).toHaveCount(2);
      await page.locator('[data-message-id="visual-user"]').hover();
      await page.getByTitle('Edit & resend this prompt', { exact: true }).click();
      const editor = page.locator('.ws-message-edit textarea');
      await expect(editor).toBeVisible();
      const editorBox = await editor.boundingBox();
      assert(
        editorBox && editorBox.x >= 0 && editorBox.x + editorBox.width <= width,
        'Message editor must fit viewport',
      );
      await editor.press('Escape');
      await expect(editor).toHaveCount(0);
      const signal = page.locator('.ws-signal-wave rect').first();
      await expect(signal).toBeVisible();
      assert.equal(
        await signal.evaluate((el) => getComputedStyle(el).animationName),
        'ws-signal-wave',
      );
      // Read the same production animation on two animation frames; CSS presence alone is insufficient.
      assert(
        await signal.evaluate(async (el) => {
          const animation = el.getAnimations()[0];
          const before = animation?.currentTime;
          await new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          );
          return animation?.playState === 'running' && animation.currentTime > before;
        }),
        'Live tool animation must advance',
      );
      const wave = page.locator('.thinking-wave span').first();
      assert.equal(await wave.evaluate((el) => getComputedStyle(el).animationName), 'thinkingWave');
      const disclosure = page.locator('.ws-tool-disclosure');
      await disclosure.click();
      await expect(disclosure).toHaveAttribute('aria-expanded', 'true');
      await expect(page.locator('.ws-tool-body')).toBeVisible();
      await page.getByRole('button', { name: 'Complete tool', exact: true }).click();
      await expect(page.locator('.ws-activity-signal')).toHaveAttribute('data-state', 'success');
      await expect(page.locator('.ws-tool-body')).toContainText('No diagnostics found');
      await page.getByRole('button', { name: 'Fail tool', exact: true }).click();
      await expect(page.locator('.ws-activity-signal')).toHaveAttribute('data-state', 'error');
      await page.getByRole('button', { name: 'Complete tool', exact: true }).click();
      const model = page.getByTestId('interaction-model');
      const trigger = model.getByRole('button').first();
      await trigger.click();
      await expect(trigger).toHaveAttribute('aria-expanded', 'true');
      const popupId = await trigger.getAttribute('aria-controls');
      assert(popupId, 'Model trigger must identify its open popup');
      const popup = page.locator(`[id="${popupId}"]`);
      await expect(popup.locator('input')).toBeFocused();
      await popup.locator('input').fill('Review');
      await popup.getByRole('button', { name: /Review model/ }).click();
      await expect(trigger).toContainText('review');
      await trigger.click();
      await page.keyboard.press('Escape');
      await expect(trigger).toBeFocused();
      await expect(trigger).toHaveAttribute('aria-expanded', 'false');
      await page.getByRole('button', { name: /Review workspace/ }).click();
      await expect(page.getByRole('button', { name: /Review workspace/ })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      await page.getByRole('button', { name: 'Copy workspace summary', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Copied', exact: true })).toHaveAttribute(
        'data-copied',
        'true',
      );
      assert.equal(
        await page.evaluate(() => navigator.clipboard.readText()),
        'Workspace copy verification',
      );
      await page.getByRole('button', { name: 'Open queue', exact: true }).click();
      const dialog = page.getByRole('dialog');
      await expect(page.getByTestId('queue-item')).toHaveCount(2);
      const box = await dialog.boundingBox();
      await assertSquareCorners(page);
      assert(box && box.x >= 0 && box.x + box.width <= width + 1, 'Queue must fit viewport');
      await page.getByTestId('queue-sort-toggle').click();
      await page.getByTestId('queue-remove-0').click();
      await expect(page.getByTestId('queue-item')).toHaveCount(1);
      await page.screenshot({
        animations: 'disabled',
        path: path.join(output, `interaction-queue-${theme}-${width}.png`),
      });
      await dialog.getByRole('button', { name: 'Close', exact: true }).click();
      await expect(dialog).toHaveCount(0);
      await page.getByRole('button', { name: 'Open inspector', exact: true }).click();
      await expect(page.getByTestId('inspector-close')).toBeVisible();
      await assertSquareCorners(page);
      await page.getByTestId('inspector-close').click();
      await expect(page.getByTestId('inspector-close')).toHaveCount(0);
      await page.getByRole('button', { name: 'Show notification', exact: true }).click();
      await expect(page.locator('.ws-toast')).toContainText('Workspace review complete');
      await assertSquareCorners(page);
      assert.equal(
        await page
          .locator('.ws-toast-timer')
          .evaluate((el) => getComputedStyle(el).animationDuration),
        '20s',
      );
      await page.locator('.ws-toast button').click();
      await expect(page.locator('.ws-toast')).toHaveCount(0);
      assert(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        'Document must fit viewport',
      );
      const root = page.getByTestId('interaction-workbench');
      await assertSquareCorners(page);
      assert(
        await root.evaluate((el) => el.scrollWidth <= el.clientWidth),
        'Interaction content must fit viewport',
      );
      await page.getByRole('button', { name: 'Run tool', exact: true }).click();
      await page.emulateMedia({ reducedMotion: 'reduce' });
      assert.equal(await signal.evaluate((el) => getComputedStyle(el).animationName), 'none');
      assert.equal(await wave.evaluate((el) => getComputedStyle(el).animationName), 'none');
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      await root.evaluate((el) => {
        el.scrollTop = 0;
      });
      await page.screenshot({
        animations: 'disabled',
        path: path.join(output, `interaction-workspace-${theme}-${width}.png`),
      });
      results.push({
        theme,
        width,
        liveMotion: 'PASS',
        toolStates: 'PASS',
        modelKeyboard: 'PASS',
        copy: 'PASS',
        queue: 'PASS',
        inspector: 'PASS',
        toast: 'PASS',
        reducedMotion: 'PASS',
      });
      console.log('interaction workspace passed', theme, width);
      await page.close();
    }
  }
  return results;
}
