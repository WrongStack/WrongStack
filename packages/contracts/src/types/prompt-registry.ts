/**
 * Prompt registry / sync types — the contract for a remote prompt hub
 * (e.g. prompts.wrongstack.com) and the local installed-prompts manifest.
 *
 * The manifest shape intentionally mirrors the bundled dataset's
 * `data/prompts/index.json` (see `PromptManifest` in `types/prompt.ts`): the
 * builtin dataset IS a local registry, so builtin and synced prompts can flow
 * through one validation + diff path. This file defines the format and the
 * structural validator; the actual fetch/download is a deliberately small stub
 * (see `prompts/prompt-installer.ts`) — "groundwork now, sync later".
 */
import type { PromptCategory } from './prompt.js';

export interface PromptRegistryRef {
  id: string;
  slug: string;
  title: string;
  description: string;
  category: PromptCategory;
  tags: string[];
  /** sha256 of the prompt content — drives the update diff. */
  checksum: string;
  version?: string | undefined;
  license?: string | undefined;
  /** Optional direct URL to the full prompt JSON. */
  url?: string | undefined;
}

export interface PromptRegistryManifest {
  registryVersion: 1;
  /** Where this manifest came from (hub URL or `owner/repo`). */
  source: string;
  generatedAt: string;
  prompts: PromptRegistryRef[];
}

/** One entry recorded in `<profile>/installed-prompts.json`. */
export interface InstalledPromptEntry {
  slug: string;
  /** The registry/source this prompt was pulled from. */
  source: string;
  /** The ref pinned at install (tag/branch/commit or manifest version). */
  ref: string;
  checksum: string;
  /** True once the prompt body has actually been written locally. */
  synced: boolean;
  installedAt: string;
}

export interface PromptManifestData {
  version: 1;
  entries: InstalledPromptEntry[];
}

/** Result of validating an untrusted manifest. */
export type ManifestValidation =
  | { ok: true; manifest: PromptRegistryManifest }
  | { ok: false; errors: string[] };

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CHECKSUM_RE = /^[a-f0-9]{64}$/;
const MAX_STR = 4096;

/**
 * Structurally validate an untrusted registry manifest. Treats the manifest as
 * DATA, not instructions: enforces slug charset, checksum format, and field
 * lengths so a malicious hub can't smuggle oversized or malformed entries into
 * the local store. Does NOT fetch prompt bodies.
 */
export function validateRegistryManifest(raw: unknown): ManifestValidation {
  const errors: string[] = [];
  if (!raw || typeof raw !== 'object') return { ok: false, errors: ['manifest is not an object'] };
  const m = raw as Record<string, unknown>;

  if (m['registryVersion'] !== 1) errors.push('registryVersion must be 1');
  if (typeof m['source'] !== 'string' || !m['source'])
    errors.push('source must be a non-empty string');
  if (typeof m['generatedAt'] !== 'string') errors.push('generatedAt must be a string');
  if (!Array.isArray(m['prompts'])) {
    errors.push('prompts must be an array');
    return { ok: false, errors };
  }

  const seen = new Set<string>();
  const refs: PromptRegistryRef[] = [];
  (m['prompts'] as unknown[]).forEach((p, i) => {
    if (!p || typeof p !== 'object') {
      errors.push(`prompts[${i}] is not an object`);
      return;
    }
    const r = p as Record<string, unknown>;
    const slug = r['slug'];
    if (typeof slug !== 'string' || !SLUG_RE.test(slug)) {
      errors.push(`prompts[${i}].slug invalid (must be kebab-case)`);
      return;
    }
    if (seen.has(slug)) {
      errors.push(`prompts[${i}].slug "${slug}" duplicated`);
      return;
    }
    seen.add(slug);
    if (typeof r['checksum'] !== 'string' || !CHECKSUM_RE.test(r['checksum'])) {
      errors.push(`prompts[${i}].checksum must be a 64-char sha256 hex`);
      return;
    }
    for (const field of ['id', 'title', 'description', 'category'] as const) {
      const v = r[field];
      if (typeof v !== 'string' || v.length === 0 || v.length > MAX_STR) {
        errors.push(`prompts[${i}].${field} must be a non-empty string under ${MAX_STR} chars`);
        return;
      }
    }
    const tags = Array.isArray(r['tags'])
      ? (r['tags'].filter((t) => typeof t === 'string') as string[])
      : [];
    refs.push({
      id: r['id'] as string,
      slug,
      title: r['title'] as string,
      description: r['description'] as string,
      category: r['category'] as string,
      tags,
      checksum: r['checksum'] as string,
      version: typeof r['version'] === 'string' ? r['version'] : undefined,
      license: typeof r['license'] === 'string' ? r['license'] : undefined,
      url: typeof r['url'] === 'string' ? r['url'] : undefined,
    });
  });

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    manifest: {
      registryVersion: 1,
      source: m['source'] as string,
      generatedAt: m['generatedAt'] as string,
      prompts: refs,
    },
  };
}

export interface RegistryDiff {
  /** Slugs present in the manifest but not locally. */
  added: PromptRegistryRef[];
  /** Slugs present locally but whose checksum differs in the manifest. */
  updated: PromptRegistryRef[];
  /** Slugs present locally and identical in the manifest. */
  unchanged: PromptRegistryRef[];
}

/**
 * Compute what a pull WOULD change, by slug+checksum, against the prompts the
 * caller already has. Pure — no I/O, no writes.
 */
export function diffRegistry(
  local: { slug: string; checksum?: string | undefined }[],
  manifest: PromptRegistryManifest,
): RegistryDiff {
  const localBySlug = new Map(local.map((e) => [e.slug, e.checksum]));
  const diff: RegistryDiff = { added: [], updated: [], unchanged: [] };
  for (const ref of manifest.prompts) {
    if (!localBySlug.has(ref.slug)) diff.added.push(ref);
    else if (localBySlug.get(ref.slug) !== ref.checksum) diff.updated.push(ref);
    else diff.unchanged.push(ref);
  }
  return diff;
}
