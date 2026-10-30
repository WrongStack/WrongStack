import assert from 'node:assert/strict';
import path from 'node:path';
import { expect } from '@playwright/test';
import en from '../../src/i18n/locales/en/activity.json' with { type: 'json' };
import tr from '../../src/i18n/locales/tr/activity.json' with { type: 'json' };

export async function checkHistoryLayout(browser, base, output, errors) {
  const results = [];
  const failures = [];
  for (const theme of ['light', 'dark']) {
    for (const lang of ['en', 'tr']) {
      for (const width of [1440, 768, 390, 320]) {
        const page = await browser.newPage({
          viewport: { width, height: 820 },
          colorScheme: theme,
        });
        page.on('pageerror', (error) => errors.push(error.message));
        await page.emulateMedia({ reducedMotion: 'reduce' });
        const l = (lang === 'en' ? en : tr).sessions;
        const check = async (name, run) => {
          try {
            await run();
            results.push({ theme, lang, width, name, result: 'PASS' });
          } catch (error) {
            failures.push(`${theme}/${lang}/${width}/${name}: ${error.message}`);
          }
        };
        const ids = () =>
          page
            .locator('[data-session-id]')
            .evaluateAll((rows) => rows.map((row) => row.dataset.sessionId));
        try {
          await page.goto(`${base}?history-review=1&theme=${theme}&lang=${lang}`);
          const history = page.locator('[data-history-variant]');
          const rows = history.locator('[data-session-id]');
          const first = history.locator('[data-session-id="history-recent"]');
          const search = history.getByRole('searchbox', { name: l.filterPlaceholder });
          const sort = history.getByRole('combobox', { name: l.sort.label });
          await expect(rows).toHaveCount(3);
          await page.evaluate(() => document.fonts.ready);
          await check('recent order control', async () =>
            assert.deepEqual(await ids(), ['history-recent', 'history-long', 'history-older']),
          );
          await check('row width and readable main content', async () => {
            const size = await first.evaluate((row) => ({
              width: row.clientWidth,
              content: row.scrollWidth,
              body: row.querySelector('button').getBoundingClientRect().width,
            }));
            assert(
              size.content <= size.width + 1,
              `EXPECTED row to fit; ACTUAL ${JSON.stringify(size)}`,
            );
            assert(
              size.body >= size.width * 0.6,
              `EXPECTED at least 60% of row width for session content; ACTUAL ${JSON.stringify(size)}`,
            );
          });
          await page.screenshot({
            animations: 'disabled',
            path: path.join(output, `history-workspace-${theme}-${lang}-${width}.png`),
          });
          for (const order of ['tokens', 'activity']) {
            await sort.selectOption(order);
            await check(`${order} ordering across dates`, async () =>
              assert.deepEqual(await ids(), ['history-older', 'history-long', 'history-recent']),
            );
          }
          await sort.selectOption('recent');
          await check('search and no-match control', async () => {
            await search.fill('Older detailed');
            await expect(rows).toHaveCount(1);
            await search.fill('no-such-session-in-this-workspace');
            await expect(history.getByText(l.noMatches, { exact: true })).toBeVisible();
            await history.getByTitle(l.clearFilter).click();
            await expect(rows).toHaveCount(3);
          });
          await check('favorite filter', async () => {
            await first.getByTitle(l.markFavorite).click();
            await history.getByRole('button', { name: l.filters.favorites, exact: true }).click();
            await expect(rows).toHaveCount(1);
            assert.deepEqual(await ids(), ['history-recent']);
            await history.getByRole('button', { name: l.filters.all, exact: true }).click();
            await first.getByTitle(l.unfavorite).click();
          });
          await check('rename Escape does not save', async () => {
            await first.getByTitle(l.renameAction).click();
            const name = history.getByRole('textbox', { name: l.rename, exact: true });
            await expect(name).toBeFocused();
            await name.fill('Cancelled history draft');
            await name.press('Escape');
            assert.deepEqual(await page.evaluate(() => window.fixture.historyActions), []);
            await expect(name).toHaveCount(0);
          });
          await check('rename Enter saves once', async () => {
            await first.getByTitle(l.renameAction).click();
            const name = history.getByRole('textbox', { name: l.rename, exact: true });
            await name.fill('Renamed workspace');
            await name.press('Enter');
            assert.deepEqual(await page.evaluate(() => window.fixture.historyActions), [
              { type: 'rename', id: 'history-recent', name: 'Renamed workspace' },
            ]);
            await expect(first.getByTitle('Renamed workspace', { exact: true })).toBeVisible();
          });
          await page.getByRole('button', { name: 'Toggle sidebar variant' }).click();
          await check('sidebar control', async () => {
            await expect(history).toHaveAttribute('data-history-variant', 'sidebar');
            const size = await history.evaluate((el) => ({
              width: el.clientWidth,
              content: el.scrollWidth,
            }));
            assert(
              size.content <= size.width + 1,
              `EXPECTED sidebar to fit; ACTUAL ${JSON.stringify(size)}`,
            );
            assert(size.width <= 301, 'EXPECTED the sidebar control to stay within 300px');
            await expect(rows).toHaveCount(3);
          });
          await page.screenshot({
            animations: 'disabled',
            path: path.join(output, `history-sidebar-${theme}-${lang}-${width}.png`),
          });
          await page.getByRole('button', { name: 'Toggle large history' }).click();
          await check('pagination resets after search', async () => {
            await expect(rows).toHaveCount(10);
            await history
              .getByRole('button', { name: (lang === 'en' ? en : tr).pagination.nextPage })
              .click();
            await expect(rows).toHaveCount(10);
            await search.fill('Older detailed');
            await expect(rows).toHaveCount(1);
            assert.deepEqual(await ids(), ['history-older']);
          });
        } finally {
          await page.close();
        }
      }
    }
  }
  console.log(`HISTORY CHECKS: ${results.length} passed`);
  if (failures.length) console.error(failures.join('\n'));
  assert.deepEqual(failures, [], 'PROBLEM CONFIRMED: history defects');
  console.log('PROBLEM NOT REPRODUCED; FIX VERIFIED');
  return results;
}
