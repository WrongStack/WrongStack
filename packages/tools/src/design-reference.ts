import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type {
  ImageBlock,
  Tool,
  ToolProgressEvent,
  ToolStreamEvent,
} from '@wrongstack/contracts/types';
import { attachToolImages, getToolImages, ToolValidationError } from '@wrongstack/contracts/types';
import type { Context } from '@wrongstack/core/agent';
import {
  compareDesignDna,
  DESIGN_DNA_EXTRACTOR,
  DESIGN_INSPECT_EXTRACTOR,
  type DesignDna,
  type DesignDnaRaw,
  type DesignInspectRaw,
  designProjectDir,
  dnaToTokenOverrides,
  ensureDesignDir,
  type InspectRuntimeEvidence,
  type InspectStage,
  type InspectSurface,
  inspectDesign,
  renderDesignDnaMarkdown,
  renderDesignMdFromDna,
  renderDnaComparisonMarkdown,
  renderInspectMarkdown,
  summarizeDesignDna,
} from '@wrongstack/core/design';
import { ToolCapabilities } from '@wrongstack/core/security';
import { atomicWrite } from '@wrongstack/core/utils';
import { managerFor, owner } from './browser/tools.js';
import { withServedProjectFile } from './design-reference-serve.js';

/**
 * `design_reference` — measure a rendered page instead of describing it:
 * `extract` a reference's design DNA, `compare` an implementation against it,
 * `inspect` a page for reference-free rendered defects.
 *
 * A separate tool from `design` on purpose: these actions reach the network,
 * and capability gates (`--restricted`, subagent capability sets, auto-approve)
 * are decided per tool before any input is known, so only a tool that
 * declares `net.outbound` is visible to them. `design` keeps its offline token
 * actions under every policy.
 *
 * Extraction runs through the browser tools' own session manager, so the
 * network guard, private-origin allowlist and run-abort cleanup are the same
 * as `browser_open`; a localhost dev server needs `/browser allow <origin>`.
 * One isolated session per viewport (the viewport is fixed at creation), each
 * closed before the next opens. Results are files under
 * `.design/references/<slug>/` so a later turn — or another model — reads the
 * same numbers instead of re-describing a screenshot.
 */

/** 5-breakpoint responsive matrix (designmd.me standard: 1440, 1280, 1024, 768, 375). */
const DEFAULT_DNA_VIEWPORTS = [1440, 1280, 1024, 768, 375] as const;
const VIEWPORT_HEIGHT = 900;

function referencesDir(projectRoot: string): string {
  return path.join(designProjectDir(projectRoot), 'references');
}

/** `https://www.stripe.com/pricing?x` → `stripe-com-pricing`. */
function referenceSlug(url: string): string {
  const u = new URL(url);
  const raw = `${u.hostname.replace(/^www\./, '')}${u.pathname === '/' ? '' : u.pathname}`;
  return (
    raw
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64) || 'reference'
  );
}

/** `site/landing.html` → `site-landing`: the slug for a served project file. */
function fileSlug(file: string): string {
  return (
    file
      .toLowerCase()
      .replace(/\.html?$/, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64) || 'page'
  );
}

/** A served project file: its slug and the name reports show instead of the loopback URL. */
interface PageLabel {
  slug: string;
  name: string;
}

function assertHttpUrl(url: string | undefined): string {
  const value = url?.trim();
  let parsed: URL | undefined;
  try {
    parsed = value ? new URL(value) : undefined;
  } catch {
    parsed = undefined;
  }
  if (!value || !parsed || !/^https?:$/.test(parsed.protocol)) {
    throw new ToolValidationError({
      message:
        'design_reference: "url" must be an absolute http(s) URL, e.g. "https://example.com".',
      field: 'url',
    });
  }
  return value;
}

function normalizeViewports(viewports: unknown): number[] {
  if (viewports === undefined) return [...DEFAULT_DNA_VIEWPORTS];
  const list = (Array.isArray(viewports) ? viewports : [viewports]).map(Number);
  if (
    list.length === 0 ||
    list.length > 6 ||
    list.some((w) => !Number.isInteger(w) || w < 320 || w > 3840)
  ) {
    throw new ToolValidationError({
      message:
        'design_reference: "viewports" takes 1–6 integer widths between 320 and 3840, e.g. [1440, 1280, 1024, 768, 375].',
      field: 'viewports',
    });
  }
  return [...new Set(list)].sort((a, b) => b - a);
}

/** Validate a slug the caller passed so it cannot walk out of `.design/references`. */
function assertSlug(slug: string, field: string): string {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(slug)) {
    throw new ToolValidationError({
      message: `design_reference: "${slug}" is not a reference name — use the slug \`design_reference {action:"extract"}\` printed (lowercase letters, digits, dashes).`,
      field,
    });
  }
  return slug;
}

interface Measured<T> {
  raws: T[];
  runtime: InspectRuntimeEvidence[];
  screenshots: Array<{ width: number; file: string }>;
  images: ImageBlock[];
}

/**
 * Run one in-page measurement script per viewport, each in its own isolated
 * session, and keep a first-screen screenshot plus the console/network
 * evidence the manager collected for that session.
 */
async function measure<T extends { v: 1 }>(
  ctx: Context,
  url: string,
  viewports: number[],
  outDir: string,
  signal: AbortSignal,
  script: string = DESIGN_DNA_EXTRACTOR,
  onProgress?: ((event: ToolProgressEvent) => void) | undefined,
  stagePrefix = '',
  viewportHeight: number = VIEWPORT_HEIGHT,
): Promise<Measured<T>> {
  const manager = managerFor(ctx);
  const ownerId = owner(ctx);
  const out: Measured<T> = { raws: [], runtime: [], screenshots: [], images: [] };
  // Screenshots of someone else's site must never become tracked repo files.
  await ensureDesignDir(ctx.projectRoot);
  await fs.mkdir(outDir, { recursive: true });
  for (let idx = 0; idx < viewports.length; idx++) {
    const width = viewports[idx]!;
    signal.throwIfAborted();
    onProgress?.({
      type: 'log',
      text: `${stagePrefix}Measuring ${url} @ ${width}×${viewportHeight}px (breakpoint ${idx + 1}/${viewports.length})…`,
    });
    const session = await manager.open(
      ownerId,
      {
        url,
        viewport: { width, height: viewportHeight },
        trace: false,
        conversationId: ctx.session?.id,
      },
      signal,
    );
    try {
      const raw = (await manager.evaluate(session.id, ownerId, script, signal)) as T;
      if (raw?.v !== 1)
        throw new Error(`design_reference: the page at ${url} returned no measurement`);
      out.raws.push(raw);
      const evidence = await manager.snapshot(session.id, ownerId, signal);
      out.runtime.push({
        consoleErrors: evidence.console.filter((c) => c.level === 'error').map((c) => c.text),
        failedRequests: evidence.network
          .filter((n) => n.failed || (n.status !== undefined && n.status >= 400))
          .map((n) => `${n.status ?? 'failed'} ${n.url}`),
      });
      const shot = await manager.screenshot(session.id, ownerId, { fullPage: false }, signal);
      const file = path.join(outDir, `${width}.png`);
      await fs.copyFile(shot.path, file);
      out.screenshots.push({ width, file });
      out.images.push(...getToolImages(shot));
    } finally {
      await manager.close(session.id, ownerId).catch(() => undefined);
    }
  }
  return out;
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await atomicWrite(file, `${JSON.stringify(value, null, 2)}\n`);
}

/** The returned report and every asset it creates belong to one retained review. */
async function reviewRunDir(latestDir: string): Promise<string> {
  const runs = path.join(latestDir, 'runs');
  await fs.mkdir(runs, { recursive: true });
  const dir = path.join(runs, randomUUID());
  await fs.mkdir(dir);
  return dir;
}

/** Compatibility aliases stay mutable; completed cards receive the retained run path. */
async function publishLatestReview(
  runDir: string,
  latestDir: string,
  files: string[],
): Promise<void> {
  for (const file of files) {
    const target = path.join(latestDir, file);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await atomicWrite(target, await fs.readFile(path.join(runDir, file)));
  }
}

const rel = (projectRoot: string, file: string): string =>
  path.relative(projectRoot, file).replace(/\\/g, '/');

function isSameOriginHttp(candidate: string, base: string): boolean {
  try {
    const [target, origin] = [new URL(candidate), new URL(base)];
    return /^https?:$/.test(target.protocol) && target.origin === origin.origin;
  } catch {
    return false;
  }
}

/** Select deduplicated subpages within the `maxPages` crawl budget. */
export function selectReferenceSubpages(args: {
  url: string;
  extraPages: string[];
  discovered: string[];
  maxPages: number;
}): string[] {
  const canon = (raw: string): [string, string] => {
    try {
      const u = Object.assign(new URL(raw), { hash: '' });
      return [u.toString(), `${u.origin}${u.pathname.replace(/\/+$/, '') || '/'}${u.search}`];
    } catch {
      return [raw.split('#')[0] ?? raw, (raw.split('#')[0] ?? raw).replace(/\/+$/, '')];
    }
  };
  const seen = new Set([canon(args.url)[1]]);
  return [...args.extraPages, ...args.discovered.filter((u) => isSameOriginHttp(u, args.url))]
    .flatMap((raw) => {
      const [clean, key] = canon(raw);
      return seen.size < seen.add(key).size ? [clean] : [];
    })
    .slice(0, Math.max(0, args.maxPages - 1));
}

function normalizeMaxPages(maxPages: unknown, extraPageCount = 0): number {
  if (maxPages === undefined) return Math.min(8, 1 + extraPageCount);
  const n = Number(maxPages);
  if (!Number.isInteger(n) || n < 1 || n > 8) {
    throw new ToolValidationError({
      message: 'design_reference: "maxPages" must be an integer between 1 and 8.',
      field: 'maxPages',
    });
  }
  return n;
}

function normalizeExtraPages(pages: unknown): string[] {
  if (pages === undefined) return [];
  if (!Array.isArray(pages) || pages.length > 7) {
    throw new ToolValidationError({
      message: 'design_reference: "pages" takes an array of 1–7 additional http(s) URLs.',
      field: 'pages',
    });
  }
  return pages.map((p) => assertHttpUrl(typeof p === 'string' ? p : ''));
}

async function extractReference(
  ctx: Context,
  input: {
    url?: string | undefined;
    name?: string | undefined;
    viewports?: unknown;
    pages?: unknown;
    maxPages?: unknown;
  },
  signal: AbortSignal,
  page?: PageLabel,
  onProgress?: ((event: ToolProgressEvent) => void) | undefined,
): Promise<{ slug: string; dna: DesignDna; output: string; path: string; images: ImageBlock[] }> {
  const url = assertHttpUrl(input.url);
  const viewports = normalizeViewports(input.viewports);
  const extraPages = normalizeExtraPages(input.pages);
  // `maxPages` is the total page budget; the explicitly requested subpages
  // count against it, so the default covers them.
  const maxPages = normalizeMaxPages(input.maxPages, extraPages.length);
  const slug = input.name
    ? assertSlug(input.name.trim(), 'name')
    : (page?.slug ?? referenceSlug(url));
  const dir = path.join(referencesDir(ctx.projectRoot), slug);
  const { raws, screenshots, images } = await measure<DesignDnaRaw>(
    ctx,
    url,
    viewports,
    dir,
    signal,
    DESIGN_DNA_EXTRACTOR,
    onProgress,
    '[1/4] ',
  );
  const allRaws = [...raws];
  const discovered = raws[0]?.internalLinks ?? [];
  const subpages = selectReferenceSubpages({ url, extraPages, discovered, maxPages });
  if (extraPages.length > subpages.length) {
    onProgress?.({
      type: 'log',
      text: `[2/4] maxPages ${maxPages} leaves room for ${subpages.length} of the ${extraPages.length} requested subpage(s); the rest are not measured.`,
    });
  }
  const widest = [viewports[0] ?? 1440];
  if (subpages.length > 0) {
    for (let i = 0; i < subpages.length; i++) {
      const subUrl = subpages[i] as string;
      onProgress?.({
        type: 'log',
        text: `[2/4] Crawling subpage ${i + 2}/${subpages.length + 1}: ${subUrl} @ ${widest[0]}px…`,
      });
      try {
        const subDir = path.join(dir, `page-${i + 2}`);
        const subMeasured = await measure<DesignDnaRaw>(ctx, subUrl, widest, subDir, signal);
        allRaws.push(...subMeasured.raws);
      } catch (err) {
        // A cancelled run must not keep going and write artifacts as if it succeeded.
        if (signal.aborted) throw err;
        // A single failing subpage does not abort primary extraction, but it is reported.
        onProgress?.({
          type: 'log',
          text: `[2/4] subpage skipped (${subUrl}): ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
    signal.throwIfAborted();
  } else {
    onProgress?.({
      type: 'log',
      text: '[2/4] Single-page extraction (subpage crawl skipped)…',
    });
  }
  onProgress?.({
    type: 'log',
    text: `[3/4] Synthesizing Design DNA across ${allRaws.length} measurement(s) (palette, typography roles, 14 component archetypes, responsive matrix)…`,
  });
  const dna = summarizeDesignDna(allRaws);
  await writeJson(path.join(dir, 'raw.json'), allRaws);
  await writeJson(path.join(dir, 'dna.json'), dna);
  const markdown = renderDesignDnaMarkdown(dna);
  const dnaMdRel = rel(ctx.projectRoot, path.join(dir, 'dna.md'));
  await atomicWrite(path.join(dir, 'dna.md'), markdown);
  const designMdRel = rel(ctx.projectRoot, path.join(dir, 'DESIGN.md'));
  onProgress?.({
    type: 'log',
    text: `[4/4] Writing 10-section DESIGN.md specification → ${designMdRel}`,
  });
  const designMdText = renderDesignMdFromDna(dna, {
    name: input.name?.trim(),
  });
  await atomicWrite(path.join(dir, 'DESIGN.md'), designMdText);
  onProgress?.({ type: 'file_changed', path: designMdRel, operation: 'write' });
  onProgress?.({ type: 'file_changed', path: dnaMdRel, operation: 'write' });
  const overrides = dnaToTokenOverrides(dna);
  const output = [
    markdown.trimEnd(),
    '',
    `Saved: ${rel(ctx.projectRoot, dir)}/{dna.md,dna.json,raw.json,DESIGN.md} (${dna.source.pagesAnalyzed ?? 1} page(s) analyzed across [${viewports.join(', ')}]px) · screenshots ${screenshots
      .map((s) => rel(ctx.projectRoot, s.file))
      .join(
        ', ',
      )} — read the screenshots before naming patterns; numbers do not show imagery or tone.`,
    `Full 10-section DESIGN.md specification: ${rel(ctx.projectRoot, path.join(dir, 'DESIGN.md'))}.`,
    `Reference name for compare: "${slug}".`,
    '',
    'Carry the measured system into Design Studio (after pinning the closest kit with `design {action:"use"}`):',
    `design {action:"set", set:${JSON.stringify(overrides)}}`,
    'Learn the decisions, not the brand: do not copy logos, product imagery, copy or a licensed font you do not hold.',
  ].join('\n');
  return { slug, dna, output, path: rel(ctx.projectRoot, path.join(dir, 'dna.md')), images };
}

async function loadDna(projectRoot: string, slug: string, field: string): Promise<DesignDna> {
  const file = path.join(referencesDir(projectRoot), assertSlug(slug, field), 'dna.json');
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as DesignDna;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new ToolValidationError({
        message: `design_reference: no extracted reference "${slug}" (expected ${rel(projectRoot, file)}). Run \`design_reference {action:"extract", url:"…"}\` first.`,
        field,
      });
    }
    throw err;
  }
}

async function compareReference(
  ctx: Context,
  input: {
    reference?: string | undefined;
    url?: string | undefined;
    against?: string | undefined;
    viewports?: unknown;
  },
  signal: AbortSignal,
  page?: PageLabel,
  onProgress?: ((event: ToolProgressEvent) => void) | undefined,
): Promise<{
  output: string;
  overall: number;
  path: string;
  latestPath: string;
  images: ImageBlock[];
}> {
  const refSlug = input.reference?.trim();
  if (!refSlug) {
    throw new ToolValidationError({
      message:
        'design_reference: "compare" needs reference:"<slug from extract>" plus url:"<implementation>" or against:"<other slug>".',
      field: 'reference',
    });
  }
  const ref = await loadDna(ctx.projectRoot, refSlug, 'reference');
  let impl: DesignDna;
  let implLabel: string;
  let images: ImageBlock[] = [];
  const latestDir = path.join(referencesDir(ctx.projectRoot), refSlug);
  let runDir: string;
  let aliases: string[] = [];
  if (input.against) {
    impl = await loadDna(ctx.projectRoot, input.against.trim(), 'against');
    implLabel = input.against.trim();
    runDir = await reviewRunDir(latestDir);
  } else {
    const url = assertHttpUrl(input.url);
    // Measure the implementation at the reference's own viewports unless told otherwise.
    const viewports =
      input.viewports === undefined ? ref.source.viewports : normalizeViewports(input.viewports);
    runDir = await reviewRunDir(latestDir);
    const dir = path.join(runDir, 'implementation');
    const measured = await measure<DesignDnaRaw>(
      ctx,
      url,
      viewports,
      dir,
      signal,
      DESIGN_DNA_EXTRACTOR,
      onProgress,
      '[1/2] ',
    );
    images = measured.images;
    impl = summarizeDesignDna(measured.raws);
    aliases = [
      ...measured.screenshots.map(({ file }) => path.relative(runDir, file)),
      'implementation/dna.json',
    ];
    implLabel = page?.name ?? url;
  }
  onProgress?.({
    type: 'log',
    text: `[2/2] Scoring per-axis fidelity (${refSlug} ↔ ${implLabel})…`,
  });
  const cmp = compareDesignDna(ref, impl);
  const markdown = renderDnaComparisonMarkdown(cmp, refSlug, implLabel);
  signal.throwIfAborted();
  await writeJson(path.join(runDir, 'reference.json'), ref);
  await writeJson(path.join(runDir, 'implementation/dna.json'), impl);
  const file = path.join(runDir, 'fidelity.md');
  const fidelityRel = rel(ctx.projectRoot, file);
  await atomicWrite(file, `${markdown}\n`);
  signal.throwIfAborted();
  await publishLatestReview(runDir, latestDir, [...aliases, 'fidelity.md']);
  onProgress?.({ type: 'file_changed', path: fidelityRel, operation: 'write' });
  return {
    output: markdown,
    overall: cmp.overall,
    path: fidelityRel,
    latestPath: rel(ctx.projectRoot, path.join(latestDir, 'fidelity.md')),
    images,
  };
}

/**
 * `inspect` — reference-free rendered quality gate. FAIL
 * marks a defect, WARN a craft problem to fix or defend; the report lists
 * what the measurement cannot see so a clean result is not read as a review.
 */
async function inspectPage(
  ctx: Context,
  input: {
    url?: string | undefined;
    viewports?: unknown;
    surface?: string | undefined;
    stage?: string | undefined;
  },
  signal: AbortSignal,
  page?: PageLabel,
  onProgress?: ((event: ToolProgressEvent) => void) | undefined,
): Promise<{
  output: string;
  fails: number;
  warns: number;
  path: string;
  latestPath: string;
  images: ImageBlock[];
}> {
  const url = assertHttpUrl(input.url);
  if (input.stage !== undefined && input.stage !== 'hero' && input.stage !== 'full') {
    throw new ToolValidationError({
      message:
        'design_reference: "stage" is "hero" (1280×800 + 375 hero-first fold gate) or "full" (default).',
      field: 'stage',
    });
  }
  const stage: InspectStage = input.stage ?? 'full';
  const viewports =
    input.viewports === undefined && stage === 'hero'
      ? [1280, 375]
      : normalizeViewports(input.viewports);
  const viewportHeight = stage === 'hero' ? 800 : VIEWPORT_HEIGHT;
  if (input.surface !== undefined && input.surface !== 'page' && input.surface !== 'app') {
    throw new ToolValidationError({
      message:
        'design_reference: "surface" is "page" (marketing/content) or "app" (dense product screen).',
      field: 'surface',
    });
  }
  const surface: InspectSurface = input.surface ?? 'page';
  const latestDir = path.join(
    designProjectDir(ctx.projectRoot),
    'inspect',
    page?.slug ?? referenceSlug(url),
  );
  const dir = await reviewRunDir(latestDir);
  const { raws, runtime, screenshots, images } = await measure<DesignInspectRaw>(
    ctx,
    url,
    viewports,
    dir,
    signal,
    DESIGN_INSPECT_EXTRACTOR,
    onProgress,
    '[1/2] ',
    viewportHeight,
  );
  onProgress?.({
    type: 'log',
    text: `[2/2] Evaluating rendered layout, WCAG contrast & touch-target rules (${surface}, stage: ${stage})…`,
  });
  const report = inspectDesign(
    raws.map((raw, i) => ({ raw, runtime: runtime[i] })),
    surface,
    { stage },
  );
  const markdown = renderInspectMarkdown(report);
  signal.throwIfAborted();
  await writeJson(path.join(dir, 'inspect.json'), report);
  const inspectRel = rel(ctx.projectRoot, path.join(dir, 'inspect.md'));
  await atomicWrite(path.join(dir, 'inspect.md'), markdown);
  signal.throwIfAborted();
  await publishLatestReview(dir, latestDir, [
    ...screenshots.map(({ file }) => path.relative(dir, file)),
    'inspect.json',
    'inspect.md',
  ]);
  onProgress?.({ type: 'file_changed', path: inspectRel, operation: 'write' });
  const output = [
    markdown.trimEnd(),
    '',
    `Saved: ${rel(ctx.projectRoot, dir)}/inspect.{md,json} · screenshots ${screenshots
      .map((s) => rel(ctx.projectRoot, s.file))
      .join(', ')}`,
  ].join('\n');
  return {
    output,
    fails: report.fails,
    warns: report.warns,
    path: inspectRel,
    latestPath: rel(ctx.projectRoot, path.join(latestDir, 'inspect.md')),
    images,
  };
}

export interface DesignReferenceInput {
  action: 'extract' | 'compare' | 'inspect';
  /** extract: the page to measure; compare/inspect: the implementation to measure. */
  url?: string | undefined;
  /** Instead of url: a project .html file, served on loopback for this call. */
  file?: string | undefined;
  /** extract: reference name (slug) to save under; defaults from the URL. */
  name?: string | undefined;
  /** Viewport widths, default [1440, 1280, 1024, 768, 375]. */
  viewports?: number[] | undefined;
  /** extract: additional subpage URLs to analyze and merge into the reference DNA. */
  pages?: string[] | undefined;
  /** extract: total number of pages (1–8) to analyze, auto-discovering same-origin internal links when > 1. */
  maxPages?: number | undefined;
  /** compare: the extracted reference slug to score against. */
  reference?: string | undefined;
  /** compare: another extracted slug instead of measuring `url`. */
  against?: string | undefined;
  /** inspect: thresholds for a content "page" (default) or a dense "app" screen. */
  surface?: InspectSurface | undefined;
  /** inspect: "hero" checks the opening fold fast at [1280, 375] × 800px; "full" (default) checks all breakpoints. */
  stage?: InspectStage | undefined;
}

export interface DesignReferenceOutput {
  action: string;
  output: string;
  /** The markdown record, project-relative; inspect/compare return a retained run snapshot. */
  path: string;
  /** inspect/compare: mutable compatibility alias for the latest completed review. */
  latestPath?: string | undefined;
  /** extract: the reference slug to pass to compare. */
  reference?: string | undefined;
  /** compare: overall fidelity 0..1 (the lowest axis). */
  score?: number | undefined;
  /** inspect: FAIL and WARN counts. */
  fails?: number | undefined;
  warns?: number | undefined;
}

export const designReferenceTool: Tool<DesignReferenceInput, DesignReferenceOutput> = {
  name: 'design_reference',
  category: 'Design',
  description:
    'Measure rendered pages in a browser instead of describing them. "extract" records a reference ' +
    'site’s design DNA (color roles, type scale, spacing unit, radii, motion, section rhythm) under ' +
    '.design/references; "compare" scores an implementation against it per axis; "inspect" is a ' +
    'reference-free FAIL/WARN gate (overflow, contrast, target size, type, broken media).',
  usageHint:
    '`design_reference {action:"extract", url:"https://example.com", maxPages:6}` writes `.design/references/example-com/{DESIGN.md,dna.md}` → build → ' +
    '`design_reference {action:"compare", reference:"example-com", url:"http://localhost:5173/"}`; ' +
    '`design_reference {action:"inspect", url:"http://localhost:5173/", surface:"app"}` before calling UI work done; ' +
    'a static page needs no server: `design_reference {action:"inspect", file:"index.html"}`.',
  permission: 'confirm',
  // A trust rule should name the site being opened, not the action.
  subjectKey: 'url',
  mutating: true,
  riskTier: 'standard',
  capabilities: [ToolCapabilities.NET_OUTBOUND, ToolCapabilities.FS_WRITE],
  // One browser session per viewport; the first use may install Chromium
  // (three-minute subprocess limit, as browser_open).
  timeoutMs: 420_000,
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['extract', 'compare', 'inspect'],
        description:
          'extract = measure url as a reference; compare = score url (or another reference via ' +
          'against) against reference; inspect = rendered quality gate for url.',
      },
      url: {
        type: 'string',
        description:
          'Absolute http(s) URL. A localhost dev server needs /browser allow <origin> first.',
      },
      file: {
        type: 'string',
        description:
          'Instead of url: a project-relative .html file (e.g. "index.html"). The tool serves the ' +
          'project on 127.0.0.1 for this call only — no dev server needed for static pages.',
      },
      name: {
        type: 'string',
        description: 'extract: reference slug to save as (default derived from the URL).',
      },
      viewports: {
        type: 'array',
        items: { type: 'integer', minimum: 320, maximum: 3840 },
        description: 'Viewport widths, 1–6 (default [1440, 1280, 1024, 768, 375]).',
      },
      pages: {
        type: 'array',
        items: { type: 'string' },
        description:
          'extract: additional http(s) subpage URLs (1–7) to analyze and merge into the reference DNA.',
      },
      maxPages: {
        type: 'integer',
        minimum: 1,
        maximum: 8,
        description:
          'extract: total number of pages (1–8) to analyze, auto-discovering same-origin internal links when > 1.',
      },
      reference: { type: 'string', description: 'compare: slug of the extracted reference.' },
      against: {
        type: 'string',
        description: 'compare: slug of another extracted reference, instead of measuring url.',
      },
      surface: {
        type: 'string',
        enum: ['page', 'app'],
        description:
          'inspect: "page" (marketing/content, default) or "app" (dense product screen — smaller body and more type sizes allowed).',
      },
      stage: {
        type: 'string',
        enum: ['hero', 'full'],
        description:
          'inspect: "hero" runs a fast 1280×800 + 375×800 fold gate before writing the rest of the page; "full" (default) runs all viewports.',
      },
    },
    required: ['action'],
  },
  async execute(input, ctx, opts): Promise<DesignReferenceOutput> {
    return executeDesignReference(input, ctx, opts?.signal ?? ctx?.signal);
  },
  async *executeStream(input, ctx, opts): AsyncGenerator<ToolStreamEvent<DesignReferenceOutput>> {
    const queue: ToolProgressEvent[] = [];
    let wake: (() => void) | undefined;
    let settled = false;
    const onProgress = (event: ToolProgressEvent) => {
      queue.push(event);
      wake?.();
    };
    const task = executeDesignReference(input, ctx, opts?.signal ?? ctx?.signal, onProgress);
    void task.then(
      () => {
        settled = true;
        wake?.();
      },
      () => {
        settled = true;
        wake?.();
      },
    );
    while (!settled || queue.length > 0) {
      if (queue.length > 0) {
        yield queue.shift()!;
      } else {
        await new Promise<void>((resolve) => {
          wake = resolve;
          if (settled || queue.length > 0) resolve();
        });
        wake = undefined;
      }
    }
    const output = await task;
    yield { type: 'final', output };
  },
};

async function executeDesignReference(
  input: DesignReferenceInput,
  ctx: Context,
  rawSignal?: AbortSignal | undefined,
  onProgress?: ((event: ToolProgressEvent) => void) | undefined,
): Promise<DesignReferenceOutput> {
  const signal = rawSignal ?? new AbortController().signal;
  signal.throwIfAborted();
  if (input.file !== undefined) {
    if (input.url !== undefined) {
      throw new ToolValidationError({
        message: 'design_reference: pass url or file, not both.',
        field: 'file',
      });
    }
    const file = String(input.file).trim();
    return withServedProjectFile(ctx.projectRoot, file, (url) =>
      runAction(
        { ...input, file: undefined, url },
        ctx,
        signal,
        { slug: fileSlug(file), name: file },
        onProgress,
      ),
    );
  }
  return runAction(input, ctx, signal, undefined, onProgress);
}

async function runAction(
  input: DesignReferenceInput,
  ctx: Context,
  signal: AbortSignal,
  page?: PageLabel,
  onProgress?: ((event: ToolProgressEvent) => void) | undefined,
): Promise<DesignReferenceOutput> {
  if (input.action === 'extract') {
    const result = await extractReference(ctx, input, signal, page, onProgress);
    return attachToolImages(
      {
        action: input.action,
        path: result.path,
        reference: result.slug,
        output: result.output,
      },
      result.images,
    );
  }
  if (input.action === 'compare') {
    const result = await compareReference(ctx, input, signal, page, onProgress);
    return attachToolImages(
      {
        action: input.action,
        path: result.path,
        latestPath: result.latestPath,
        score: result.overall,
        output: result.output,
      },
      result.images,
    );
  }
  if (input.action === 'inspect') {
    const result = await inspectPage(ctx, input, signal, page, onProgress);
    return attachToolImages(
      {
        action: input.action,
        path: result.path,
        latestPath: result.latestPath,
        fails: result.fails,
        warns: result.warns,
        output: result.output,
      },
      result.images,
    );
  }
  throw new ToolValidationError({
    message: `design_reference: unknown action "${String(input.action)}". Allowed actions: extract, compare, inspect.`,
    field: 'action',
  });
}
