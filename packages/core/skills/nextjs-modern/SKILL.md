---
name: nextjs-modern
description: "Next.js 16 App Router: Server Components, Server Actions, use cache/cacheComponents, proxy.ts, route handlers and next.config. Use when building, migrating or debugging Next.js routes, data fetching, caching and revalidation, auth checks in actions, hydration errors or production deployment. Not for React component logic outside Next.js (use react-modern) or container packaging (use docker-deploy)."
version: 1.3.1
required-capabilities: [filesystem.read, filesystem.write]
required-tools: []
optional-capabilities: [verification.run, web.research]
trigger: "Use when the change touches app/ routes, next.config.*, proxy.ts, Server Actions, caching or a Next.js upgrade."
metadata:
  routing-group: frontend
paths: ["next.config.*"]
---

# Next.js 16 App Router

## Selection card
- Task: Build, migrate or debug Next.js App Router routes, actions and caching.
- Start: Read package.json and the lockfile, next.config.*, the app/ segment being changed and any proxy.ts.
- Finish: `next build` passes, direct load and client navigation of the route work, and cache behavior is proven across a mutation (and across two users for private data).

## Overview

In the App Router every component is a Server Component until a `'use client'` boundary says otherwise, and every Server Action is a public POST endpoint — security and caching decisions follow from those two facts.
Target the latest stable release: Next.js 16.4.4 with React/react-dom 19.3.1,
verified from npm on 2026-11-02. Refresh the registry before a new install or
upgrade. The installed version explains migration work; it does not make an
older major the recommended target.

## Rules

1. Validate and authorize inside every Server Action and Route Handler; a hidden button, proxy redirect or client check is not authorization. Mark server-only modules with `import 'server-only'`.
2. Keep Server Components the default; add client boundaries only for state, effects, browser APIs and event handlers, and pass serializable props across them.
3. Await request APIs: `params`, `searchParams`, `cookies()`, `headers()` and `draftMode()` are asynchronous. Use generated route types (`next typegen`, `PageProps<'/route'>`) instead of hand-written prop shapes.
4. Choose caching deliberately. Separate public data from per-user data; a tag does nothing unless the read path attaches it.
5. Stale-while-revalidate: `revalidateTag(tag, 'max')`. Read-your-own-writes inside a Server Action: `updateTag(tag)`. Do not copy the deprecated one-argument `revalidateTag` form.
6. With `cacheComponents` enabled, uncached request-time data must sit inside a Suspense boundary; follow the `'use cache'`/`cacheLife`/`cacheTag` model and drop legacy segment flags such as `dynamic = 'force-dynamic'`.
7. `redirect()`, `notFound()` and related helpers throw; call them outside `try/catch` or rethrow.
8. Production truth comes from `next build` plus `next start` (or the deployment adapter), not `next dev`.

## First moves by situation

| Situation | First moves |
|---|---|
| Upgrade to 16 | Read the version-16 guide; run `npx @next/codemod@canary upgrade latest`; then fix async request APIs, `middleware.ts` to `proxy.ts`, lint script, image config |
| Stale data after a mutation | Confirm the read is tagged; the action calls `updateTag` or `revalidateTag(tag, 'max')`; check the client router with `router.refresh()` or the action's refresh |
| One user sees another's data | Look for `'use cache'` or fetch caching around per-user reads; cookies inside a cached scope; module-level caches |
| Build error about uncached data outside Suspense | With `cacheComponents`, wrap the request-time part in `<Suspense>` or cache it explicitly |
| Hydration error | Non-deterministic render (dates, random, locale), invalid HTML nesting, browser extensions; fix the source rather than `suppressHydrationWarning` |
| Action works locally, fails behind proxy | Check the Server Actions allowed-origins and body-size settings in next.config and the forwarded host headers |
| Slow route | Find sequential awaits (waterfalls); start independent fetches together; move slow parts behind Suspense to stream |
| Image fails in production | `remotePatterns` for remote hosts, `localPatterns` for local images with query strings, configured `qualities` |

## Patterns and pitfalls

- **Proxy, not middleware** — Next.js 16 renames the convention to `proxy.ts` (exported `proxy` function); keep it thin: redirects, rewrites and header work, never the only auth check.
- **Turbopack by default** — dev and build use Turbopack; custom webpack config is ignored unless the build opts out with `--webpack`. Check plugins before migrating.
- **`next lint` removed** — run ESLint or Biome directly from package.json scripts.
- **fetch is not cached by default** — since Next.js 15; caching is opt-in through `'use cache'` or fetch options. Old code assuming default caching silently becomes dynamic.
- **Action closures** — values captured by inline actions are encrypted, but never close over secrets; pass ids and re-read on the server.
- **`NEXT_PUBLIC_` is build-time** — inlined into client bundles at build; changing it at runtime does nothing for the browser.
- **`after()`** — schedule logging or analytics after the response; do not place correctness-critical writes there.
- **Parallel routes** — every slot needs `default.tsx`, or hard navigation renders 404.
- **`loading.tsx`** — wraps the whole segment in Suspense; finer boundaries stream faster and keep layout visible.
- **Form state** — `useActionState` returns `[state, formAction, isPending]`; return typed error objects from the action instead of throwing for validation failures.
- **Standalone output** — `output: 'standalone'` needs `public/` and `.next/static` copied next to `server.js`, and the server must bind `0.0.0.0` in containers.
- **Route Handlers** — GET handlers are dynamic by default; they are the right place for webhooks and external HTTP contracts, Server Actions for UI mutations.

## Workflow

1. Establish the latest stable target and the migration delta from the installed version; inspect adapter and plugin support before changing bundlers.
2. Place queries near their routes and mutations in server-only modules; fetch independent data concurrently and add reachable loading, empty, error and not-found states.
3. Implement actions with validation, authorization, typed result state and the right tag invalidation.
4. If `cacheComponents` is enabled, mark cacheable work with `'use cache'`, give it `cacheLife` and `cacheTag`, and keep request-time reads inside Suspense.
5. Verify build, type generation, lint (separate command), direct route load and client navigation; test cache behavior across a mutation and across two users.
6. Match production Node/runtime support; distinguish a working local production server from a live deployment.

## Proof

- Types: `npx next typegen` then `npx tsc --noEmit`
- Lint: the project's ESLint or Biome script (not `next lint`)
- Build: `npx next build` — read the route table for static versus dynamic markers
- Run: `npx next start -p 3000`, then `curl -fsS localhost:3000/<route>` and a client-side navigation in a browser
- Cache proof: load as user A, mutate, reload; then load as user B with a different cookie and confirm no cross-user data

## Stop and ask

- Enabling `cacheComponents`, switching bundlers, or changing deployment output is implied but not requested.
- Per-user data would enter a shared cache, or an action lacks a server-side authorization source.
- The upgrade requires a plugin or adapter without a compatible release.

## Before returning

- [ ] Next.js and React versions, next.config.*, proxy.ts and bundler settings verified against the lockfile
- [ ] Request APIs awaited; generated route types used
- [ ] Client boundaries minimal; secrets and database clients only in server-only modules
- [ ] Every Server Action and Route Handler validates input and authorizes the user/tenant on the server
- [ ] Cache tags attached on reads; `updateTag` versus `revalidateTag(tag, 'max')` chosen deliberately; two-user isolation checked
- [ ] `next build` passes and the route was exercised on `next start`, with observed results reported

## Sources

Reviewed 2026-11-02; refresh before upgrades:
[installation](https://nextjs.org/docs/app/getting-started/installation),
[version 16 migration](https://nextjs.org/docs/app/guides/upgrading/version-16),
[revalidateTag](https://nextjs.org/docs/app/api-reference/functions/revalidateTag),
[updateTag](https://nextjs.org/docs/app/api-reference/functions/updateTag),
[cacheComponents](https://nextjs.org/docs/app/api-reference/config/next-config-js/cacheComponents).

## Skills in scope

- react-modern — React 19 `useActionState`, `useOptimistic`, Server/Client Component composition, and Suspense boundaries.
- typescript-strict — generated Next.js route types (`PageProps`, `LayoutProps`, `next typegen`) and strict action state contracts.
- authentication-sessions — sessions and auth checks used by actions and route handlers.
- testing — verifying App Router Server Actions, Route Handlers, and per-user cache isolation.
- docker-deploy — standalone output (`output: 'standalone'`), `HOSTNAME=0.0.0.0` binding, and multi-stage container builds.
