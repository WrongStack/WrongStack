import assert from 'node:assert/strict';
import path from 'node:path';
import { expect } from '@playwright/test';

/** Real layouts at short viewport heights; document width alone misses clipped children. */
export async function checkResponsiveLayout(browser, base, output, errors) {
  const failures = [];
  const results = [];
  for (const theme of ['dark', 'light']) {
    for (const width of [1440, 768, 390, 320]) {
      const page = await browser.newPage({ viewport: { width, height: 720 }, colorScheme: theme });
      page.on('pageerror', (error) => errors.push(error.message));
      const check = async (name, run) => {
        try {
          await run();
          results.push({ theme, width, name, result: 'PASS' });
        } catch (error) {
          failures.push(`${theme}/${width}/${name}: ${error.message}`);
        }
      };
      const openView = async (view) => {
        await page.evaluate((next) => window.fixture.ui.getState().setCurrentView(next), view);
        const surface = page.locator(`[data-workbench-view="${view}"]`);
        await expect(surface).toBeVisible();
        await expect(surface.locator('.ws-loading-art')).toHaveCount(0, { timeout: 15000 });
        await page.evaluate(() => document.fonts.ready);
        return surface;
      };
      try {
        await page.goto(`${base}?theme=${theme}&views=1&composer=1`);
        await expect(page.locator('.ws-welcome h2')).toBeVisible();
        for (const view of [
          'provider-test',
          'context',
          'chronicle',
          'project-kit',
          'techstack',
          'session-story',
        ]) {
          const surface = await openView(view);
          await check(`${view} header`, async () => {
            const header = surface.locator('.ws-page-header').first();
            const overflow = await header.evaluate((el) => ({
              width: el.clientWidth,
              content: el.scrollWidth,
            }));
            assert(
              overflow.content <= overflow.width + 1,
              `EXPECTED header content to fit; ACTUAL ${JSON.stringify(overflow)}`,
            );
            const title = header.locator('h1').first();
            const size = await title.evaluate((el) => ({
              width: el.clientWidth,
              content: el.scrollWidth,
            }));
            assert(
              size.content <= size.width + 1,
              `EXPECTED readable title; ACTUAL ${JSON.stringify(size)}`,
            );
            const group = await title.evaluate((el) => ({
              width: el.parentElement.clientWidth,
              content: el.parentElement.scrollWidth,
            }));
            assert(
              group.content <= group.width + 1,
              `EXPECTED title and badges to fit; ACTUAL ${JSON.stringify(group)}`,
            );
            const titleBox = await title.boundingBox();
            const headerBox = await header.boundingBox();
            assert(
              titleBox.y >= headerBox.y &&
                titleBox.y + titleBox.height <= headerBox.y + headerBox.height + 1,
              'EXPECTED title inside header height; ACTUAL header content covered by the next section',
            );
            for (const button of await header.locator('button').all()) {
              const box = await button.boundingBox();
              if (!box) continue;
              assert(
                box.y >= headerBox.y && box.y + box.height <= headerBox.y + headerBox.height + 1,
                'EXPECTED actions inside header height; ACTUAL actions covered by the next section',
              );
              const overlaps =
                box.x < titleBox.x + titleBox.width &&
                box.x + box.width > titleBox.x &&
                box.y < titleBox.y + titleBox.height &&
                box.y + box.height > titleBox.y;
              assert(
                !overlaps,
                'EXPECTED page title clear of action buttons; ACTUAL overlapping controls',
              );
            }
          });
          if (view === 'context') {
            await check('context pressure scale', async () => {
              for (const card of await surface.locator('.ws-panel').all()) {
                const size = await card.evaluate((el) => ({
                  width: el.clientWidth,
                  content: el.scrollWidth,
                }));
                assert(
                  size.content <= size.width + 1,
                  `EXPECTED context scale inside card; ACTUAL ${JSON.stringify(size)}`,
                );
              }
            });
          }
          if (view === 'provider-test') {
            await check('topbar view label', async () => {
              const bar = page.locator('.ws-topbar:visible');
              const label = bar.getByText('Provider Test', { exact: true });
              const labelBox = await label.boundingBox();
              const officeBox = await bar.getByTestId('topbar-office-map').boundingBox();
              if (width < 768)
                assert(
                  labelBox.x + labelBox.width < officeBox.x,
                  'EXPECTED view label before actions; ACTUAL overlapping label',
                );
            });
          }
          if (view === 'chronicle') {
            await check('Chronicle table scroll', async () => {
              const resource = surface.getByText('Resource', { exact: true });
              const reachable = await resource.evaluate((el) => {
                for (let parent = el.parentElement; parent; parent = parent.parentElement) {
                  if (getComputedStyle(parent).overflowX === 'auto') {
                    parent.scrollLeft = parent.scrollWidth;
                    const child = el.getBoundingClientRect();
                    const outer = parent.getBoundingClientRect();
                    return child.right <= outer.right + 1 && child.left >= outer.left;
                  }
                }
                return false;
              });
              assert(
                reachable,
                'EXPECTED all event columns reachable in the table scroller; ACTUAL clipped header',
              );
            });
          }
          await page.screenshot({
            animations: 'disabled',
            path: path.join(output, `responsive-${view}-${theme}-${width}.png`),
          });
        }
        const analytics = await openView('analytics');
        await expect(analytics.locator('.ws-metric')).toHaveCount(6);
        await check('analytics card labels', async () => {
          for (const card of await analytics.locator('.ws-metric').all()) {
            const size = await card.evaluate((el) => ({
              width: el.clientWidth,
              content: el.scrollWidth,
            }));
            assert(
              size.content <= size.width + 1,
              `EXPECTED metric labels inside card; ACTUAL ${JSON.stringify(size)}`,
            );
          }
        });
        const setup = await openView('setup');
        await check('provider card headings', async () => {
          const overflow = await setup.locator('h3').evaluateAll((titles) =>
            titles
              .map((title) => title.parentElement)
              .filter((el) => el.scrollWidth > el.clientWidth + 1)
              .map((el) => el.textContent),
          );
          assert.deepEqual(overflow, [], 'EXPECTED provider title and badges to wrap');
        });
        const codemap = await openView('codemap');
        await check('Code Atlas controls', async () => {
          for (const selector of ['.ws-code-toolbar', '.ws-code-live-controls']) {
            const size = await codemap
              .locator(selector)
              .evaluate((el) => ({ width: el.clientWidth, content: el.scrollWidth }));
            assert(
              size.content <= size.width + 1,
              `EXPECTED ${selector} controls to fit; ACTUAL ${JSON.stringify(size)}`,
            );
          }
        });
        await page.evaluate(() => window.fixture.ui.getState().setCurrentView('chat'));
        const input = page.locator('[data-chat-textarea]:visible');
        await expect(input).toBeEnabled();
        for (const height of [720, 420]) {
          await page.setViewportSize({ width, height });
          for (const kind of ['companions', 'subagents']) {
            await check(`${kind} popover at height ${height}`, async () => {
              const trigger =
                kind === 'companions'
                  ? page.getByTestId('composer-companions-button')
                  : page
                      .locator('.ws-composer-options')
                      .getByRole('button', { name: /Subagents:/ });
              await trigger.click();
              const panel =
                kind === 'companions'
                  ? page.getByTestId('composer-companions-popover')
                  : page
                      .getByText('Subagent models', { exact: true })
                      .locator('..')
                      .locator('..')
                      .locator('..');
              await expect(panel).toBeVisible();
              const box = await panel.boundingBox();
              assert(
                box.x >= 0 &&
                  box.x + box.width <= width + 1 &&
                  box.y >= 0 &&
                  box.y + box.height <= height + 1,
                `EXPECTED ${kind} panel inside viewport; ACTUAL ${JSON.stringify(box)}`,
              );
              assert(
                await panel.evaluate(
                  (el) =>
                    el.scrollHeight <= el.clientHeight + 1 ||
                    getComputedStyle(el).overflowY === 'auto',
                ),
                'EXPECTED overflowing options to scroll',
              );
              const toggle = panel.getByRole(kind === 'companions' ? 'switch' : 'checkbox').first();
              if (kind === 'companions') {
                const previous = await toggle.getAttribute('aria-checked');
                await toggle.click();
                await expect(toggle).toHaveAttribute('aria-checked', String(previous !== 'true'));
                await toggle.click();
                await expect(toggle).toHaveAttribute('aria-checked', previous);
                assert.equal(
                  (await toggle.boundingBox()).height,
                  20,
                  'Companion switches retain their compact track height',
                );
              } else {
                const previous = await toggle.isChecked();
                await toggle.setChecked(!previous);
                await expect(panel).toBeVisible();
                await toggle.setChecked(previous);
              }
              await expect(panel).toBeVisible();
              await page.screenshot({
                animations: 'disabled',
                path: path.join(output, `responsive-${kind}-${theme}-${width}-${height}.png`),
              });
              await page.keyboard.press('Escape');
              await expect(trigger).toBeFocused();
            });
            await page.keyboard.press('Escape');
          }
        }
        await page.screenshot({
          animations: 'disabled',
          path: path.join(output, `responsive-composer-${theme}-${width}.png`),
        });
      } finally {
        await page.close();
      }
    }
  }
  for (const failure of failures) console.error('PROBLEM CONFIRMED', failure);
  assert.deepEqual(failures, [], 'Responsive layout contracts');
  console.log('FIX VERIFIED: responsive layouts', results.length);
  return results;
}
