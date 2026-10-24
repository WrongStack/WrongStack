import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Tool } from '@wrongstack/contracts/types';
import { ToolValidationError } from '@wrongstack/contracts/types';
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
  type InspectSurface,
  inspectDesign,
  renderDesignDnaMarkdown,
  renderDesignMd,
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

/** Desktop, tablet, phone — tablet is where layouts most often break. */
const DEFAULT_DNA_VIEWPORTS = [1440, 768, 390] as const;
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
    list.length > 4 ||
    list.some((w) => !Number.isInteger(w) || w < 320 || w > 3840)
  ) {
    throw new ToolValidationError({
      message:
        'design_reference: "viewports" takes 1–4 integer widths between 320 and 3840, e.g. [1440, 390].',
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
): Promise<Measured<T>> {
  const manager = managerFor(ctx);
  const ownerId = owner(ctx);
  const out: Measured<T> = { raws: [], runtime: [], screenshots: [] };
  // Screenshots of someone else's site must never become tracked repo files.
  await ensureDesignDir(ctx.projectRoot);
  await fs.mkdir(outDir, { recursive: true });
  for (const width of viewports) {
    signal.throwIfAborted();
    const session = await manager.open(
      ownerId,
      {
        url,
        viewport: { width, height: VIEWPORT_HEIGHT },
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

const rel = (projectRoot: string, file: string): string =>
  path.relative(projectRoot, file).replace(/\\/g, '/');

async function extractReference(
  ctx: Context,
  input: { url?: string | undefined; name?: string | undefined; viewports?: unknown },
  signal: AbortSignal,
  page?: PageLabel,
): Promise<{ slug: string; dna: DesignDna; output: string; path: string }> {
  const url = assertHttpUrl(input.url);
  const viewports = normalizeViewports(input.viewports);
  const slug = input.name
    ? assertSlug(input.name.trim(), 'name')
    : (page?.slug ?? referenceSlug(url));
  const dir = path.join(referencesDir(ctx.projectRoot), slug);
  const { raws, screenshots } = await measure<DesignDnaRaw>(ctx, url, viewports, dir, signal);
  const dna = summarizeDesignDna(raws);
  await writeJson(path.join(dir, 'raw.json'), raws);
  await writeJson(path.join(dir, 'dna.json'), dna);
  const markdown = renderDesignDnaMarkdown(dna);
  await atomicWrite(path.join(dir, 'dna.md'), markdown);
  const overrides = dnaToTokenOverrides(dna);
  // The measured system in the interchange format, for tools that read DESIGN.md.
  const light: Record<string, string> = {};
  const dark: Record<string, string> = {};
  for (const [key, value] of Object.entries(overrides)) {
    if (key.startsWith('light.')) light[key.slice(6)] = value;
    else if (key.startsWith('dark.')) dark[key.slice(5)] = value;
    else light[key] = dark[key] = value;
  }
  await atomicWrite(
    path.join(dir, 'DESIGN.md'),
    renderDesignMd({
      name: dna.source.title || slug,
      description: `Measured from ${dna.source.url} on ${dna.source.capturedAt.slice(0, 10)}; reference only — not a licence to copy the brand.`,
      tokens: dna.theme === 'dark' ? { light: dark, dark } : { light, dark: { ...light, ...dark } },
      overview: `Measured reference. Signals: ${dna.signals.join(', ') || 'none'}.`,
    }),
  );
  const output = [
    markdown.trimEnd(),
    '',
    `Saved: ${rel(ctx.projectRoot, dir)}/{dna.md,dna.json,raw.json,DESIGN.md} · screenshots ${screenshots
      .map((s) => rel(ctx.projectRoot, s.file))
      .join(
        ', ',
      )} — read the screenshots before naming patterns; numbers do not show imagery or tone.`,
    `Reference name for compare: "${slug}".`,
    '',
    'Carry the measured system into Design Studio (after pinning the closest kit with `design {action:"use"}`):',
    `design {action:"set", set:${JSON.stringify(overrides)}}`,
    'Learn the decisions, not the brand: do not copy logos, product imagery, copy or a licensed font you do not hold.',
  ].join('\n');
  return { slug, dna, output, path: rel(ctx.projectRoot, path.join(dir, 'dna.md')) };
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
): Promise<{ output: string; overall: number; path: string }> {
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
  if (input.against) {
    impl = await loadDna(ctx.projectRoot, input.against.trim(), 'against');
    implLabel = input.against.trim();
  } else {
    const url = assertHttpUrl(input.url);
    // Measure the implementation at the reference's own viewports unless told otherwise.
    const viewports =
      input.viewports === undefined ? ref.source.viewports : normalizeViewports(input.viewports);
    const dir = path.join(referencesDir(ctx.projectRoot), refSlug, 'implementation');
    const { raws } = await measure<DesignDnaRaw>(ctx, url, viewports, dir, signal);
    impl = summarizeDesignDna(raws);
    await writeJson(path.join(dir, 'dna.json'), impl);
    implLabel = page?.name ?? url;
  }
  const cmp = compareDesignDna(ref, impl);
  const markdown = renderDnaComparisonMarkdown(cmp, refSlug, implLabel);
  const file = path.join(referencesDir(ctx.projectRoot), refSlug, 'fidelity.md');
  await atomicWrite(file, `${markdown}\n`);
  return { output: markdown, overall: cmp.overall, path: rel(ctx.projectRoot, file) };
}

/**
 * `inspect` — reference-free rendered quality gate. FAIL
 * marks a defect, WARN a craft problem to fix or defend; the report lists
 * what the measurement cannot see so a clean result is not read as a review.
 */
async function inspectPage(
  ctx: Context,
  input: { url?: string | undefined; viewports?: unknown; surface?: string | undefined },
  signal: AbortSignal,
  page?: PageLabel,
): Promise<{ output: string; fails: number; warns: number; path: string }> {
  const url = assertHttpUrl(input.url);
  const viewports = normalizeViewports(input.viewports);
  if (input.surface !== undefined && input.surface !== 'page' && input.surface !== 'app') {
    throw new ToolValidationError({
      message:
        'design_reference: "surface" is "page" (marketing/content) or "app" (dense product screen).',
      field: 'surface',
    });
  }
  const surface: InspectSurface = input.surface ?? 'page';
  const dir = path.join(
    designProjectDir(ctx.projectRoot),
    'inspect',
    page?.slug ?? referenceSlug(url),
  );
  const { raws, runtime, screenshots } = await measure<DesignInspectRaw>(
    ctx,
    url,
    viewports,
    dir,
    signal,
    DESIGN_INSPECT_EXTRACTOR,
  );
  const report = inspectDesign(
    raws.map((raw, i) => ({ raw, runtime: runtime[i] })),
    surface,
  );
  const markdown = renderInspectMarkdown(report);
  await writeJson(path.join(dir, 'inspect.json'), report);
  await atomicWrite(path.join(dir, 'inspect.md'), markdown);
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
    path: rel(ctx.projectRoot, path.join(dir, 'inspect.md')),
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
  /** Viewport widths, default [1440, 768, 390]. */
  viewports?: number[] | undefined;
  /** compare: the extracted reference slug to score against. */
  reference?: string | undefined;
  /** compare: another extracted slug instead of measuring `url`. */
  against?: string | undefined;
  /** inspect: thresholds for a content "page" (default) or a dense "app" screen. */
  surface?: InspectSurface | undefined;
}

export interface DesignReferenceOutput {
  action: string;
  output: string;
  /** The markdown record the action wrote, project-relative. */
  path: string;
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
    '`design_reference {action:"extract", url:"https://example.com"}` → build → ' +
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
        description: 'Viewport widths, 1–4 (default [1440, 768, 390]).',
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
    },
    required: ['action'],
  },
  async execute(input, ctx, opts): Promise<DesignReferenceOutput> {
    const signal = opts?.signal ?? ctx?.signal ?? new AbortController().signal;
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
        runAction({ ...input, file: undefined, url }, ctx, signal, {
          slug: fileSlug(file),
          name: file,
        }),
      );
    }
    return runAction(input, ctx, signal);
  },
};

async function runAction(
  input: DesignReferenceInput,
  ctx: Context,
  signal: AbortSignal,
  page?: PageLabel,
): Promise<DesignReferenceOutput> {
  if (input.action === 'extract') {
    const result = await extractReference(ctx, input, signal, page);
    return {
      action: input.action,
      path: result.path,
      reference: result.slug,
      output: result.output,
    };
  }
  if (input.action === 'compare') {
    const result = await compareReference(ctx, input, signal, page);
    return {
      action: input.action,
      path: result.path,
      score: result.overall,
      output: result.output,
    };
  }
  if (input.action === 'inspect') {
    const result = await inspectPage(ctx, input, signal, page);
    return {
      action: input.action,
      path: result.path,
      fails: result.fails,
      warns: result.warns,
      output: result.output,
    };
  }
  throw new ToolValidationError({
    message: `design_reference: unknown action "${String(input.action)}". Allowed actions: extract, compare, inspect.`,
    field: 'action',
  });
}
