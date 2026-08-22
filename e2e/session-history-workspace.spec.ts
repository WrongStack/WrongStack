import { expect, test } from '@playwright/test';

/**
 * Session history workspace — the SessionsDashboard (History | Live tabs)
 * opened via the "Open sessions dashboard" button in the Session side
 * panel. The former History activity-bar entry was folded into 'chat'
 * (see the Activity union in packages/webui/src/stores/ui-store.ts).
 */

test.describe('session history workspace', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
  });

  test('promotes sidebar history into the full History and Live workspace', async ({ page }) => {
    // The dashboard opens from the Session panel header button
    // (activity:history.openDashboard in SessionPanel.tsx).
    await page.getByRole('button', { name: /open sessions dashboard/i }).click();

    const workspace = page.getByTestId('sessions-workspace');
    await expect(workspace).toBeVisible({ timeout: 10_000 });

    // The workspace header exposes the filter searchbox
    // (activity:sessions.filterPlaceholder) and starts on the History tab.
    await expect(workspace.getByRole('searchbox', { name: /Filter title/i })).toBeVisible();
    const historyTab = workspace.getByRole('tab', { name: /^History$/ });
    await expect(historyTab).toHaveAttribute('aria-selected', 'true');

    // The workspace variant of the history list renders plus its stats
    // rail (labels are CSS-uppercased — match case-insensitively).
    await expect(workspace.locator('[data-history-variant="workspace"]')).toBeVisible();
    await expect(workspace.getByText(/^tool calls$/i)).toBeVisible();
    await expect(workspace.getByText(/^files changed$/i)).toBeVisible();

    const liveTab = workspace.getByRole('tab', { name: /live sessions/i });
    await liveTab.click();
    await expect(liveTab).toHaveAttribute('aria-selected', 'true');
  });

  test('keeps the square website geometry across controls', async ({ page }) => {
    await page.getByRole('button', { name: /open sessions dashboard/i }).click();

    const workspace = page.getByTestId('sessions-workspace');
    await expect(workspace).toBeVisible({ timeout: 10_000 });

    // The workspace uses sharp-cornered (square) geometry for the filter
    // searchbox, tab triggers, and history filter chips.
    await expect(workspace.getByRole('searchbox')).toHaveCSS('border-radius', '0px');
    await expect(workspace.getByRole('tab', { name: /^History$/ })).toHaveCSS(
      'border-radius',
      '0px',
    );
    await expect(workspace.getByRole('button', { name: 'All', exact: true })).toHaveCSS(
      'border-radius',
      '0px',
    );
  });
});
