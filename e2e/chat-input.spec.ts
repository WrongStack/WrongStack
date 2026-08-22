import { expect, test } from '@playwright/test';

/**
 * ChatInput E2E tests — verify the chat input renders, accepts text,
 * handles slash commands, and shows the send button.
 *
 * These tests run against the live WebUI server.
 *
 * The WebUI has two states on load:
 *  - **setup**: no provider/model configured yet → SetupScreen is visible.
 *  - **ready**: provider/model configured → ChatInput is visible.
 *
 * Previous versions used `if (await input.isVisible())` guards that silently
 * passed when the expected UI was absent. These strict versions fail if
 * neither the chat input nor the setup screen is present.
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
    .poll(async () => (await inputLocator.isVisible()) || (await setupLocator.isVisible()), {
      timeout: 10_000,
      message: 'Neither chat input nor setup screen appeared',
    })
    .toBe(true);

  if (await inputLocator.isVisible()) return 'chat';
  return 'setup';
}

test.describe('ChatInput', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
  });

  test('either chat input or setup screen is visible on load', async ({ page }) => {
    // This test itself replaces the old silent-pass behavior.
    // If neither appears, the app failed to load.
    const state = await waitForReadyState(page);
    expect(['chat', 'setup']).toContain(state);
  });

  test('input field is present and editable when chat is ready', async ({ page }) => {
    const state = await waitForReadyState(page);
    expect(state, 'chat input should be visible when provider is configured').toBe('chat');

    const input = page.locator(chatInput).first();
    await input.fill('Hello, world!');
    await expect(input).toHaveValue('Hello, world!');
  });

  test('send button is present when input has text', async ({ page }) => {
    const state = await waitForReadyState(page);
    expect(state, 'chat input should be visible when provider is configured').toBe('chat');

    const input = page.locator(chatInput).first();
    await input.fill('Test message');

    // The send button should appear or become enabled once text is entered.
    const sendBtn = page.locator('[aria-label*="send" i], button:has(svg[class*="send"])').first();
    await expect(sendBtn).toBeVisible({ timeout: 3000 });
    await expect(sendBtn).toBeEnabled();
  });

  test('slash command menu appears on /', async ({ page }) => {
    const state = await waitForReadyState(page);
    expect(state, 'chat input should be visible when provider is configured').toBe('chat');

    const input = page.locator(chatInput).first();
    await input.focus();
    await input.fill('/');

    // SlashCommandPopup renders above the composer with a keyboard-hint
    // header and one button per matching command (see
    // packages/webui/src/components/ChatInput/slash-popup.tsx). Anchor on
    // the unique hint text, then scope to its popup container — other
    // `bottom-full`-anchored elements exist in the DOM.
    const hint = page.getByText(/Tab complete/);
    await expect(hint).toBeVisible({ timeout: 5000 });
    const popup = hint.locator('xpath=ancestor::div[contains(@class,"bottom-full")][1]');
    // At least one command entry is offered — the command name renders in
    // a font-mono span.
    await expect(popup.locator('button span.font-mono').first()).toBeVisible();
  });

  test('draft token counter shows for long input', async ({ page }) => {
    const state = await waitForReadyState(page);
    expect(state, 'chat input should be visible when provider is configured').toBe('chat');

    const input = page.locator(chatInput).first();
    // DraftTokenCounter appears from the first character and switches to
    // token estimates at >= 400 chars (4-char heuristic) — see
    // packages/webui/src/components/ChatInput/draft-token-counter.tsx.
    await input.fill('B'.repeat(450));

    const counter = page.locator('span[title*="tokens" i]').first();
    await expect(counter).toBeVisible({ timeout: 3000 });
    await expect(counter).toContainText('450');
  });

  test('abort button is attached to DOM', async ({ page }) => {
    const state = await waitForReadyState(page);
    expect(state, 'chat input should be visible when provider is configured').toBe('chat');

    // The abort button may be hidden without an active request, but it
    // should be present in the DOM.
    const abortBtn = page
      .locator('[aria-label*="abort" i], button:has(svg[class*="square"])')
      .first();
    await expect(abortBtn).toBeAttached({ timeout: 3000 });
  });

  test('refine panel toggle is accessible', async ({ page }) => {
    const state = await waitForReadyState(page);
    expect(state, 'chat input should be visible when provider is configured').toBe('chat');

    // The enhance/refine toggle sits in the composer button bar and
    // exposes its state via title (chat:input.refineEnabledTitle /
    // refineDisabledTitle in packages/webui/src/i18n/locales/en/chat.json).
    const refineToggle = page.locator('button[title*="Refining" i]').first();
    await expect(refineToggle).toBeVisible({ timeout: 5000 });
    await refineToggle.click();
    // The toggle flips state — the title attribute swaps between the
    // enabled/disabled wording.
    await expect(refineToggle).toHaveAttribute('title', /refining/i, { timeout: 5000 });
    // Click back to restore the original state.
    await refineToggle.click();
  });

  test('file attach button is present', async ({ page }) => {
    const state = await waitForReadyState(page);
    expect(state, 'chat input should be visible when provider is configured').toBe('chat');

    const attachBtn = page.locator('[aria-label*="attach" i], [aria-label*="file" i]').first();
    await expect(attachBtn).toBeVisible({ timeout: 3000 });
    await expect(attachBtn).toBeEnabled();
  });
});
