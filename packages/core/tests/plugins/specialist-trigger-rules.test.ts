import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SPECIALIST_TRIGGERS,
  matchSpecialistTriggers,
  resolveSpecialistTriggerConfig,
  type SpecialistTriggerRule,
  specialistFireKey,
  specialistTaskText,
  toPosixPath,
} from '../../src/plugins/specialist-trigger-rules.js';

const rule = (over: Partial<SpecialistTriggerRule> = {}): SpecialistTriggerRule => ({
  role: 'database',
  match: ['**/migrations/**'],
  reason: 'schema moved',
  ...over,
});

describe('resolveSpecialistTriggerConfig', () => {
  it('stays off unless the user explicitly turns it on', () => {
    // This plugin spends money without being asked, so anything short of an
    // explicit `true` — undefined, null, the string "true" — must read as off.
    expect(resolveSpecialistTriggerConfig(undefined).enabled).toBe(false);
    expect(resolveSpecialistTriggerConfig({}).enabled).toBe(false);
    expect(resolveSpecialistTriggerConfig({ enabled: 'true' as never }).enabled).toBe(false);
    expect(resolveSpecialistTriggerConfig({ enabled: 1 as never }).enabled).toBe(false);
    expect(resolveSpecialistTriggerConfig({ enabled: true }).enabled).toBe(true);
  });

  it('ships the default rules and appends extras to them', () => {
    const resolved = resolveSpecialistTriggerConfig({ extraRules: [rule({ role: 'custom' })] });
    expect(resolved.rules).toHaveLength(DEFAULT_SPECIALIST_TRIGGERS.length + 1);
    expect(resolved.rules.at(-1)?.role).toBe('custom');
  });

  it('lets `rules` replace the defaults outright', () => {
    const resolved = resolveSpecialistTriggerConfig({ rules: [rule({ role: 'only' })] });
    expect(resolved.rules.map((entry) => entry.role)).toEqual(['only']);
  });

  it('treats an empty `rules` array as "no rules", not as "use the defaults"', () => {
    expect(resolveSpecialistTriggerConfig({ rules: [] }).rules).toEqual([]);
  });

  it('drops malformed rules rather than letting them misfire', () => {
    const resolved = resolveSpecialistTriggerConfig({
      rules: [
        rule(),
        { role: '', match: ['x'], reason: 'r' },
        { role: 'x', match: [], reason: 'r' },
        { match: ['x'] } as never,
        null as never,
      ],
    });
    expect(resolved.rules).toHaveLength(1);
  });

  it('falls back to the documented caps for absent or nonsensical numbers', () => {
    expect(resolveSpecialistTriggerConfig({})).toMatchObject({
      debounceMs: 20_000,
      maxConcurrent: 2,
      maxPerSession: 8,
    });
    expect(
      resolveSpecialistTriggerConfig({
        debounceMs: -1,
        maxConcurrent: 0,
        maxPerSession: Number.NaN,
      }),
    ).toMatchObject({ debounceMs: 20_000, maxConcurrent: 2, maxPerSession: 8 });
  });

  it('does not let a caller mutate the shipped defaults through the resolved config', () => {
    const resolved = resolveSpecialistTriggerConfig({});
    resolved.rules.push(rule({ role: 'sneaky' }));
    expect(resolveSpecialistTriggerConfig({}).rules.map((entry) => entry.role)).not.toContain(
      'sneaky',
    );
  });
});

describe('matchSpecialistTriggers', () => {
  it('matches nested paths and ignores unrelated ones', () => {
    const matches = matchSpecialistTriggers(
      ['db/migrations/001_init.sql', 'src/app.ts', 'README.md'],
      [rule()],
    );
    expect(matches).toHaveLength(1);
    expect(matches[0]?.paths).toEqual(['db/migrations/001_init.sql']);
  });

  it('wakes every rule a path concerns rather than picking one winner', () => {
    // A migration under auth/ is genuinely both agents' business; making them
    // compete would silently drop one of the two findings.
    const matches = matchSpecialistTriggers(
      ['src/auth/migrations/002_tokens.sql'],
      [rule(), rule({ role: 'security-scanner', match: ['**/auth/**'] })],
    );
    expect(matches.map((entry) => entry.rule.role)).toEqual(['database', 'security-scanner']);
  });

  it('normalises Windows separators so globs still match', () => {
    expect(toPosixPath('db\\migrations\\001.sql')).toBe('db/migrations/001.sql');
    const matches = matchSpecialistTriggers(['db\\migrations\\001.sql'], [rule()]);
    expect(matches[0]?.paths).toEqual(['db/migrations/001.sql']);
  });

  it('returns nothing when no rule matches', () => {
    expect(matchSpecialistTriggers(['src/app.ts'], [rule()])).toEqual([]);
  });

  it('sorts matched paths so the fire key does not depend on git output order', () => {
    const forward = matchSpecialistTriggers(['m/migrations/b.sql', 'm/migrations/a.sql'], [rule()]);
    const reverse = matchSpecialistTriggers(['m/migrations/a.sql', 'm/migrations/b.sql'], [rule()]);
    expect(specialistFireKey(forward[0] as never)).toBe(specialistFireKey(reverse[0] as never));
  });

  it('gives a different key once the matched set actually changes', () => {
    const one = matchSpecialistTriggers(['m/migrations/a.sql'], [rule()]);
    const two = matchSpecialistTriggers(['m/migrations/a.sql', 'm/migrations/b.sql'], [rule()]);
    expect(specialistFireKey(one[0] as never)).not.toBe(specialistFireKey(two[0] as never));
  });
});

describe('the shipped rules', () => {
  const fires = (filePath: string): string[] =>
    matchSpecialistTriggers([filePath], DEFAULT_SPECIALIST_TRIGGERS).map(
      (entry) => entry.rule.role,
    );

  it('routes the file shapes each rule claims', () => {
    expect(fires('pnpm-lock.yaml')).toContain('dependency');
    expect(fires('packages/core/package.json')).toContain('dependency');
    expect(fires('db/migrations/003_add_index.sql')).toContain('database');
    expect(fires('apps/web/locales/tr.json')).toContain('i18n');
    expect(fires('packages/core/src/auth/token.ts')).toContain('security-scanner');
    expect(fires('api/openapi.yaml')).toContain('api');
    expect(fires('proto/orders.proto')).toContain('api');
    expect(fires('.github/workflows/ci.yml')).toContain('devops');
    expect(fires('deploy/Dockerfile')).toContain('devops');
    expect(fires('e2e/checkout.spec.ts')).toContain('e2e');
    expect(fires('packages/core/tests/perf/compactor.bench.ts')).toContain('performance');
    expect(fires('src/payments/refund.ts')).toContain('payments');
    expect(fires('ios/App/ContentView.swift')).toContain('ios');
    expect(fires('android/app/build.gradle.kts')).toContain('android');
  });

  it('leaves ordinary source files alone', () => {
    // The second test every rule has to pass: a rule that fires on routine
    // source or docs churn crowds the per-session cap out from under the rules
    // that only speak when something genuinely happened.
    expect(fires('packages/core/src/coordination/director.ts')).toEqual([]);
    expect(fires('packages/tui/src/components/Composer.tsx')).toEqual([]);
    expect(fires('README.md')).toEqual([]);
    expect(fires('docs/slash/fleet.md')).toEqual([]);
    expect(fires('packages/core/tests/coordination/director.test.ts')).toEqual([]);
  });

  it('does not mistake a budget ledger or a zod schema for its domain', () => {
    // Both were real false positives caught by scanning the rules against this
    // repository's 8632 tracked files before shipping them.
    expect(fires('packages/core/src/coordination/brain-ledger.ts')).toEqual([]);
    expect(fires('packages/core/src/chronicle/metrics-schema.ts')).toEqual([]);
  });

  it('names a role for every rule and a reason the woken agent can act on', () => {
    for (const entry of DEFAULT_SPECIALIST_TRIGGERS) {
      expect(entry.role).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(entry.reason.length).toBeGreaterThan(40);
      expect(entry.match.length).toBeGreaterThan(0);
    }
  });
});

describe('specialistTaskText', () => {
  it('carries the reason and every changed path', () => {
    const [match] = matchSpecialistTriggers(
      ['db/migrations/a.sql', 'db/migrations/b.sql'],
      [rule({ reason: 'schema moved, check reversibility' })],
    );
    const task = specialistTaskText(match as never);
    expect(task).toContain('schema moved, check reversibility');
    expect(task).toContain('db/migrations/a.sql');
    expect(task).toContain('db/migrations/b.sql');
  });

  it('tells the agent nobody is blocked on it and a clean result is a valid answer', () => {
    const [match] = matchSpecialistTriggers(['db/migrations/a.sql'], [rule()]);
    const task = specialistTaskText(match as never);
    expect(task).toMatch(/nobody is/);
    expect(task).toMatch(/no concerns/);
  });
});
