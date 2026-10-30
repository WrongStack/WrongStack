import assert from 'node:assert/strict';
import path from 'node:path';
import { expect } from '@playwright/test';

export async function checkNavigationLayout(browser, base, output, errors) {
  const failures = [];
  const results = [];
  const documentedResizeNotices = [];
  for (const theme of ['dark', 'light']) {
    for (const language of ['en', 'tr']) {
      for (const width of [1440, 390, 320]) {
        const page = await browser.newPage({
          viewport: { width, height: 640 },
          colorScheme: theme,
        });
        page.on('pageerror', (error) => errors.push(error.message));
        let earlierNativeErrors = [];
        await page.addInitScript((diagnostics) => {
          window.__navigationLayoutErrors = [];
          const traces = [];
          let lastResizeSource = '';
          const NativeResizeObserver = window.ResizeObserver;
          window.ResizeObserver = class extends NativeResizeObserver {
            constructor(callback) {
              const stack = new Error().stack ?? '';
              super((entries, observer) => {
                lastResizeSource = stack;
                if (diagnostics) {
                  traces.push({
                    stack,
                    targets: entries.map((entry) => ({
                      tag: entry.target.tagName,
                      className: String(entry.target.className),
                      width: entry.contentRect.width,
                      height: entry.contentRect.height,
                    })),
                  });
                  if (traces.length > 8) traces.shift();
                }
                callback(entries, observer);
              });
            }
          };
          window.addEventListener('error', (event) => {
            window.__navigationLayoutErrors.push({
              message: event.message,
              // Virtua documents this native notice as harmless. Require both
              // a null Error object and observed Virtua callback provenance;
              // all actual exceptions and other window errors still fail.
              // https://github.com/inokawa/virtua#what-is-resizeobserver-loop-completed-with-undelivered-notifications-error
              documentedResizeNotice:
                event.error == null &&
                event.message === 'ResizeObserver loop completed with undelivered notifications.' &&
                (lastResizeSource.includes('/virtua.js') || lastResizeSource.includes('/virtua/')),
              traces: diagnostics ? [...traces] : [],
            });
          });
        }, process.env.WEBUI_RESIZE_DIAGNOSTICS === '1');
        await page.emulateMedia({ reducedMotion: 'reduce' });
        const check = async (name, run) => {
          try {
            await run();
            results.push({ theme, language, width, name, result: 'PASS' });
          } catch (error) {
            failures.push(`${theme}/${language}/${width}/${name}: ${error.message}`);
          }
        };
        try {
          await page.goto(`${base}?navigation-review=1&lang=${language}&theme=${theme}`);
          await expect(page.getByTestId('navigation-review')).toBeVisible();
          const searchTrigger = page.getByRole('button', {
            name: 'Search conversation',
            exact: true,
          });
          await searchTrigger.click();
          const search = page.getByTestId('search-review').locator('.ws-dialog');
          await expect(search.locator('input')).toBeFocused();
          await search.locator('input').fill('workspace');
          await check('conversation search layout', async () => {
            const size = await search.evaluate((el) => ({
              width: el.clientWidth,
              content: el.scrollWidth,
            }));
            assert(
              size.content <= size.width + 1,
              `EXPECTED search controls to fit; ACTUAL ${JSON.stringify(size)}`,
            );
            if (width < 640) {
              const inputBox = await search.locator('input').boundingBox();
              assert(
                inputBox.width >= size.width / 2,
                `EXPECTED a readable search field; ACTUAL width ${inputBox.width}`,
              );
              for (const button of await search.getByRole('button').all()) {
                const box = await button.boundingBox();
                assert(
                  box.width >= 44 && box.height >= 44,
                  `EXPECTED mobile search touch targets >=44px; ACTUAL ${JSON.stringify(box)}`,
                );
              }
            }
          });
          await search.screenshot({
            animations: 'disabled',
            path: path.join(output, `navigation-search-${theme}-${language}-${width}.png`),
          });
          await check('search Escape control', async () => {
            await search.locator('input').press('Escape');
            await expect(search).toHaveCount(0);
            await expect(page.getByRole('textbox', { name: 'Review message' })).toBeFocused();
          });
          await searchTrigger.click();
          await expect(search.locator('input')).toBeFocused();
          await search.locator('input').fill('workspace');
          await check('search Escape from navigation button', async () => {
            await search.getByRole('button').nth(1).focus();
            await page.keyboard.press('Escape');
            await expect(search).toHaveCount(0, { timeout: 1500 });
            await expect(page.getByRole('textbox', { name: 'Review message' })).toBeFocused();
          });
          if (await search.count()) await search.getByRole('button').last().click();
          const paletteTrigger = page.getByRole('button', {
            name: 'Open command palette',
            exact: true,
          });
          await paletteTrigger.click();
          const palette = page.getByRole('dialog');
          await expect(palette.getByRole('combobox')).toBeFocused();
          await check('command palette layout', async () => {
            const header = palette.getByRole('combobox').locator('..');
            const size = await header.evaluate((el) => ({
              width: el.clientWidth,
              content: el.scrollWidth,
            }));
            assert(
              size.content <= size.width + 1,
              `EXPECTED command input to fit; ACTUAL ${JSON.stringify(size)}`,
            );
          });
          await check('command palette focus return', async () => {
            await page.keyboard.press('Escape');
            await expect(palette).toHaveCount(0);
            await expect(paletteTrigger).toBeFocused({ timeout: 1500 });
          });
          await check('palette preserves underlying conversation search', async () => {
            await searchTrigger.click();
            await expect(search.locator('input')).toBeFocused();
            await paletteTrigger.click();
            await expect(palette.getByRole('combobox')).toBeFocused();
            await page.keyboard.press('Escape');
            await expect(palette).toHaveCount(0);
            await expect(search).toHaveCount(1);
            await search.locator('input').press('Escape');
            await expect(search).toHaveCount(0);
          });
          for (const mode of ['Short task control', 'Long task content', 'Expanded task content']) {
            await page.getByRole('button', { name: mode, exact: true }).click();
            const task = page.getByTestId('task-review');
            await check(mode, async () => {
              const title = task.locator('h3');
              const size = await title.evaluate((el) => ({
                width: el.clientWidth,
                content: el.scrollWidth,
              }));
              assert(
                size.content <= size.width + 1,
                `EXPECTED task title to wrap; ACTUAL ${JSON.stringify(size)}`,
              );
              const body = task.locator('.sdd-rise > div').nth(1);
              const bodySize = await body.evaluate((el) => ({
                width: el.clientWidth,
                content: el.scrollWidth,
              }));
              assert(
                bodySize.content <= bodySize.width + 1,
                `EXPECTED task fields to fit; ACTUAL ${JSON.stringify(bodySize)}`,
              );
            });
            await page.screenshot({
              animations: 'disabled',
              path: path.join(
                output,
                `navigation-task-${mode.split(' ')[0].toLowerCase()}-${theme}-${language}-${width}.png`,
              ),
            });
          }
          await page.getByTestId('notification-menu-trigger').filter({ visible: true }).click();
          const notifications = page.getByRole('menu');
          await expect(notifications).toBeVisible();
          await check('localized notification controls', async () => {
            const header = notifications.locator('> div').first();
            const size = await header.evaluate((el) => ({
              width: el.clientWidth,
              content: el.scrollWidth,
            }));
            assert(
              size.content <= size.width + 1,
              `EXPECTED translated actions to fit; ACTUAL ${JSON.stringify(size)}`,
            );
          });
          await page.screenshot({
            animations: 'disabled',
            path: path.join(output, `navigation-notifications-${theme}-${language}-${width}.png`),
          });
          await page.keyboard.press('Escape');
          earlierNativeErrors = await page.evaluate(() => window.__navigationLayoutErrors);
          await page.goto(
            `${base}?navigation-review=1&views=1&view=settings&lang=${language}&theme=${theme}`,
          );
          const nav = page.locator('.ws-settings-nav');
          await expect(nav).toBeVisible();
          if (width < 1024) await nav.getByRole('button', { expanded: false }).click();
          const searchSettings = nav.getByRole('searchbox');
          await searchSettings.fill(language === 'en' ? 'color' : 'renk');
          await check('settings search control', async () => {
            await expect(nav.getByRole('tab')).not.toHaveCount(0);
          });
          await searchSettings.fill(
            await page.evaluate(async () => {
              const { i18n } = await import('/src/i18n/index.ts');
              return i18n.t('settings:features.autoReviewDebounceLabel');
            }),
          );
          await check('settings search finds review setting', async () => {
            const expectedLabel = await page.evaluate(async () => {
              const { i18n } = await import('/src/i18n/index.ts');
              return i18n.t('settings:tabs.chimera');
            });
            await expect(nav.getByRole('tab', { name: expectedLabel, exact: true })).toBeVisible({
              timeout: 1500,
            });
            const wrongLabel = await page.evaluate(async () => {
              const { i18n } = await import('/src/i18n/index.ts');
              return i18n.t('settings:tabs.context');
            });
            await expect(nav.getByRole('tab', { name: wrongLabel, exact: true })).toHaveCount(0);
          });
        } finally {
          const nativeErrors = [
            ...(earlierNativeErrors ?? []),
            ...((await page.evaluate(() => window.__navigationLayoutErrors)) ?? []),
          ];
          for (const error of nativeErrors ?? []) {
            if (error.documentedResizeNotice) {
              documentedResizeNotices.push({ theme, language, width, message: error.message });
              continue;
            }
            failures.push(`${theme}/${language}/${width}/window error: ${error.message}`);
            if (error.traces.length)
              console.error('RESIZE DIAGNOSTICS', JSON.stringify(error.traces).slice(0, 10000));
          }
          await page.close();
        }
      }
    }
  }
  for (const failure of failures) console.error('PROBLEM CONFIRMED', failure);
  assert.deepEqual(failures, [], 'Navigation layout contracts');
  console.log('FIX VERIFIED: navigation layouts', results.length);
  console.log('DOCUMENTED VIRTUA RESIZE NOTICES:', documentedResizeNotices.length);
  return results;
}
