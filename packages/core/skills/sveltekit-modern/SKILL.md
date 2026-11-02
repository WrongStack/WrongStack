---
name: sveltekit-modern
description: "Svelte 5 runes and SvelteKit: .svelte components, +page/+layout loads, form actions, hooks, $env, adapters and svelte.config. Use when building or fixing Svelte components or SvelteKit routes, load/action data flow, SSR, auth in hooks or an upgrade; follow the installed runtime and migration contract. Not for generic TypeScript typing (use typescript-strict) or HTTP contract design (use api-design)."
trigger: "Use when the change touches *.svelte or .svelte.ts files, svelte.config.*, +page/+layout/+server files, hooks.server.ts or a SvelteKit adapter."
version: 1.1.1
required-capabilities: [filesystem.read]
required-tools: []
optional-capabilities: [filesystem.write, execution.shell, verification.run, web.research]
metadata:
  routing-group: frontend
  domain: "web"
paths: ["*.svelte", "svelte.config.*"]
---

# SvelteKit Modern

## Selection card
- Task: Build or repair Svelte 5 components and SvelteKit loads, actions, hooks and adapters.
- Start: Read svelte.config.*, the adapter, src/hooks.server.ts, src/app.d.ts and the route's +page/+layout files.
- Finish: svelte-check and the production build pass, and the route works through the real adapter with and without JavaScript where forms are involved.

## Overview

SvelteKit splits every route into code that runs only on the server, code that runs on both, and component code — almost every SvelteKit bug is code running on the wrong side of that line or state shared across requests.
Checked 2026-11-02: Svelte 5.57.3 and SvelteKit 3.1.1. SvelteKit 3.1.1 declares peer typescript ^6.0.0 while latest TypeScript is 7.0.2; verify adapter/runtime and peer requirements before upgrading.
Svelte 5 runes make reactivity explicit; legacy `export let`, `$:` and stores still run but should not be mixed into the same component.

## Rules

1. Secrets and database access live in `+page.server.ts`, `+server.ts`, hooks and `$lib/server/*`; universal `+page.ts` loads run in the browser too. Private env comes from `$env/static/private` or `$env/dynamic/private` only.
2. No per-request data in module scope on the server: users, tokens and transactions travel through `event.locals` (typed in `src/app.d.ts`), load data or component context.
3. Derive with `$derived`/`$derived.by`; `$effect` is for side effects with a returned cleanup, never for copying one state into another.
4. Mutations go through form actions or `+server.ts` handlers that validate input, authorize the user and return `fail(status, data)` for recoverable errors.
5. `redirect()` and `error()` throw; never wrap code that calls them in a `try/catch` that swallows the throw — rethrow with `isRedirect`/`isHttpError` checks.
6. Use the fetch function passed to `load`, not the global one: it forwards cookies, works during SSR and avoids a second request on hydration.
7. Prove on the adapter's production build; `vite dev` hides adapter, origin and body-size behavior.

## First moves by situation

| Situation | First moves |
|---|---|
| Form action fails with a cross-site POST error behind a proxy | adapter-node needs `ORIGIN` (or `PROTOCOL_HEADER`/`HOST_HEADER`) set to the public URL |
| Data visible to the wrong user | Search server modules for top-level `let`/`$state`/caches holding user data; move to `locals` or per-request objects |
| Load runs twice or leaks a secret | Check whether it is `+page.ts` (universal) versus `+page.server.ts`; move privileged work server-side |
| Effect loop or stale UI | Replace effect-based syncing with `$derived`; read incidental values through `untrack` |
| Page not updating after a mutation | Action success triggers `invalidateAll`; custom fetches need `depends('app:key')` plus `invalidate('app:key')` |
| Migrating Svelte 4 components | `npx sv migrate svelte-5`, then review: slots to snippets, `on:click` to `onclick`, stores to runes where it helps |
| Upgrading SvelteKit major | Read the official migration guide for the target major; check adapter and Vite peer ranges first |
| Large upload rejected | Check `BODY_SIZE_LIMIT` (adapter-node) or the platform limit before touching code |

## Patterns and pitfalls

- **Runes outside components** — shared reactive logic lives in `.svelte.js`/`.svelte.ts` modules; exporting a reassigned `$state` primitive breaks reactivity, so export an object or getter functions.
- **`$state.raw` and `$state.snapshot`** — use raw state for large immutable data you replace wholesale; snapshot before passing state to `structuredClone`, `postMessage` or third-party libraries.
- **Props** — `let { value = $bindable(), ...rest } = $props()`; mutating a non-bindable prop is a warning sign of shared ownership.
- **Snippets replace slots** — `{#snippet row(item)}` with `{@render row(item)}`; event attributes (`onclick`) replace `on:` directives in runes mode.
- **`$app/state`** — prefer `page` from `$app/state` over the `$app/stores` store API in new code.
- **Serializable load data** — loads serialize with devalue (Date, Map, Set, BigInt are fine); class instances and functions are not, and private fields must be dropped before returning.
- **Streaming** — return un-awaited promises from a server load to stream slow data; give the UI a pending state and handle rejection in `{#await}`.
- **Cookies** — `cookies.set` needs an explicit `path`; set `httpOnly`, `secure` and `sameSite` deliberately for session cookies.
- **Progressive enhancement** — `use:enhance` keeps forms working without JavaScript; custom `enhance` callbacks must still call `update()` or apply the result.
- **Page options** — `prerender`, `ssr`, `csr`, `trailingSlash` cascade from layouts; a prerendered page cannot read cookies or call actions.
- **`$lib/server` guard** — importing it from client code fails the build; that error is protection, not something to work around.
- **Remote functions** — newer SvelteKit versions add `query`/`form`/`command` from `$app/server`; check whether they are stable or behind an experimental flag in the installed version before adopting them.

## Workflow

1. Read config, adapter, hooks and `app.d.ts`; list which files of the route run server-only, universally and in the browser.
2. Model server data in `+page.server.ts` or `+layout.server.ts`; type with the generated `./$types` (`PageServerLoad`, `Actions`).
3. Implement mutations as actions with validation, authorization and `fail()` feedback; wire `use:enhance`.
4. Build components with runes, deriving instead of syncing, with effect cleanup for timers and listeners.
5. Test the server pieces (load, action, handle) directly and the page through a browser, including a second user for private data.
6. Build for production and run the adapter output.

## Proof

- Types and diagnostics: `npx svelte-check --tsconfig ./tsconfig.json` (or the project's `check` script)
- Unit and component tests: the project's runner, e.g. `npx vitest run`
- Production build: `npx vite build`
- Adapter output: `npx vite preview`, or for adapter-node `ORIGIN=http://localhost:3000 node build`, then `curl -fsS localhost:3000/<route>`
- Form without JavaScript: submit with `curl -fsS -X POST -H "Origin: http://localhost:3000" -d "field=value" localhost:3000/<route>?/<action>`

## Stop and ask

- The fix needs a different adapter or deployment target.
- Private data would move into a universal load or client bundle.
- An upgrade forces TypeScript, Vite or Node outside the declared peer ranges.

## Before returning

- [ ] Versions, adapter and peer ranges (TypeScript, Vite, Node) verified; blockers reported
- [ ] Server-only work and private env stay in server files; nothing private in universal loads
- [ ] No per-request state in server module scope
- [ ] Runes derive rather than sync; effects return cleanup
- [ ] Actions validate, authorize and return `fail()`; forms work with and without JavaScript
- [ ] svelte-check, tests and the adapter production build pass; observed behavior reported

## Sources

Versioned facts checked 2026-11-02; refresh authoritative sources before new installs/upgrades.
[Svelte docs](https://svelte.dev/docs/svelte/overview), [SvelteKit docs](https://svelte.dev/docs/kit/introduction), [Form actions](https://svelte.dev/docs/kit/form-actions), [adapter-node](https://svelte.dev/docs/kit/adapter-node).

## Skills in scope

- api-design — `+server.ts` endpoints, action payloads and error envelopes.
- typescript-strict — generated `./$types` route contracts and strict rune typing.
- authentication-sessions — session cookies and auth in hooks.
- design-system — shared visual tokens, themes and component states.
- testing — Svelte 5 components, load/action handlers and multi-user SSR isolation.
