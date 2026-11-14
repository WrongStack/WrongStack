import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { computeStableJsonHash } from './fingerprint.js';

/**
 * Per-run isolation. Each benchmark run gets one sandbox directory tree:
 *
 *   <sandbox>/
 *     home/        → isolated WRONGSTACK_HOME (config seed + all session JSONL)
 *     work/<id>/   → one copy of a task template per (task × cell)
 *
 * The isolated home keeps project sessions off the developer's real
 * `~/.wrongstack`. Auth is copied in (vault key + provider config + models
 * cache) so custom providers resolve; `projects/` and `logs/` are not copied.
 * Each task workdir hashes to its own project slug under home/projects/, so
 * concurrent runs never share a session file even though they share one home.
 */
export interface Sandbox {
  /** Root sandbox dir. */
  root: string;
  /** Isolated WRONGSTACK_HOME. */
  homeDir: string;
  /** Directory that holds per-task workdirs. */
  workRoot: string;
  /**
   * Hash of the behavior-affecting config the sandboxed CLI will actually read.
   *
   * The sandbox seeds its config from the operator's own home, so two people
   * running the same suite can silently be running two different harnesses
   * (different skills mode, token-saving tier, system-prompt variant, tool
   * settings). Folding this into the fingerprint makes that visible instead of
   * letting it masquerade as a model difference. Credentials, provider
   * definitions, and the saved provider/model are excluded — they are either
   * secrets or the variable under test.
   */
  configHash: string;
}

/**
 * Config keys that change how the agent behaves. Deliberately an allow-list:
 * `providers` holds encrypted keys and `provider`/`model` are the variable
 * under test, so hashing them would make every operator's fingerprint unique
 * and kill cross-machine comparability.
 */
const BEHAVIOR_CONFIG_KEYS = [
  'autonomy',
  'brain',
  'circuitBreaker',
  'context',
  'extensions',
  'features',
  'fleet',
  'hints',
  'indexing',
  'maxConcurrent',
  'modelRuntime',
  'nextPrediction',
  'Sage',
  'session',
  'skills',
  'systemPrompt',
  'tools',
  'yolo',
] as const;

/** Project the behavior-affecting subset of an effective config, for hashing. */
export function behaviorConfigProjection(config: unknown): Record<string, unknown> {
  const obj = isRecord(config) ? config : {};
  const projection: Record<string, unknown> = {};
  for (const key of BEHAVIOR_CONFIG_KEYS) {
    if (obj[key] !== undefined) projection[key] = obj[key];
  }
  return projection;
}

/**
 * Which harness the sandboxed CLI runs.
 *
 * - `lean` (default): factory defaults plus {@link LEAN_BENCH_CONFIG}. Only the
 *   operator's provider definitions (auth) cross over, so the same suite
 *   produces the same fingerprint on every machine and a published score
 *   describes WrongStack, not one person's settings.
 * - `host`: the operator's own active profile (skills, companions, brain,
 *   token-saving tier …) — useful to measure a personal setup, not to publish.
 */
export type BenchProfile = 'lean' | 'host';

/** Fixed direct tool surface for lean runs; independent of the general coding tiers. */
export const LEAN_BENCH_TOOL_NAMES: readonly string[] = [
  'read',
  'edit',
  'write',
  'bash',
  'grep',
  'glob',
];

/**
 * Pinned behavior for the lean profile. Background companions each run their
 * own model loop beside the leader — a measured core task spent more tokens in
 * the explore companion than in the leader itself — and memory, MCP, plugins
 * and the prompt library read state that differs per machine.
 *
 * The `quick` identity with the aggressive token-saving tier is the cheapest
 * harness that did not cost success: on glm-5.3-flash it passed the hard
 * suite 16/16 at 83.9k tokens per solve against the factory `pro` prompt's
 * 15/16 at 434.8k (2026-10-27, `--repeats 2`).
 */
export const LEAN_BENCH_CONFIG = {
  systemPrompt: { variant: 'quick' },
  features: {
    skills: false,
    mcp: false,
    plugins: false,
    memory: false,
    prompts: false,
    tokenSavingMode: 'aggressive',
  },
  fleet: {
    exploreCompanion: { enabled: false },
    skillCompanion: { enabled: false },
  },
  // Every `npm install` an agent ran rewrote package-lock.json, and the
  // default-on dep-watcher spawned a tech-stack audit subagent for it: ~19% of
  // a polyglot run's tokens (2026-10-28) went to registry lookups nobody graded.
  extensions: { 'file-watcher': { depWatcher: { enabled: false } } },
  Sage: { enabled: false },
} as const;

/** Create the sandbox tree and seed the isolated home's config.json. */
export async function createSandbox(opts: {
  /** Where to create the sandbox. Defaults to an OS temp dir. */
  baseDir?: string | undefined;
  maxIterations: number;
  yolo: boolean;
  /**
   * Real `WRONGSTACK_HOME` / `paths.globalRoot`. When set, the sandbox copies
   * the vault key, provider/model config, and models cache so custom providers
   * (and keys stored in the vault rather than the environment) still resolve.
   * Project sessions and logs stay isolated.
   */
  hostHomeDir?: string | undefined;
  /** Harness profile. Defaults to `lean`. */
  profile?: BenchProfile | undefined;
  /**
   * Config deep-merged over the lean profile (ignored for `host`) — how a
   * harness A/B (prompt variant, token-saving tier, …) is run. It lands in the
   * effective config, so it flips `configHash` like any other behavior change.
   */
  harnessOverlay?: Record<string, unknown> | undefined;
}): Promise<Sandbox> {
  const base = opts.baseDir ?? (await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-bench-')));
  await fs.mkdir(base, { recursive: true });
  const homeDir = path.join(base, 'home');
  const workRoot = path.join(base, 'work');
  await fs.mkdir(homeDir, { recursive: true });
  await fs.mkdir(workRoot, { recursive: true });

  const overlay = {
    yolo: opts.yolo,
    tools: { maxIterations: opts.maxIterations },
    session: { auditLevel: 'standard' as const },
  };

  let effective: Record<string, unknown> = overlay;
  if ((opts.profile ?? 'lean') === 'lean') {
    effective = await writeLeanConfig(opts.hostHomeDir, homeDir, overlay, opts.harnessOverlay);
  } else if (opts.hostHomeDir) {
    effective = await copyHostAuth(opts.hostHomeDir, homeDir, overlay);
  } else {
    await fs.writeFile(path.join(homeDir, 'config.json'), JSON.stringify(overlay, null, 2), 'utf8');
  }

  return {
    root: base,
    homeDir,
    workRoot,
    configHash: computeStableJsonHash(behaviorConfigProjection(effective)),
  };
}

/**
 * Seed the lean profile: one root config holding factory defaults, the pinned
 * lean behavior, and nothing from the operator except provider definitions
 * (encrypted keys stay encrypted; the vault key is copied so they decrypt).
 */
async function writeLeanConfig(
  hostHome: string | undefined,
  sandboxHome: string,
  overlay: { yolo: boolean; tools: { maxIterations: number }; session: { auditLevel: 'standard' } },
  harnessOverlay?: Record<string, unknown> | undefined,
): Promise<Record<string, unknown>> {
  let providers: unknown;
  if (hostHome) {
    await copyIfExists(path.join(hostHome, '.key'), path.join(sandboxHome, '.key'));
    await copyModelsCache(hostHome, sandboxHome);
    const root = await readJsonObject(path.join(hostHome, 'config.json'));
    const active = typeof root['activeProfile'] === 'string' ? root['activeProfile'] : undefined;
    const profile = active
      ? await readJsonObject(path.join(hostHome, 'profiles', active, 'config.json'))
      : {};
    providers = profile['providers'] ?? root['providers'];
  }
  // The harness overlay may tune behavior but never the pinned run contract
  // (yolo, iteration cap, audit level) or the credentials.
  const config: Record<string, unknown> = {
    ...deepMerge(structuredClone(LEAN_BENCH_CONFIG), harnessOverlay ?? {}),
    ...overlay,
    ...(providers !== undefined ? { providers } : {}),
  };
  await fs.writeFile(
    path.join(sandboxHome, 'config.json'),
    JSON.stringify(config, null, 2),
    'utf8',
  );
  return config;
}

/** Plain-object deep merge; arrays and scalars from `over` replace. Exported for tests. */
export function deepMerge(
  base: Record<string, unknown>,
  over: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(over)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    const prev = Object.hasOwn(out, key) ? out[key] : undefined;
    out[key] = isRecord(prev) && isRecord(value) ? deepMerge(prev, value) : value;
  }
  return out;
}

async function readJsonObject(file: string): Promise<Record<string, unknown>> {
  try {
    const raw: unknown = JSON.parse((await fs.readFile(file, 'utf8')).replace(/^﻿/, ''));
    return isRecord(raw) ? raw : {};
  } catch {
    return {};
  }
}

async function copyModelsCache(hostHome: string, sandboxHome: string): Promise<void> {
  const cacheDest = path.join(sandboxHome, 'cache');
  await fs.mkdir(cacheDest, { recursive: true });
  for (const name of ['models.dev.json', 'models-overlay.json']) {
    await copyIfExists(path.join(hostHome, 'cache', name), path.join(cacheDest, name));
  }
}

/**
 * Bring auth + provider definitions into the sandbox without copying the
 * operator's project sessions. Encrypted `apiKey` fields stay encrypted; the
 * matching `.key` is copied so the child can decrypt them the same way the
 * interactive CLI does.
 */
async function copyHostAuth(
  hostHome: string,
  sandboxHome: string,
  overlay: { yolo: boolean; tools: { maxIterations: number }; session: { auditLevel: 'standard' } },
): Promise<Record<string, unknown>> {
  await copyIfExists(path.join(hostHome, '.key'), path.join(sandboxHome, '.key'));
  // The root config selects the active profile; the profile config is what the
  // agent actually runs on, so the fingerprint hashes the active profile when
  // there is one and falls back to the root config otherwise.
  const rootConfig = await writeOverlayConfig(
    path.join(hostHome, 'config.json'),
    path.join(sandboxHome, 'config.json'),
    overlay,
    true,
  );
  const activeProfile =
    typeof rootConfig['activeProfile'] === 'string' ? rootConfig['activeProfile'] : undefined;
  let effective = rootConfig;

  const hostProfiles = path.join(hostHome, 'profiles');
  let profileNames: string[] = [];
  try {
    const entries = await fs.readdir(hostProfiles, { withFileTypes: true });
    profileNames = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    profileNames = [];
  }
  for (const name of profileNames) {
    const destDir = path.join(sandboxHome, 'profiles', name);
    await fs.mkdir(destDir, { recursive: true });
    const profileConfig = await writeOverlayConfig(
      path.join(hostProfiles, name, 'config.json'),
      path.join(destDir, 'config.json'),
      overlay,
      false,
    );
    if (name === activeProfile) effective = profileConfig;
  }

  await copyModelsCache(hostHome, sandboxHome);
  return effective;
}

async function writeOverlayConfig(
  src: string,
  dest: string,
  overlay: { yolo: boolean; tools: { maxIterations: number }; session: { auditLevel: 'standard' } },
  required: boolean,
): Promise<Record<string, unknown>> {
  let raw: unknown = {};
  try {
    // The CLI's config loader ignores a leading UTF-8 BOM; a BOM here used to
    // fail the parse and seed the sandbox with an overlay-only config.
    raw = JSON.parse((await fs.readFile(src, 'utf8')).replace(/^﻿/, ''));
  } catch {
    if (!required) return {};
  }
  const obj = isRecord(raw) ? { ...raw } : {};
  const tools = isRecord(obj['tools']) ? { ...obj['tools'] } : {};
  const session = isRecord(obj['session']) ? { ...obj['session'] } : {};
  obj['yolo'] = overlay.yolo;
  obj['tools'] = { ...tools, maxIterations: overlay.tools.maxIterations };
  obj['session'] = { ...session, auditLevel: overlay.session.auditLevel };
  delete obj['mcpServers'];
  delete obj['plugins'];
  await fs.writeFile(dest, JSON.stringify(obj, null, 2), 'utf8');
  return obj;
}

async function copyIfExists(src: string, dest: string): Promise<void> {
  try {
    await fs.copyFile(src, dest);
  } catch {
    // Host file is optional (fresh install, no vault, no models cache).
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Copy a task template into a fresh workdir. The directory name embeds the
 * cell label and task id so it is both unique (parallel-safe) and debuggable.
 */
export async function prepareWorkdir(
  sandbox: Sandbox,
  templateDir: string,
  taskId: string,
  cellLabel: string,
  exclude?: string[] | undefined,
  /**
   * 1-based attempt index. Repeats of the same (task × cell) MUST get distinct
   * workdirs: they can run concurrently, and the workdir path also decides the
   * session slug the tool metrics are read back from.
   */
  attempt?: number | undefined,
): Promise<string> {
  const suffix = attempt !== undefined && attempt > 1 ? `__a${attempt}` : '';
  // Slugs alone collide after case folding, punctuation removal or truncation.
  const cellKey = `${slug(cellLabel)}-${computeStableJsonHash(cellLabel)}`;
  const taskKey = `${slug(taskId)}-${computeStableJsonHash(taskId)}`;
  const safe = `${cellKey}__${taskKey}${suffix}`;
  const dest = path.join(sandbox.workRoot, safe);
  // Fresh copy every time: a previous failed run must not leak edits forward.
  await fs.rm(dest, { recursive: true, force: true });
  const excludeSet = new Set(exclude ?? []);
  await fs.cp(templateDir, dest, {
    recursive: true,
    // Drop any path whose segments include an excluded name (e.g. `.meta`),
    // so the reference solution never reaches the agent's workdir.
    filter:
      excludeSet.size === 0
        ? undefined
        : (src) => {
            const relative = path.relative(templateDir, src);
            return relative === '' || !relative.split(/[\\/]/).some((seg) => excludeSet.has(seg));
          },
  });
  return dest;
}

/** Remove the whole sandbox tree. Best-effort. */
export async function cleanupSandbox(sandbox: Sandbox): Promise<void> {
  /* v8 ignore next -- fs.rm with force:true does not reject for a missing tree; the catch is a best-effort guard. */
  await fs.rm(sandbox.root, { recursive: true, force: true }).catch(() => undefined);
}

function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'x'
  );
}
