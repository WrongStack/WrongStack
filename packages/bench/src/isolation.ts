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
  if (opts.hostHomeDir) {
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

  const cacheDest = path.join(sandboxHome, 'cache');
  await fs.mkdir(cacheDest, { recursive: true });
  await copyIfExists(
    path.join(hostHome, 'cache', 'models.dev.json'),
    path.join(cacheDest, 'models.dev.json'),
  );
  await copyIfExists(
    path.join(hostHome, 'cache', 'models-overlay.json'),
    path.join(cacheDest, 'models-overlay.json'),
  );

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
    raw = JSON.parse(await fs.readFile(src, 'utf8'));
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
  const safe = `${slug(cellLabel)}__${slug(taskId)}${suffix}`;
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
        : (src) => !src.split(/[\\/]/).some((seg) => excludeSet.has(seg)),
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
