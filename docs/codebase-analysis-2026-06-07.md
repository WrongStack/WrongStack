# WrongStack Codebase Analysis Report
**Date:** 2026-07-06 | **Version:** 0.282.1 | **Scope:** 14 packages + 2 apps (core, cli, tools, providers, mcp, webui, tui, plug-lsp, runtime, acp, plugins, telegram, bench, webui-hq + apps/wrongstack, apps/desktop)

---

## Overall Assessment

The codebase is in **excellent health**. The security posture is strong — all previously reported vulnerabilities (C-1 through L-15 from the May 2026 audit) are verified fixed. The architecture is clean, dependency topology is respected (core has zero cross-package imports), the tool executor has multiple defense-in-depth layers, and the codebase is free of `as any` in source code. There are no CRITICAL or HIGH-severity bugs found.

The findings below are **technical debt and code quality** issues, not security vulnerabilities.

---

## HIGH — Code Duplication

### H-1: `expectDefined` duplicated **80 times** across the codebase

**Category:** Code Quality / Duplication
**Effort:** M (medium — mostly automated fix)

The helper function `expectDefined<T>(value: T | null | undefined): T` is defined **80 separate times** across the monorepo. A proper shared implementation exists at `packages/core/src/utils/expect-defined.ts` and is reachable via `@wrongstack/core`, yet nearly every package defines its own local copy.

**Affected packages (count of duplicates):**

| Package | Copies |
|---------|--------|
| `cli` | 15 |
| `core` | 25 |
| `tools` | 9 |
| `webui` | 7 |
| `acp` | 2 |
| `tui` | 2 |
| `mcp` | 1 |
| `telegram` | 2 |
| `plug-lsp` | 3 |
| `providers` | 2 |
| `plugins` | 3 |

**Why it matters:** Every copy is a maintenance hazard — if the error message changes or TypeScript patterns evolve, 80 files need updating. It also bloats bundle sizes (micro, but multiplied by 80).

**Fix:**
1. Remove all local `function expectDefined` definitions
2. Import from `@wrongstack/core` (it's exported via `utils/index.js` → the main barrel)
3. For packages that don't depend on `@wrongstack/core` (tools, providers, etc. — they do), use the existing import

```typescript
// Before — local copy in 80 files
function expectDefined<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) {
    throw new Error('Expected value to be defined');
  }
  return value;
}

// After — import from core
import { expectDefined } from '@wrongstack/core';
```

---

## HIGH — Code Convention Violations

### H-2: Turkish comments in autophase package (8 files, 146+ matches)

**Category:** Code Convention
**Severity:** High for internationalization consistency
**Files:** All files in `packages/core/src/autophase/`

The autophase package contains Turkish-language comments mixed with English. Examples from `phase-orchestrator.ts`:
- Line 131: `// Autonomous tick loop (gerçek zamanlı monitoring için)`
- Line 137: `/** Bekleyen tüm faz merge'lerini (dep-sıralı + global seri) bekle. */`
- Lines 143-159: `/** Duraklat — ... */`, `/** Devam et — ... */`, `/** Tamamen durdur — ... */`

**Why it matters:** Mixed languages in comments create a barrier for non-Turkish-speaking contributors. The project is an international open-source project — comments should be in a single language (English).

**Fix:** Translate Turkish comments to English:
```typescript
// Before
// Autonomous tick loop (gerçek zamanlı monitoring için)

// After
// Autonomous tick loop (for real-time monitoring)
```

---

## MEDIUM — Type Safety

### M-1: Unsafe type casts in cost-tracker plugin config access

**File:** `packages/plugins/src/cost-tracker/index.ts:144-145`

The cost-tracker plugin accesses its own config through double unsafe casts:

```typescript
const budgetLimit = (api.config.extensions?.['cost-tracker'] as Record<string, unknown>)?.['budgetLimit'] as number ?? 0;
const warningThreshold = (api.config.extensions?.['cost-tracker'] as Record<string, unknown>)?.['warningThreshold'] as number ?? 80;
```

**Why this is problematic:** The plugin already defines a `configSchema` and `defaultConfig`. The `api.config` should expose the plugin's typed options without requiring `as` casts that bypass all type checking. If the config key name changes, this silently returns `0`/`80` with no type error.

**Fix:** The `PluginAPI` type should include a typed `config` accessor that accepts the plugin's config type:

```typescript
// Ideal: api.config.get<'cost-tracker'>() returns typed config
const cfg = api.config.getPluginConfig<'cost-tracker'>();
const budgetLimit = cfg.budgetLimit ?? 0;
```

Alternatively, store config on setup:

```typescript
setup(api) {
  const cfg = api.config.extensions?.['cost-tracker'] ?? {};
  const budgetLimit = typeof cfg.budgetLimit === 'number' ? cfg.budgetLimit : 0;
}
```

---

### M-2: cost-tracker `cost_reset` tool incorrectly declares `mutating: false`

**File:** `packages/plugins/src/cost-tracker/index.ts:185`

The `cost_reset` tool resets in-memory tracking state (`sessionCost.requests`, counters, etc.) but declares `mutating: false`:

```typescript
api.tools.register({
  name: 'cost_reset',
  // ...
  permission: 'auto',
  mutating: false,  // actually mutates sessionCost
```

**Fix:** Set `mutating: true`:

```typescript
  mutating: true,  // resets in-memory tracking state
```

---

### M-3: `as any` in cost-tracker event subscription

**File:** `packages/plugins/src/cost-tracker/index.ts:269`

```typescript
api.onEvent('session.close' as any, async () => {
```

The `'session.close'` event doesn't exist in the typed `EventBus` event map. The plugin uses `as any` to bypass the type system.

**Fix:** Either:
1. Add `'session.close'` to the `EventMap` in `events.ts` if it's a legitimate lifecycle event
2. Use `session.ended` or another existing event type
3. If this is a custom plugin event, it should go through a plugin-specific channel

---

## MEDIUM — Test Coverage

### M-4: No dedicated test for the shared `expectDefined` utility

**File:** `packages/core/src/utils/expect-defined.ts` (no corresponding test file)

The most duplicated function in the codebase (80 copies) has no unit tests at the canonical definition site.

**Fix:** Add `packages/core/tests/utils/expect-defined.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { expectDefined } from '../../src/utils/expect-defined.js';

describe('expectDefined', () => {
  it('returns the value when defined', () => {
    expect(expectDefined('hello')).toBe('hello');
    expect(expectDefined(0)).toBe(0);
    expect(expectDefined(false)).toBe(false);
  });
  it('throws on null', () => {
    expect(() => expectDefined(null)).toThrow('Expected value to be defined');
  });
  it('throws on undefined', () => {
    expect(() => expectDefined(undefined)).toThrow('Expected value to be defined');
  });
});
```

---

## LOW — Code Quality

### L-1: `expectDefined` not explicitly re-exported from core barrel

**File:** `packages/core/src/index.ts`

`expectDefined` is reachable only through the wildcard `export * from './utils/index.js'` on line 3. It's not in the explicit re-export section (lines 8-353). This may have contributed to it being missed and duplicated.

**Fix:** Add an explicit re-export near the other utility re-exports:

```typescript
export { expectDefined } from './utils/expect-defined.js';
```

---

### L-2: `expectDefined` provides poor error messages

**File:** `packages/core/src/utils/expect-defined.ts:7`

The error message `'Expected value to be defined'` provides no information about **which** value was undefined. This makes debugging difficult when the call stack is deep.

**Fix:** Add a contextual parameter:

```typescript
export function expectDefined<T>(value: T | null | undefined, label?: string): T {
  if (value === null || value === undefined) {
    throw new Error(label ? `Expected ${label} to be defined` : 'Expected value to be defined');
  }
  return value;
}
```

---

## Summary

| Severity | Count | Issue |
|----------|-------|-------|
| **HIGH** | 2 | `expectDefined` 80× duplication, Turkish comments in autophase |
| **MEDIUM** | 4 | Unsafe casts in cost-tracker, wrong mutating flag, `as any` event, missing test |
| **LOW** | 2 | Implicit re-export, poor error messages |

**Security Posture:** All 15 previously reported vulnerabilities (C-1/C-2, H-1 through H-4, M-1 through M-4, L-1 through L-15) are verified fixed. The codebase has zero `as any` in core source, zero shell injection patterns, zero hardcoded secrets in source, and zero empty catch blocks. The tool executor has robust defense-in-depth (schema validation → hook validation → permission policy → capability enforcement → execution tracing).

**Architectural Health:** Clean dependency topology (core depends on no WrongStack packages), well-structured kernel primitives (Container, Pipeline, EventBus, RunController at ~600 total lines), and no circular dependencies detected.

---

## Quick-Reference Fix Checklist

- [ ] **H-1:** Replace all 80 local `expectDefined` definitions with `import { expectDefined } from '@wrongstack/core'`
- [ ] **H-2:** Translate Turkish comments in `packages/core/src/autophase/` to English (8 files, 146+ matches)
- [ ] **M-1:** Add typed config accessor for cost-tracker plugin or use runtime type guards
- [ ] **M-2:** Set `mutating: true` on `cost_reset` tool in cost-tracker plugin
- [ ] **M-3:** Add `'session.close'` to EventMap or remove `as any` workaround
- [ ] **M-4:** Add unit tests for `packages/core/src/utils/expect-defined.ts`
- [ ] **L-1:** Add explicit re-export of `expectDefined` in core barrel
- [ ] **L-2:** Add optional `label` parameter to `expectDefined` for better error messages
