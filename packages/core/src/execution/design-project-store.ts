/**
 * Project-local Design Studio store — a gitignored `<project>/.design/` directory
 * that persists design DECISIONS and project-specific design RULES across
 * sessions, separate from the committed `.wrongstack/design-kits/` (shared
 * custom kits). Layout:
 *
 *   .design/.gitignore   `*`  — self-ignores so the dir is untracked in ANY repo
 *   .design/rules.md     project design rules (always injected when UI work is active)
 *   .design/active.json  { kit, stack } — the pinned kit, restored on session start
 *   .design/decisions.md append-only log of kit choices (timestamp · kit · stack · via)
 *
 * All writes are best-effort: a failure here must never break the tool, slash
 * command, or a turn.
 */

import { existsSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { DesignKitTokens } from '@wrongstack/contracts/types/design-kit';
import { withFileLock } from '../utils/atomic-write.js';
import { getDesignKitLoader } from './design-kit-loader.js';

const DESIGN_DIR = '.design';

export function designProjectDir(projectRoot: string): string {
  return path.join(projectRoot, DESIGN_DIR);
}

const RULE_FILES = ['rules.md', 'RULES.md', 'design.md'];

/**
 * True when `file` (or, while it is absent, its directory) resolves inside the
 * project. `.design/` is self-ignored only when WrongStack creates it: a cloned
 * repo can commit it — and `PRODUCT.md` — as symlinks. Followed, a link put any
 * host file into the system prompt (rules, brief) and a kit choice overwrote
 * the target of `active.json`. A dangling link is refused: writing it would
 * create its target.
 */
export async function insideDesignProject(projectRoot: string, file: string): Promise<boolean> {
  const inside = (real: string, root: string): boolean => {
    const rel = path.relative(root, real);
    return !(rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel));
  };
  try {
    const root = await fs.realpath(projectRoot);
    try {
      return inside(await fs.realpath(file), root);
    } catch {
      const isLink = await fs
        .lstat(file)
        .then((st) => st.isSymbolicLink())
        .catch(() => false);
      if (isLink) return false;
      const dir = await fs.realpath(path.dirname(file)).catch(() => undefined);
      return dir === undefined || inside(dir, root);
    }
  } catch {
    return false;
  }
}

async function assertInsideDesignProject(projectRoot: string, file: string): Promise<void> {
  if (!(await insideDesignProject(projectRoot, file))) {
    throw new Error(`design: ${file} links outside the project; not written`);
  }
}

/** Read current rules, including files created or revised during this session. */
export async function loadProjectDesignRules(projectRoot: string): Promise<string | undefined> {
  for (const name of RULE_FILES) {
    try {
      const file = path.join(designProjectDir(projectRoot), name);
      if (!(await insideDesignProject(projectRoot, file))) continue;
      const txt = await fs.readFile(file, 'utf8');
      if (txt.trim()) {
        return txt.trim();
      }
    } catch {
      // file absent — try next
    }
  }
  return undefined;
}

/**
 * User color/token overrides. Keys are token names (`primary`, `bg`, …) applied
 * to BOTH themes, or theme-scoped (`light.primary`, `dark.bg`). Values are any
 * token string (OKLCH/hex). These override kit `tokens.json` everywhere tokens
 * are consumed — the `use` snapshot, `materialize`, and `verify`.
 */
export type DesignOverrides = Record<string, string>;

export interface PersistedActiveKit {
  kit: string;
  stack?: string | undefined;
  overrides?: DesignOverrides | undefined;
}

function parseOverrides(value: unknown): DesignOverrides | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const out: DesignOverrides = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === 'string' && v.trim()) out[k] = v.trim();
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Read the persisted active kit from `.design/active.json`, if any. */
export async function loadActiveKit(projectRoot: string): Promise<PersistedActiveKit | undefined> {
  try {
    const file = path.join(designProjectDir(projectRoot), 'active.json');
    if (!(await insideDesignProject(projectRoot, file))) return undefined;
    const raw = await fs.readFile(file, 'utf8');
    const parsed = JSON.parse(raw) as { kit?: unknown; stack?: unknown; overrides?: unknown };
    if (parsed && typeof parsed.kit === 'string') {
      return {
        kit: parsed.kit,
        stack: typeof parsed.stack === 'string' ? parsed.stack : undefined,
        overrides: parseOverrides(parsed.overrides),
      };
    }
  } catch {
    // absent or malformed — no persisted kit
  }
  return undefined;
}

/**
 * Apply token overrides onto a kit's light/dark token sets. A bare key
 * (`primary`) is applied to both themes; a scoped key (`light.bg`/`dark.bg`)
 * only to that theme. Returns NEW objects — never mutates the input.
 */
export function applyTokenOverrides<
  T extends {
    light?: Record<string, string> | undefined;
    dark?: Record<string, string> | undefined;
  },
>(tokens: T, overrides: DesignOverrides | undefined): T {
  if (!overrides || Object.keys(overrides).length === 0) return tokens;
  const light = { ...(tokens.light ?? {}) };
  const dark = { ...(tokens.dark ?? {}) };
  for (const [key, val] of Object.entries(overrides)) {
    // Only a `light.`/`dark.` prefix is theme-scoping. Any other dotted key
    // (or a bare key) is a LITERAL token name applied to both themes — so
    // kebab-scale names never collide, and a stray `foo.bar` isn't silently
    // dropped (the old code matched `dot > 0` but only acted on light/dark).
    const dot = key.indexOf('.');
    const theme = dot > 0 ? key.slice(0, dot) : '';
    if (theme === 'light') {
      light[key.slice(dot + 1)] = val;
    } else if (theme === 'dark') {
      dark[key.slice(dot + 1)] = val;
    } else {
      light[key] = val;
      dark[key] = val;
    }
  }
  return { ...tokens, light, dark };
}

export async function ensureDesignDir(projectRoot: string): Promise<string> {
  const dir = designProjectDir(projectRoot);
  await fs.mkdir(dir, { recursive: true });
  // Self-ignore: a `.gitignore` of `*` makes the whole directory untracked in
  // any project, so design decisions never pollute the repo and we don't have
  // to edit the project's root .gitignore.
  const gi = path.join(dir, '.gitignore');
  if (!existsSync(gi) && (await insideDesignProject(projectRoot, gi))) {
    try {
      await fs.writeFile(gi, '*\n');
    } catch {
      // best-effort
    }
  }
  return dir;
}

/**
 * Persist a kit choice: update `active.json` and append to `decisions.md`.
 * `isoTime` is passed in so callers control the timestamp (and tests stay
 * deterministic). Best-effort — swallows all errors.
 */
export async function recordKitChoice(
  projectRoot: string,
  kit: string,
  stack: string | undefined,
  source: string,
  isoTime: string,
  overrides?: DesignOverrides | undefined,
): Promise<void> {
  try {
    const dir = await ensureDesignDir(projectRoot);
    const record: Record<string, unknown> = { kit, stack: stack ?? null };
    if (overrides && Object.keys(overrides).length > 0) record.overrides = overrides;
    const active = path.join(dir, 'active.json');
    await assertInsideDesignProject(projectRoot, active);
    // Under the same lock as checked override writes, so neither lands inside the other.
    await withFileLock(active, async () => {
      await fs.writeFile(active, `${JSON.stringify(record, null, 2)}\n`);
      await assertInsideDesignProject(projectRoot, path.join(dir, 'decisions.md'));
      const line = `- ${isoTime} · kit=${kit}${stack ? ` stack=${stack}` : ''} · via=${source}\n`;
      await fs.appendFile(path.join(dir, 'decisions.md'), line);
    });
  } catch {
    // best-effort: never break the caller
  }
}

/** The kit, or a reviewed override value, changed before a checked override write. */
export class DesignOverridesChanged extends Error {
  constructor() {
    super('The design kit or a reviewed override changed since it was read.');
    this.name = 'DesignOverridesChanged';
  }
}

/** What a caller reviewed: the pinned kit and, per key, the value it saw ('' = no override). */
export interface DesignOverridesExpectation {
  kit: string;
  values?: Record<string, string> | undefined;
}

/**
 * Merge color/token overrides into `active.json` WITHOUT changing the pinned
 * kit (used by `design set primary=…`). Returns the merged override map, or
 * undefined if there is no active kit to attach them to. Best-effort on write.
 */
export async function recordOverrides(
  projectRoot: string,
  patch: DesignOverrides,
  isoTime: string,
  expected?: DesignOverridesExpectation | undefined,
): Promise<DesignOverrides | undefined> {
  // A project without a pinned kit gets no `.design/` directory (or lock) from this call.
  if (!(await loadActiveKit(projectRoot))) return undefined;
  const merge = (active: PersistedActiveKit): DesignOverrides => {
    const merged: DesignOverrides = { ...(active.overrides ?? {}) };
    for (const [k, v] of Object.entries(patch)) {
      if (v?.trim()) merged[k] = v.trim();
      else delete merged[k]; // empty value clears an override
    }
    return merged;
  };
  let dir: string;
  try {
    dir = await ensureDesignDir(projectRoot);
    await assertInsideDesignProject(projectRoot, path.join(dir, 'active.json'));
  } catch {
    // Best-effort, as before: report the merge without persisting it.
    const active = await loadActiveKit(projectRoot);
    return active ? merge(active) : undefined;
  }
  const file = path.join(dir, 'active.json');
  // Read, compare and write under the file's lock, so another runtime's kit choice or override
  // write cannot land between this read and the write.
  return withFileLock(file, async () => {
    const active = await loadActiveKit(projectRoot);
    if (!active) return undefined;
    if (
      expected &&
      (active.kit !== expected.kit ||
        Object.entries(expected.values ?? {}).some(
          ([key, value]) => (active.overrides?.[key] ?? '') !== value.trim(),
        ))
    )
      throw new DesignOverridesChanged();
    const merged = merge(active);
    try {
      const record: Record<string, unknown> = { kit: active.kit, stack: active.stack ?? null };
      if (Object.keys(merged).length > 0) record.overrides = merged;
      await fs.writeFile(file, `${JSON.stringify(record, null, 2)}\n`);
      await assertInsideDesignProject(projectRoot, path.join(dir, 'decisions.md'));
      const keys = Object.keys(patch).join(',');
      await fs.appendFile(
        path.join(dir, 'decisions.md'),
        `- ${isoTime} · kit=${active.kit} · override=${keys} · via=set\n`,
      );
    } catch {
      // best-effort
    }
    return merged;
  });
}

/** Clear the persisted active kit (e.g. `/design off`). Best-effort. */
export async function clearPersistedActiveKit(projectRoot: string): Promise<void> {
  try {
    await fs.rm(path.join(designProjectDir(projectRoot), 'active.json'), { force: true });
  } catch {
    // best-effort
  }
}

/** @deprecated Rules are read fresh; retained for existing test-helper callers. */
export function _resetDesignRulesCache(): void {
  // No process-lifetime cache: it hid rules written after the first UI request.
}

// ── captured project tokens (kit-less verify) ────────────────────────────────

/**
 * The project's OWN token system, snapshotted by `design capture` into
 * `.design/captured-tokens.json`. Lets the verify loop (tool + write-time
 * middleware) run against an established system without pinning a kit — the
 * "middle case" design-critique documents as the common one in mature
 * codebases.
 */
export interface CapturedTokens {
  stack: string;
  capturedAt: string;
  files: string[];
  tokens: DesignKitTokens;
  /** `[data-palette]` variant blocks, recorded separately by capture (informational). */
  palettes?: Record<string, Record<string, string>> | undefined;
}

const CAPTURED_FILE = 'captured-tokens.json';

/** Persist a capture (best-effort). Returns the project-relative path used. */
export async function saveCapturedTokens(
  projectRoot: string,
  captured: {
    stack: string;
    files: string[];
    tokens: DesignKitTokens;
    palettes?: Record<string, Record<string, string>>;
    capturedAt?: string;
  },
): Promise<string> {
  const dir = await ensureDesignDir(projectRoot);
  const record: CapturedTokens = {
    stack: captured.stack,
    capturedAt: captured.capturedAt ?? new Date().toISOString(),
    files: captured.files,
    tokens: captured.tokens,
    ...(captured.palettes ? { palettes: captured.palettes } : {}),
  };
  const rel = path.join(DESIGN_DIR, CAPTURED_FILE);
  await assertInsideDesignProject(projectRoot, path.join(dir, CAPTURED_FILE));
  await fs.writeFile(path.join(dir, CAPTURED_FILE), `${JSON.stringify(record, null, 2)}\n`);
  return rel;
}

/** Read the persisted capture, if any (absent/malformed → undefined). */
export async function loadCapturedTokens(projectRoot: string): Promise<CapturedTokens | undefined> {
  try {
    const file = path.join(designProjectDir(projectRoot), CAPTURED_FILE);
    if (!(await insideDesignProject(projectRoot, file))) return undefined;
    const raw = await fs.readFile(file, 'utf8');
    const parsed = JSON.parse(raw) as Partial<CapturedTokens>;
    if (parsed?.tokens && (parsed.tokens.light || parsed.tokens.dark)) {
      return {
        stack: parsed.stack ?? 'web',
        capturedAt: parsed.capturedAt ?? '',
        files: parsed.files ?? [],
        tokens: parsed.tokens,
        palettes: parsed.palettes,
      };
    }
  } catch {
    // absent or malformed — no capture
  }
  return undefined;
}

/** Remove the persisted capture (e.g. the token source moved). Best-effort. */
export async function clearCapturedTokens(projectRoot: string): Promise<void> {
  try {
    await fs.rm(path.join(designProjectDir(projectRoot), CAPTURED_FILE), { force: true });
  } catch {
    // best-effort
  }
}

export interface VerifyTokenSource {
  /** Override-applied (kit) or as-captured (project) token sets. */
  tokens: DesignKitTokens;
  source: 'kit' | 'captured';
  /** Kit id when source === 'kit'. */
  kit?: string | undefined;
  /** Project-relative files the capture came from, when source === 'captured'. */
  files?: string[] | undefined;
}

/**
 * Resolve the token basis for the verify loop. A pinned kit ALWAYS wins — an
 * explicit commitment outranks a snapshot; if the pinned kit's tokens are
 * unreadable, undefined is returned (never a silent fallback to the capture,
 * which would report drift against the wrong basis). Without a pin, the
 * captured project tokens serve as the kit-less middle case.
 */
export async function resolveVerifyTokens(
  projectRoot: string,
): Promise<VerifyTokenSource | undefined> {
  const active = await loadActiveKit(projectRoot).catch(() => undefined);
  if (active) {
    const loader = getDesignKitLoader(projectRoot);
    // readTokens() merges the foundations base under ANY id, so it never
    // returns undefined for an unknown kit — check the manifest explicitly.
    // A pin that no longer resolves reports nothing rather than silently
    // switching basis to the capture.
    const manifest = await loader.find(active.kit).catch(() => undefined);
    if (!manifest) return undefined;
    const raw = await loader.readTokens(active.kit).catch(() => undefined);
    if (!raw) return undefined;
    return {
      tokens: applyTokenOverrides(raw, active.overrides),
      source: 'kit',
      kit: active.kit,
    };
  }
  const captured = await loadCapturedTokens(projectRoot).catch(() => undefined);
  if (captured) return { tokens: captured.tokens, source: 'captured', files: captured.files };
  return undefined;
}
