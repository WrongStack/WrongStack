import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { ToolValidationError } from '@wrongstack/contracts/types';
import {
  captureProjectWiring,
  DESIGN_JOBS,
  DESIGN_MATERIALS,
  type DesignKitAxes,
  type DesignKitLoader,
  type DesignPhotoOrientation,
  type DesignStack,
  diffDesignMd,
  ensureDesignDeal,
  ensureDesignDraw,
  ensureDesignPhotos,
  getDesignDeal,
  loadActiveKit,
  normalizeDesignJob,
  normalizeDesignMaterial,
  parseDesignMd,
  recordDesignChoice,
  renderDesignDeal,
  renderDesignDraw,
  renderDesignMd,
  renderDesignMdDiff,
  renderDesignPhotos,
  renderKeptWiringReport,
  resolveVerifyTokens,
  runKeptWiringCheck,
} from '@wrongstack/core/design';
import { atomicWrite } from '@wrongstack/core/utils';

/** The design tool's `ctx` slice these actions need. */
interface ActionCtx {
  projectRoot: string;
  meta: Record<string, unknown>;
}

interface ActionResult {
  action: string;
  kit?: string | undefined;
  source?: string | undefined;
  path?: string | undefined;
  output: string;
}

/**
 * `deal`: draw three kits for the session (seeded, recent choices left out).
 * `seed` reproduces a printed deal, `query` narrows the pool by kit wording,
 * `redeal` draws again.
 */
export async function dealAction(
  ctx: ActionCtx,
  loader: DesignKitLoader,
  input: {
    stack?: DesignStack | undefined;
    query?: string | undefined;
    seed?: string | undefined;
    redeal?: boolean;
  },
): Promise<ActionResult> {
  const { deal, entries } = await ensureDesignDeal(ctx, loader, input);
  if (entries.length === 0) throw new Error('design: no kits are installed to deal from.');
  return {
    action: 'deal',
    output:
      `${renderDesignDeal(deal, entries)}\n\n` +
      'Pin with `design {action:"use", kit:"<id>", stack:"<stack>"}`.',
  };
}

/**
 * Gate on `use` when a deal exists: a kit outside it needs a stated reason.
 * Without a deal the choice is free (the pre-deal flow). Records the choice
 * either way so later deals leave recently used kits out.
 */
export async function checkDealtChoice(
  ctx: ActionCtx,
  kitId: string,
  reason: string | undefined,
  axes?: DesignKitAxes | undefined,
): Promise<string> {
  const deal = getDesignDeal(ctx);
  const dealt = deal ? deal.kits.includes(kitId) : false;
  const why = reason?.trim();
  if (deal && !dealt && !why) {
    throw new ToolValidationError({
      message:
        `design: "${kitId}" is outside this session's deal (${deal.kits.join(', ')}). ` +
        'Choose a dealt kit, or pass `reason` saying why the product needs this one — it is recorded.',
      field: 'reason',
    });
  }
  await recordDesignChoice(ctx.projectRoot, {
    kit: kitId,
    dealt,
    axes,
    reason: why || undefined,
  });
  return deal && !dealt ? `\nChosen outside the deal: ${why}\n` : '';
}

/**
 * `draw`: deal a job-native + material-native page anatomy (macrostructure,
 * opening hero, nav, sections, footer, and 2 overused compositions to skip).
 */
export async function drawAction(
  ctx: ActionCtx,
  loader: DesignKitLoader,
  input: {
    job?: string | undefined;
    material?: string | undefined;
    seed?: string | undefined;
    redeal?: boolean;
  },
): Promise<ActionResult> {
  const job = normalizeDesignJob(input.job);
  if (!job) {
    throw new ToolValidationError({
      message: `design: "draw" requires a valid job (${DESIGN_JOBS.join(', ')}). Got: ${JSON.stringify(input.job ?? '')}`,
      field: 'job',
    });
  }
  const material = normalizeDesignMaterial(input.material ?? 'product');
  if (!material) {
    throw new ToolValidationError({
      message: `design: invalid material "${input.material}". Allowed materials: ${DESIGN_MATERIALS.join(', ')}`,
      field: 'material',
    });
  }
  const active = await loadActiveKit(ctx.projectRoot).catch(() => undefined);
  const manifest = active?.kit ? await loader.find(active.kit) : undefined;
  const drawn = await ensureDesignDraw(ctx, {
    job,
    material,
    seed: input.seed,
    redeal: input.redeal,
    kitPictured: manifest?.pictured,
  });
  return {
    action: 'draw',
    kit: active?.kit,
    output: renderDesignDraw(drawn),
  };
}

/**
 * `snapshot`: record existing routes, form field names, `data-testid`s, and named
 * event handlers into `.design/before.json` before starting a redesign.
 */
export async function snapshotAction(
  ctx: ActionCtx,
  files: string[] | undefined,
  assertProjectRelative: (files: string[], projectRoot: string, label: string) => Promise<void>,
): Promise<ActionResult> {
  if (files?.length) {
    await assertProjectRelative(files, ctx.projectRoot, 'snapshot file');
  }
  const { snapshot, relPath } = await captureProjectWiring(ctx.projectRoot, files);
  const total =
    snapshot.links.length +
    snapshot.formFields.length +
    snapshot.testIds.length +
    snapshot.handlers.length;
  return {
    action: 'snapshot',
    path: relPath,
    output:
      `Saved pre-redesign wiring snapshot (${total} contract(s): ${snapshot.links.length} link(s), ` +
      `${snapshot.formFields.length} form field(s), ${snapshot.testIds.length} testid(s), ` +
      `${snapshot.handlers.length} handler(s) across ${snapshot.files.length} file(s)) → ${relPath}.\n` +
      'Run `design {action:"kept"}` after the redesign to verify zero routes, inputs, or handlers were dropped.',
  };
}

/**
 * `kept`: verify all pre-redesign wiring recorded in `.design/before.json`
 * survived the redesign unless explicitly listed in `drop`.
 */
export async function keptAction(
  ctx: ActionCtx,
  files: string[] | undefined,
  drop: string[] | undefined,
  assertProjectRelative: (files: string[], projectRoot: string, label: string) => Promise<void>,
): Promise<ActionResult & { violations?: number | undefined }> {
  if (files?.length) {
    await assertProjectRelative(files, ctx.projectRoot, 'kept file');
  }
  const report = await runKeptWiringCheck(ctx.projectRoot, {
    explicitFiles: files,
    allowRemoved: drop,
  });
  return {
    action: 'kept',
    path: '.design/before.json',
    violations: report.missing.length,
    output: renderKeptWiringReport(report),
  };
}

/**
 * `photos`: rank bundled open-licensed Wikimedia Commons photographs for one or
 * more concrete subjects (`;` or `,` separated), aligned to the active kit's
 * paper/accent axes, and emit `[data-slot]` markup + `data-credits` attribution.
 */
export async function photosAction(
  ctx: ActionCtx,
  loader: DesignKitLoader,
  input: {
    query?: string | undefined;
    orient?: string | undefined;
    seed?: string | undefined;
  },
): Promise<ActionResult> {
  const queries = (input.query ?? '')
    .split(/[;|,]/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (queries.length === 0) {
    throw new ToolValidationError({
      message:
        'design: "photos" requires `query` naming concrete subjects (e.g. "pottery studio; ceramic bowls").',
      field: 'query',
    });
  }
  if (
    input.orient !== undefined &&
    input.orient !== 'landscape' &&
    input.orient !== 'portrait' &&
    input.orient !== 'square'
  ) {
    throw new ToolValidationError({
      message: 'design: "orient" must be "landscape", "portrait", or "square".',
      field: 'orient',
    });
  }
  const active = await loadActiveKit(ctx.projectRoot);
  const manifest = active ? await loader.find(active.kit) : undefined;
  const result = await ensureDesignPhotos(ctx.projectRoot, {
    queries,
    orientation: input.orient as DesignPhotoOrientation | undefined,
    axes: manifest?.axes,
    kitId: manifest?.id,
    photoTreatment: manifest?.photo,
    seed: input.seed,
  });
  return {
    action: 'photos',
    kit: manifest?.id,
    output: renderDesignPhotos(result),
  };
}

/** `document`: write the pinned kit or captured tokens as a linted DESIGN.md. */
export async function documentAction(
  ctx: ActionCtx,
  loader: DesignKitLoader,
  input: { out?: string | undefined; force?: boolean | undefined },
  assertProjectRelative: (files: string[], projectRoot: string, label: string) => Promise<void>,
): Promise<ActionResult> {
  const source = await resolveVerifyTokens(ctx.projectRoot);
  if (!source) {
    throw new Error(
      'design: nothing to document (no active kit, no captured tokens). Pin a kit with ' +
        '`design {action:"use", kit:"<id>"}` or capture the project’s tokens with ' +
        '`design {action:"capture"}`.',
    );
  }
  const manifest = source.kit ? await loader.find(source.kit) : undefined;
  const markdown = renderDesignMd({
    name: manifest?.name ?? path.basename(path.resolve(ctx.projectRoot)),
    description: manifest
      ? `Design Studio kit ${manifest.id} with project overrides.`
      : `Captured from ${source.files?.join(', ') ?? 'the project'}.`,
    tokens: source.tokens,
    overview: manifest?.aesthetic,
  });
  const outRel = input.out ?? 'DESIGN.md';
  await assertProjectRelative([outRel], ctx.projectRoot, 'document path');
  const abs = path.resolve(ctx.projectRoot, outRel);
  const exists = await fs
    .access(abs)
    .then(() => true)
    .catch(() => false);
  if (exists && !input.force) {
    throw new Error(
      `design: ${outRel} already exists — nothing was written. Re-run with force:true to overwrite.`,
    );
  }
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await atomicWrite(abs, markdown);
  const issues = parseDesignMd(markdown).issues.filter((i) => i.severity !== 'info');
  return {
    action: 'document',
    kit: source.kit,
    source: source.source,
    path: outRel,
    output:
      `Wrote ${outRel} (${source.source === 'kit' ? `kit ${source.kit}` : 'captured tokens'}). ` +
      'The front matter is normative (colors incl. dark-<role>, typography, rounded, spacing, ' +
      'components); edit the prose sections with the product’s real direction. ' +
      '`design {action:"capture"}` reads it back as the token source.' +
      (issues.length
        ? `\nLint: ${issues.map((i) => `[${i.rule}] ${i.message}`).join('; ')}`
        : '\nLint: clean.'),
  };
}

async function readDesignMdDoc(projectRoot: string, rel: string) {
  let text: string;
  try {
    text = await fs.readFile(path.resolve(projectRoot, rel), 'utf8');
  } catch {
    throw new ToolValidationError({ message: `design: cannot read ${rel}`, field: 'files' });
  }
  const parsed = parseDesignMd(text);
  if (!parsed.doc) {
    throw new Error(
      `design: ${rel} is not a readable DESIGN.md: ${parsed.issues.map((i) => i.message).join('; ')}`,
    );
  }
  return parsed;
}

/**
 * `diff`: token regressions between two DESIGN.md versions (files:[before,
 * after]), or between a DESIGN.md and the active system (files:[path]).
 */
export async function diffAction(
  ctx: ActionCtx,
  loader: DesignKitLoader,
  files: string[] | undefined,
  assertProjectRelative: (files: string[], projectRoot: string, label: string) => Promise<void>,
): Promise<ActionResult> {
  const list = files?.length ? files : ['DESIGN.md'];
  if (list.length > 2) {
    throw new ToolValidationError({
      message:
        'design: diff takes files:[before, after] or files:[DESIGN.md] (against the active system).',
      field: 'files',
    });
  }
  await assertProjectRelative(list, ctx.projectRoot, 'diff file');
  const before = await readDesignMdDoc(ctx.projectRoot, list[0] as string);
  let after: ReturnType<typeof parseDesignMd>;
  let label: string;
  if (list.length === 2) {
    after = await readDesignMdDoc(ctx.projectRoot, list[1] as string);
    label = `${list[0]} → ${list[1]}`;
  } else {
    const source = await resolveVerifyTokens(ctx.projectRoot);
    if (!source) {
      throw new Error(
        'design: no active system to compare with. Pass files:[before, after], or pin a kit first.',
      );
    }
    const manifest = source.kit ? await loader.find(source.kit) : undefined;
    after = parseDesignMd(
      renderDesignMd({ name: manifest?.name ?? 'active system', tokens: source.tokens }),
    );
    label = `${list[0]} → active ${source.source === 'kit' ? `kit ${source.kit}` : 'captured tokens'}`;
  }
  if (!before.doc || !after.doc) throw new Error('design: nothing to compare.');
  const changes = diffDesignMd(before.doc, after.doc);
  const lintErrors = after.issues.filter((i) => i.severity === 'error');
  return {
    action: 'diff',
    output:
      renderDesignMdDiff(changes, label) +
      (lintErrors.length
        ? `\nLint errors in the newer version: ${lintErrors.map((i) => `[${i.rule}] ${i.message}`).join('; ')}`
        : '') +
      (changes.some((c) => c.severity === 'FAIL')
        ? '\nFAIL is a regression (AA contrast lost, a reference broken): fix it or state why in the change.'
        : ''),
  };
}
