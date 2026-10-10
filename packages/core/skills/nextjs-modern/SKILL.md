---
name: nextjs-modern
description: "Build, migrate, and debug Next.js 16 App Router applications with React 19, Server Components, Server Actions, explicit caching, and production deployment. Use when implementing Next.js routes, upgrading to the latest stable Next.js, or fixing rendering and cache behavior."
version: 1.2.1
required-capabilities: [filesystem.read, filesystem.write]
required-tools: []
optional-capabilities: [verification.run, web.research]
trigger: "implementing Next.js routes, upgrading to the latest stable Next.js, or fixing rendering and cache behavior."
metadata:
  routing-group: frontend
---

# Next.js 16 App Router

## Selection card
- Task: Next.js App Router routes, actions and caching.
- Start: Locate the affected route/component and its runtime/lockfile.
- Finish: apply the acceptance checks below; report observed results and unresolved constraints.

## Overview

Target the latest stable release: Next.js 16.4.0 with React/react-dom 19.3.0,
verified from npm on 2026-10-09. Refresh the registry before a new install or
upgrade. The installed version explains migration work; it does not make an
older major the recommended target.

## Rules

1. Inspect the lockfile, next.config, scripts, routing mode and deployment adapter.
   Verify the latest stable versions, engine and peer requirements together.
2. Keep Server Components as the default; introduce client boundaries only for
   browser APIs, hooks and interaction. Keep credentials and database clients server-side.
3. Await request APIs such as params, searchParams, cookies and headers where
   applicable. Use generated route types rather than inventing every prop shape.
4. Validate and authorize each Server Action and Route Handler at the data
   boundary. A hidden button, proxy redirect or client check is not authorization.
5. Choose caching intentionally. Separate public data from per-user data and
   include tenant/user identity where isolation requires it. A tag does nothing
   unless the read path actually attaches that tag.
6. For stale-while-revalidate, specify revalidateTag(tag, 'max'). For immediate
   read-your-own-writes inside a Server Action, choose updateTag(tag). Do not
   copy the deprecated one-argument revalidateTag form.

## Workflow

1. Establish the latest stable target and migration deltas. Next.js 16 uses
   Turbopack by default, has the proxy convention replacing middleware, and
   removes next lint. Inspect adapter/plugin support before changing bundlers.
2. Place queries near their routes and keep mutations in server-only modules.
   Fetch independent data concurrently; put Suspense around boundaries that
   really suspend. Add reachable loading, empty, error and not-found states.
3. Use Server Actions for framework-integrated UI mutations; Route Handlers for
   external HTTP contracts. Model form state explicitly with useActionState,
   pending/error feedback and validation. Avoid any in action signatures.
4. If cacheComponents is enabled, follow its use cache/cacheLife/cacheTag model
   and streaming constraints. Do not combine old route flags with that model
   without checking the current documentation.
5. Verify the production build, type generation, linter as a separate command,
   direct route load and client navigation. Test cache behavior across mutation
   and across two different users where private data is involved.
6. Match production Node/runtime support and bind container servers to
   0.0.0.0. Distinguish a working local production server from a live deployment.

## Before returning

- Latest stable target and installed starting version recorded with source URLs.
- Server/client boundary, authorization and cache policy verified.
- Mutation refresh checked through the visible UI, including error handling.
- Build and relevant route checks reported; deployment evidence scoped honestly.

## Sources

Reviewed 2026-10-09; refresh before upgrades:
[installation](https://nextjs.org/docs/app/getting-started/installation),
[version 16 migration](https://nextjs.org/docs/app/guides/upgrading/version-16),
[revalidateTag](https://nextjs.org/docs/app/api-reference/functions/revalidateTag),
[updateTag](https://nextjs.org/docs/app/api-reference/functions/updateTag).

## Skills in scope

- react-modern — component, form and hook semantics.
- typescript-strict — action states and route contracts.
- testing — cache and route behavior.
- docker-deploy — production container startup.
