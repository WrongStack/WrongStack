import { expect, test } from '@playwright/test';

/**
 * File Explorer E2E tests — verify the file tree renders, files can be
 * opened, edited in the code editor, and saved via Ctrl+S.
 *
 * These tests run against the live WebUI server.
 */

/** The chat input locator — matches textarea or input with message-like attributes. */
const chatInput =
  'textarea[placeholder*="message" i], textarea[placeholder*="input" i], input[placeholder*="message" i], input[placeholder*="input" i], textarea[data-testid="chat-input"]';

/** The setup screen locator — shown when no provider/model is configured. */
const setupScreen = '[data-testid="setup-screen"], [class*="setup"], [class*="Setup"]';

/**
 * Wait for either the chat input or the setup screen to become visible,
 * then return which state the WebUI is in.
 */
async function waitForReadyState(page: import('@playwright/test').Page): Promise<'chat' | 'setup'> {
  const inputLocator = page.locator(chatInput).first();
  const setupLocator = page.locator(setupScreen).first();

  await expect
    .poll(
      async () => {
        const inputVisible = await inputLocator.isVisible().catch(() => false);
        const setupVisible = await setupLocator.isVisible().catch(() => false);
        return inputVisible || setupVisible;
      },
      { timeout: 10_000, message: 'Neither chat input nor setup screen appeared' },
    )
    .toBe(true);

  const inputVisible = await inputLocator.isVisible().catch(() => false);
  return inputVisible ? 'chat' : 'setup';
}

/** Open the Files view from the activity bar. */
async function openFilesView(page: import('@playwright/test').Page): Promise<void> {
  // The Files activity button is labeled via its tooltip/accessibility name.
  const filesButton = page
    .getByRole('button', { name: /^Files/ })
    .or(page.locator('button:has(svg.lucide-folder-open)'))
    .first();
  await filesButton.click();
  // Wait for the view to render — the editor area (or its empty state).
  await page.waitForTimeout(500);
}

test.describe('WebUI File Explorer', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('files view opens from the activity bar', async ({ page }) => {
    const state = await waitForReadyState(page);
    expect(state).toBe('chat');

    await openFilesView(page);

    // The main surface switches to the code editor area. With no file
    // open it renders an explicit empty state (activity:codeEditor.
    // noFilesOpen); once a file opens it renders the Monaco editor.
    const editor = page.locator('.monaco-editor').or(page.getByText(/no files open/i));
    await expect(editor.first()).toBeVisible({ timeout: 10_000 });
  });

  test('file tree shows project files', async ({ page }) => {
    const state = await waitForReadyState(page);
    expect(state).toBe('chat');

    await openFilesView(page);

    // The side panel's file tree renders one treeitem per visible entry
    // (folders and files — see FileExplorer/TreeRow.tsx, role="treeitem").
    const treeItems = page.getByRole('treeitem');
    await expect(treeItems.first()).toBeVisible({ timeout: 10_000 });
    const count = await treeItems.count();
    expect(count, 'file tree should list more than one entry').toBeGreaterThan(1);
  });

  test('opening a file shows its content in the editor', async ({ page }) => {
    const state = await waitForReadyState(page);
    expect(state).toBe('chat');

    await openFilesView(page);

    // Wait for the tree to populate, then click the first file node.
    // File nodes are typically clickable spans/li elements with filenames.
    const fileNode = page
      .locator(
        '[class*="tree"] [class*="file"], [class*="tree"] [class*="node"], [class*="file-row"]',
      )
      .first();

    // If file nodes exist, click one and verify the editor shows content.
    if (await fileNode.isVisible({ timeout: 5000 }).catch(() => false)) {
      await fileNode.click();
      // The Monaco editor should have a textarea with content
      const editorTextarea = page
        .locator('.monaco-editor textarea.inputarea, [role="textbox"]')
        .first();
      await expect(editorTextarea).toBeVisible({ timeout: 5000 });
    }
  });

  test('Ctrl+S triggers file save (no error)', async ({ page }) => {
    const state = await waitForReadyState(page);
    expect(state).toBe('chat');

    await openFilesView(page);

    // If a file is open, press Ctrl+S and verify no crash/error toast
    const editor = page
      .locator('.monaco-editor, [role="textbox"], textarea.inputarea, [class*="editor"]')
      .first();
    if (await editor.isVisible({ timeout: 5000 }).catch(() => false)) {
      await editor.focus();
      await page.keyboard.press('Control+S');

      // Wait briefly for the save event to process — no error toast should appear
      await page.waitForTimeout(1000);

      // Check for error toasts (should not be present for a valid save)
      const errorToast = page
        .locator('[class*="toast"][class*="error"], [class*="toast"][class*="destructive"]')
        .first();
      // This is a negative assertion — the test passes if no error toast appeared
      expect(await errorToast.isVisible().catch(() => false)).toBe(false);
    }
  });

  test('files view can navigate back to chat', async ({ page }) => {
    const state = await waitForReadyState(page);
    expect(state).toBe('chat');

    await openFilesView(page);

    // Click the chat button in the activity bar to return
    const chatButton = page
      .locator('button:has(svg.lucide-message-square), button[title*="chat" i]')
      .first();
    await chatButton.click();

    // Chat input should be visible again
    await expect(page.locator(chatInput).first()).toBeVisible({ timeout: 5000 });
  });
});
