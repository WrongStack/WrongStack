---
name: astro-modern
description: "Astro sites: .astro pages, islands and client: directives, content collections, Actions, server islands, adapters and astro.config. Use when building or fixing Astro routes, content schemas, on-demand rendering, view transitions or an Astro upgrade; hydrate only what is interactive. Not for the UI framework inside an island (use react-modern, vue-nuxt or sveltekit-modern) or general page speed work (use web-performance)."
trigger: "Use when the change touches *.astro files, astro.config.*, src/content.config.ts, src/actions or an Astro adapter."
version: 1.1.2
required-capabilities: [filesystem.read]
required-tools: []
optional-capabilities: [filesystem.write, execution.shell, verification.run, web.research]
metadata:
  routing-group: frontend
  domain: "web"
paths: ["*.astro", "astro.config.*"]
---

# Astro Modern

## Selection card
- Task: Build or repair Astro pages, islands, content collections, Actions and deployment output.
- Start: Read astro.config.*, the adapter and integrations, src/content.config.ts and the affected route.
- Finish: `astro check` and the production build pass, and the route behaves correctly in the deployed rendering mode.

## Overview

Astro ships HTML first: every byte of client JavaScript is an explicit island decision, and each route is prerendered or rendered on demand — confusing the two causes most Astro bugs.
Checked 2026-11-02: Astro 7.4.5. Verify the current runtime/adapter and UI integration versions before install or migration.
Request data (cookies, headers, sessions) exists only on on-demand routes; on prerendered routes it is build-time data.

## Rules

1. Choose per route: prerendered for content that is the same for everyone, on-demand (`export const prerender = false` with an adapter) for request-specific data. Never read cookies or auth on a prerendered route.
2. Hydrate the smallest interactive component, with the cheapest directive that works: `client:visible` or `client:idle` before `client:load`; `client:only` only for browser-only widgets, with reserved layout space.
3. Island props must be serializable; functions and class instances do not cross the server/client boundary.
4. Content shape is defined once in `src/content.config.ts` schemas; pages consume typed entries, never ad-hoc frontmatter guesses.
5. Actions and endpoints validate input with schemas and authorize on the server; a form posting to an Action must work without client JavaScript when `accept: 'form'` is used.
6. Secrets stay server-only (typed env schema or non-`PUBLIC_` variables); anything prefixed `PUBLIC_` ships to the browser.
7. Prove behavior on the built output and the real adapter; `astro dev` routing and headers differ from static hosts and serverless runtimes.

## First moves by situation

| Situation | First moves |
|---|---|
| Page needs a little interactivity | Extract only the interactive part into a framework component; pick a lazy client directive; keep layout in `.astro` |
| Logged-in or per-user data | Mark the route on-demand or use a server island (`server:defer`) inside a static page; confirm an adapter is configured |
| Content collection type errors | Run `npx astro sync`; compare schema to entries; check the glob() or file() loader base paths |
| Script stops working after navigation | View transitions (`<ClientRouter />`) keep scripts from re-running; re-init on `astro:page-load` and clean up on `astro:before-swap` |
| Broken assets or links on deploy | Check `base`, `trailingSlash`, `site`; prefix internal links with `import.meta.env.BASE_URL` |
| Remote image fails to optimize | Allow the host in `image.domains`/`image.remotePatterns`; provide width and height |
| Upgrade to a new Astro major | Read the official upgrade guide; `npx @astrojs/upgrade`; fix removed APIs before features |
| Slow page | Count islands and their directives; measure shipped JS in the build output before touching code |

## Patterns and pitfalls

- **Script processing** — `<script>` in `.astro` is bundled, deduplicated and runs once per page as a module; `is:inline` opts out and is then neither bundled nor deduplicated.
- **Scoped styles** — styles are component-scoped; target child component internals with `:global()` sparingly, or pass a class prop.
- **Removed and replaced APIs** — `Astro.glob` gave way to content collections or `import.meta.glob`; `<ViewTransitions />` became `<ClientRouter />`; collection entries render with `render(entry)` from `astro:content`. Check the upgrade guide of the installed major for the current list.
- **`getStaticPaths`** — required for dynamic routes that are prerendered; params must be strings and every path must be enumerable at build time.
- **Middleware timing** — middleware runs per request on on-demand routes but only once at build time for prerendered ones; auth in middleware does not protect prerendered HTML.
- **`client:only` cost** — renders nothing on the server: no SEO content and a layout jump unless the slot has fixed dimensions.
- **Framework duplication** — mixing React, Vue and Svelte islands ships each runtime; one framework per site unless there is a reason.
- **Server islands** — personalize a fragment (cart count, avatar) of a cached static page; props are encrypted into the URL, so keep them small.
- **Images** — `<Image />`/`<Picture />` from `astro:assets` optimize local imports; files in `public/` are copied as-is and never optimized.
- **Actions errors** — throw `ActionError` with a code; on the client check `isInputError(error)` to show field messages rather than a generic failure.
- **Sitemaps and canonical URLs** — require `site` in config; missing it silently produces relative or missing URLs.

## Workflow

1. Read config, adapter, integrations and the route's rendering mode; list islands on the page.
2. Model content in the collection schema first, then the page that reads it.
3. Implement markup in `.astro`; extract only interactive pieces as islands with a deliberate directive.
4. Add Actions or endpoints with schema validation and server authorization where data changes.
5. Build, then exercise the built site through the adapter's preview or the real host.

## Proof

- Types and diagnostics: `npx astro check`
- Generated types after schema changes: `npx astro sync`
- Production build: `npx astro build` (read the route list: prerendered versus on-demand)
- Built output: `npx astro preview` where the adapter supports it, then `curl -fsSI localhost:4321/<route>` for status and headers
- Shipped JavaScript: inspect `dist/_astro/` sizes before and after the change

## Stop and ask

- The change requires adding or switching an adapter or moving the whole site to on-demand rendering.
- Protected data would be exposed on a prerendered route.
- An upgrade skips majors or the adapter has no release for the target Astro version.

## Before returning

- [ ] Each changed route's rendering mode matches its data (static versus on-demand)
- [ ] Only interactive components hydrate, with the lightest working directive and serializable props
- [ ] Collection schemas validate content; `astro check` passes
- [ ] Actions and endpoints validate input and authorize on the server
- [ ] No secret readable through `PUBLIC_` variables or client bundles
- [ ] Production build verified through the real adapter or host, with observed results reported

## Sources

Versioned facts checked 2026-11-02; refresh authoritative sources before new installs/upgrades.
[Astro docs](https://docs.astro.build/), [On-demand rendering](https://docs.astro.build/en/guides/on-demand-rendering/), [Islands](https://docs.astro.build/en/concepts/islands/), [Content collections](https://docs.astro.build/en/guides/content-collections/), [Actions](https://docs.astro.build/en/guides/actions/).

## Skills in scope

- design-craft — visual direction, typography and responsive rhythm for Astro pages.
- web-performance — measure shipped JavaScript, LCP and CLS on the built site.
- accessibility — semantic markup and keyboard behavior for islands and forms.
- react-modern — React components used as islands.
- ci-cd — build and deploy pipelines for the chosen adapter.
