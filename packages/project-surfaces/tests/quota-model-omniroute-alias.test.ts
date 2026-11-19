import { describe, expect, it } from 'vitest';
import type { QuotaSnapshot } from '../src/providers/provider-quota-store';
import {
  cardsInUse,
  omniRouteProviderOfMeter,
  type QuotaCard,
  quotaPageSections,
} from '../src/providers/quota-model';

/**
 * F4: OmniRoute builds pool meter ids from the RAW connection.provider
 * (`omniroute:<provider>:<connection>`), which may be an alias exactly as a
 * routed model id may (`cc/…`). The meter-side resolver must normalize through
 * the same OMNIROUTE_ALIAS map the model side uses — special-casing only 'agy'
 * left every other alias-reported account never matching the models in use,
 * so the quota surface hid the very account serving the running model.
 */

function poolMeter(provider: string, id: string, pct: number): QuotaSnapshot {
  return {
    providerId: 'omniroute',
    meterId: `omniroute:${provider}:${id}`,
    meterLabel: `${provider} · ${id}`,
    windows: [{ id: '5h', usedPercent: pct, windowMinutes: 300, resetsAt: 1_800_000_000 }],
    via: 'omniroute',
    capturedAt: 1_700_000_000_000,
  } as QuotaSnapshot;
}

function gateway(meters: QuotaSnapshot[]): QuotaCard {
  return { providerId: 'omniroute', aliases: ['omniroute'], vendor: 'omniroute', meters };
}

const servingIds = (card: QuotaCard | undefined): string[] =>
  (card?.meters ?? []).map((m) => m.meterId);

describe('OmniRoute alias-reported pool accounts (F4)', () => {
  it.each([
    ['cc', 'claude', 'cc/claude-opus-5'],
    ['cx', 'codex', 'cx/gpt-5.4-codex'],
    ['gh', 'github', 'gh/gpt-5.4'],
    ['kmc', 'kimi-coding', 'kmc/kimi-k3'],
    ['cmd', 'command-code', 'cmd/command-r'],
    ['agy', 'antigravity', 'antigravity/gemini-3.6-flash'],
  ])('a %s-reported account serves %s models', (alias, canonical, model) => {
    const card = gateway([poolMeter(alias, 'c1', 30)]);
    const shown = cardsInUse([card], [{ provider: 'omniroute', model }])[0];
    expect(servingIds(shown)).toContain(`omniroute:${alias}:c1`);
    expect(shown?.hiddenPoolAccounts).toBe(0);
    // The canonical model id matches the alias-reported account too.
    const canonicalShown = cardsInUse(
      [card],
      [{ provider: 'omniroute', model: `${canonical}/some-model` }],
    )[0];
    expect(servingIds(canonicalShown)).toContain(`omniroute:${alias}:c1`);
  });

  it('keeps canonical accounts and hides unrelated ones', () => {
    const card = gateway([poolMeter('claude', 'c1', 40), poolMeter('codex', 'c2', 10)]);
    const shown = cardsInUse([card], [{ provider: 'omniroute', model: 'claude/claude-opus-5' }])[0];
    expect(servingIds(shown)).toEqual(['omniroute:claude:c1']);
    expect(shown?.hiddenPoolAccounts).toBe(1);
  });

  it('marks the alias account in-use on the Plan Quota page', () => {
    const card = gateway([poolMeter('cc', 'c1', 95), poolMeter('codex', 'c2', 10)]);
    const sections = quotaPageSections(
      [card],
      [{ provider: 'omniroute', model: 'cc/claude-opus-5' }],
    );
    const ccEntry = [
      ...sections.inUse,
      ...sections.plans,
      ...sections.pool,
      ...sections.balances,
    ].find((entry) => entry.key.includes('omniroute:cc:c1'));
    expect(ccEntry?.inUse).toBe(true);
    expect(sections.inUse.map((entry) => entry.key)).toEqual(['omniroute\u0000omniroute:cc:c1']);
    expect(sections.summary).toMatchObject({ accounts: 2, critical: 1 });
  });

  it('still names no single account for auto/bare models', () => {
    const card = gateway([poolMeter('claude', 'c1', 40)]);
    for (const model of ['auto/claude-opus-5', 'claude-opus-5']) {
      const shown = cardsInUse([card], [{ provider: 'omniroute', model }])[0];
      expect(servingIds(shown)).toEqual([]);
    }
  });

  it('resolves segments safely: unknown passthrough, empty/missing undefined, non-pool undefined', () => {
    expect(omniRouteProviderOfMeter(poolMeter('claude', 'c1', 5))).toBe('claude');
    expect(omniRouteProviderOfMeter(poolMeter('cc', 'c1', 5))).toBe('claude');
    expect(
      omniRouteProviderOfMeter({
        ...poolMeter('x', 'c1', 5),
        meterId: 'omniroute::c1',
      } as QuotaSnapshot),
    ).toBeUndefined();
    expect(
      omniRouteProviderOfMeter({
        ...poolMeter('x', 'c1', 5),
        meterId: 'omniroute',
      } as QuotaSnapshot),
    ).toBeUndefined();
    expect(
      omniRouteProviderOfMeter({
        ...poolMeter('claude', 'c1', 5),
        via: undefined,
      } as QuotaSnapshot),
    ).toBeUndefined();
  });
});
