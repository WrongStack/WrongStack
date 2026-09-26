import { describe, expect, it } from 'vitest';
import { evaluateModelCalendar } from '../../src/core/model-availability-calendar.js';
import { configuredProviderIdentities } from '../../src/utils/provider-catalog-binding.js';

const atUtc = (value: string) => new Date(`${value}Z`);

describe('model availability calendar', () => {
  it('blocks a provider during a recurring daytime window', () => {
    const result = evaluateModelCalendar(
      [
        {
          id: 'night',
          provider: 'openai',
          days: [1],
          start: '01:00',
          end: '08:00',
          timezone: 'UTC',
        },
      ],
      'openai',
      'gpt-5',
      atUtc('2026-07-20T03:00:00'),
    );
    expect(result.allowed).toBe(false);
  });

  it('handles overnight windows using the day on which the window starts', () => {
    const rules = [
      { id: 'overnight', provider: 'cc', days: [1], start: '22:00', end: '07:00', timezone: 'UTC' },
    ];
    expect(evaluateModelCalendar(rules, 'cc', 'opus', atUtc('2026-07-20T23:00:00')).allowed).toBe(
      false,
    );
    expect(evaluateModelCalendar(rules, 'cc', 'opus', atUtc('2026-07-21T06:30:00')).allowed).toBe(
      false,
    );
    expect(evaluateModelCalendar(rules, 'cc', 'opus', atUtc('2026-07-21T08:00:00')).allowed).toBe(
      true,
    );
  });

  it('treats equal start/end as an all-day blackout', () => {
    expect(
      evaluateModelCalendar(
        [
          {
            id: 'sunday',
            model: 'expensive',
            days: [0],
            start: '00:00',
            end: '00:00',
            timezone: 'UTC',
          },
        ],
        'any',
        'expensive',
        atUtc('2026-07-19T15:00:00'),
      ).allowed,
    ).toBe(false);
  });

  it('normalizes OmniRoute transport ids before matching', () => {
    const result = evaluateModelCalendar(
      [{ id: 'cc-night', provider: 'cc', model: 'claude-opus-4.8', start: '00:00', end: '00:00' }],
      'omniroute',
      'cc/claude-opus-4.8',
    );
    expect(result.allowed).toBe(false);
  });

  it('covers a second account with a rule naming its vendor, or the account itself', () => {
    // `work` is built from the `anthropic` entry. A vendor rule used to cover
    // it at run time only because its id collapsed to `anthropic` — and never
    // in the fallback chain, which names it `work`.
    const providers = { work: { type: 'anthropic' } };
    const allDay = (provider: string) => [{ id: provider, provider, start: '00:00', end: '00:00' }];
    const work = configuredProviderIdentities(providers, 'work');
    expect(work).toEqual(['work', 'anthropic']);
    expect(evaluateModelCalendar(allDay('anthropic'), work, 'claude').allowed).toBe(false);
    expect(evaluateModelCalendar(allDay('work'), work, 'claude').allowed).toBe(false);
    expect(evaluateModelCalendar(allDay('openai'), work, 'claude').allowed).toBe(true);
    // The vendor's own account is not blocked by a rule for the second one.
    expect(evaluateModelCalendar(allDay('work'), 'anthropic', 'claude').allowed).toBe(true);
  });

  it('ignores disabled, malformed-time, and unrelated rules', () => {
    expect(
      evaluateModelCalendar(
        [
          { id: 'off', enabled: false, provider: 'cc', start: '00:00', end: '00:00' },
          { id: 'bad', provider: 'cc', start: '25:00', end: '00:00' },
          { id: 'other', provider: 'openai', start: '00:00', end: '00:00' },
        ],
        'cc',
        'opus',
      ).allowed,
    ).toBe(true);
  });

  it('supports use-only windows and unions multiple allowed windows', () => {
    const rules = [
      {
        id: 'morning',
        mode: 'allow_only' as const,
        provider: 'cc',
        start: '08:00',
        end: '12:00',
        timezone: 'UTC',
      },
      {
        id: 'evening',
        mode: 'allow_only' as const,
        provider: 'cc',
        start: '18:00',
        end: '20:00',
        timezone: 'UTC',
      },
    ];
    expect(evaluateModelCalendar(rules, 'cc', 'opus', atUtc('2026-07-20T09:00:00')).allowed).toBe(
      true,
    );
    expect(evaluateModelCalendar(rules, 'cc', 'opus', atUtc('2026-07-20T19:00:00')).allowed).toBe(
      true,
    );
    expect(evaluateModelCalendar(rules, 'cc', 'opus', atUtc('2026-07-20T15:00:00')).allowed).toBe(
      false,
    );
  });

  it('lets an explicit blackout override an overlapping allow-only window', () => {
    const rules = [
      {
        id: 'allow',
        mode: 'allow_only' as const,
        provider: 'cc',
        start: '08:00',
        end: '20:00',
        timezone: 'UTC',
      },
      { id: 'lunch', provider: 'cc', start: '12:00', end: '13:00', timezone: 'UTC' },
    ];
    expect(evaluateModelCalendar(rules, 'cc', 'opus', atUtc('2026-07-20T12:30:00')).allowed).toBe(
      false,
    );
  });

  it('ignores invalid allow-only rules instead of permanently blocking a target', () => {
    const rules = [
      { id: 'bad-time', mode: 'allow_only' as const, provider: 'cc', start: '99:00', end: '17:00' },
      {
        id: 'bad-zone',
        mode: 'allow_only' as const,
        provider: 'cc',
        start: '09:00',
        end: '17:00',
        timezone: 'Not/AZone',
      },
    ];
    expect(evaluateModelCalendar(rules, 'cc', 'opus', atUtc('2026-07-20T12:00:00')).allowed).toBe(
      true,
    );
  });
});
