import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { ToolValidationError } from '@wrongstack/contracts/types';
import {
  type DesignKitLoader,
  type DesignStack,
  diffDesignMd,
  ensureDesignDeal,
  getDesignDeal,
  parseDesignMd,
  recordDesignChoice,
  renderDesignDeal,
  renderDesignMd,
  renderDesignMdDiff,
  resolveVerifyTokens,
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
  await recordDesignChoice(ctx.projectRoot, { kit: kitId, dealt, reason: why || undefined });
  return deal && !dealt ? `\nChosen outside the deal: ${why}\n` : '';
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
