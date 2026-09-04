import { expect, type Page, test } from '@playwright/test';

/**
 * Global workbench inspector drawer.
 *
 * The inspector is a fixed right-side Radix drawer. It overlays the active
 * work surface (no layout shift) and exposes the four monitor tabs
 * (Fleet / Agents / Audit / Council). Entry points are keyboard shortcuts —
 * F2 and Ctrl+Shift+M — since the compact-shell redesign moved the top-bar
 * trigger to opening the left Agents sidebar (`openPanel('agents')`)
 * instead of this drawer.
 */
async function openInspector(page: Page, via: 'f2' | 'ctrl-shift-m' = 'f2') {
  const drawer = page.getByTestId('inspector-drawer');
  // Both entry points reach the App.tsx root-effect keydown listener, and a
  // press right after networkidle can land before that listener attaches —
  // the boot race documented in fleet-monitor.spec.ts. Wait for app chrome,
  // neutralize focus (F1..F12 are skipped while a text field is focused and
  // the chat textarea auto-focuses at boot), and re-press once. Safe for
  // both paths: F2 is an idempotent open, and Ctrl+Shift+M on a closed
  // drawer takes the open branch of its toggle.
  for (let attempt = 0; attempt < 2; attempt++) {
    await expect(page.locator('#main-content')).toBeVisible();
    await page.locator('body').focus();
    // Ctrl+Shift+M is a TOGGLE (it closes the drawer when already open on
    // the Fleet tab — exactly the state it produces). A blind re-press
    // after a slow render would close the drawer it just opened, so on
    // retry check visibility first and skip the press if it landed.
    if (attempt > 0 && (await drawer.isVisible())) return drawer;
    if (via === 'f2') {
      await page.keyboard.press('F2');
    } else {
      await page.keyboard.press('Control+Shift+M');
    }
    try {
      await expect(drawer).toBeVisible({ timeout: 3_000 });
      return drawer;
    } catch {
      // Boot race lost the press — retry once.
    }
  }
  // Both attempts missed: fail with the standard assertion and full timeout
  // so the report shows the real symptom instead of a bare loop exit.
  await expect(drawer).toBeVisible();
  return drawer;
}

test.describe('global inspector drawer', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    // Readiness gate: the top bar (and its Agents trigger) renders only in
    // the ready state — not on the first-run setup screen.
    await expect(page.getByTestId('inspector-trigger').filter({ visible: true }).first()).toBeVisible();
  });

  test('opens on the right without shrinking the work surface', async ({ page }) => {
    const main = page.locator('#main-content');
    const widthBefore = (await main.boundingBox())?.width;

    const drawer = await openInspector(page);

    await expect
      .poll(async () => {
        const box = await drawer.boundingBox();
        if (!box) return Number.POSITIVE_INFINITY;
        return Math.abs(box.x + box.width - page.viewportSize()!.width);
      })
      .toBeLessThanOrEqual(1);
    expect((await main.boundingBox())?.width).toBe(widthBefore);
  });

  test('provides keyboard-accessible Fleet, Agents and Audit tabs', async ({ page }) => {
    // Ctrl+Shift+M exercises the second entry point (opens on the Fleet tab).
    await openInspector(page, 'ctrl-shift-m');

    const fleet = page.getByRole('tab', { name: /^Fleet/ });
    const agents = page.getByRole('tab', { name: /^Agents/ });
    const audit = page.getByRole('tab', { name: /^Audit/ });

    await expect(fleet).toHaveAttribute('aria-selected', 'true');
    await agents.click();
    await expect(agents).toHaveAttribute('aria-selected', 'true');

    // Radix roving focus: ArrowRight from the Agents tab moves focus to the
    // Audit tab and activates it (automatic activation).
    await agents.focus();
    await page.keyboard.press('ArrowRight');
    await expect(audit).toBeFocused();
    await expect(audit).toHaveAttribute('aria-selected', 'true');

    // The fourth monitor tab — Council — activates the same way.
    const council = page.getByRole('tab', { name: /^Council/ });
    await council.click();
    await expect(council).toHaveAttribute('aria-selected', 'true');
  });

  test('closes with the labelled action and restores trigger focus', async ({ page }) => {
    await openInspector(page);
    const trigger = page.getByTestId('inspector-trigger').filter({ visible: true }).first();

    await page.getByTestId('inspector-close').click();

    await expect(page.getByTestId('inspector-drawer')).toBeHidden();
    await expect(trigger).toBeFocused();
  });

  test('closes with Escape', async ({ page }) => {
    const drawer = await openInspector(page);

    await page.keyboard.press('Escape');

    await expect(drawer).toBeHidden();
  });
});
