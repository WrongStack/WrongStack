---
name: web-performance
version: 1.1.1
description: "Core Web Vitals (LCP, INP, CLS), slow pages, bundle size, long tasks and jank, measured with traces, Lighthouse and field data. Use when diagnosing a slow route, poor vitals, bundle growth, main-thread blocking, layout shift or animation jank; compare matched before/after runs and preserve functionality. Not for backend latency without a browser symptom (use observability) or animation design itself (use motion-design)."
trigger: "Use when a page is slow, vitals regress, a bundle grows, or interactions and scrolling feel janky."
required-capabilities: [filesystem.read, filesystem.write]
required-tools: []
optional-capabilities: [verification.run, web.research]
metadata:
  routing-group: frontend
---

# Web Performance

## Selection card
- Task: Measure and improve browser loading, interaction and visual stability.
- Start: Build for production and record a baseline trace of the slow journey with device, network and cache conditions written down.
- Finish: the same measurement repeated after the change shows the bottleneck moved, with sample counts, conditions and preserved behavior reported.

## Overview

Optimize the measured bottleneck, never the score: find which sub-part of LCP, which phase of INP or which element of CLS is responsible, change that, and measure again under identical conditions.
Current Core Web Vitals are LCP, INP and CLS; good thresholds are at most 2.5 seconds, 200 milliseconds and 0.1 respectively
at the 75th percentile. Field evidence and local lab runs answer different questions.

## Rules

1. Measure production builds only, and write down route, commit, device or CPU throttle, network profile, cache state and data set. Dev-server numbers are not performance.
2. Attribute before fixing: LCP splits into TTFB, resource load delay, resource load duration and render delay; INP splits into input delay, processing time and presentation delay. Fix the largest part.
3. Field data (CrUX, RUM) says whether users are affected; lab traces say why. Lighthouse alone cannot measure INP.
4. Compare matched runs, at least five per side, and report median and spread; never a best run or an invented percentage.
5. Every optimization keeps behavior, accessibility and SEO intact; re-run the affected tests.
6. Budgets come from an observed baseline and target devices, not universal rules.
7. Keep analytics labels bounded and sensitive data out of performance telemetry.

## First moves by situation

| Situation | First moves |
|---|---|
| Poor LCP | Identify the LCP element in a trace; is it in the initial HTML? Remove `loading="lazy"` from it, add `fetchpriority="high"`, preload its font or image, check TTFB |
| High TTFB | Server-Timing header, cache headers, CDN hit ratio, redirects chain; hand off to observability for server spans |
| Poor INP | Record the slow interaction in the Performance panel; read Long Animation Frames attribution; split the handler, yield to the main thread, defer non-urgent work |
| CLS | Enable layout-shift regions; reserve size for images, ads, embeds and banners; use metric-matched font fallbacks |
| Bundle growth | Compare bundle analyzer output between commits; look for duplicated packages, whole-library imports, client boundaries pulling server code |
| Scroll or animation jank | Trace frames; look for layout thrash (read then write in loops), non-composited animations, heavy paint areas |
| Slow back/forward navigation | Check bfcache eligibility in DevTools Application panel: `unload` handlers, open connections and `Cache-Control: no-store` block it |
| Regression after a dependency bump | Bisect with the same scripted measurement; diff the bundle |

## Patterns and pitfalls

- **LCP discoverability** — an LCP image set by CSS background, client-side rendering or a lazy hydration boundary cannot start loading early; put it in the HTML with `srcset`/`sizes`.
- **Fonts** — preload only the one or two critical files; set the font-display descriptor deliberately and `size-adjust`/`ascent-override` fallbacks to stop swap-induced shifts.
- **Yielding** — break long tasks with `scheduler.yield()` where supported and a `setTimeout` fallback; do the visible update first, then defer analytics and persistence.
- **Layout thrash** — interleaved reads (`offsetHeight`, `getBoundingClientRect`) and writes force synchronous layout; batch reads, then writes, or move them to `requestAnimationFrame`.
- **Compositor-only animation** — animate `transform` and `opacity`; animating `top`, `width` or box-shadow repaints each frame.
- **`content-visibility: auto`** — skips rendering of off-screen sections; pair it with `contain-intrinsic-size` or it causes scroll jumps.
- **Third parties** — tag managers, chat widgets and A/B scripts dominate INP and TBT; load them after interaction or behind facades, and measure with them blocked to size their cost.
- **Images** — AVIF/WebP with correct `sizes`; serve dimensions matching the rendered size; `decoding="async"` for non-critical images.
- **Speculation Rules** — prefetch or prerender likely next pages declaratively in supporting browsers; never prerender URLs with side effects.
- **Hydration cost** — large client trees delay INP on load; move static parts to server rendering and hydrate only interactive islands.
- **Caching** — immutable hashed assets with long `max-age`; HTML short-lived or revalidated; a misconfigured CDN shows up as TTFB, not as JavaScript.

## Workflow

1. Reproduce on a production build with a scripted journey (cold and warm cache) and capture a trace plus network waterfall; pull field data if available.
2. Attribute the worst metric to its sub-part with file, resource or call-stack evidence.
3. Make one narrow change aimed at that sub-part.
4. Re-test behavior, responsiveness and accessibility.
5. Re-measure with the same script and conditions; report samples, median, spread and trade-offs; run the affected build and tests.

## Proof

- Lab audit: `npx lighthouse <url> --preset=desktop --output=json --output-path=./lh.json` (and the mobile default), repeated runs
- Traces: Chrome DevTools Performance panel with CPU throttling, saved as evidence
- Field or RUM: the `web-vitals` library attribution build reporting LCP, INP and CLS with their attribution fields
- Bundle: the bundler's analyzer (`npx vite-bundle-visualizer`, `@next/bundle-analyzer`, `source-map-explorer dist/*.js`)
- Scripted runs: Playwright with network and CPU throttling for repeatable before/after numbers

## Stop and ask

- The fix needs removing a product feature, third-party script or analytics vendor.
- Only a development-server or single-run measurement is available for a consequential claim.
- The change alters SEO-relevant rendering (server versus client) for important pages.

## Acceptance checks

- [ ] Production build measured under matched cold/warm network and CPU conditions before and after
- [ ] Bottleneck attributed to a concrete sub-part: waterfall resource, long task, script or shifting element
- [ ] LCP element discoverable in initial HTML and not lazy-loaded
- [ ] At least five samples per side with median and spread reported
- [ ] Interaction, accessibility and tests still pass after the change

## Sources

[Web Vitals](https://web.dev/articles/vitals), reviewed 2026-11-02.
[Optimize LCP](https://web.dev/articles/optimize-lcp), [Optimize INP](https://web.dev/articles/optimize-inp), [Long Animation Frames](https://developer.chrome.com/docs/web-platform/long-animation-frames).
Refresh thresholds and measurement tooling before consequential claims.

## Skills in scope

- observability — Real User Monitoring (RUM) Core Web Vitals collection and attribution telemetry.
- nextjs-modern — SSR/streaming boundaries, image optimization, and server cache headers.
- web-platform-baseline — browser support for APIs such as speculation rules and scheduler.yield.
- motion-design — compositor-safe animations and main-thread frame budget discipline.
- threejs-3d — WebGL/WebGPU asset compression, draw-call batching, and canvas initialization latency.
