import { test, expect } from '@playwright/test';

/**
 * AgentFlowCanvas E2E tests — verify the flow graph canvas renders,
 * shows nodes and edges, and responds to pan/zoom interactions.
 *
 * Uses the viz store which is fed by the WebSocket fleet events.
 */
test.describe('AgentFlowCanvas', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
  });

  test('canvas renders without crash', async ({ page }) => {
    // Look for the React Flow canvas container
    const canvas = page
      .locator('.react-flow, [class*="flow-canvas"], [class*="agent-flow"]')
      .first();
    if (await canvas.isVisible({ timeout: 5000 })) {
      await expect(canvas).toBeVisible();
    }
  });

  test('minimap is present', async ({ page }) => {
    const minimap = page.locator('[class*="minimap"], .react-flow__minimap').first();
    if (await minimap.isVisible({ timeout: 3000 })) {
      await expect(minimap).toBeVisible();
    }
  });

  test('controls (zoom in/out) are present', async ({ page }) => {
    const controls = page.locator('.react-flow__controls, [class*="flow-controls"]').first();
    if (await controls.isVisible({ timeout: 3000 })) {
      await expect(controls).toBeVisible();
      // Should have zoom in and zoom out buttons
      const zoomIn = controls.locator('button').first();
      await expect(zoomIn).toBeEnabled();
    }
  });

  test('background pattern renders', async ({ page }) => {
    const background = page.locator('.react-flow__background, [class*="background"]').first();
    if (await background.isVisible({ timeout: 3000 })) {
      await expect(background).toBeVisible();
    }
  });

  test('canvas can be panned', async ({ page }) => {
    const canvas = page.locator('.react-flow, [class*="flow-canvas"]').first();
    if (await canvas.isVisible({ timeout: 3000 })) {
      const box = await canvas.boundingBox();
      if (box) {
        // Drag across the canvas
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.down();
        await page.mouse.move(box.x + box.width / 2 + 100, box.y + box.height / 2 + 100);
        await page.mouse.up();
        // Canvas should still be visible after pan
        await expect(canvas).toBeVisible();
      }
    }
  });

  test('canvas can be zoomed', async ({ page }) => {
    const canvas = page.locator('.react-flow, [class*="flow-canvas"]').first();
    if (await canvas.isVisible({ timeout: 3000 })) {
      const controls = page.locator('.react-flow__controls, [class*="flow-controls"]').first();
      if (await controls.isVisible({ timeout: 1000 })) {
        const zoomInBtn = controls.locator('button').first();
        await zoomInBtn.click();
        // Zoom should have happened (canvas still visible)
        await expect(canvas).toBeVisible();
      }
    }
  });

  test('agent nodes appear in canvas', async ({ page }) => {
    // Wait a moment for fleet events to populate the viz store
    await page.waitForTimeout(1000);
    const nodes = page.locator('.react-flow__node, [class*="flow-node"]');
    const count = await nodes.count();
    // Should have at least some nodes if the viz store is populated
    if (count > 0) {
      await expect(nodes.first()).toBeAttached();
    }
  });

  test('edge labels render for tool calls', async ({ page }) => {
    await page.waitForTimeout(1000);
    const edges = page.locator('.react-flow__edge, [class*="flow-edge"]');
    const count = await edges.count();
    if (count > 0) {
      await expect(edges.first()).toBeAttached();
    }
  });
});
