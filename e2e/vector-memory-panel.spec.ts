import { expect, test } from '@playwright/test';

/**
 * Vector Memory panel — browser verification of the inline-expand + Forget
 * surface against the embedded WebUI host started by global-setup.
 *
 * Covers the panel contract end-to-end through real UI:
 *   1. navigation to the Memory view (overflow menu — see note below) and
 *      activation of the "Vector memory" SAGE tab that hosts the panel,
 *   2. the enabled contract (status strip with live store data, no
 *      disabled/error placeholder),
 *   3. search → inline expand (master-detail) → accordion collapse,
 *   4. the destructive Forget confirmation dialog, and
 *   5. probe-absence after the forget.
 *
 * The vector store is STRICTLY OPT-IN (`getVectorMemoryStore` is undefined
 * in hosts that don't wire one — e.g. a fresh CI checkout without the
 * transformers model cache). When `/api/vector-memory/status` reports
 * `enabled:false` the spec skips instead of failing: the disabled
 * placeholder is the contracted behavior in that environment, not a bug.
 *
 * Selector conventions (learned the hard way — see project memory):
 *   - The Memory view is NOT reachable via `button[title*="Memory"]`: that
 *     matches the "Memory context — injected SAGE memories" dock chip,
 *     which opens a monitor dialog instead. On the Desktop Chrome viewport
 *     the Memory nav icon overflows into the "…" UtilitiesMenu — navigate
 *     via `menuitem "Memory"` (exact).
 *   - Hit toggle buttons render ONLY the score as their accessible name
 *     (e.g. "0.762"); the hit text lives in a sibling paragraph. Locate the
 *     hit `<li>` by text and scope the toggle inside it.
 *   - The model id appears 3× in the status strip (provider / model /
 *     providers rows) — use `.first()`.
 *   - Never assert "No results." after forgetting a probe: semantic search
 *     over a populated store legitimately returns OTHER entries for the
 *     query. The contract is probe-absence.
 */

/** Unique probe marker — cleanup + absence assertions key off this. */
const PROBE_TAG = 'e2e-vm-panel-probe';
const PROBE_TEXT = `${PROBE_TAG} wrongstack webui vector memory browser verification entry`;
const PROBE_QUERY = `${PROBE_TAG} browser verification`;

test.describe('Vector Memory panel', () => {
  test('enabled panel → expand hit → Forget dialog → probe gone', async ({ page }) => {
    // Embedding a cold model (first run in a fresh environment) can take
    // well over the 30s config default — the seed POST and the first search
    // both pay that cost once.
    test.setTimeout(180_000);

    // ── Auth ── When global-setup provisions a token (WEBUI_E2E_TOKEN),
    // authenticate with it; otherwise plain '/' (CI's default behavior).
    const token = process.env.WEBUI_E2E_TOKEN;
    await page.goto(token ? `/?token=${encodeURIComponent(token)}` : '/');

    // Wait for the app shell (chat state in CI via E2E_PROVIDER/E2E_MODEL,
    // or the developer's saved config locally).
    const chatOrSetup = page.locator('textarea, [data-testid="setup-screen"]');
    await expect(chatOrSetup.first()).toBeVisible({ timeout: 20_000 });

    // ── Opt-in contract ── Skip (not fail) when the host wires no store.
    // Fail-safe: an unauthenticated page (auth wall) or non-JSON error body
    // resolves to enabled:false so CI shows a skip, not an error.
    const status = await page.evaluate(async () => {
      try {
        const res = await fetch('/api/vector-memory/status');
        return (await res.json()) as { enabled?: boolean };
      } catch {
        return { enabled: false };
      }
    });
    test.skip(!status.enabled, 'vector memory store not wired in this host (opt-in surface)');

    // ── Navigate to the Memory view via the "…" overflow UtilitiesMenu.
    await page.getByRole('button', { name: /^more/i }).first().click();
    await page.getByRole('menuitem', { name: 'Memory', exact: true }).click();

    // ── Activate the Vector memory lens — the panel is the third SAGE tab,
    //    not a panel below the tab bar. The trigger's accessible name also
    //    carries the hint span ("Semantic embedding store"), so match loosely.
    await page.getByRole('tab', { name: /vector memory/i }).click();

    // ── Enabled panel renders inside the tab with live store data.
    const panel = page.locator('.vector-memory-panel');
    await expect(panel).toBeVisible({ timeout: 20_000 });
    await expect(
      panel.locator('.vector-memory-panel--disabled, .vector-memory-panel--error'),
    ).toHaveCount(0);
    // Model id appears 3× in the status strip — .first() avoids strict mode.
    await expect(panel.getByText('all-MiniLM-L6-v2').first()).toBeVisible();
    await expect(panel.getByText('Entries / vectors').first()).toBeVisible();

    // ── Seed exactly one probe entry through the API the panel itself
    //    uses. Stale copies from previously failed runs are forgotten first
    //    so the absence assertions at the end stay meaningful.
    const seed = await page.evaluate(
      async ({ text, tag, query }) => {
        for (let round = 0; round < 10; round += 1) {
          const s = (await fetch(
            `/api/vector-memory/search?q=${encodeURIComponent(query)}&limit=20`,
          ).then((r) => r.json())) as { hits: Array<{ id: string; text: string }> };
          const stale = s.hits.filter((h) => h.text.includes(tag));
          if (stale.length === 0) break;
          for (const h of stale) {
            await fetch(`/api/vector-memory/store/${encodeURIComponent(h.id)}`, {
              method: 'DELETE',
            });
          }
        }
        const res = await fetch('/api/vector-memory/store', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, tags: [tag] }),
        });
        return res.json() as Promise<{ id: string; hasVector: boolean }>;
      },
      { text: PROBE_TEXT, tag: PROBE_TAG, query: PROBE_QUERY },
    );
    expect(seed.hasVector).toBe(true);

    // ── Search via the panel's own UI. The hit toggle's accessible name is
    //    ONLY the score — match the hit <li> by text, scope the toggle.
    await panel.getByLabel('Query').fill(PROBE_QUERY);
    await panel.getByRole('button', { name: 'Search' }).click();
    const probeHit = panel.locator('.vector-memory-panel__hit').filter({ hasText: PROBE_TAG });
    const probeToggle = probeHit.locator('.vector-memory-panel__hit-toggle');
    await expect(probeToggle).toBeVisible({ timeout: 60_000 });

    // ── Inline expand: detail region with id/score fields + Forget action.
    await probeToggle.click();
    const detail = probeHit.locator('.vector-memory-panel__hit-detail');
    await expect(detail).toBeVisible();
    await expect(detail.getByText('id')).toBeVisible();
    await expect(detail.getByRole('button', { name: 'Forget' })).toBeVisible();
    // Expanded body shows the full probe text (no preview truncation).
    await expect(panel.getByText(PROBE_TEXT, { exact: false })).toBeVisible();

    // ── Accordion: second click collapses the detail region.
    await probeToggle.click();
    await expect(panel.locator('.vector-memory-panel__hit-detail')).toHaveCount(0);
    await probeToggle.click(); // re-expand for the forget flow
    await expect(detail).toBeVisible();

    // ── Forget: destructive confirmation dialog (DeleteMemoryDialog pattern).
    await detail.getByRole('button', { name: 'Forget' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('Forget this vector memory?')).toBeVisible();
    await expect(dialog.getByText(/removes the entry and its embedding/i)).toBeVisible();
    await expect(dialog.getByText(PROBE_TAG, { exact: false })).toBeVisible();

    await dialog.getByRole('button', { name: 'Forget memory' }).click();
    await expect(dialog).not.toBeVisible({ timeout: 15_000 });

    // ── Probe-absence. Do NOT assert "No results." — semantic search over
    //    a populated store legitimately returns other entries; the contract
    //    is that the probe itself is gone, from the list and from search.
    await expect(
      panel.locator('.vector-memory-panel__hit').filter({ hasText: PROBE_TAG }),
    ).toHaveCount(0, { timeout: 15_000 });
    await panel.getByLabel('Query').fill(PROBE_QUERY);
    await panel.getByRole('button', { name: 'Search' }).click();
    await expect(
      panel.locator('.vector-memory-panel__hit').filter({ hasText: PROBE_TAG }),
    ).toHaveCount(0, { timeout: 60_000 });
  });
});
