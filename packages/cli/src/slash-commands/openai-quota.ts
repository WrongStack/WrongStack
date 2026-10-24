/**
 * `/openai-quota` — how much of the ChatGPT (Codex) subscription this account
 * has burned, and when the windows reset.
 *
 * A "Sign in with ChatGPT" account is metered on rolling windows — typically a
 * 5-hour one and a weekly one — and the ChatGPT backend reports the burn on
 * every `/codex/responses` response, in headers. Nothing about that reaches the
 * SSE body, so before this existed the first visible sign of an exhausted plan
 * was a 429 in the middle of a turn.
 *
 * The command is provider-scoped; the machinery underneath is not. It renders
 * whatever `@wrongstack/core/quota` holds for one provider id, and the renderer
 * below reads only the neutral shape. A second metered provider needs a
 * reporter and a one-line command, not a second copy of this file.
 *
 * Two sources feed it. The headers keep it current as turns run; before any
 * turn, the command asks the account usage endpoint (`/wham/usage`, the read
 * behind the official client's `/status`) through the active ChatGPT
 * transport. That read is a status call, not a model call — it spends none of
 * the plan it reports.
 *
 * Usage:
 *   /openai-quota     Show the latest reading for every metered window
 */

import type { Provider, ProviderConfig, SlashCommand } from '@wrongstack/contracts/types';
import {
  formatQuotaPercent,
  formatQuotaResetIn,
  getAllProviderQuota,
  groupQuotaSnapshots,
  type ProviderQuotaSnapshot,
  type ProviderQuotaWindow,
  quotaResetInMs,
  quotaWindowLabel,
} from '@wrongstack/core/quota';
import { color } from '@wrongstack/core/utils';
import {
  readConfiguredProviderAccountQuota,
  readProviderAccountQuota,
  refreshProviderAccountQuota,
} from '@wrongstack/providers';
import { reportWrongForgeQuota } from '../fleet/wrongforge-quota.js';

/** The provider this command reports on. */
const PROVIDER_ID = 'openai-codex';

const BAR_WIDTH = 24;

/** Where the saved providers come from — the live config in a session. */
export interface QuotaCommandDeps {
  providers?: () => Readonly<Record<string, ProviderConfig>> | undefined;
}

/** ChatGPT sign-in — the `openai-codex` family, under any config key. */
function isCodexConfig(providerId: string, cfg: ProviderConfig): boolean {
  return (cfg.type ?? providerId) === 'openai-codex' || cfg.family === 'openai-codex';
}

/**
 * Take a fresh account reading before rendering: from the active provider
 * when it has an account read, otherwise from each saved ChatGPT sign-in — so
 * the quota shows even while the session runs on another provider, and
 * before any turn. Best effort: a failed read leaves the standing readings to
 * be shown as they are.
 */
async function readAccountQuotas(
  active: Provider | undefined,
  deps: QuotaCommandDeps,
): Promise<void> {
  let alreadyRead: string | undefined;
  try {
    if (active) {
      const result = await readProviderAccountQuota(active);
      if (result?.ok) alreadyRead = active.id;
    }
  } catch {
    // Fall through to the saved sign-ins.
  }
  const providers = deps.providers?.() ?? {};
  const saved = Object.entries(providers).filter(
    ([id, cfg]) =>
      id !== alreadyRead && (isCodexConfig(id, cfg) || (cfg.type ?? id) === 'openai-chatgpt'),
  );
  await Promise.all(
    saved.map(async ([id, cfg]) => {
      try {
        await readConfiguredProviderAccountQuota(id, cfg, providers);
      } catch {
        // A sign-in that cannot be built or read keeps its standing reading.
      }
    }),
  );
}

/** The key a saved provider runs on: its active `apiKeys[]` entry, else the legacy field. */
function activeApiKey(cfg: ProviderConfig): string | undefined {
  const keys = Array.isArray(cfg.apiKeys) ? cfg.apiKeys : [];
  const key =
    keys.length > 0
      ? ((cfg.activeKey ? keys.find((k) => k.label === cfg.activeKey) : undefined) ?? keys[0])
          ?.apiKey
      : cfg.apiKey;
  return key?.trim() ? key : undefined;
}

/**
 * Read every saved provider that has an account read — MiniMax, Z.AI /
 * BigModel, Kimi Code, OpenCode Go, OpenRouter, an OmniRoute gateway with a
 * management token, the prepaid balances (DeepSeek, Moonshot, SiliconFlow)
 * and any configured `quotaEndpoint`. The reads are status calls, not model
 * calls; a provider without one resolves without a request. Best effort,
 * like the ChatGPT read.
 */
async function readKeyedAccountQuotas(deps: QuotaCommandDeps): Promise<void> {
  const saved = Object.entries(deps.providers?.() ?? {}).filter(
    ([id, cfg]) => !isCodexConfig(id, cfg),
  );
  await Promise.all(
    saved.map(async ([id, cfg]) => {
      const apiKey = activeApiKey(cfg);
      // A keyless gateway is still read with its management token.
      if (!apiKey && !cfg.managementToken) return;
      try {
        await refreshProviderAccountQuota({
          providerId: id,
          type: cfg.type,
          baseUrl: cfg.baseUrl,
          apiKey: apiKey ?? '',
          managementToken: cfg.managementToken,
          quotaEndpoint: cfg.quotaEndpoint,
        });
      } catch {
        // A read that fails keeps the standing reading.
      }
    }),
  );
}

/**
 * Render every reading, folding the ones that are one account seen through
 * several saved providers (every OpenCode key of an account reads the same
 * usage) into one block that names them all.
 */
function renderQuotaSnapshots(snapshots: readonly ProviderQuotaSnapshot[]): string[] {
  const lines: string[] = [];
  for (const group of groupQuotaSnapshots(snapshots)) {
    const rendered = renderQuotaSnapshot(group.snapshot);
    if (group.providerIds.length > 1) {
      const title = group.snapshot.meterLabel ?? group.snapshot.meterId;
      const plan = group.snapshot.planLabel
        ? ` ${color.dim(`plan: ${group.snapshot.planLabel}`)}`
        : '';
      rendered[0] = `  ${color.cyan(group.providerIds.join(', '))} ${color.dim(`— ${title} (one account)`)}${plan}`;
    }
    lines.push(...rendered, '');
  }
  return lines;
}

function bar(usedPercent: number): string {
  const clamped = Math.max(0, Math.min(100, usedPercent));
  const filled = Math.round((clamped / 100) * BAR_WIDTH);
  const glyphs = `${'█'.repeat(filled)}${'░'.repeat(BAR_WIDTH - filled)}`;
  // The thresholds are advisory, not the backend's: they exist so a glance at
  // the bar says "fine / start pacing / about to be cut off".
  if (clamped >= 90) return color.red(glyphs);
  if (clamped >= 70) return color.amber(glyphs);
  return color.green(glyphs);
}

function renderWindow(window: ProviderQuotaWindow): string {
  const label = quotaWindowLabel(window).padEnd(4);
  const pct = formatQuotaPercent(window.usedPercent);
  const remaining = Math.max(0, 100 - window.usedPercent);
  const left = color.dim(` (${formatQuotaPercent(remaining)} left)`);
  const resetIn = formatQuotaResetIn(quotaResetInMs(window));
  const reset = resetIn ? color.dim(` · resets in ${resetIn}`) : '';
  return `    ${label} ${bar(window.usedPercent)} ${pct}${left}${reset}`;
}

/**
 * Render one meter. Provider-neutral by construction — everything it reads is
 * on the shared snapshot shape.
 */
export function renderQuotaSnapshot(snapshot: ProviderQuotaSnapshot): string[] {
  const lines: string[] = [];
  const title = snapshot.meterLabel ?? snapshot.meterId;
  const plan = snapshot.planLabel ? ` ${color.dim(`plan: ${snapshot.planLabel}`)}` : '';
  // A pool account behind a gateway, not the plan this session draws on.
  const via = snapshot.via ? ` ${color.dim('(pool account)')}` : '';
  lines.push(`  ${color.cyan(snapshot.providerId)} ${color.dim(`— ${title}`)}${via}${plan}`);

  for (const window of snapshot.windows) lines.push(renderWindow(window));

  if (snapshot.credits) {
    const value = snapshot.credits.unlimited
      ? color.green('unlimited')
      : (snapshot.credits.balance ?? (snapshot.credits.hasCredits ? 'available' : 'none'));
    lines.push(`    ${color.dim('credits:')} ${value}`);
  }
  if (snapshot.reachedWindowId) {
    lines.push(`    ${color.red(`limit reached: ${snapshot.reachedWindowId}`)}`);
  }
  if (snapshot.note) {
    lines.push(`    ${color.dim(snapshot.note.slice(0, 200))}`);
  }
  const ageSec = Math.max(0, Math.round((Date.now() - snapshot.capturedAt) / 1000));
  const age = ageSec < 60 ? `${ageSec}s ago` : `${Math.floor(ageSec / 60)}m ago`;
  lines.push(`    ${color.dim(`as of ${age}`)}`);
  return lines;
}

export function buildOpenAIQuotaCommand(deps: QuotaCommandDeps = {}): SlashCommand {
  return {
    name: 'openai-quota',
    category: 'Inspect',
    description: 'ChatGPT (Codex) subscription quota — windows used and reset times',
    help: [
      'Usage:',
      '  /openai-quota     Show the latest ChatGPT/Codex quota reading',
      '',
      'The command reads the account usage endpoint of your ChatGPT sign-in',
      'first — a status read, not a model call — so a reading shows before any',
      'message, whichever provider the session runs on. After that, every',
      'response on ChatGPT keeps it current.',
      'Percentages are per rolling window (5h and/or weekly, per plan).',
    ].join('\n'),
    async run(_args, ctx): Promise<{ message: string }> {
      await readAccountQuotas(ctx?.provider, deps);
      const saved = deps.providers?.() ?? {};
      const directIds = new Set([
        'openai-chatgpt',
        ...Object.entries(saved)
          .filter(([id, cfg]) => (cfg.type ?? id) === 'openai-chatgpt')
          .map(([id]) => id),
      ]);
      const ids = new Set([
        PROVIDER_ID,
        ...directIds,
        ...Object.entries(saved)
          .filter(([id, cfg]) => isCodexConfig(id, cfg))
          .map(([id]) => id),
      ]);
      const snapshots = getAllProviderQuota().filter((snapshot) => ids.has(snapshot.providerId));
      const lines: string[] = [
        `${color.bold('WrongStack')} ${color.dim('— ChatGPT / Codex quota')}`,
        '',
      ];
      for (const snapshot of snapshots) lines.push(...renderQuotaSnapshot(snapshot), '');
      const directConfigured =
        Object.keys(saved).some((id) => directIds.has(id)) ||
        (ctx?.provider !== undefined && directIds.has(ctx.provider.id));
      if (directConfigured && !snapshots.some((snapshot) => directIds.has(snapshot.providerId))) {
        lines.push(
          `  ${color.dim('To read ChatGPT plan and app quotas, sign in to openai-codex with the same ChatGPT account/workspace.')}`,
          `  https://chatgpt.com/settings/usage`,
          '',
        );
      }
      if (snapshots.length === 0 && !directConfigured) {
        lines.push(
          `  ${color.dim('No quota reading yet.')}`,
          '',
          `  ${color.dim('Sign in with')} ${color.cyan('wstack auth login chatgpt')}${color.dim('; the quota is then read')}`,
          `  ${color.dim('from the account without spending a message.')}`,
        );
      }
      return { message: lines.join('\n') };
    },
  };
}

/**
 * `/provider-quota` — every metered subscription this session has heard from.
 *
 * The narrow `/openai-quota` above stays because it answers one question
 * without making the user read past other providers; this one exists because
 * the reporters are no longer Codex-only. Claude Pro/Max and GitHub Copilot
 * report into the same store, and a session that is signed into two metered
 * plans has no other way to see which one is about to run out.
 *
 * The name says `provider` on purpose. A bare `/quota` would read as "what
 * this project costs" — an account-wide spend view that does not exist here —
 * and would occupy the name if one is ever built. What this shows is exactly
 * the provider plane's readings, so that is what it is called.
 */
export function buildProviderQuotaCommand(deps: QuotaCommandDeps = {}): SlashCommand {
  return {
    name: 'provider-quota',
    category: 'Inspect',
    description: 'Subscription quota across every metered provider — windows used and reset times',
    help: [
      'Usage:',
      '  /provider-quota   Show the latest quota reading for every metered provider',
      '',
      'Each provider reports its own plan usage on the responses to requests',
      'you were already making. Saved ChatGPT sign-ins and MiniMax, Z.AI, Kimi',
      'Code, OpenCode Go, OpenRouter, DeepSeek, Moonshot and SiliconFlow keys are',
      'also asked directly (an account read spends nothing), so they show before',
      'any turn. An OmniRoute provider with a `managementToken` shows every',
      "account in the gateway's pool; any other provider can describe its own",
      'account endpoint in `quotaEndpoint`.',
      'The local WrongForge subscription is read through its /v1/usage endpoint,',
      'even without a saved provider entry; explicit refresh bypasses its cache.',
      'For one provider only, /openai-quota shows just ChatGPT/Codex.',
    ].join('\n'),
    async run(_args, ctx): Promise<{ message: string }> {
      await Promise.all([
        readAccountQuotas(ctx?.provider, deps),
        readKeyedAccountQuotas(deps),
        reportWrongForgeQuota({ force: true }),
      ]);
      // Sorted so the output does not reshuffle between runs as providers
      // report in a different order than they did last time.
      const snapshots = [...getAllProviderQuota()].sort(
        (a, b) =>
          a.providerId.localeCompare(b.providerId) ||
          (a.meterLabel ?? a.meterId).localeCompare(b.meterLabel ?? b.meterId),
      );
      const lines: string[] = [
        `${color.bold('WrongStack')} ${color.dim('— provider subscription quota')}`,
        '',
      ];
      lines.push(...renderQuotaSnapshots(snapshots));
      const directMissing = Object.entries(deps.providers?.() ?? {}).some(
        ([id, cfg]) =>
          (cfg.type ?? id) === 'openai-chatgpt' &&
          !snapshots.some((snapshot) => snapshot.providerId === id),
      );
      if (directMissing) {
        lines.push(
          '  To read ChatGPT plan and app quotas, sign in to openai-codex with the same ChatGPT account/workspace.',
          '  https://chatgpt.com/settings/usage',
          '',
        );
      }
      if (snapshots.length === 0) {
        lines.push(
          `  ${color.dim('No quota reading yet.')}`,
          '',
          `  ${color.dim('Metered plans (Claude Pro/Max, ChatGPT/Codex, Copilot, Antigravity,')}`,
          `  ${color.dim('MiniMax, Z.AI / BigModel, Kimi Code, OpenCode Go, OpenRouter, OmniRoute) report')}`,
          `  ${color.dim('usage on the responses to your own requests. Send one message on a')}`,
          `  ${color.dim('subscription login, then run /provider-quota again.')}`,
          '',
          `  ${color.dim('An API-key provider is billed per token and reports no plan window,')}`,
          `  ${color.dim('so it never appears here.')}`,
        );
      }
      return { message: lines.join('\n') };
    },
  };
}
