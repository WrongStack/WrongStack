// @vitest-environment jsdom

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, describe, expect, it } from 'vitest';
import { ConversationNotices } from '../src/ConversationNotices';
import {
  type ConversationNotice,
  conversationNotice,
  noticeText,
} from '../src/conversation-notices';
import { surfaceI18n } from '../src/surface-i18n';

/** Every notice branch, with the English it showed before its wording moved to the catalog. */
const cases: Array<[string, Record<string, unknown>, string, string]> = [
  [
    'provider.stream_error',
    {},
    'Provider stream warning (unknown event): no detail.',
    'The engine skipped this stream event and kept going.',
  ],
  [
    'provider.stream_error',
    { eventType: 'ping', message: 'bad frame' },
    'Provider stream warning (ping): bad frame.',
    'The engine skipped this stream event and kept going.',
  ],
  [
    'provider.model_switched',
    { to: { providerId: 'openai', model: 'gpt-5' } },
    'Model: openai/gpt-5.',
    '',
  ],
  [
    'provider.model_switched',
    { from: { providerId: 'a', model: 'b' }, to: { providerId: 'openai', model: 'gpt-5' } },
    'Model: openai/gpt-5 (was a/b).',
    '',
  ],
  ['checkpoint.written', {}, 'Checkpoint written (0 files).', ''],
  [
    'checkpoint.written',
    { fileCount: 1, promptPreview: 'fix it' },
    'Checkpoint written (1 file).',
    'fix it',
  ],
  ['checkpoint.written', { promptIndex: 4, fileCount: 1 }, 'Checkpoint #4 written (1 file).', ''],
  ['checkpoint.written', { promptIndex: 4, fileCount: 2 }, 'Checkpoint #4 written (2 files).', ''],
  [
    'token.cost_estimate_unavailable',
    {},
    'Cost estimate unavailable for this model.',
    'Its price is not in the model catalog; token counts are still recorded.',
  ],
  [
    'trust.persisted',
    { tool: 'bash', pattern: 'git *', decision: 'always' },
    'Always allowed bash: git *.',
    '',
  ],
  [
    'trust.persisted',
    { tool: 'bash', displayPattern: 'git push', decision: 'deny' },
    'Denied bash: git push.',
    '',
  ],
  ['delegation.delivery_pending', {}, 'Background delegation result ready.', ''],
  [
    'delegation.delivery_pending',
    { delegationIds: ['d1'] },
    'Background delegation result ready (d1).',
    '',
  ],
  [
    'delegation.delivery_pending',
    { count: 2, delegationIds: ['d1', 'd2'] },
    '2 background delegation results ready (d1, d2).',
    '',
  ],
  [
    'delegation.auto_wake_started',
    { delegationIds: ['d1'] },
    'Auto-wake: a background delegation result arrived (d1); the leader started a new turn.',
    '',
  ],
  [
    'delegation.auto_wake_started',
    { delegationIds: ['d1', 'd2'], chain: 2 },
    'Auto-wake: background delegation results arrived (d1, d2); the leader started a new turn — woken turn 2 without your input.',
    '',
  ],
  [
    'delegation.auto_wake_suppressed',
    { reason: 'chain_cap', pending: 1 },
    'Auto-wake paused: 1 background result held after too many consecutive woken turns — send a message to continue.',
    '',
  ],
  [
    'delegation.auto_wake_suppressed',
    { reason: 'chain_cap', pending: 3 },
    'Auto-wake paused: 3 background results held after too many consecutive woken turns — send a message to continue.',
    '',
  ],
  [
    'mcp.server.disconnected',
    { name: 'github', terminal: true },
    'MCP server "github" is not connected (unknown); its tools are unavailable.',
    'Settings > Connected tools can reconnect it.',
  ],
  [
    'mcp.server.disconnected',
    { name: 'github', terminal: true, reason: 'gone\nstack' },
    'MCP server "github" is not connected (gone); its tools are unavailable.',
    'Settings > Connected tools can reconnect it.',
  ],
  ['mcp.server.reconnected', { name: 'github' }, 'MCP server "github" is connected again.', ''],
  [
    'run.result',
    { status: 'max_iterations' },
    'The run stopped at its iteration limit.',
    'Send a message to continue from here. The limit is the tools.maxIterations setting.',
  ],
  [
    'run.result',
    { status: 'max_iterations', iterations: 40 },
    'The run stopped at its iteration limit after 40 turns.',
    'Send a message to continue from here. The limit is the tools.maxIterations setting.',
  ],
  [
    'tool.loop_detected',
    {},
    'The engine ended the turn: a repeating reply.',
    'Rephrase the request or give the missing information before continuing.',
  ],
  [
    'tool.loop_detected',
    { tools: 'read', repeatCount: 5 },
    'The engine ended the turn: repeated read calls (5 repeats).',
    'Rephrase the request or give the missing information before continuing.',
  ],
  [
    'session.damaged',
    {},
    "This conversation's journal is damaged.",
    'History & recovery shows what the journal still holds.',
  ],
  [
    'session.damaged',
    { detail: 'line 4' },
    "This conversation's journal is damaged: line 4",
    'History & recovery shows what the journal still holds.',
  ],
  [
    'compaction.failed',
    {},
    'Context compaction failed.',
    'The context was not reduced; Context & instructions shows its current size.',
  ],
  [
    'compaction.failed',
    { message: 'too big' },
    'Context compaction failed: too big',
    'The context was not reduced; Context & instructions shows its current size.',
  ],
  [
    'provider.model_rerouted',
    { served: 'b' },
    'The provider answered with b instead of the requested model.',
    '',
  ],
  [
    'provider.model_rerouted',
    { providerId: 'p', served: 'b', requested: 'a', reason: 'busy' },
    'p answered with b instead of a (busy).',
    '',
  ],
  ['provider.active_blocked', {}, 'The provider is blocked.', ''],
  [
    'provider.active_blocked',
    { providerId: 'p', model: 'm', lastError: '429', fallbackProviderId: 'q', fallbackModel: 'n' },
    'p/m is blocked: 429.',
    'The engine tries q/n instead.',
  ],
  [
    'model.tier_proposed',
    {
      target: { provider: 'p', model: 'm' },
      toTier: 'budget',
      reason: 'Simple turns.',
      projectedSavingsUsd: 0.5,
    },
    'WrongStack proposes the budget tier: p/m.',
    'Simple turns. Projected saving about $0.5000.',
  ],
];

const notice = (type: string, payload: Record<string, unknown>) => {
  const made = conversationNotice(type, payload, 'n', 0);
  if (!made) throw new Error(`no notice for ${type}`);
  return made;
};

describe('conversation notices in the display language', () => {
  afterAll(async () => {
    await surfaceI18n.changeLanguage('en');
  });

  it('keeps every English notice exactly as it was', () => {
    for (const [type, payload, text, hint] of cases) {
      const made = notice(type, payload);
      expect(made.text, type).toBe(text);
      expect(made.hint, type).toBe(hint);
    }
    expect(notice('model.tier_proposed', cases.at(-1)![1]).action?.label).toBe('Switch to budget');
  });

  it('words every notice from keys present in all seven languages', () => {
    for (const language of ['en', 'tr', 'de', 'fr', 'it', 'es', 'pt-BR']) {
      const t = surfaceI18n.getFixedT(language, 'desktop');
      for (const [type, payload] of cases) {
        const made = notice(type, payload);
        const missing: string[] = [];
        const translate = (key: string, values: Record<string, string | number>) => {
          if (!surfaceI18n.exists(`notices.${key}`, { ns: 'desktop', lng: language }))
            missing.push(key);
          return t(`notices.${key}`, values);
        };
        noticeText(made.message, translate);
        noticeText(made.detail, translate);
        noticeText(made.action?.labelText, translate);
        expect(missing, `${language} ${type}`).toEqual([]);
      }
    }
  });

  it('shows notices, hints and actions in Turkish', async () => {
    await surfaceI18n.changeLanguage('tr');
    const notices: ConversationNotice[] = [
      notice('run.result', { status: 'max_iterations', iterations: 40 }),
      notice('mcp.server.disconnected', { name: 'github', terminal: true }),
      notice('model.tier_proposed', cases.at(-1)![1]),
    ];
    const html = renderToStaticMarkup(
      createElement(ConversationNotices, { notices, onAction: async () => undefined }),
    )
      .replaceAll('<!-- -->', '')
      .replaceAll('&quot;', '"')
      .replaceAll('&gt;', '>');
    expect(html).toContain('Çalıştırma 40 turdan sonra yineleme sınırında durdu.');
    expect(html).toContain(
      'MCP sunucusu "github" bağlı değil (bilinmiyor); araçları kullanılamıyor.',
    );
    expect(html).toContain('Ayarlar > Bağlı araçlar bölümünden yeniden bağlanabilir.');
    expect(html).toContain('Simple turns. Öngörülen tasarruf yaklaşık $0,5000.');
    expect(html).toContain('budget katmanına geç');
    expect(html).not.toContain('iteration limit');
    expect(html).not.toContain('Switch to');
  });

  it('keeps the English text when a notice carries no wording', async () => {
    await surfaceI18n.changeLanguage('tr');
    const legacy: ConversationNotice = {
      id: 'x',
      severity: 'info',
      text: 'Legacy engine line.',
      hint: '',
      at: 0,
    };
    const html = renderToStaticMarkup(createElement(ConversationNotices, { notices: [legacy] }));
    expect(html).toContain('Legacy engine line.');
  });
});
