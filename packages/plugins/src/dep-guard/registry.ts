/**
 * Registry-backed checks for dep-guard: does the package exist, how old is it,
 * and does the version about to be installed carry a known vulnerability.
 *
 * The offline checks (deny list, edit-distance typosquats) cannot see the
 * shape an agent actually produces: a plausible name that does not exist
 * (a hallucinated package), or one that was registered days ago by someone
 * waiting for exactly that hallucination (slopsquatting). Only the registry
 * can tell those apart from a real dependency.
 *
 * Everything here fails OPEN: a registry that does not answer in time, a body
 * over the size cap, or a malformed document yields `unchecked`, never a
 * block. dep-guard's PreToolUse hook is a fail-closed policy hook, so an
 * exception escaping this module would refuse the install — every path
 * returns a value instead.
 */

export type Ecosystem = 'npm' | 'PyPI' | 'crates.io';

export interface RegistryFinding {
  name: string;
  ecosystem: Ecosystem;
  /**
   * `missing`   — the public registry does not know the name (a private
   *               registry might; the caller only warns);
   * `new`       — first published less than `minAgeDays` ago;
   * `vulnerable`— OSV lists advisories for the version to be installed;
   * `unchecked` — the registry or OSV could not answer; `reason` says why.
   */
  kind: 'missing' | 'new' | 'vulnerable' | 'unchecked';
  detail: string;
}

export interface RegistryCheckOptions {
  fetchImpl: typeof fetch;
  signal: AbortSignal;
  minAgeDays: number;
  vulnerabilityCheck: boolean;
  now?: number | undefined;
}

/** A metadata document larger than this is an established package — its age is not read. */
const MAX_METADATA_BYTES = 1_048_576;
const DAY_MS = 86_400_000;
const USER_AGENT = 'wrongstack-dep-guard (+https://github.com/wrongstack)';

export function ecosystemOf(manager: string): Ecosystem | null {
  const m = manager.toLowerCase();
  if (m === 'npm' || m === 'pnpm' || m === 'yarn' || m === 'bun') return 'npm';
  if (m === 'pip' || m === 'pip3' || m === 'uv') return 'PyPI';
  if (m === 'cargo') return 'crates.io';
  return null;
}

/**
 * An exact version the install pins, or null for a range / a tag / none.
 * What counts as a pin is the manager's grammar, not the digits: pip's
 * `==4.2` is exactly 4.2, but npm's `lodash@4` / `@4.17` is a range (npm
 * installs the newest 4.x), and cargo's `smallvec@1.0.0` is a caret
 * requirement (cargo locks the newest 1.x) — only `=1.0.0` pins it. Asking
 * OSV about the literal `4` / `1.0.0` reported advisories of a version that
 * is never installed.
 */
export function exactVersion(version: string | null, ecosystem: Ecosystem): string | null {
  if (!version) return null;
  const raw = version.trim();
  const v = raw.replace(/^=+/, '');
  if (ecosystem === 'PyPI') {
    return /^\d+(?:\.\d+){0,3}(?:[-+.][0-9A-Za-z.-]+)?$/.test(v) ? v : null;
  }
  if (ecosystem === 'crates.io' && !raw.startsWith('=')) return null;
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(v) ? v : null;
}

/** The name the registry knows: pip extras (`requests[socks]`) are not part of it. */
function registryName(name: string, ecosystem: Ecosystem): string {
  return ecosystem === 'PyPI' ? name.replace(/\[[^\]]*\]$/, '') : name;
}

interface Metadata {
  exists: boolean;
  /** Epoch ms of the first publication; null when unknown or not read. */
  createdAt: number | null;
  latest: string | null;
}

/** Read a JSON body up to the cap; null when the body is larger. */
async function readCappedJson(res: Response): Promise<unknown | null> {
  const declared = Number(res.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > MAX_METADATA_BYTES) {
    await res.body?.cancel().catch(() => {});
    return null;
  }
  const reader = res.body?.getReader();
  if (!reader) return JSON.parse(await res.text()) as unknown;
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_METADATA_BYTES) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

function metadataUrl(name: string, ecosystem: Ecosystem): string {
  switch (ecosystem) {
    case 'npm':
      // A scoped name keeps its `@` and encodes the slash.
      return `https://registry.npmjs.org/${name.replace('/', '%2F')}`;
    case 'PyPI':
      return `https://pypi.org/pypi/${encodeURIComponent(name)}/json`;
    case 'crates.io':
      return `https://crates.io/api/v1/crates/${encodeURIComponent(name)}`;
  }
}

function parseMetadata(doc: unknown, ecosystem: Ecosystem): Metadata {
  const d = (doc ?? {}) as Record<string, unknown>;
  const epoch = (v: unknown): number | null => {
    const t = typeof v === 'string' ? Date.parse(v) : Number.NaN;
    return Number.isFinite(t) ? t : null;
  };
  if (ecosystem === 'npm') {
    const time = (d['time'] ?? {}) as Record<string, unknown>;
    const tags = (d['dist-tags'] ?? {}) as Record<string, unknown>;
    return {
      exists: true,
      createdAt: epoch(time['created']),
      latest: typeof tags['latest'] === 'string' ? tags['latest'] : null,
    };
  }
  if (ecosystem === 'PyPI') {
    const info = (d['info'] ?? {}) as Record<string, unknown>;
    const releases = (d['releases'] ?? {}) as Record<string, unknown>;
    let first: number | null = null;
    for (const files of Object.values(releases)) {
      if (!Array.isArray(files)) continue;
      for (const f of files) {
        const t = epoch((f as Record<string, unknown>)['upload_time_iso_8601']);
        if (t !== null && (first === null || t < first)) first = t;
      }
    }
    return {
      exists: true,
      createdAt: first,
      latest: typeof info['version'] === 'string' ? info['version'] : null,
    };
  }
  const krate = (d['crate'] ?? {}) as Record<string, unknown>;
  return {
    exists: true,
    createdAt: epoch(krate['created_at']),
    latest: typeof krate['max_stable_version'] === 'string' ? krate['max_stable_version'] : null,
  };
}

async function fetchMetadata(
  name: string,
  ecosystem: Ecosystem,
  opts: RegistryCheckOptions,
): Promise<Metadata | { error: string }> {
  const url = metadataUrl(name, ecosystem);
  const res = await opts.fetchImpl(url, {
    signal: opts.signal,
    headers: { accept: 'application/json', 'user-agent': USER_AGENT },
  });
  if (res.status === 404) {
    await res.body?.cancel().catch(() => {});
    return { exists: false, createdAt: null, latest: null };
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    return { error: `${new URL(url).host} answered HTTP ${res.status}` };
  }
  const doc = await readCappedJson(res);
  // Over the cap: a document that large belongs to a long-lived package.
  if (doc === null) return { exists: true, createdAt: null, latest: null };
  return parseMetadata(doc, ecosystem);
}

async function fetchAdvisories(
  name: string,
  ecosystem: Ecosystem,
  version: string,
  opts: RegistryCheckOptions,
): Promise<string[] | { error: string }> {
  const res = await opts.fetchImpl('https://api.osv.dev/v1/query', {
    method: 'POST',
    signal: opts.signal,
    headers: { 'content-type': 'application/json', 'user-agent': USER_AGENT },
    body: JSON.stringify({ package: { name, ecosystem }, version }),
  });
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    return { error: `api.osv.dev answered HTTP ${res.status}` };
  }
  const doc = (await res.json()) as { vulns?: Array<{ id?: unknown }> };
  return (doc.vulns ?? [])
    .map((v) => (typeof v.id === 'string' ? v.id : ''))
    .filter(Boolean)
    .slice(0, 5);
}

function errorText(err: unknown): string {
  if (err instanceof Error) {
    return err.name === 'AbortError' || err.name === 'TimeoutError'
      ? 'the registry did not answer in time'
      : err.message;
  }
  return String(err);
}

/**
 * Check one package. Returns the findings for it (possibly several: a new
 * package can also be vulnerable), or an empty list when it is established
 * and clean. Never throws.
 */
export async function checkPackage(
  pkg: { name: string; version: string | null },
  ecosystem: Ecosystem,
  opts: RegistryCheckOptions,
): Promise<RegistryFinding[]> {
  const name = registryName(pkg.name, ecosystem);
  const base = { name, ecosystem };
  try {
    const meta = await fetchMetadata(name, ecosystem, opts);
    if ('error' in meta) return [{ ...base, kind: 'unchecked', detail: meta.error }];
    if (!meta.exists) {
      return [
        {
          ...base,
          kind: 'missing',
          detail: `the public ${ecosystem} registry has no package named "${name}"`,
        },
      ];
    }
    const findings: RegistryFinding[] = [];
    const now = opts.now ?? Date.now();
    if (meta.createdAt !== null && now - meta.createdAt < opts.minAgeDays * DAY_MS) {
      const days = Math.max(0, Math.floor((now - meta.createdAt) / DAY_MS));
      findings.push({
        ...base,
        kind: 'new',
        detail: `"${name}" was first published ${days === 0 ? 'today' : `${days} day(s) ago`}`,
      });
    }
    const version =
      exactVersion(pkg.version, ecosystem) ?? (pkg.version === null ? meta.latest : null);
    if (opts.vulnerabilityCheck && version) {
      const advisories = await fetchAdvisories(name, ecosystem, version, opts);
      if ('error' in advisories) {
        findings.push({ ...base, kind: 'unchecked', detail: advisories.error });
      } else if (advisories.length > 0) {
        findings.push({
          ...base,
          kind: 'vulnerable',
          detail: `${name}@${version} has known advisories: ${advisories.join(', ')}`,
        });
      }
    }
    return findings;
  } catch (err) {
    return [{ ...base, kind: 'unchecked', detail: errorText(err) }];
  }
}

// ---------------------------------------------------------------------------
// Registry verdict
// ---------------------------------------------------------------------------

export interface RegistryVerdictConfig {
  /** An `allow` entry is the user's answer to the question this would raise. */
  isAllowed(name: string, ecosystem: Ecosystem): boolean;
  minPackageAgeDays: number;
  vulnerabilityCheck: boolean;
  registryTimeoutMs: number;
  /** Answers remembered across commands, keyed `ecosystem:name@version`. */
  cache: Map<string, RegistryFinding[]>;
  maxCacheEntries: number;
}

export interface RegistryVerdict {
  /** A package young enough to refuse (block mode) — the first one found. */
  block: { name: string; reason: string } | null;
  notes: string[];
}

/**
 * Ask the registries about every package of the command, together, within
 * `registryTimeoutMs`. Allow-listed packages are not asked: an `allow` entry
 * is the user's answer to exactly the question this would raise. Never throws —
 * the hook it runs in is fail-closed.
 */
export async function registryVerdict(
  installs: ReadonlyArray<{
    manager: string;
    packages: ReadonlyArray<{ name: string; version: string | null }>;
  }>,
  cfg: RegistryVerdictConfig,
  hookSignal?: AbortSignal | undefined,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<RegistryVerdict> {
  const verdict: RegistryVerdict = { block: null, notes: [] };
  if (typeof fetchImpl !== 'function') return verdict;
  const seen = new Set<string>();
  const targets: Array<{
    pkg: { name: string; version: string | null };
    ecosystem: Ecosystem;
    key: string;
  }> = [];
  for (const install of installs) {
    const ecosystem = ecosystemOf(install.manager);
    if (!ecosystem) continue;
    for (const pkg of install.packages) {
      if (cfg.isAllowed(pkg.name, ecosystem)) continue;
      // `workspace:`, `npm:alias@x`, `link:` resolve to something other than the name.
      if (pkg.version !== null && /^[a-z]+:/i.test(pkg.version)) continue;
      const key = `${ecosystem}:${pkg.name}@${pkg.version ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      targets.push({ pkg, ecosystem, key });
    }
  }
  if (targets.length === 0) return verdict;
  // Past 2^31-1 ms the timer fires after ~1 ms (every lookup "unchecked", a
  // day-old package let through); >= 2^32 throws out of a never-throw path.
  const budgetMs = Number.isFinite(cfg.registryTimeoutMs)
    ? Math.min(Math.max(1, cfg.registryTimeoutMs), 2_147_483_647)
    : 3000;
  const timeout = AbortSignal.timeout(budgetMs);
  const signal = hookSignal ? AbortSignal.any([hookSignal, timeout]) : timeout;
  const results = await Promise.all(
    // Every package, in parallel: the time budget bounds the wait, not a count.
    targets.map(async ({ pkg, ecosystem, key }) => {
      const cached = cfg.cache.get(key);
      if (cached) return cached;
      const findings = await checkPackage(pkg, ecosystem, {
        fetchImpl,
        signal,
        minAgeDays: cfg.minPackageAgeDays,
        vulnerabilityCheck: cfg.vulnerabilityCheck,
      });
      // An unanswered question is asked again next time, not remembered.
      if (!findings.some((f) => f.kind === 'unchecked')) {
        if (cfg.cache.size >= cfg.maxCacheEntries) {
          const oldest = cfg.cache.keys().next().value;
          if (oldest !== undefined) cfg.cache.delete(oldest);
        }
        cfg.cache.set(key, findings);
      }
      return findings;
    }),
  );
  const unchecked: string[] = [];
  for (const f of results.flat()) {
    if (f.kind === 'new' && !verdict.block) {
      verdict.block = {
        name: f.name,
        reason:
          `dep-guard: ${f.detail} — newer than the ${cfg.minPackageAgeDays}-day minimum. ` +
          'A just-registered name is how a hallucinated dependency gets hijacked. Check that this is the package the user means ' +
          `(spelling, publisher); if it is, ask the user to add "${f.name}" to config.extensions["dep-guard"].allow.`,
      };
    } else if (f.kind === 'new') {
      verdict.notes.push(`${f.detail} — younger than ${cfg.minPackageAgeDays} days.`);
    } else if (f.kind === 'missing') {
      verdict.notes.push(
        `${f.detail} — it may be a hallucinated name. Check the spelling against the project's docs; if it lives on a private registry, ignore this.`,
      );
    } else if (f.kind === 'vulnerable') {
      verdict.notes.push(
        `${f.detail} (osv.dev) — install a fixed version unless the user needs this one.`,
      );
    } else {
      unchecked.push(`${f.name} (${f.detail})`);
    }
  }
  if (unchecked.length > 0) {
    verdict.notes.push(`registry check did not run for: ${unchecked.join('; ')}.`);
  }
  return verdict;
}
