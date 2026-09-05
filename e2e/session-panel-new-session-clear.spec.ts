import { expect, type Page, test } from '@playwright/test';

/**
 * SessionPanel quick actions — the two flows that own the tab topology:
 *
 *   1. "New session" opens a FRESH session as a NEW tab (through the
 *      identity-prompt picker, exactly like the tab bar's `+` and Ctrl+N),
 *      and never touches the sessions the other tabs hold.
 *   2. "Clear" retires the FOREGROUND tab's session and lands its
 *      replacement record in the SAME tab: same slot count, same selected
 *      position, new `?session=` id in the URL, and the retired record
 *      still listed by the server (closed, not deleted).
 *
 * Runs against the embedded WebUI host started by global-setup. Selector
 * notes (learned from the existing specs — see e2e/vector-memory-panel):
 *   - The panel lives inside the "Side panel" dialog (role=dialog,
 *     aria-label="Side panel"); every panel-button lookup is scoped to it.
 *     Without that scope, "New session" is ambiguous: the tab bar's `+`
 *     carries the same accessible name from the chat:newSession catalog
 *     entry (both are lowercase — do not rely on case to disambiguate).
 *   - A first-run host may auto-open the identity picker over the panel;
 *     it is dismissed before the test drives the panel itself.
 *   - The `sessions.list` WS frames must be subscribed BEFORE page.goto:
 *     page.on('websocket') only fires for sockets created after the
 *     subscription, and the boot socket is the one that carries the
 *     post-clear broadcast.
 *
 * Sessions created here (one per test) stay on record as empty, closed
 * sessions — deleting them from a live server is refused while it still
 * holds them (see e2e/four-tab-no-mixing), so the spec does not clean up.
 */

/** Latest `sessions.list` payload ids seen on ANY socket of this page. */
function sessionListWatcher(page: Page): () => string[] {
  let latest: string[] = [];
  page.on('websocket', (ws) => {
    ws.on('framereceived', (frame) => {
      try {
        const msg = JSON.parse(String(frame.payload ?? '{}')) as {
          type?: string;
          payload?: { sessions?: Array<{ id?: unknown }> };
        };
        if (msg.type === 'sessions.list' && Array.isArray(msg.payload?.sessions)) {
          latest = msg.payload.sessions
            .map((s) => (typeof s.id === 'string' ? s.id : ''))
            .filter(Boolean);
        }
      } catch {
        // non-JSON frame
      }
    });
  });
  return () => latest;
}

/** The `?session=` id the tab store syncs into the URL on activation. */
function sessionParam(page: Page): string | null {
  return new URL(page.url()).searchParams.get('session');
}

const tabs = (page: Page) =>
  page.getByRole('tablist', { name: 'Open session tabs' }).getByRole('tab');

/** Buttons inside the Session side panel (not the tab bar, not dialogs). */
const panelButton = (page: Page, name: string) =>
  page.getByRole('dialog', { name: 'Side panel' }).getByRole('button', { name, exact: true });

/** Index of the selected tab within the strip, or -1 before it renders. */
async function selectedIndex(page: Page): Promise<number> {
  const strip = page.getByRole('tablist', { name: 'Open session tabs' });
  return strip
    .getByRole('tab', { selected: true })
    .evaluate((el) => Array.prototype.indexOf.call(el.parentElement?.children ?? [], el))
    .catch(() => -1);
}

async function openChat(page: Page): Promise<void> {
  const token = process.env.WEBUI_E2E_TOKEN;
  await page.goto(token ? `/?token=${encodeURIComponent(token)}` : '/');
  // Chat ready — or a first-run host sitting on the setup screen, which
  // this spec cannot drive (no session to retire).
  const shell = page.locator('textarea, [data-testid="setup-screen"]').first();
  await expect(shell).toBeVisible({ timeout: 20_000 });
  test.skip(
    await page.getByTestId('setup-screen').isVisible(),
    'needs a configured provider (session flows unreachable from setup)',
  );
  // Dismiss a first-run identity picker so the panel is clickable; a host
  // that already chose a variant never opens it. Scoped by name — the side
  // panel itself carries role="dialog" ("Side panel"), as does the SAGE
  // memory-injector aside, so a bare dialog locator is never unique.
  const picker = page.getByRole('dialog', { name: 'System prompt' });
  if (await picker.isVisible()) {
    await picker.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(picker).toBeHidden();
  }
  // The boot session owns the strip's single tab and the URL's session id.
  await expect(page.getByRole('tablist', { name: 'Open session tabs' })).toBeVisible();
  expect(sessionParam(page)).toBeTruthy();
}

test.describe('SessionPanel — New session / Clear', () => {
  test('New session opens a fresh session as a NEW tab', async ({ page }) => {
    await openChat(page);

    const before = await tabs(page).count();
    expect(before).toBeGreaterThanOrEqual(1);
    const bootId = sessionParam(page);

    await panelButton(page, 'New session').click();

    // The identity-prompt picker owns the funnel; its confirm sends
    // `session.new`, which must never touch the boot session's tab.
    const picker = page.getByRole('dialog', { name: 'System prompt' });
    await expect(picker).toBeVisible();
    await picker.getByRole('button', { name: 'Apply & start session' }).click();
    await expect(picker).toBeHidden();

    // A new tab appeared at the end of the strip and took the foreground…
    await expect(tabs(page)).toHaveCount(before + 1);
    const newcomer = tabs(page).nth(before);
    await expect(newcomer).toHaveAttribute('aria-selected', 'true');
    // …the URL names the NEW session…
    await expect.poll(() => sessionParam(page)).not.toBe(bootId);
    // …and the boot tab keeps its slot, unselected.
    await expect(tabs(page).first()).toHaveAttribute('aria-selected', 'false');
  });

  test('Clear retires the session and lands a NEW record in the SAME tab', async ({ page }) => {
    // Subscribe before goto — the boot socket carries the post-clear
    // `sessions.list` broadcast (see header note).
    const listedIds = sessionListWatcher(page);
    await openChat(page);

    const before = await tabs(page).count();
    const bootId = sessionParam(page);
    expect(bootId).toBeTruthy();
    const selectedBefore = await selectedIndex(page);
    expect(selectedBefore).toBeGreaterThanOrEqual(0);

    // Idle session → no busy-confirm stands between the click and the swap.
    await panelButton(page, 'Clear').click();

    // The URL's session id flips to the replacement record…
    await expect.poll(() => sessionParam(page), { timeout: 15_000 }).not.toBe(bootId);
    const freshId = sessionParam(page);
    // …while the strip neither grows nor shrinks…
    await expect(tabs(page)).toHaveCount(before);
    // …and the SAME slot stays selected — no new tab, no tab closed.
    expect(await selectedIndex(page)).toBe(selectedBefore);

    // The retired record survives on the server as a CLOSED session next to
    // its replacement (journal finalized, nothing deleted).
    await expect
      .poll(async () => listedIds().includes(bootId as string), { timeout: 15_000 })
      .toBe(true);
    expect(listedIds()).toContain(freshId as string);
  });
});
