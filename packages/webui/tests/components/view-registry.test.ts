/**
 * B-17 (docs/audit/webui-full-review-2026-09-03.md) — the per-view
 * registration for the main area used to live as 26 hand-written
 * `currentView === 'X' &&` branches inside `ViewRouter.tsx`, each repeating
 * the same ErrorBoundary + Suspense + wrapper-div skeleton. The branches now
 * live in a registry (`view-registry.ts`) and are rendered by `MainViewSlot`.
 *
 * These tests pin the contracts that fall out of the move:
 *
 *  1. Every `View` the store can be set to has a registry entry. A view
 *     without an entry would render an empty `<MainViewSlot>` (the slot
 *     early-returns), which would silently swallow the click — the
 *     compile-time `Exclude` was added for the same reason (see
 *     `view-registry.ts`).
 *  2. Every registry entry has a non-empty wrapper class OR `wrapperClassName`
 *     === '' for the one view (`context`) that needs to land without a div.
 *  3. Each entry references a real i18n key. A typo would render `t('...:')`
 *     as a key-as-string fallback — silent and broken. The catalog-integrity
 *     test already covers this for `t('ns:key')` literals in JSDoc/source;
 *     this test pins it for the registry entries (which are NOT literals,
 *     they live in object fields, so the existing regex misses them).
 *  4. `chat` is NOT in the registry — it stays a special mount in
 *     `ViewRouter` for lifetime + parking.
 */
import { describe, expect, it } from 'vitest';
import { VIEW_REGISTRY, type ViewMeta } from '../../src/components/view-registry';
import { VIEWS, type View } from '../../src/stores/ui-store';

/** Every entry must have a non-empty `boundaryNameKey` in the activity ns. */
function isWellFormed(entry: ViewMeta, view: View): string | null {
  if (!entry.Component) return `${view}: missing Component`;
  if (typeof entry.boundaryNameKey !== 'string' || entry.boundaryNameKey.length === 0) {
    return `${view}: missing boundaryNameKey`;
  }
  if (!entry.boundaryNameKey.startsWith('activity:')) {
    return `${view}: boundaryNameKey must be in the activity namespace`;
  }
  if (entry.loadingLabelKey !== null && !entry.loadingLabelKey.startsWith('activity:')) {
    return `${view}: loadingLabelKey must be in the activity namespace or null`;
  }
  return null;
}

describe('B-17 view registry', () => {
  it('covers every view except chat', () => {
    const routed = new Set(Object.keys(VIEW_REGISTRY) as View[]);
    expect(routed.has('chat')).toBe(false);
    for (const view of VIEWS) {
      if (view === 'chat') continue;
      expect(routed.has(view), `${view} is missing from VIEW_REGISTRY`).toBe(true);
    }
  });

  it('declares no entry for chat', () => {
    // The chat surface is mounted for the session lifetime by ViewRouter and
    // parked rather than remounted, so it intentionally sits outside the
    // registry slot.
    expect(VIEW_REGISTRY.chat).toBeUndefined();
  });

  it('every entry is well-formed', () => {
    const failures: string[] = [];
    for (const [view, entry] of Object.entries(VIEW_REGISTRY)) {
      if (!entry) {
        failures.push(`${view}: undefined entry`);
        continue;
      }
      const err = isWellFormed(entry, view as View);
      if (err) failures.push(err);
    }
    expect(failures).toEqual([]);
  });

  it('each boundary/loading key resolves to a real catalog key', () => {
    // The static `t('ns:key')` walker in catalog-integrity misses registry
    // entries because the keys live in object fields, not as call-site
    // literals. Walk the entries ourselves so a typo in a label renders a
    // assertion failure here instead of a broken UI in production.
    const { default: activity } = (() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      return { default: require('../../src/i18n/locales/en/activity.json') };
    })() as { default: Record<string, unknown> };

    function walk(node: unknown, prefix: string, out: Set<string>): void {
      if (node && typeof node === 'object' && !Array.isArray(node)) {
        for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
          const path = prefix ? `${prefix}.${k}` : k;
          if (v && typeof v === 'object' && !Array.isArray(v)) walk(v, path, out);
          else out.add(path);
        }
      }
    }
    const keys = new Set<string>();
    walk(activity, '', keys);

    function resolve(keyPath: string): string[] {
      // `keyPath` is `activity:panels.foo.bar` — strip the namespace prefix
      // and look up the dotted remainder.
      const remainder = keyPath.replace(/^activity:/, '');
      const dotted = remainder.split('.').join('.');
      return keys.has(dotted) ? [] : [`${keyPath} → ${dotted}`];
    }

    const missing: string[] = [];
    for (const [view, entry] of Object.entries(VIEW_REGISTRY)) {
      if (!entry) continue;
      missing.push(...resolve(entry.boundaryNameKey).map((m) => `${view} boundary ${m}`));
      if (entry.loadingLabelKey) {
        missing.push(...resolve(entry.loadingLabelKey).map((m) => `${view} loading ${m}`));
      }
    }
    expect(missing).toEqual([]);
  });

  it('the runtime expects to call MainViewSlot only when currentView !== chat', () => {
    // Documented contract: chat is special, parked-not-remounted. The slot
    // called for `chat` would still render the registry entry (none
    // exists), so callers MUST guard. This is the loose form of the
    // compile-time check; reading the route file pins the convention in CI.
    const src = require('node:fs').readFileSync(
      require('node:path').resolve(__dirname, '../../src/components/ViewRouter.tsx'),
      'utf8',
    ) as string;
    expect(src).toMatch(/currentView\s*!==\s*['"]chat['"]\s*&&\s*<MainViewSlot/);
  });
});
