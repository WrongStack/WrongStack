---
name: angular-modern
description: "Angular apps with signals, standalone components, zoneless change detection, SSR hydration, typed forms and ng update migrations. Use when building or fixing Angular components, services, routing, forms, signals/RxJS interop, SSR or upgrades; inspect zoneless versus Zone.js behavior instead of assuming either. Not for generic TypeScript typing (use typescript-strict) or non-Angular UI frameworks."
trigger: "Use when the change touches angular.json, *.component.ts, Angular routing, signals, RxJS interop, SSR/hydration or an ng update."
version: 1.1.1
required-capabilities: [filesystem.read]
required-tools: []
optional-capabilities: [filesystem.write, execution.shell, verification.run, web.research]
metadata:
  routing-group: frontend
  domain: "web"
paths: ["angular.json", "*.component.ts"]
---

# Angular Modern

## Selection card
- Task: Build or repair Angular components, signals state, routing, forms, SSR and upgrades.
- Start: Read angular.json, the bootstrap file (app.config.ts or main.ts), package.json versions and the affected component.
- Finish: the production build passes with strict templates, the changed route works in the configured rendering mode, and the checks below pass.

## Overview

Modern Angular is signals-first: state lives in `signal`/`computed`, components are standalone, and change detection may run without Zone.js — code that silently relied on zones stops updating.
Checked 2026-11-02: Angular core/compiler-cli 22.2.4 and Angular CLI 22.2.5. Coordinate framework/compiler/CLI packages. Compiler-cli 22.2.4 declares TypeScript >=6.0 <6.1, so current TypeScript 7.0.2 is outside its supported range. Report this blocker; do not force the peer combination.
Keep Angular projects on the TypeScript line the compiler declares; the native TypeScript 7 compiler is not an Angular compiler.

## Rules

1. Detect the change-detection mode first (`provideZonelessChangeDetection()` versus zone.js in polyfills). In zoneless apps, state that templates read must be signals, inputs, async pipe or an explicit `markForCheck()`.
2. Derive with `computed()` or `linkedSignal()`; never write signals inside `effect()` to synchronize state. Effects are for leaving Angular: DOM APIs, storage, logging, third-party widgets.
3. Every subscription has an owner: `async` pipe, `toSignal()`, or `takeUntilDestroyed()` (inside an injection context or with an explicit `DestroyRef`).
4. Route guards and hidden controls are navigation policy, not authorization; the server re-checks every request.
5. Typed reactive forms (`NonNullableFormBuilder`, `FormGroup<{...}>`) with pending, error and disabled states that match server validation.
6. Browser-only APIs (`window`, `localStorage`, DOM measurement) run in `afterNextRender()` or behind `isPlatformBrowser`; SSR output must hydrate without mismatches.
7. Upgrade one major at a time with `ng update` and its schematics; keep @angular/* packages on the same version and TypeScript inside the compiler's peer range.

## First moves by situation

| Situation | First moves |
|---|---|
| View does not update after async work | Check zoneless mode; is the value a plain field set in a callback? Make it a signal or use the async pipe |
| `ExpressionChangedAfterItHasBeenCheckedError` | State changes during change detection (often in a child or a getter); move it to a `computed`, an event handler, or `afterNextRender` |
| Effect loops or stale values | Find `set`/`update` inside `effect()`; replace with `computed`/`linkedSignal`; wrap incidental reads in `untracked()` |
| `NG0203` / inject outside injection context | `toSignal`, `takeUntilDestroyed`, `inject()` called in a callback; move to field initializer/constructor or pass `injector` |
| Hydration mismatch warnings | Non-deterministic render (dates, random ids, browser checks during SSR); DOM mutated outside templates |
| Duplicate HTTP requests | Cold observable subscribed twice (two async pipes); SSR transfer cache not enabled; share with `toSignal` or `shareReplay({ bufferSize: 1, refCount: true })` |
| Major upgrade | Read update.angular.dev for the from/to pair; `ng update @angular/core@<n> @angular/cli@<n>`; review schematic diffs per commit |
| Bundle budget failure | Inspect `ng build --stats-json` output; move heavy routes behind `loadComponent` or `@defer` |

## Patterns and pitfalls

- **Signal component APIs** — `input()`, `input.required()`, `output()`, `model()` for two-way binding, `viewChild()`/`contentChild()` queries. Inputs are read-only signals; local edits belong in `linkedSignal(() => this.value())`.
- **`@for` needs `track`** — track a stable id, not `$index`, for lists that reorder or mutate, otherwise DOM state (focus, inputs) attaches to the wrong row.
- **Legacy structural directives** — `*ngIf`/`*ngFor` still work but new code uses `@if`/`@for`/`@switch`; the control-flow schematic (`ng generate @angular/core:control-flow`) migrates mechanically — review output.
- **`toSignal` semantics** — subscribes immediately and lives as long as its injector; give `initialValue` or `requireSync: true` deliberately, never leave an unexpected `undefined` in templates.
- **`resource()` / `httpResource()`** — check their stability status in the installed version before relying on them in production code; they cancel stale requests when their params signal changes.
- **Zoneless libraries** — third-party code that waits on `NgZone.onStable` or patches timers may never settle without zones; test it in the real mode.
- **`@defer`** — deferred components must not also be referenced eagerly elsewhere or they ship in the main bundle; give `@placeholder`/`@loading` blocks real layout to avoid CLS.
- **SSR HTTP** — `provideHttpClient(withFetch())` on the server and the hydration transfer cache avoid a second fetch on the client; never cache per-user responses in transfer state.
- **Functional guards and resolvers** — `CanActivateFn` with `inject()`; class-based guards are legacy. Return a `UrlTree` for redirects instead of navigating inside the guard.
- **Strict templates** — keep `strictTemplates` on; `$any()` in templates is a type escape to remove, not a fix.
- **Root services leak** — `providedIn: 'root'` services never get destroyed; subscriptions there need explicit teardown or a lifetime tied to a feature injector.
- **Test runner** — newer CLI projects may use Vitest rather than Karma; read the test builder in angular.json before writing test commands.

## Workflow

1. Read app.config.ts/main.ts (providers, change detection, hydration), angular.json (builders, budgets, SSR) and the version matrix in package.json.
2. Trace the feature: route → component → service → HttpClient; note signal versus RxJS conventions in neighbours.
3. For upgrades, run the official update path one major at a time and keep schematic output in separate reviewable steps.
4. Implement with signals for template state, RxJS for event choreography and cancellation, typed forms for input.
5. Test component behavior through the DOM (TestBed or a harness), guards and forms states; include an SSR render when SSR is enabled.
6. Build for production and exercise the route in the configured mode.

## Proof

- Production build with template type checking: `ng build --configuration production`
- Unit tests once: `ng test --watch=false` (runner per angular.json)
- Lint if configured: `ng lint`
- SSR: build, then start the server script from package.json (often `npm run serve:ssr:<app>`) and `curl -fsS localhost:4000/<route>` to confirm server HTML
- Hydration: open the route in a browser with dev mode and confirm the console reports hydration without mismatch warnings

## Stop and ask

- The requested upgrade needs TypeScript outside the compiler's peer range or skips majors.
- A migration from zone.js to zoneless (or NgModules to standalone) is implied but not requested.
- Server authorization is missing behind a guard you were asked to add.
- The production build only passes by raising budgets or disabling strict templates.

## Before returning

- [ ] Angular, CLI and TypeScript versions inside the declared peer ranges; blockers reported
- [ ] Change-detection mode identified and the change works in it
- [ ] Derived state uses `computed`/`linkedSignal`; no signal writes inside effects
- [ ] Every subscription has an owner; no leaks in root services
- [ ] `@for` tracks stable ids; forms typed with pending and error states
- [ ] SSR/hydration safe for browser-only APIs when SSR is enabled
- [ ] Production build and tests pass; observed route behavior reported

## Sources

Versioned facts checked 2026-11-02; refresh authoritative sources before new installs/upgrades.
[Angular compatibility](https://angular.dev/reference/versions), [Zoneless](https://angular.dev/guide/zoneless), [Signals](https://angular.dev/guide/signals), [Update guide](https://angular.dev/update-guide), [Hydration](https://angular.dev/guide/hydration).

## Skills in scope

- typescript-strict — strict template and component type safety across signals, inputs and injection tokens.
- api-design — HttpClient DTOs, error envelopes and server validation contracts.
- testing — component signal transitions, guards and form states with deterministic harnesses.
- web-performance — bundle budgets, defer blocks and hydration cost measured in traces.
- design-system — shared visual tokens, themes and component states.
