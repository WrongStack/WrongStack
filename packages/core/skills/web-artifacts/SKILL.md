---
name: web-artifacts
description: "Single-file HTML artifacts: mini-tools, calculators, dashboards, simulators, prototypes; React or vanilla JS, Tailwind, Lucide. Use when producing a standalone page or embed that runs without a backend (opened from a file, a sandboxed iframe or static hosting) with client-side state, charts and exports. Not for features inside an existing app codebase (use react-modern or nextjs-modern) or browser test automation (use webapp-testing)."
version: 1.2.2
required-capabilities: [filesystem.read, filesystem.write]
required-tools: []
optional-capabilities: [verification.run, browser.interact, web.research]
trigger: "Use when a self-contained interactive HTML page, mini-tool or prototype must run with no backend or build server."
metadata:
  routing-group: frontend
---

# Web Artifacts — WrongStack

## Selection card
- Task: Build a standalone interactive web artifact that runs from one HTML file (or a micro-bundle) with no backend.
- Start: Fix the delivery context — `file://`, sandboxed iframe or static host — because it decides storage, modules, CDN access and downloads; then write the state model (inputs, derived values, persisted keys).
- Finish: the file opens in its delivery context with zero console errors, every control changes the output, promised state survives reload, export works, and it renders at 390 px and desktop widths.

## Overview

A web artifact is an app whose only server is the browser: it loads from the file or pinned URLs, survives the sandbox it runs in, and keeps state small enough to serialize into the URL.

## Rules

1. Pin an exact version on every CDN URL — never `@latest` — and inline small dependencies; an unpinned URL breaks the artifact the day a major version ships.
2. Without a build step there is no JSX: use the htm library's tagged templates with React, or plain DOM; in-browser Babel recompiles on every load and suits throwaway demos only.
3. The Tailwind browser build compiles styles at runtime and is meant for prototyping; inline compiled or hand-written CSS for anything shared.
4. Wrap every `localStorage`/`sessionStorage` access in try/catch with an in-memory fallback: sandboxed iframes without `allow-same-origin` and some privacy modes throw.
5. Shareable state lives in the URL (`URLSearchParams` plus `history.replaceState`), preferences in storage, everything else is derived.
6. Keep computation in pure functions (state in, values out) separate from rendering so it can be tested from Node and Playwright.
7. Labelled inputs, `<output>` for results, keyboard-operable custom widgets, visible focus, `prefers-color-scheme` and reduced motion.
8. Never embed API keys or secrets: anyone who opens the file can read them.

## First moves by situation

| Artifact | First moves |
|---|---|
| Calculator or converter | Form inputs → pure compute → `<output>`; parse with `valueAsNumber` and handle `NaN`; money in integer minor units, shown with `Intl.NumberFormat` |
| Chart or visualization | Inline SVG with a `viewBox` for up to a few thousand marks, canvas beyond; label axes and give a text summary |
| Simulator or animation | `requestAnimationFrame` loop driven by elapsed time, a pause control, reduced-motion fallback |
| Data import | `<input type="file">` and `await file.text()`; parse in the page; nothing uploaded |
| Export | `Blob` + `URL.createObjectURL` + an `<a download>` click, then revoke the URL; `canvas.toBlob` for PNG |
| Needs npm packages | ESM CDN with a pinned version through an import map, or Vite with `vite-plugin-singlefile` to inline everything into one HTML file |
| Runs inside a sandbox | Feature-detect storage, clipboard, downloads and popups; degrade with a visible message, not an exception |

## Patterns and pitfalls

- **Modules over file://** — an inline `<script type="module">` runs, but importing a sibling `.js` file from `file://` is blocked in Chromium (origin `null`); inline it or serve over http.
- **Import maps** — the `<script type="importmap">` must precede every module script, and `react-dom` must resolve to the same React copy as your code; two copies produce "invalid hook call". Check the CDN's options for externalizing peer dependencies.
- **Blurry canvas** — set `canvas.width = cssWidth * devicePixelRatio`, scale the context by the same factor, and redo it from a `ResizeObserver`.
- **History spam** — `pushState` on every keystroke floods the back button; replace state while typing.
- **CSV injection** — exported cells starting with `=`, `+`, `-` or `@` run as formulas in spreadsheet apps; prefix user-supplied values with `'` and quote fields containing commas, quotes or newlines.
- **Clipboard** — `navigator.clipboard.writeText` needs a secure context and a user gesture; inside an iframe it also needs `allow="clipboard-write"`.
- **Imported data into the DOM** — set `textContent`; never feed file or URL data to `innerHTML`.
- **Offline fonts** — a Google Fonts link fails offline and under strict CSP; use a system stack or an inlined WOFF2 subset and accept the size.
- **Template look** — avoid centered floating cards with one radius everywhere, purple-to-blue mesh gradients, glowing borders and Inter-by-default; pick a personality (industrial terminal, editorial, Scandinavian utility, dense dashboard) and use split panes or a sticky control rail.

## Tech defaults

- **Format**: Single-file HTML embedding React 19.3.1 (via ESM import map or bundled build) or modern vanilla web components (checked 2026-11-02).
- **Styling**: Tailwind CSS 4.3.3 (`@tailwindcss/browser` CDN or pre-compiled scoped styles).
- **Icons**: Lucide Icons (checked 2026-11-02: lucide-react 1.66.0 or standalone SVG embeds).
- **No backend**: computation, charting (SVG/Canvas) and exports (CSV, JSON, PNG) run client-side.

## Template blueprint

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Loan Payment Calculator</title>
  <!-- Prototype only: replace with compiled CSS before sharing. Pin the version you verified. -->
  <script src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4.3.3"></script>
</head>
<body class="bg-zinc-950 text-zinc-100 min-h-dvh font-mono">
  <main class="grid gap-6 p-6 lg:grid-cols-[20rem_1fr]">
    <form id="inputs" class="flex flex-col gap-4 border border-zinc-800 p-5">
      <label class="flex flex-col gap-1">Principal
        <input id="principal" name="principal" type="number" inputmode="decimal" min="0" value="250000" class="bg-zinc-900 p-2">
      </label>
    </form>
    <section aria-live="polite" class="border border-zinc-800 p-5">
      Monthly payment: <output id="result" form="inputs" for="principal">—</output>
    </section>
  </main>
  <script type="module">
    const store = (() => { try { localStorage.setItem('_', '1'); return localStorage; }
      catch { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v) }; } })();
    const form = document.getElementById('inputs');
    const compute = ({ principal }) => principal / 360; // pure: replace with the real model
    function render() {
      const principal = form.elements.principal.valueAsNumber;
      document.getElementById('result').textContent = Number.isFinite(principal)
        ? new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(compute({ principal })) : '—';
      const params = new URLSearchParams({ principal: String(principal) });
      history.replaceState(null, '', `?${params}`);
      store.setItem('last', params.toString());
    }
    form.addEventListener('input', render);
    render();
  </script>
</body>
</html>
```

## Proof

- Delivery context: open the file directly and through `npx serve .` (or `python -m http.server 8000`); the console stays empty in both.
- Playwright smoke: `await page.goto('file:///abs/path/index.html')`, fail on any `pageerror` or console error, fill each input, and assert the `<output>` text changes.
- Sandbox: load it in `<iframe sandbox="allow-scripts" src="index.html">` and confirm the storage fallback keeps the page working.
- Markup: `npx html-validate index.html`.
- Size and dependencies: `wc -c index.html` and `rg -n "https://" index.html` — every URL pinned, none needed when the artifact is promised offline.

## Stop and ask

- The artifact would need a backend, an API key or the user's credentials.
- User data would leave the page (analytics, remote APIs, third-party embeds).
- An offline or air-gapped requirement conflicts with CDN dependencies.
- A bundled library's licence is unclear for redistribution.

## Acceptance checks

- [ ] Complete application runs standalone from a single HTML file or micro-bundle without backend or CORS failures.
- [ ] Zero AI-slop visual tropes; layout, surface hierarchy, and typography adhere to a deliberate design personality.
- [ ] All interactive controls (sliders, forms, keyboard shortcuts, buttons) trigger immediate, deterministic state updates.
- [ ] Client-side persistence (`localStorage` / URL state) and data export mechanisms function offline.
- [ ] Every external URL pinned to an exact version; no secrets in the file
- [ ] Storage access survives a sandboxed iframe through the fallback
- [ ] Rendered at 390 px and desktop width with labelled inputs and visible focus

## Skills in scope

- react-modern — React 19 state derivation, actions, and effect hygiene
- design-system — semantic CSS tokens and anti-slop component styling
- webapp-testing — headless Playwright verification of interactive user flows
- theme-factory — a measured palette and font pairing for the artifact's personality
- accessibility — labelled controls, keyboard operation and contrast in custom widgets
