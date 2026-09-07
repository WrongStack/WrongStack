/**
 * Single-file, dependency-free HTML rendering of the atlas.
 *
 * The WebUI's CodeMap is the interactive view, but it needs a running server, a
 * built index and a browser pointed at localhost. This is the other half: one
 * file you can attach to a pull request, publish as a CI artifact, or mail to
 * somebody who will never install the toolchain.
 *
 * ## Why it embeds rather than fetches
 *
 * A page that fetches `atlas.json` beside it does not work from `file://` in
 * any modern browser — the request is a cross-origin one to a null origin. The
 * data is inlined as JSON so a double-click opens a working map.
 *
 * ## Why the layout is computed here, not in the page
 *
 * A force simulation in the page would make the same input produce a slightly
 * different picture on every open. Positions are computed once, deterministic
 * given the document, so two exports of the same index are byte-identical and
 * a committed export diffs meaningfully.
 */

import type { AtlasDocument, AtlasPackage } from './atlas-projection.js';

/** Packages drawn on the canvas. Beyond this the picture stops being readable. */
export const EXPORT_PACKAGE_LIMIT = 40;

/** Files listed in the ranked table. */
export const EXPORT_FILE_LIMIT = 120;

/** Canvas dimensions of the generated SVG, in user units. */
const CANVAS = { width: 1000, height: 700 };

/** Smallest and largest package circle radius, mapped from rank. */
const RADIUS = { min: 14, max: 46 };

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ESCAPES[character] ?? character);
}

/**
 * Inline a JSON payload inside a `<script>` safely.
 *
 * `</script>` anywhere in the data — a file path, a model-written summary —
 * would close the tag early and the page would break, so the sequence is
 * escaped at the character level rather than trusted.
 */
function inlineJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

interface PlacedPackage {
  package: AtlasPackage;
  x: number;
  y: number;
  radius: number;
}

/**
 * Place packages on concentric rings, most central at the middle.
 *
 * A radial arrangement says the one thing the picture should say without a
 * legend: distance from the centre is distance from the code everything else
 * depends on. Ring sizes grow outwards so the outer rings do not crowd.
 */
function placePackages(packages: readonly AtlasPackage[]): PlacedPackage[] {
  const shown = packages.slice(0, EXPORT_PACKAGE_LIMIT);
  if (shown.length === 0) return [];
  const maxRank = shown.reduce((max, pkg) => Math.max(max, pkg.rank), 0) || 1;
  const centreX = CANVAS.width / 2;
  const centreY = CANVAS.height / 2;

  const placed: PlacedPackage[] = [];
  let index = 0;
  let ring = 0;
  while (index < shown.length) {
    const capacity = ring === 0 ? 1 : Math.min(ring * 6, shown.length - index);
    const radius = ring === 0 ? 0 : ring * 115;
    for (let slot = 0; slot < capacity && index < shown.length; slot++, index++) {
      const pkg = shown[index] as AtlasPackage;
      const angle = (slot / capacity) * Math.PI * 2 - Math.PI / 2;
      placed.push({
        package: pkg,
        x: centreX + Math.cos(angle) * radius,
        y: centreY + Math.sin(angle) * radius * 0.68,
        radius: RADIUS.min + (pkg.rank / maxRank) * (RADIUS.max - RADIUS.min),
      });
    }
    ring++;
  }
  return placed;
}

/** Round to whole units so the same document always emits the same bytes. */
const unit = (value: number): string => value.toFixed(1);

function renderSvg(document: AtlasDocument): string {
  const placed = placePackages(document.packages);
  if (placed.length === 0) {
    return '<p class="empty">No ranked packages to draw.</p>';
  }
  const at = new Map(placed.map((entry) => [entry.package.name, entry]));
  const maxWeight = document.edges.reduce((max, edge) => Math.max(max, edge.weight), 0) || 1;

  const lines: string[] = [
    `<svg viewBox="0 0 ${CANVAS.width} ${CANVAS.height}" role="img" aria-label="Package dependency map">`,
  ];

  for (const edge of document.edges) {
    const from = at.get(edge.from);
    const to = at.get(edge.to);
    if (from === undefined || to === undefined || from === to) continue;
    const strength = Math.min(1, edge.weight / maxWeight);
    lines.push(
      `<line x1="${unit(from.x)}" y1="${unit(from.y)}" x2="${unit(to.x)}" y2="${unit(to.y)}" ` +
        `stroke-width="${(0.5 + strength * 2.5).toFixed(2)}" stroke-opacity="${(0.12 + strength * 0.4).toFixed(2)}" />`,
    );
  }

  for (const entry of placed) {
    const name = escapeHtml(entry.package.name);
    const summary = entry.package.summary ?? '';
    const title = escapeHtml(
      `${entry.package.name} — ${entry.package.files} files, rank ${entry.package.rank.toFixed(4)}${
        summary === '' ? '' : `\n${summary}`
      }`,
    );
    lines.push(
      `<g class="pkg" data-package="${name}" tabindex="0">`,
      `<title>${title}</title>`,
      `<circle cx="${unit(entry.x)}" cy="${unit(entry.y)}" r="${unit(entry.radius)}" />`,
      `<text x="${unit(entry.x)}" y="${unit(entry.y + entry.radius + 13)}">${name}</text>`,
      '</g>',
    );
  }

  lines.push('</svg>');
  return lines.join('\n');
}

function renderFileRows(document: AtlasDocument): string {
  return document.files
    .slice(0, EXPORT_FILE_LIMIT)
    .map((file) => {
      const declarations = file.symbols
        .slice(0, 4)
        .map((symbol) => escapeHtml(symbol.name))
        .join(', ');
      const description = file.concept ?? declarations;
      return (
        `<tr data-package="${escapeHtml(file.package)}">` +
        `<td class="num">${file.rank.toFixed(4)}</td>` +
        `<td class="path">${escapeHtml(file.path)}</td>` +
        `<td class="num">${file.inDeg}</td>` +
        `<td class="num">${file.outDeg}</td>` +
        `<td class="desc">${escapeHtml(description)}</td>` +
        '</tr>'
      );
    })
    .join('\n');
}

export interface AtlasExportOptions {
  /** Repository name shown in the header. */
  projectName?: string | undefined;
}

/**
 * Render the atlas as one self-contained HTML document.
 *
 * Deterministic: the same {@link AtlasDocument} always produces the same bytes,
 * with no timestamp, no random ids and no measurement of the host.
 */
export function renderAtlasHtml(document: AtlasDocument, options: AtlasExportOptions = {}): string {
  const name = options.projectName ?? 'Codebase';
  const described = document.packages.filter((pkg) => pkg.summary !== undefined);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(name)} — Codebase Atlas</title>
<style>
:root {
  color-scheme: light dark;
  --bg: #ffffff; --fg: #16181d; --muted: #61656e; --line: #d9dce2;
  --accent: #3b5bdb; --panel: #f6f7f9;
}
@media (prefers-color-scheme: dark) {
  :root { --bg: #101216; --fg: #e6e8ec; --muted: #9aa0ab; --line: #2a2e36;
          --accent: #7c93f5; --panel: #171a20; }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg);
       font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif; }
header { padding: 24px 28px 12px; border-bottom: 1px solid var(--line); }
h1 { margin: 0 0 4px; font-size: 20px; }
h2 { margin: 28px 0 10px; font-size: 15px; text-transform: uppercase;
     letter-spacing: .12em; color: var(--muted); }
main { padding: 8px 28px 48px; max-width: 1180px; margin: 0 auto; }
.counts { color: var(--muted); font-size: 12px; }
figure { margin: 16px 0 0; border: 1px solid var(--line); background: var(--panel); }
svg { display: block; width: 100%; height: auto; }
svg line { stroke: var(--accent); }
svg circle { fill: var(--accent); fill-opacity: .22; stroke: var(--accent); stroke-width: 1.5; }
svg text { fill: var(--fg); font-size: 10px; text-anchor: middle; font-family: ui-monospace, monospace; }
svg .pkg { cursor: pointer; }
svg .pkg:hover circle, svg .pkg:focus circle { fill-opacity: .5; outline: none; }
svg .pkg.muted { opacity: .25; }
table { width: 100%; border-collapse: collapse; font-size: 12px; }
th, td { padding: 5px 8px; border-bottom: 1px solid var(--line); text-align: left;
         vertical-align: top; }
th { color: var(--muted); font-weight: 600; font-size: 11px; text-transform: uppercase;
     letter-spacing: .08em; }
td.num { text-align: right; font-family: ui-monospace, monospace; white-space: nowrap; }
td.path { font-family: ui-monospace, monospace; }
td.desc { color: var(--muted); }
tr[hidden] { display: none; }
ul.subsystems { list-style: none; padding: 0; margin: 0; }
ul.subsystems li { padding: 6px 0; border-bottom: 1px solid var(--line); }
ul.subsystems b { font-family: ui-monospace, monospace; }
.filter { margin: 10px 0 0; font-size: 12px; color: var(--muted); }
.filter button { font: inherit; color: var(--accent); background: none; border: 0;
                 cursor: pointer; padding: 0; text-decoration: underline; }
.empty { color: var(--muted); }
.wrap { overflow-x: auto; }
footer { color: var(--muted); font-size: 11px; padding: 0 28px 32px; max-width: 1180px;
         margin: 0 auto; }
</style>
</head>
<body>
<header>
  <h1>${escapeHtml(name)} — Codebase Atlas</h1>
  <p class="counts">${document.counts.files} files · ${document.counts.symbols} symbols · ${document.counts.packages} packages · ranking is PageRank over the reference graph, relative to this repository</p>
</header>
<main>
  <h2>Package map</h2>
  <figure>${renderSvg(document)}</figure>
  <p class="filter" id="filter">Click a package to filter the table. <button type="button" id="clear" hidden>Clear filter</button></p>
${
  described.length === 0
    ? ''
    : `  <h2>Subsystems</h2>
  <ul class="subsystems">
${described.map((pkg) => `    <li><b>${escapeHtml(pkg.name)}</b> — ${escapeHtml(pkg.summary ?? '')}</li>`).join('\n')}
  </ul>
`
}  <h2>Most central files</h2>
  <div class="wrap">
  <table>
    <thead><tr><th>Rank</th><th>File</th><th>In</th><th>Out</th><th>What it is</th></tr></thead>
    <tbody id="files">
${renderFileRows(document)}
    </tbody>
  </table>
  </div>
</main>
<footer>Generated from the codebase index by <code>/codebase-map --export</code>. Ranks are relative to this repository and mean nothing across repositories.</footer>
<script id="atlas" type="application/json">${inlineJson({
    counts: document.counts,
    packages: document.packages,
    edges: document.edges,
  })}</script>
<script>
(function () {
  var rows = Array.prototype.slice.call(document.querySelectorAll('#files tr'));
  var groups = Array.prototype.slice.call(document.querySelectorAll('svg .pkg'));
  var clear = document.getElementById('clear');
  var active = null;

  function apply(name) {
    active = name;
    rows.forEach(function (row) {
      row.hidden = name !== null && row.getAttribute('data-package') !== name;
    });
    groups.forEach(function (group) {
      group.classList.toggle('muted', name !== null && group.getAttribute('data-package') !== name);
    });
    clear.hidden = name === null;
  }

  groups.forEach(function (group) {
    var name = group.getAttribute('data-package');
    function toggle() { apply(active === name ? null : name); }
    group.addEventListener('click', toggle);
    group.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggle(); }
    });
  });
  clear.addEventListener('click', function () { apply(null); });
})();
</script>
</body>
</html>
`;
}
