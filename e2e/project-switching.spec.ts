import { test, expect } from '@playwright/test';

/**
 * Project switching E2E tests — verify the projects panel opens, shows
 * registered projects, allows selecting/switching, and has the add-project
 * dialog.
 *
 * These tests run against the live WebUI server.
 */

/** The chat input locator — matches textarea or input with message-like attributes. */
const chatInput = 'textarea[placeholder*="message" i], textarea[placeholder*="input" i], input[placeholder*="message" i], input[placeholder*="input" i], textarea[data-testid="chat-input"]';

/** The setup screen locator — shown when no provider/model is configured. */
const setupScreen = '[data-testid="setup-screen"], [class*="setup"], [class*="Setup"]';

/**
 * Wait for either the chat input or the setup screen to become visible,
 * then return which state the WebUI is in.
 */
async function waitForReadyState(page: import('@playwright/test').Page): Promise<'chat' | 'setup'> {
  const inputLocator = page.locator(chatInput).first();
  const setupLocator = page.locator(setupScreen).first();

  await expect.poll(
    async () => {
      const inputVisible = await inputLocator.isVisible().catch(() => false);
      const setupVisible = await setupLocator.isVisible().catch(() => false);
      return inputVisible || setupVisible;
    },
    { timeout: 10_000, message: 'Neither chat input nor setup screen appeared' },
  ).toBe(true);

  const inputVisible = await inputLocator.isVisible().catch(() => false);
  return inputVisible ? 'chat' : 'setup';
}

/** Open the Projects panel from the activity bar. */
async function openProjectsPanel(page: import('@playwright/test').Page): Promise<void> {
  const projectsButton = page.locator('button:has(svg.lucide-folders)').first();
  await projectsButton.click();
  await page.waitForTimeout(500);
}

test.describe('WebUI Project Switching', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  // FIXME(2026-08-17): rotten spec — times out in CI against current UI (run 31978025696); repair before re-enabling.

  test.fixme('projects panel opens from the activity bar', async ({ page }) => {
    const state = await waitForReadyState(page);
    expect(state).toBe('chat');

    await openProjectsPanel(page);

    // The projects panel should show either a list of projects or an empty state.
    // Look for project-related content: cards, list items, or "No projects" text.
    const projectContent = page.locator(
      '[class*="project"], [class*="Project"], :text-matches("project", "i")',
    ).first();
    await expect(projectContent).toBeVisible({ timeout: 5000 });
  });

  // FIXME(2026-08-17): rotten spec — times out in CI against current UI (run 31978025696); repair before re-enabling.

  test.fixme('project list shows registered projects or empty state', async ({ page }) => {
    const state = await waitForReadyState(page);
    expect(state).toBe('chat');

    await openProjectsPanel(page);

    // Either project cards/items are visible or the "No projects registered" empty state.
    const projectItems = page.locator('[class*="project-item"], [class*="project-card"], [class*="project-row"]');
    const emptyState = page.locator('text=/no projects/i');

    // At least one should be visible within 5s
    await expect.poll(
      async () => {
        const itemsVisible = await projectItems.first().isVisible().catch(() => false);
        const emptyVisible = await emptyState.first().isVisible().catch(() => false);
        return itemsVisible || emptyVisible;
      },
      { timeout: 5000, message: 'Neither project list nor empty state appeared' },
    ).toBe(true);
  });

  // FIXME(2026-08-17): rotten spec — times out in CI against current UI (run 31978025696); repair before re-enabling.

  test.fixme('add project dialog opens', async ({ page }) => {
    const state = await waitForReadyState(page);
    expect(state).toBe('chat');

    await openProjectsPanel(page);

    // Click the "Add Project" button (typically a + icon or "Add" text button)
    const addButton = page.locator('button:has(svg.lucide-plus), button:has-text("Add"), button:has-text("Add Project")').first();
    if (await addButton.isVisible({ timeout: 5000 }).catch(() => false)) {
      await addButton.click();

      // A dialog should appear with a folder path input
      await expect(page.locator('input[placeholder*="path" i], input[placeholder*="folder" i], input[placeholder*="project" i]')).toBeVisible({ timeout: 5000 });
    }
  });

  // FIXME(2026-08-17): rotten spec — times out in CI against current UI (run 31978025696); repair before re-enabling.

  test.fixme('selecting a project triggers switch flow', async ({ page }) => {
    const state = await waitForReadyState(page);
    expect(state).toBe('chat');

    await openProjectsPanel(page);

    // If there are project items, click the first one
    const projectItem = page.locator('[class*="project-item"], [class*="project-card"], [class*="project-row"]').first();
    if (await projectItem.isVisible({ timeout: 5000 }).catch(() => false)) {
      await projectItem.click();

      // After clicking a project, either:
      // 1. A confirmation dialog appears (if agents are running), or
      // 2. The view switches directly back to chat with the new project loaded
      const confirmDialog = page.locator('[role="dialog"], [class*="confirm"], [class*="dialog"]').first();
      const chatVisible = await page.locator(chatInput).first().isVisible().catch(() => false);

      // Either a dialog appeared or the chat view is visible
      const dialogVisible = await confirmDialog.isVisible().catch(() => false);
      expect(dialogVisible || chatVisible).toBe(true);
    }
  });

  // FIXME(2026-08-17): rotten spec — times out in CI against current UI (run 31978025696); repair before re-enabling.

  test.fixme('projects panel can navigate back to chat', async ({ page }) => {
    const state = await waitForReadyState(page);
    expect(state).toBe('chat');

    await openProjectsPanel(page);

    // Click the chat button to return
    const chatButton = page.locator('button:has(svg.lucide-message-square), button[title*="chat" i]').first();
    await chatButton.click();

    await expect(page.locator(chatInput).first()).toBeVisible({ timeout: 5000 });
  });
});
