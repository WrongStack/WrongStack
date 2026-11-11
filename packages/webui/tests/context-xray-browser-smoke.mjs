/**
 * Rendered acceptance gate for the Context X-Ray (item-by-item context-window
 * occupancy + the long-context price cliff).
 *
 * Why this exists as a permanent smoke: `ContextXRay.tsx` is the only surface in
 * the app that paints the four semantic status hues (`--info/--warning/
 * --success/--destructive`) as fills AND renders 10px/11px captions inside a
 * dialog, and the project's AA rule is measured, not asserted — the same rule
 * `mailbox-compose-browser-smoke.mjs` enforces. That harness is already 979
 * lines, so this surface gets its own focused smoke instead of being appended to
 * it.
 *
 * Mounts the REAL `ContextBreakdownModal` (Radix dialog + real token CSS + real
 * i18n activity chunk) under a Vite dev server with a stubbed socket that answers
 * `context.debug`, then per theme/viewport:
 *   1. contrast: every text node inside the X-Ray at 4.5:1 (3:1 large text),
 *      alpha-blended exactly like the compose smoke — `text-foreground/80` and
 *      `/90` are blended over their resolved background before measuring, so an
 *      alpha-only regression cannot hide;
 *   2. non-text: the four section fills against the bar track at WCAG 1.4.11 3:1
 *      (hue rides on fills, never on sub-12px text);
 *   3. semantics: cliff and capped-trigger markers exist and the trigger sits
 *      BEFORE the cliff — the whole point of `min(threshold x window, cliff)`;
 *   4. interaction: a section expands to item rows and collapses again;
 *   5. geometry: the dialog stays inside the viewport with no horizontal
 *      overflow at 1366 / 390 / 320 px.
 *
 * Run: `bun run test:context-xray-browser` (or `bun tests/context-xray-browser-smoke.mjs`).
 * Exit code is non-zero on any failure, so CI can gate on it.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';

const here = path.dirname(fileURLToPath(import.meta.url));
const webuiRoot = path.resolve(here, '..');

/**
 * A 1M-window route with a published 2x step-up at 200K: the case the feature
 * exists for. Balanced soft (0.7) would fire at 691K, so the cliff IS binding —
 * trigger 190K (cliff x 0.95 headroom), target 170K (cliff x 0.85).
 */
const XRAY = {
  system: {
    total: 41_000,
    bySource: {
      identity: 2_100,
      'tool-usage': 6_800,
      environment: 1_900,
      'user-instructions': 3_400,
      'project-instructions': 5_200,
      skills: 9_600,
      mode: 1_200,
      plan: 700,
      'leader-after-task': 1_100,
      contributor: 400,
      ledger: 900,
      glossary: 300,
      peers: 260,
      nextsteps: 1_500,
      other: 6_600,
    },
  },
  tools: {
    total: 18_400,
    builtin: 12_100,
    mcp: 6_300,
    count: 34,
    mcpByServer: { kanban: 2_400, mailbox: 1_900, sage: 2_000 },
  },
  history: {
    total: 121_000,
    text: 22_000,
    toolInputs: 14_000,
    toolResults: 78_000,
    thinking: 5_000,
    other: 2_000,
    messageCount: 96,
  },
  volatile: {
    ledger: 2_600,
    nextsteps: 1_400,
    continuity: 1_200,
    memoryEvidence: 2_900,
    total: 8_100,
  },
  total: 188_500,
  effectiveMaxContext: 1_000_000,
  usedPct: 0.1885,
  warnings: [],
};

const CLIFF = {
  cliffTokens: 200_000,
  multiplier: 2,
  field: 'input',
  baseRate: 3,
  cliffRate: 6,
  binding: true,
  triggerTokens: 190_000,
  uncappedTriggerTokens: 691_400,
  inputTokens: 188_500,
  tokensToTrigger: 1_500,
  targetTokens: 170_000,
  availableInputTokens: 987_700,
};

function harnessPlugin(source) {
  const virtualId = 'virtual:context-xray-browser-smoke';
  const resolvedId = `\0${virtualId}.tsx`;
  return {
    name: 'context-xray-browser-smoke',
    resolveId: (id) => (id === virtualId ? resolvedId : undefined),
    load: (id) => (id === resolvedId ? source : undefined),
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (req.url?.split('?')[0] !== '/__context_xray_smoke') return next();
        const html = await server.transformIndexHtml(
          req.url,
          '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="/@id/virtual:context-xray-browser-smoke"></script></body></html>',
        );
        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(html);
      });
    },
  };
}

const pageSource = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import '/src/index.css';
import { ContextBreakdownModal } from '/src/components/ContextBreakdownModal.tsx';
import { getWSClient } from '/src/lib/ws-client.ts';
import { applyPalette } from '/src/lib/palettes.ts';
import { useConfigStore, useSessionStore } from '/src/stores/index.ts';
import { i18n } from '/src/i18n/index.ts';

// Socket stub. The modal only needs an "open" status plus a socket that ANSWERS
// context.debug: the answer is dispatched from inside send(), so the render is
// driven by React's own subscription/poll lifecycle instead of a wall-clock
// timer racing a passive effect (the flake pattern this gate must not add).
const handlers = new Map();
const wsClient = getWSClient(useConfigStore.getState().wsUrl);
// 'status' is a prototype getter — plain assignment throws; shadow it.
Object.defineProperty(wsClient, 'status', { value: { state: 'open' }, configurable: true });
wsClient.onStatus = () => () => {};
const originalOn = wsClient.on.bind(wsClient);
wsClient.on = (type, handler) => {
  const set = handlers.get(type) ?? new Set();
  set.add(handler);
  handlers.set(type, set);
  return originalOn(type, handler);
};
wsClient.send = (message) => {
  if (!message || message.type !== 'context.debug') return;
  const set = handlers.get('context.debug');
  if (!set) return;
  for (const handler of set) {
    handler({
      type: 'context.debug',
      payload: {
        // xray/cliff are NESTED keys: ContextBreakdownModal reads data.xray and
        // data.cliff and ContextXRay renders nothing without them.
        xray: ${JSON.stringify(XRAY)},
        cliff: ${JSON.stringify(CLIFF)},
        total: ${XRAY.total},
        systemPrompt: ${XRAY.system.total},
        tools: { total: ${XRAY.tools.total}, count: ${XRAY.tools.count}, breakdown: [] },
        messages: { total: ${XRAY.history.total}, count: ${XRAY.history.messageCount}, breakdown: [] },
        mode: 'balanced',
      },
    });
  }
};

// Real theme + palette mechanisms, so light/dark audit the app's own token set.
window.__setTheme = (theme) => {
  useConfigStore.getState().setTheme(theme);
  document.documentElement.classList.toggle('dark', theme === 'dark');
};
window.__setPalette = (palette) => {
  useConfigStore.getState().setPalette(palette);
  applyPalette(document.documentElement, palette);
};

useSessionStore.setState({ cacheStats: null, maxContext: ${XRAY.effectiveMaxContext}, lastInputTokens: ${XRAY.total} });

createRoot(document.getElementById('root')).render(
  React.createElement(ContextBreakdownModal, { open: true, onClose: () => {} }),
);

// 'activity' is a DEFERRED chunk (B-13): without this await the sweep would
// measure raw key strings instead of the labels users actually see.
await i18n.changeLanguage('en');
await i18n.loadNamespaces(['activity']);
window.__xrayReady = true;
`;

async function start() {
  const server = await createServer({
    root: webuiRoot,
    configFile: path.join(webuiRoot, 'vite.config.ts'),
    plugins: [harnessPlugin(pageSource)],
    server: { host: '127.0.0.1', port: 0 },
    logLevel: 'error',
  });
  await server.listen();
  const address = server.httpServer.address();
  if (!address || typeof address === 'string') throw new Error('Vite did not expose a TCP port');
  return { server, url: `http://127.0.0.1:${address.port}/__context_xray_smoke` };
}

/**
 * Self-contained page expression (module-scope variables do not survive
 * `page.evaluate`, mirroring the compose smoke's CONTRAST_AUDIT). Measures text
 * contrast with alpha compositing, fill contrast against the bar track, marker
 * geometry and the section-button inventory.
 */
const XRAY_AUDIT = `(() => {
  const parse = (s) => {
    const m = (s || '').match(/rgba?\\(([\\d.]+)[,\\s]+([\\d.]+)[,\\s]+([\\d.]+)(?:[,\\s/]+([\\d.]+))?\\)/);
    return m ? { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] } : null;
  };
  const over = (t, u) => ({
    r: t.r * t.a + u.r * (1 - t.a),
    g: t.g * t.a + u.g * (1 - t.a),
    b: t.b * t.a + u.b * (1 - t.a),
    a: t.a + u.a * (1 - t.a),
  });
  const effectiveBg = (el) => {
    let acc = null;
    let node = el;
    while (node && node instanceof Element) {
      const c = parse(getComputedStyle(node).backgroundColor);
      if (c && c.a > 0) acc = acc ? over(acc, c) : c;
      if (acc && acc.a >= 0.999) break;
      node = node.parentElement;
    }
    return acc && acc.a > 0 ? over(acc, { r: 255, g: 255, b: 255, a: 1 }) : { r: 255, g: 255, b: 255, a: 1 };
  };
  const lum = (c) => {
    const f = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  };
  const ratio = (a, b) => {
    const l1 = lum(a); const l2 = lum(b);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  };
  const round = (n) => Math.round(n * 100) / 100;
  const rgb = (c) => 'rgb(' + Math.round(c.r) + ',' + Math.round(c.g) + ',' + Math.round(c.b) + ')';

  const dialog = document.querySelector('[role="dialog"]');
  if (!dialog) return { error: 'no dialog mounted' };
  const section = Array.from(dialog.querySelectorAll('section')).find((s) => s.querySelector('[role="img"]'));
  if (!section) return { error: 'Context X-Ray section not rendered (xray payload missing?)' };

  const text = [];
  const walker = document.createTreeWalker(section, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    const label = node.textContent.trim();
    if (!label) continue;
    const el = node.parentElement;
    if (!el || el.closest('script,style')) continue;
    // Decorative/aria-hidden runs carry no accessible text; role=img surfaces are
    // labelled by their aria-label, same exclusion as the compose smoke.
    if (el.closest('[role="img"], [aria-hidden]')) continue;
    const cs = getComputedStyle(el);
    const fgRaw = parse(cs.color);
    if (!fgRaw) continue;
    const bg = effectiveBg(el);
    const fg = fgRaw.a < 1 ? over(fgRaw, bg) : fgRaw;
    text.push({
      text: label.slice(0, 34),
      fontSize: parseFloat(cs.fontSize),
      weight: parseInt(cs.fontWeight, 10) || 400,
      ratio: round(ratio(fg, bg)),
      fg: rgb(fg),
      bg: rgb(bg),
    });
  }

  // Non-text: the four section fills + the legend swatches vs what sits behind
  // them. WCAG 1.4.11 needs 3:1; the project keeps status hue OFF sub-12px text.
  const graphics = [];
  const bar = section.querySelector('[role="img"]');
  const track = effectiveBg(bar);
  for (const seg of Array.from(bar.querySelectorAll(':scope > div > div[style*="background-color"]'))) {
    const fill = parse(getComputedStyle(seg).backgroundColor);
    if (!fill) continue;
    graphics.push({
      kind: 'segment',
      label: (seg.getAttribute('title') || 'segment').slice(0, 28),
      ratio: round(ratio(fill.a < 1 ? over(fill, track) : fill, track)),
      fill: rgb(fill.a < 1 ? over(fill, track) : fill),
      bg: rgb(track),
    });
  }
  for (const dot of Array.from(section.querySelectorAll('span[aria-hidden][style*="background-color"]'))) {
    const fill = parse(getComputedStyle(dot).backgroundColor);
    if (!fill) continue;
    const bg = effectiveBg(dot.parentElement || section);
    graphics.push({
      kind: 'swatch',
      label: (dot.nextElementSibling ? dot.nextElementSibling.textContent : 'swatch').slice(0, 28),
      ratio: round(ratio(fill.a < 1 ? over(fill, bg) : fill, bg)),
      fill: rgb(fill.a < 1 ? over(fill, bg) : fill),
      bg: rgb(bg),
    });
  }

  const marks = Array.from(bar.querySelectorAll('span[aria-hidden]')).map((el) => ({
    cls: el.className.replace(/\\s+/g, ' ').slice(0, 44),
    leftPct: parseFloat(el.style.left) || 0,
    cliff: el.className.includes('bg-destructive'),
  }));

  return {
    text,
    graphics,
    marks,
    barAria: bar.getAttribute('aria-label') || '',
    buttons: Array.from(section.querySelectorAll('button[aria-expanded]')).map((b) => ({
      label: b.textContent.trim().slice(0, 28),
      expanded: b.getAttribute('aria-expanded'),
    })),
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    dialogBox: (() => {
      const r = dialog.getBoundingClientRect();
      return { x: Math.round(r.x), w: Math.round(r.width), right: Math.round(r.right) };
    })(),
  };
})()`;

/** Expand/collapse, driven by real clicks so React state (not markup) is tested. */
async function auditInteraction(page) {
  const button = page.locator('[role="dialog"] section button[aria-expanded]').first();
  if ((await button.count()) === 0) return { error: 'no section buttons' };
  const before = await page
    .locator('[role="dialog"] section button[aria-expanded="true"] + ul li')
    .count();
  await button.click();
  const expandedCount = await page
    .locator('[role="dialog"] section button[aria-expanded="true"] + ul li')
    .count();
  const ariaOpen = await button.getAttribute('aria-expanded');
  const sampleRow = await page
    .locator('[role="dialog"] section button[aria-expanded="true"] + ul li')
    .first()
    .textContent();
  await button.click();
  const after = await page
    .locator('[role="dialog"] section button[aria-expanded="true"] + ul li')
    .count();
  return {
    before,
    expandedCount,
    ariaOpen,
    sampleRow: (sampleRow || '').trim().slice(0, 40),
    after,
  };
}

const VIEWPORTS = [
  [1366, 768],
  [390, 844],
  [320, 568],
];

const { server, url } = await start();
const browser = await chromium.launch({ headless: true });
const results = [];
try {
  for (const [theme, palette] of [
    ['light', 'signal'],
    ['dark', 'terminal'],
  ]) {
    for (const [width, height] of VIEWPORTS) {
      const context = await browser.newContext({ viewport: { width, height } });
      const page = await context.newPage();
      const pageErrors = [];
      page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 200)));
      page.on('console', (m) => {
        if (m.type() === 'error') pageErrors.push(`console: ${m.text().slice(0, 200)}`);
      });
      await page.goto(url, { waitUntil: 'load' });
      await page.waitForFunction(() => window.__xrayReady === true, null, { timeout: 30_000 });
      await page.evaluate(
        ([t, p]) => {
          window.__setTheme(t);
          window.__setPalette(p);
        },
        [theme, palette],
      );
      // The bar only exists once the stubbed socket answer has reached the hook.
      await page.waitForSelector('[role="dialog"] section [role="img"]', { timeout: 15_000 });

      const audit = await page.evaluate(XRAY_AUDIT);
      const interaction = audit.error ? null : await auditInteraction(page);

      const textFailures = [];
      const graphicFailures = [];
      if (!audit.error) {
        for (const row of audit.text) {
          const large = row.fontSize >= 24 || (row.fontSize >= 18.66 && row.weight >= 700);
          if (row.ratio < (large ? 3 : 4.5)) textFailures.push({ ...row, needed: large ? 3 : 4.5 });
        }
        for (const g of audit.graphics) if (g.ratio < 3) graphicFailures.push(g);
      }

      const cliff = (audit.marks ?? []).find((m) => m.cliff);
      const trigger = (audit.marks ?? []).find((m) => !m.cliff);
      const problems = [];
      if (audit.error) problems.push(audit.error);
      else {
        if (!audit.barAria) problems.push('occupancy bar has no aria-label');
        if (audit.buttons.length < 2)
          problems.push(`expected >=2 expandable sections, got ${audit.buttons.length}`);
        if (!cliff || !trigger) problems.push('cliff and/or capped-trigger marker missing');
        else if (!(trigger.leftPct < cliff.leftPct))
          problems.push(
            `trigger must fire BEFORE the cliff (trigger ${trigger.leftPct}% vs cliff ${cliff.leftPct}%)`,
          );
        if (audit.overflow > 1)
          problems.push(`horizontal overflow ${audit.overflow}px at ${width}x${height}`);
        const box = audit.dialogBox;
        if (box.x < -1 || box.right > width + 1)
          problems.push(`dialog escaped ${width}px viewport: ${JSON.stringify(box)}`);
        if (!interaction || interaction.error)
          problems.push(`interaction: ${interaction?.error ?? 'no data'}`);
        else {
          if (interaction.before !== 0) problems.push('a section was expanded before any click');
          if (interaction.expandedCount < 1)
            problems.push('expanding a section revealed no item rows');
          if (interaction.ariaOpen !== 'true') problems.push('aria-expanded did not become true');
          if (interaction.after !== 0) problems.push('second click did not collapse the section');
        }
        if (textFailures.length) problems.push(`${textFailures.length} text node(s) below 4.5:1`);
        if (graphicFailures.length) problems.push(`${graphicFailures.length} fill(s) below 3:1`);
        if (pageErrors.length) problems.push(`${pageErrors.length} page error(s)`);
      }

      results.push({
        combo: `${theme}/${width}x${height}`,
        passed: problems.length === 0,
        problems,
        textNodes: audit.text?.length ?? 0,
        minText: audit.text?.length ? Math.min(...audit.text.map((r) => r.ratio)) : null,
        minGraphic: audit.graphics?.length ? Math.min(...audit.graphics.map((g) => g.ratio)) : null,
        weakestText: audit.text?.length
          ? audit.text.reduce((a, b) => (b.ratio < a.ratio ? b : a))
          : null,
        weakestGraphic: audit.graphics?.length
          ? audit.graphics.reduce((a, b) => (b.ratio < a.ratio ? b : a))
          : null,
        marks: (audit.marks ?? []).map((m) => `${m.cliff ? 'cliff' : 'trigger'}@${m.leftPct}%`),
        pageErrors,
        textFailures,
        graphicFailures,
      });
      await context.close();
    }
  }
} finally {
  await browser.close();
  await server.close();
}

const passed = results.every((r) => r.passed);
console.log(JSON.stringify({ passed, results }, null, 2));
process.exitCode = passed ? 0 : 1;
