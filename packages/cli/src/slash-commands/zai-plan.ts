/**
 * `/zai-plan` — the Z.AI / BigModel GLM Coding Plan, the way the official
 * ZCode client's usage panel shows it: the subscription in force, the 5-hour
 * and weekly model windows, the monthly MCP tool-call pool, the last days'
 * token usage per model with the cache-hit rate, and the platform's own
 * service health.
 *
 * Unlike `/provider-quota`, which only replays what turns already observed,
 * this asks: every section is an account read on the monitor API. None of
 * them is a model call, so the plan it describes is not spent by looking.
 *
 * It reports on the Z.AI / BigModel providers built in this session (the key
 * lives with the transport, not here). Team plans need organization/project
 * scoping that only ZCode's OAuth login carries; this reads the personal plan
 * the API key belongs to.
 *
 * Usage:
 *   /zai-plan          Plan, quota and the last 7 days
 *   /zai-plan <days>   Same, with a 1–30 day usage window
 */

import type { SlashCommand } from '@wrongstack/contracts/types';
import { formatQuotaResetIn, quotaResetInMs } from '@wrongstack/core/quota';
import { color } from '@wrongstack/core/utils';
import {
  listZaiAccounts,
  type ZaiAccountHandle,
  type ZaiPlanReport,
  type ZaiServiceHealth,
  zaiQuotaSnapshots,
} from '@wrongstack/providers';
import { renderQuotaSnapshot } from './openai-quota.js';

/** The monitor API serves at most 30 days per query. */
const MAX_DAYS = 30;
const DEFAULT_DAYS = 7;

/** `8371727911` → `8.37B`. */
function formatTokenCount(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}

function pct(rate: number | undefined, digits = 1): string {
  return rate === undefined ? '—' : `${(rate * 100).toFixed(digits)}%`;
}

function regionHost(handle: ZaiAccountHandle): string {
  return handle.region === 'zai' ? 'api.z.ai' : 'open.bigmodel.cn';
}

/** Render one account's report. */
function renderZaiPlanReport(handle: ZaiAccountHandle, report: ZaiPlanReport): string[] {
  const lines: string[] = [];
  lines.push(`  ${color.cyan(handle.providerId)} ${color.dim(`(${regionHost(handle)})`)}`);

  const sub = report.subscription;
  if (sub) {
    const cycle = sub.billingCycle ? ` · ${sub.billingCycle}` : '';
    const when = sub.renewsOrEndsOn
      ? sub.autoRenew
        ? ` · renews ${sub.renewsOrEndsOn}`
        : ` · ends ${sub.renewsOrEndsOn} ${color.dim('(auto-renew off)')}`
      : '';
    lines.push(`    ${color.dim('plan')}   ${color.bold(sub.product)}${cycle}${when}`);
  } else if (report.quota?.level) {
    lines.push(`    ${color.dim('plan')}   ${color.bold(`coding ${report.quota.level}`)}`);
  }

  if (!handle.codingPlan) {
    lines.push(
      `    ${color.amber('This provider uses the pay-as-you-go endpoint; its calls do not draw on the plan below.')}`,
    );
  }

  if (report.quota) {
    for (const snapshot of zaiQuotaSnapshots(handle.providerId, report.quota)) {
      if (snapshot.windows.length === 0) continue;
      // Skip the snapshot's own header and age lines: the account header above
      // already names the provider, and the reading is live.
      lines.push(...renderQuotaSnapshot(snapshot).slice(1, -1));
    }
    const tools = report.quota.tools;
    if (tools) {
      const total = tools.total !== undefined ? `/${tools.total}` : '';
      const resetIn = formatQuotaResetIn(
        quotaResetInMs(
          tools.resetsAt !== undefined
            ? { id: 'm', usedPercent: 0, resetsAt: tools.resetsAt }
            : undefined,
        ),
      );
      const breakdown = tools.tools
        .filter((t) => t.calls > 0)
        .map((t) => `${t.tool} ${t.calls}`)
        .join(', ');
      lines.push(
        `    ${color.dim('MCP')}    ${tools.used}${total} tool calls this month` +
          (breakdown ? color.dim(` (${breakdown})`) : '') +
          (resetIn ? color.dim(` · resets in ${resetIn}`) : ''),
      );
    }
  } else {
    lines.push(
      `    ${color.dim('Quota could not be read (key rejected, or no Coding Plan on this account).')}`,
    );
  }

  const usage = report.usage;
  if (usage && usage.totalTokens > 0) {
    lines.push(
      `    ${color.dim(`last ${usage.days}d`)} ${color.bold(formatTokenCount(usage.totalTokens))} tokens` +
        color.dim(
          ` · cache hit ${pct(usage.cacheHitRate)} · off-peak ${pct(usage.offPeakRate, 0)}`,
        ),
    );
    for (const model of usage.models.filter((m) => m.totalTokens > 0)) {
      const share = usage.totalTokens > 0 ? model.totalTokens / usage.totalTokens : 0;
      const cached =
        model.inputTokens > 0 ? model.cachedInputTokens / model.inputTokens : undefined;
      lines.push(
        `      ${model.model.padEnd(16)} ${formatTokenCount(model.totalTokens).padStart(7)}` +
          color.dim(
            ` ${pct(share, 0).padStart(4)} · out ${formatTokenCount(model.outputTokens)} · cached ${pct(cached, 0)}`,
          ),
      );
    }
    const extras: string[] = [];
    if (usage.currentStreakDays !== undefined) extras.push(`streak ${usage.currentStreakDays}d`);
    if (usage.peakDay) {
      extras.push(`peak ${formatTokenCount(usage.peakDay.tokens)} on ${usage.peakDay.date}`);
    }
    if (extras.length > 0) lines.push(`      ${color.dim(extras.join(' · '))}`);
  }

  const health = report.health;
  if (health) {
    const tier = (label: string, t: ZaiServiceHealth['lite']) =>
      `${label} ${t.tokensPerSecond !== undefined ? `${Math.round(t.tokensPerSecond)} tok/s` : '—'} · ${pct(t.successRate, 2)} ok`;
    lines.push(
      `    ${color.dim(`service ${health.date}`)}  ${tier('pro/max', health.proMax)}  ${color.dim(tier('lite', health.lite))}`,
    );
  }
  return lines;
}

function parseDays(args: string): number | undefined {
  const raw = args.trim();
  if (raw === '') return DEFAULT_DAYS;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > MAX_DAYS) return undefined;
  return n;
}

export function buildZaiPlanCommand(
  deps: { accounts?: () => readonly ZaiAccountHandle[] } = {},
): SlashCommand {
  const accounts = deps.accounts ?? listZaiAccounts;
  return {
    name: 'zai-plan',
    category: 'Inspect',
    argsHint: '[days]',
    description: 'Z.AI / BigModel GLM Coding Plan — subscription, 5h/weekly quota, MCP pool, usage',
    help: [
      'Usage:',
      '  /zai-plan          Plan, quota windows and the last 7 days of usage',
      '  /zai-plan <days>   Same, with a 1–30 day usage window',
      '',
      'Reads the Z.AI (api.z.ai) or BigModel (open.bigmodel.cn) account API with',
      'the key of each Z.AI provider in this session. These are account reads,',
      'not model calls: they do not spend the plan they describe.',
      'The quota windows also appear in /provider-quota and the status bar.',
    ].join('\n'),
    async run(args: string): Promise<{ message: string }> {
      const days = parseDays(args);
      if (days === undefined) {
        return { message: `Usage: /zai-plan [days]  (days: 1–${MAX_DAYS})` };
      }
      const lines: string[] = [`${color.bold('WrongStack')} ${color.dim('— GLM Coding Plan')}`, ''];
      const handles = accounts();
      if (handles.length === 0) {
        lines.push(
          `  ${color.dim('No Z.AI / BigModel provider is active in this session.')}`,
          '',
          `  ${color.dim('Switch to one (e.g.')} ${color.cyan('zai-coding-plan')}${color.dim(' or ')}${color.cyan('zhipuai-coding-plan')}${color.dim(') and run /zai-plan again.')}`,
        );
        return { message: lines.join('\n') };
      }
      const reports = await Promise.all(handles.map((h) => h.fetchReport({ days })));
      handles.forEach((handle, i) => {
        lines.push(...renderZaiPlanReport(handle, reports[i]!), '');
      });
      return { message: lines.join('\n').trimEnd() };
    },
  };
}
