/**
 * Safe Redesign Wiring Preservation (`design {action:"snapshot"}` / `design {action:"kept"}`).
 *
 * Restyling an existing product frequently drops routes (`href`/`to`), form field
 * `name`s, `data-testid` hooks, or named event handlers (`onClick={handleSave}`)
 * in the name of visual cleanup. `extractSourceWiring` snapshots those contracts
 * into `.design/before.json` before a redesign, and `verifyKeptWiring` proves none
 * vanished silently afterward unless explicitly listed in `allowRemoved`.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { designProjectDir, ensureDesignDir } from './design-project-store.js';
import { markCommentLines } from './design-verify.js';
import { collectProjectUiFiles } from './design-verify-run.js';

export type WiringCategory = 'link' | 'formField' | 'testId' | 'handler';

export interface DesignWiringSnapshot {
  v: 1;
  capturedAt: string;
  files: string[];
  links: string[];
  formFields: string[];
  testIds: string[];
  handlers: string[];
}

export interface MissingWiringItem {
  category: WiringCategory;
  value: string;
}

export interface KeptWiringReport {
  ok: boolean;
  filesBefore: string[];
  filesAfter: string[];
  totalBefore: number;
  keptCount: number;
  missing: MissingWiringItem[];
  waived: MissingWiringItem[];
}

const HREF_TO_RE = /\b(?:href|to)=["']([^"']+)["']/g;
const FORM_CONTROL_TAG_RE = /<(?:input|select|textarea)\b[^>]*>/gi;
const FORM_ACTION_RE = /<form\b[^>]*\baction=["']([^"']+)["']/gi;
const NAME_ATTR_RE = /\bname=["']([^"']+)["']/;
const TEST_ID_RE = /\bdata-testid=["']([^"']+)["']/g;
const NAMED_HANDLER_RE =
  /\bon(?:Click|Submit|Change|Input|KeyDown|KeyUp|Select|Focus|Blur|Close|Open|Delete|Save)=\{\s*([A-Za-z_$][\w$.]*)\s*\}/g;

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

/**
 * Pure source-level wiring extractor over UI files (HTML, JSX/TSX, Vue, Svelte, Astro).
 */
export function extractSourceWiring(
  files: readonly { path: string; text: string }[],
  capturedAt: string = new Date().toISOString(),
): DesignWiringSnapshot {
  const links = new Set<string>();
  const formFields = new Set<string>();
  const testIds = new Set<string>();
  const handlers = new Set<string>();

  for (const file of files) {
    if (/\.(css|scss|sass|less)$/i.test(file.path)) continue;
    const rawLines = file.text.split('\n');
    const commentMask = markCommentLines(rawLines);
    const activeText = rawLines.map((l, i) => (commentMask[i] ? '' : l)).join('\n');

    HREF_TO_RE.lastIndex = 0;
    for (const m of activeText.matchAll(HREF_TO_RE)) {
      const target = (m[1] ?? '').trim();
      if (!target || target === '#' || /^javascript:/i.test(target)) continue;
      // Skip external stylesheet/font links in <head>.
      if (/fonts\.googleapis\.com|api\.fontshare\.com|\.css(?:\?|$)/i.test(target)) continue;
      links.add(target);
    }

    FORM_CONTROL_TAG_RE.lastIndex = 0;
    for (const m of activeText.matchAll(FORM_CONTROL_TAG_RE)) {
      const nameMatch = NAME_ATTR_RE.exec(m[0]);
      if (nameMatch?.[1]?.trim()) {
        formFields.add(nameMatch[1].trim());
      }
    }

    FORM_ACTION_RE.lastIndex = 0;
    for (const m of activeText.matchAll(FORM_ACTION_RE)) {
      const act = (m[1] ?? '').trim();
      if (act && act !== '#') formFields.add(`action:${act}`);
    }

    TEST_ID_RE.lastIndex = 0;
    for (const m of activeText.matchAll(TEST_ID_RE)) {
      const tid = (m[1] ?? '').trim();
      if (tid) testIds.add(tid);
    }

    NAMED_HANDLER_RE.lastIndex = 0;
    for (const m of activeText.matchAll(NAMED_HANDLER_RE)) {
      const fn = (m[1] ?? '').trim();
      if (fn && fn !== 'undefined' && fn !== 'null') handlers.add(fn);
    }
  }

  return {
    v: 1,
    capturedAt,
    files: files.map((f) => f.path.replace(/\\/g, '/')).sort((a, b) => a.localeCompare(b)),
    links: sortedUnique(links),
    formFields: sortedUnique(formFields),
    testIds: sortedUnique(testIds),
    handlers: sortedUnique(handlers),
  };
}

export function beforeSnapshotPath(projectRoot: string): string {
  return path.join(designProjectDir(projectRoot), 'before.json');
}

export async function saveWiringSnapshot(
  projectRoot: string,
  snapshot: DesignWiringSnapshot,
): Promise<string> {
  await ensureDesignDir(projectRoot);
  const abs = beforeSnapshotPath(projectRoot);
  await fs.writeFile(abs, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
  return path.relative(projectRoot, abs).replace(/\\/g, '/');
}

export async function loadWiringSnapshot(
  projectRoot: string,
): Promise<DesignWiringSnapshot | undefined> {
  try {
    const raw = JSON.parse(
      (await fs.readFile(beforeSnapshotPath(projectRoot), 'utf8')).replace(/^\uFEFF/, ''),
    ) as DesignWiringSnapshot;
    return raw?.v === 1 ? raw : undefined;
  } catch {
    return undefined;
  }
}

export async function captureProjectWiring(
  projectRoot: string,
  explicitFiles?: string[] | undefined,
): Promise<{ snapshot: DesignWiringSnapshot; relPath: string }> {
  const files = await collectProjectUiFiles(projectRoot, explicitFiles);
  const snapshot = extractSourceWiring(files);
  const relPath = await saveWiringSnapshot(projectRoot, snapshot);
  return { snapshot, relPath };
}

export function verifyKeptWiring(
  before: DesignWiringSnapshot,
  after: DesignWiringSnapshot,
  options?: { allowRemoved?: readonly string[] | undefined },
): KeptWiringReport {
  const allowed = new Set((options?.allowRemoved ?? []).map((s) => s.trim()).filter(Boolean));
  const missing: MissingWiringItem[] = [];
  const waived: MissingWiringItem[] = [];
  let keptCount = 0;

  const checkCategory = (
    category: WiringCategory,
    prevList: readonly string[],
    nextList: readonly string[],
  ) => {
    const nextSet = new Set(nextList);
    for (const value of prevList) {
      if (nextSet.has(value)) {
        keptCount++;
      } else if (allowed.has(value) || allowed.has(`${category}:${value}`)) {
        waived.push({ category, value });
      } else {
        missing.push({ category, value });
      }
    }
  };

  checkCategory('link', before.links, after.links);
  checkCategory('formField', before.formFields, after.formFields);
  checkCategory('testId', before.testIds, after.testIds);
  checkCategory('handler', before.handlers, after.handlers);

  const totalBefore =
    before.links.length + before.formFields.length + before.testIds.length + before.handlers.length;

  return {
    ok: missing.length === 0,
    filesBefore: before.files,
    filesAfter: after.files,
    totalBefore,
    keptCount,
    missing,
    waived,
  };
}

export async function runKeptWiringCheck(
  projectRoot: string,
  options?: { explicitFiles?: string[] | undefined; allowRemoved?: readonly string[] | undefined },
): Promise<KeptWiringReport> {
  const before = await loadWiringSnapshot(projectRoot);
  if (!before) {
    throw new Error(
      'design kept: no `.design/before.json` snapshot found. Run `design {action:"snapshot"}` BEFORE starting a redesign.',
    );
  }
  const targetFiles =
    options?.explicitFiles && options.explicitFiles.length > 0 ? options.explicitFiles : undefined;
  const files = await collectProjectUiFiles(projectRoot, targetFiles);
  const after = extractSourceWiring(files);
  return verifyKeptWiring(before, after, { allowRemoved: options?.allowRemoved });
}

export function renderKeptWiringReport(report: KeptWiringReport): string {
  const header = report.ok
    ? `Gate: PASS — kept ${report.keptCount}/${report.totalBefore} pre-redesign wiring contract(s)${report.waived.length ? ` (${report.waived.length} explicitly dropped)` : ''}.`
    : `Gate: FAIL — ${report.missing.length} pre-redesign wiring contract(s) were dropped (${report.keptCount}/${report.totalBefore} kept).`;

  const lines = [header];
  if (report.missing.length > 0) {
    lines.push(
      '',
      'Dropped wiring (restore in markup or pass `drop:[…]` if intentionally removed):',
    );
    for (const item of report.missing) {
      lines.push(`- [${item.category}] \`${item.value}\``);
    }
  }
  if (report.waived.length > 0) {
    lines.push(
      '',
      `Explicitly dropped: ${report.waived.map((w) => `${w.category}:${w.value}`).join(', ')}`,
    );
  }
  return lines.join('\n');
}
