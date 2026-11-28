import assert from 'node:assert/strict';
import path from 'node:path';
import { expect } from '@playwright/test';
import { assertSquareCorners } from './square-corner-check.mjs';

/**
 * The composer's model, ACP runtime and permission chips against the real components; the
 * transport answers provider lists, models, plan quota and the ACP agent's settings and modes.
 */
async function seed(page) {
  await page.evaluate(() => {
    const { client, quota, config } = window.fixture;
    const now = Math.floor(Date.now() / 1000);
    const models = {
      anthropic: [
        { id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', contextWindow: 200000 },
        { id: 'claude-opus-4-1', name: 'Claude Opus 4.1', contextWindow: 200000 },
      ],
      openai: [
        { id: 'gpt-5', name: 'GPT-5', contextWindow: 400000 },
        { id: 'gpt-5-mini', name: 'GPT-5 mini', contextWindow: 400000 },
      ],
      openrouter: [{ id: 'qwen/qwen3-coder', name: 'Qwen3 Coder', contextWindow: 262000 }],
      acp: [
        { id: 'claude-code', name: 'Claude Code' },
        { id: 'codex-acp', name: 'Codex' },
      ],
    };
    client.listSavedProviders = () =>
      client.emit({
        type: 'providers.saved',
        payload: { providers: Object.keys(models).map((id) => ({ id })) },
      });
    client.listProviderModels = (provider) =>
      client.emit({
        type: 'provider.models',
        payload: { provider, models: models[provider] ?? [] },
      });
    const effort = {
      id: 'effort',
      name: 'Effort',
      category: 'thought_level',
      currentValue: 'medium',
      options: ['low', 'medium', 'high'].map((value) => ({
        value,
        name: value[0].toUpperCase() + value.slice(1),
      })),
    };
    const model = {
      id: 'model',
      name: 'Model',
      category: 'model',
      currentValue: 'opus',
      options: [
        { value: 'opus', name: 'Opus' },
        { value: 'sonnet', name: 'Sonnet' },
      ],
    };
    const mode = {
      id: 'mode',
      name: 'Mode',
      currentValue: 'default',
      options: [
        { value: 'default', name: 'Default' },
        { value: 'acceptEdits', name: 'Accept edits' },
        { value: 'bypassPermissions', name: 'Bypass permissions' },
      ],
      selectableValues: ['default', 'acceptEdits', 'bypassPermissions'],
    };
    // ACP requests check the socket itself, not the config store's mirror of it.
    Object.defineProperty(client, 'status', { configurable: true, get: () => ({ state: 'open' }) });
    const send = client.send;
    window.fixture.acpSent = [];
    client.send = (message) => {
      const payload = message.payload ?? {};
      if (message.type === 'acp.config_options') {
        window.fixture.acpSent.push(payload.values);
        for (const [id, value] of Object.entries(payload.values ?? {}))
          for (const option of [model, effort]) if (option.id === id) option.currentValue = value;
        setTimeout(
          () =>
            client.emit({
              type: 'acp.config_options',
              payload: {
                ok: true,
                requestId: payload.requestId,
                agentId: payload.agentId,
                options: [model, effort],
                applied: payload.values,
              },
            }),
          30,
        );
        return true;
      }
      if (message.type === 'acp.mode') {
        if (payload.value) mode.currentValue = payload.value;
        setTimeout(
          () =>
            client.emit({
              type: 'acp.mode',
              payload: {
                ok: true,
                requestId: payload.requestId,
                agentId: payload.agentId,
                modes: [{ ...mode }],
              },
            }),
          30,
        );
        return true;
      }
      if (message.type === 'prefs.update' && payload.requestId) {
        setTimeout(
          () =>
            client.emit({
              type: 'key.operation_result',
              payload: { requestId: payload.requestId, success: true },
            }),
          10,
        );
      }
      return send(message);
    };
    quota.getState().apply([
      {
        providerId: 'anthropic',
        meterId: 'plan',
        windows: [{ id: 'week', label: 'Week', usedPercent: 47, resetsAt: now + 86400 }],
        capturedAt: now,
      },
      {
        providerId: 'openrouter',
        meterId: 'plan',
        windows: [{ id: 'day', label: 'Day', usedPercent: 100, resetsAt: now + 3600 }],
        reachedWindowId: 'day',
        capturedAt: now,
      },
    ]);
    config.setState({ provider: 'anthropic', model: 'claude-sonnet-4-5' });
    window.fixture.prefs
      .getState()
      .set({ yolo: false, yoloPlus: false, activeSessionId: 'chip-session' });
  });
}

async function inViewport(locator, width, height, label) {
  const box = await locator.boundingBox();
  assert(
    box &&
      box.x >= 0 &&
      box.y >= 0 &&
      box.x + box.width <= width + 1 &&
      box.y + box.height <= height + 1,
    `${label} leaves the viewport: ${JSON.stringify(box)}`,
  );
}

/** On a phone the effort and permission chips sit in the Run settings dialog. */
async function runSettings(page, width) {
  if (width < 768) await page.getByRole('button', { name: 'Run settings' }).click();
}

export async function checkComposerChips(browser, base, output, errors) {
  const results = [];
  for (const theme of ['light', 'dark']) {
    for (const [width, height] of [
      [1440, 980],
      [390, 844],
    ]) {
      const page = await browser.newPage({ viewport: { width, height }, colorScheme: theme });
      page.on('pageerror', (error) => errors.push(error.message));
      try {
        await page.goto(`${base}?theme=${theme}&composer=1`);
        await expect(page.locator('[data-chat-textarea]')).toBeEnabled();
        await seed(page);

        // Model chip: brand, name and model; the list carries plan status per provider.
        const chip = page.getByTestId('composer-model-chip');
        await expect(chip).toContainText('Anthropic');
        await expect(chip).toContainText('claude-sonnet-4-5');
        await chip.click();
        const popover = page.getByTestId('composer-model-popover');
        await expect(popover).toBeVisible();
        await expect(popover.getByRole('button', { name: /Anthropic/ })).toHaveAttribute(
          'aria-current',
          'true',
        );
        await expect(popover).toContainText('Week · 53% left');
        await expect(popover).toContainText(/Limit reached/);
        await expect(popover.getByRole('button', { name: /Claude Code/ })).toBeVisible();
        await popover.getByRole('button', { name: /OpenAI/ }).click();
        await expect(popover.getByRole('button', { name: /GPT-5 mini/ })).toBeVisible();
        await inViewport(popover, width, height, 'Model popover');
        await assertSquareCorners(page);
        await page.screenshot({
          animations: 'disabled',
          path: path.join(output, `composer-model-popover-${theme}-${width}.png`),
        });
        await page.keyboard.press('Escape');
        await expect(popover).toHaveCount(0);
        await expect(chip).toBeFocused();

        // Permissions: YOLO+ turns the chip red and is written as a session pref.
        await runSettings(page, width);
        const permission = page.getByTestId('composer-permission-chip').filter({ visible: true });
        await expect(permission).toHaveAttribute('data-risk', 'none');
        await permission.click();
        const permissions = page.getByTestId('composer-permission-popover');
        await permissions.getByRole('button', { name: /YOLO\+/ }).click();
        await expect(permission).toHaveAttribute('data-risk', 'danger');
        assert(
          await page.evaluate(() =>
            window.fixture.sent.some(
              (m) => m.type === 'prefs.update' && m.payload?.yoloPlus === true,
            ),
          ),
          'YOLO+ is sent as a prefs.update',
        );
        await inViewport(permissions, width, height, 'Permission popover');
        await page.screenshot({
          animations: 'disabled',
          path: path.join(output, `composer-permissions-${theme}-${width}.png`),
        });
        await permissions.getByRole('button', { name: /^Ask/ }).click();
        await expect(permission).toHaveAttribute('data-risk', 'none');
        await page.keyboard.press('Escape');
        if (width < 768) await page.keyboard.press('Escape');

        // ACP: the agent's model and effort on their own chip, its mode on the permission chip.
        await page.evaluate(() =>
          window.fixture.config.setState({ provider: 'acp', model: 'claude-code' }),
        );
        await expect(chip).toContainText('Claude Code');
        await runSettings(page, width);
        const acp = page.getByTestId('composer-acp-chip').filter({ visible: true });
        await acp.click();
        const acpPopover = page.getByTestId('composer-acp-popover');
        await expect(acpPopover.getByRole('button', { name: 'Opus', exact: true })).toHaveAttribute(
          'aria-pressed',
          'true',
        );
        await acpPopover.getByRole('button', { name: 'High', exact: true }).click();
        await expect(acpPopover.getByRole('button', { name: 'High', exact: true })).toHaveAttribute(
          'aria-pressed',
          'true',
        );
        await expect(acp).toContainText('Opus / High');
        await inViewport(acpPopover, width, height, 'ACP popover');
        await page.screenshot({
          animations: 'disabled',
          path: path.join(output, `composer-acp-${theme}-${width}.png`),
        });
        await page.keyboard.press('Escape');
        await expect(acpPopover).toHaveCount(0);
        if (width < 768) await expect(page.getByRole('dialog')).toHaveCount(1);
        const acpPermission = page
          .getByTestId('composer-permission-chip')
          .filter({ visible: true });
        // Before the agent's mode has been read, the chip must not claim it is safe.
        await expect(acpPermission).toHaveAttribute('data-risk', 'unknown');
        await acpPermission.click();
        const modes = page.getByTestId('composer-permission-popover');
        const bypass = modes.getByRole('button', { name: /Bypass permissions/ });
        await expect(bypass).toContainText('Skips prompts');
        await bypass.click();
        await expect(acpPermission).toHaveAttribute('data-risk', 'danger');
        await expect(acpPermission).toContainText('Bypass permissions');
        await page.screenshot({
          animations: 'disabled',
          path: path.join(output, `composer-acp-mode-${theme}-${width}.png`),
        });
        await assertSquareCorners(page);
        assert(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          `Composer chips overflow at ${width}`,
        );
        results.push({ theme, width, chips: 'PASS' });
        console.log('composer chips passed', theme, width);
      } finally {
        await page.close();
      }
    }
  }
  return results;
}
