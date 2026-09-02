// Temporary end-to-end test script for file reference / add-to-chat flow.
// Run from repo root: node packages/webui/tests/manual-e2e.mjs
import { chromium } from '../../../node_modules/playwright-core/index.mjs';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:5173';

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

  try {
    console.log(`\nNavigating to ${BASE}...`);
    await page.goto(BASE, { waitUntil: 'networkidle', timeout: 20000 });
    console.log('Page loaded.\n');

    const title = await page.title();
    console.log(`Title: ${title}`);

    await page.screenshot({ path: 'e2e-screenshot-01-initial.png', fullPage: false });
    console.log('Screenshot saved: e2e-screenshot-01-initial.png');

    // Wait for WebSocket connection and data load
    await page.waitForTimeout(5000);

    // Look for the file explorer tree
    const tree = page.locator('[role="tree"]');
    const treeVisible = await tree.isVisible().catch(() => false);
    console.log(`File tree visible: ${treeVisible}`);

    if (treeVisible) {
      // Count tree items
      const allItems = page.locator('[role="treeitem"]');
      const itemCount = await allItems.count().catch(() => 0);
      console.log(`Tree items: ${itemCount}`);

      if (itemCount > 0) {
        // Get file names, try to find one that has a file icon (not folder)
        // aria-selected is only on file items
        for (let i = 0; i < itemCount; i++) {
          const item = allItems.nth(i);
          const text = await item.textContent().catch(() => '');
          const selected = await item.getAttribute('aria-selected').catch(() => null);
          console.log(`  [${i}] text="${text?.trim()}" selected=${selected}`);
        }

        // Right-click the first file item (has aria-selected)
        const fileItems = page.locator('[role="treeitem"][aria-selected]');
        const fileCount = await fileItems.count().catch(() => 0);
        console.log(`\nFile items (with aria-selected): ${fileCount}`);

        if (fileCount > 0) {
          const firstFile = fileItems.first();
          const fileName = await firstFile.textContent();
          console.log(`Right-clicking file: "${fileName?.trim()}"`);
          await firstFile.click({ button: 'right' });
          await page.waitForTimeout(800);

          await page.screenshot({ path: 'e2e-screenshot-02-context-menu.png', fullPage: false });
          console.log('Screenshot saved: e2e-screenshot-02-context-menu.png');

          // Look for the context menu with "Mention in chat" or Turkish "Sohbette bahset"
          const mentionBtn = page.getByText('Mention in chat');
          const mentionVisible = await mentionBtn.isVisible().catch(() => false);
          console.log(`'Mention in chat' visible: ${mentionVisible}`);

          if (mentionVisible) {
            await mentionBtn.click();
            await page.waitForTimeout(800);

            await page.screenshot({ path: 'e2e-screenshot-03-after-mention.png', fullPage: false });
            console.log('Screenshot saved: e2e-screenshot-03-after-mention.png');

            // Check for the References label in chat input
            const refsLabel = page.getByText('References');
            const refsVisible = await refsLabel.isVisible().catch(() => false);
            console.log(`References label visible: ${refsVisible}`);
          } else {
            // Log all visible text to debug
            const bodyText = await page
              .locator('body')
              .textContent()
              .catch(() => '');
            console.log(`Page text (first 500 chars): ${bodyText.slice(0, 500)}`);
          }
        }
      }
    } else {
      // Take a screenshot regardless
      await page.screenshot({ path: 'e2e-screenshot-01b-state.png', fullPage: false });
      console.log('Fallback screenshot saved.');

      const bodyText = await page
        .locator('body')
        .textContent()
        .catch(() => '');
      console.log(`Page text (first 500 chars): ${bodyText.slice(0, 500)}`);
    }

    console.log('\nTest complete!');
  } catch (err) {
    console.error('Error:', err.message);
    await page.screenshot({ path: 'e2e-screenshot-error.png', fullPage: false }).catch(() => {});
  } finally {
    await browser.close();
  }
}

main();
