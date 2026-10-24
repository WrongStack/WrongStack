import type { SlashCommand } from '@wrongstack/contracts/types';
import {
  JEV_FEATURES,
  jevActivitySnapshot,
  jevSettingsSnapshot,
  saveJevSettings,
  testJevConnection,
} from '@wrongstack/core/typesafe';
import { activeProfileConfigPath } from '../profile-config-path.js';
import type { SlashCommandContext } from './command-context.js';

const HELP = [
  '/jev — TypeSafe / Jev account, feature switches and activity',
  '/jev on|off — enable/disable ALL Jev requests; keeps the saved key and feature choices',
  '/jev login typesafe|openrouter|custom — securely add/replace the account key',
  '/jev route typesafe|openrouter — change route (clears old key/model/endpoint)',
  '/jev endpoint <url> — set a custom endpoint before custom login',
  '/jev model <id>|default — pin/reset the decision model',
  '/jev timeout <ms> — request timeout',
  '/jev compaction hybrid|intelligent|selective — profile compaction strategy',
  '/jev recall on|off — SAGE turn context recall dependency',
  '/jev check — billed synthetic checks for all 11 features',
  '/jev feature <name> on|off — enable/disable a consumer',
  `/jev features: ${JEV_FEATURES.join(', ')}`,
  '/jev test — one billed connection probe using saved settings',
  '/jev logs [feature] — recent process activity and persistent log path',
  '/jev logcontent on|off — record full request/response content in the log file',
  '/jev remove-key — delete the profile key (environment key may still apply)',
  'Changes are saved in the active profile. Restart existing sessions to apply all consumers.',
].join('\n');

export function buildJevCommand(opts: SlashCommandContext): SlashCommand {
  return {
    name: 'jev',
    aliases: ['typesafe'],
    category: 'Config',
    description: 'Manage Jev decision account, feature switches, connection test and debug logs.',
    argsHint: '[login|route|feature|test|logs]',
    help: HELP,
    async run(args) {
      const [sub = '', arg = '', value = ''] = args.trim().split(/\s+/);
      if (!sub || sub === 'status') {
        const s = jevSettingsSnapshot(opts.configStore.get());
        return {
          message: [
            `Jev · ${s.status} · ${s.route} · ${s.model}`,
            `Key: ${s.keySource} · timeout ${s.requestTimeoutMs} ms`,
            s.reason ?? 'Account configured; use /jev test to verify connectivity.',
            ...Object.entries(s.features).map(
              ([key, on]) =>
                `${on ? 'on ' : 'off'} ${key} · ${s.readiness[key]?.state}: ${s.readiness[key]?.reason}`,
            ),
            `Profile compaction: ${s.contextStrategy}. Model tiers: /tier. Conditions do not prove runtime use.`,
            s.logContent
              ? 'Activity log: FULL content (request/response/error) → /jev logcontent off to stop'
              : 'Activity log: metadata only → /jev logcontent on for full content',
            '',
            HELP,
          ].join('\n'),
        };
      }
      if (sub === 'help') return { message: HELP };
      if (sub === 'logs') {
        const log = jevActivitySnapshot();
        const rows = log.entries.filter((entry) => !arg || entry.feature === arg).slice(0, 30);
        const content = jevSettingsSnapshot(opts.configStore.get()).logContent;
        return {
          message: [
            `Jev activity · this process · ${log.path ?? 'no disk entries yet'}`,
            log.writeError ?? '',
            `Content: ${
              content
                ? 'request/response recorded in the log file only — never in this view'
                : 'not recorded · /jev logcontent on'
            }`,
            ...rows.map(
              (e) =>
                `${new Date(e.at).toISOString()} ${e.feature} ${e.outcome} ${e.durationMs}ms ${e.route}/${e.model} ${e.inputTokens ?? 0}in ${e.reason ?? ''}\n  ${e.project} ${JSON.stringify(e.answers ?? {})}`,
            ),
            rows.length ? '' : 'No matching Jev activity yet.',
          ].join('\n'),
        };
      }
      if (sub === 'check') {
        const { checkJevJudgments } = await import('@wrongstack/runtime/jev-checks');
        try {
          const report = await checkJevJudgments(opts.configStore.get());
          return {
            message:
              `${report.passed}/${report.total} synthetic checks passed · ${report.model}\n` +
              report.cases
                .map((c) => `${c.ok ? '✓' : '✗'} ${c.feature}: ${c.name} — ${c.actual}`)
                .join('\n'),
          };
        } catch {
          return { message: 'Jev checks unavailable; inspect /jev status.' };
        }
      }
      if (sub === 'test') {
        try {
          return { message: await testJevConnection(opts.configStore.get()) };
        } catch {
          return { message: 'Jev connection test failed. Check /jev status and /jev logs.' };
        }
      }
      if (!opts.paths) return { message: 'Profile path unavailable.' };
      let patch: Record<string, unknown>;
      if (['on', 'off', 'enable', 'disable'].includes(sub)) {
        patch = { enabled: sub === 'on' || sub === 'enable' };
      } else if (sub === 'login') {
        if (!['typesafe', 'openrouter', 'custom'].includes(arg)) return { message: HELP };
        if (!opts.readSecret || !opts.vault)
          return {
            message: 'Secure key input unavailable on this surface. Use the WebUI Jev settings.',
          };
        const key = (await opts.readSecret('Jev API key: ')).trim();
        if (!key) return { message: 'Cancelled.' };
        patch = { route: arg, apiKey: key };
        if (arg === 'custom') patch['endpoint'] = opts.configStore.get().typesafe?.endpoint;
      } else if (sub === 'route' && ['typesafe', 'openrouter'].includes(arg))
        patch = { route: arg };
      else if (sub === 'endpoint') patch = { route: 'custom', endpoint: arg };
      else if (sub === 'model') patch = { model: arg === 'default' ? null : arg };
      else if (sub === 'recall' && ['on', 'off'].includes(arg))
        patch = { recallTurnContext: arg === 'on' };
      else if (sub === 'compaction') patch = { contextStrategy: arg };
      else if (sub === 'timeout') patch = { requestTimeoutMs: Number(arg) };
      else if (sub === 'logcontent' && ['on', 'off'].includes(arg))
        patch = { logContent: arg === 'on' };
      else if (sub === 'remove-key') patch = { apiKey: null };
      else if (sub === 'feature' && ['on', 'off'].includes(value))
        patch = { features: { [arg]: value === 'on' } };
      else return { message: HELP };
      try {
        await saveJevSettings(
          opts.configStore,
          activeProfileConfigPath(opts.paths, opts.configStore.get()),
          opts.vault,
          patch,
        );
        return {
          message:
            patch['enabled'] === false
              ? 'Jev settings saved. All Jev requests disabled; the saved key and feature choices are preserved.'
              : 'Jev settings saved. Restart existing sessions to install newly enabled consumers. /jev test verifies the saved connection.',
        };
      } catch {
        return {
          message:
            'Could not save Jev settings. Check /jev help, endpoint and profile file permissions.',
        };
      }
    },
  };
}
