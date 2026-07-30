import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { FallbackProfileManager } from '../core/fallback-profile-manager.js';
import { parseModelRef } from '../core/model-ref.js';
import type { EventMap } from '../kernel/events.js';
import type { Config } from '../types/config.js';
import type { Plugin } from '../types/plugin.js';
import type { SlashCommand } from '../types/slash-command.js';
import { toErrorMessage } from '../utils/error.js';
import type {
  CascadeAgentKind,
  ChimeraCascadeNeededPayload,
  ChimeraReviewCompletePayload,
  ChimeraReviewNeededPayload,
} from './chimera-plugin.js';
import { emitReviewIfChanged } from './review-claim-registry.js';
import { buildReviewContext } from './review-context-builder.js';

// ---------------------------------------------------------------------------
// Auto-review configuration — read from config.extensions['wstack-auto-review']
// ---------------------------------------------------------------------------
export interface AutoReviewConfig {
  enabled?: boolean | undefined;
  /** Provider for review subagents. Falls back to session provider. */
  provider?: string | undefined;
  /** Model for review subagents. Falls back to session model. */
  model?: string | undefined;
  /**
   * Named fallback profile from config.fallbackProfiles.
   * Resolved via FallbackProfileManager. The first valid entry
   * becomes the primary provider/model (when provider/model are
   * omitted), and the remaining entries form the fallback chain.
   */
  fallbackProfile?: string | undefined;
  /** Debounce window in ms — wait for quiet before firing review (default 15000). */
  debounceMs?: number | undefined;
  /** Max files per review batch (default 15). */
  maxFilesPerBatch?: number | undefined;
  /** Max concurrent in-flight reviews (default 2). */
  maxConcurrentReviews?: number | undefined;
  /**
   * Cascade severity threshold: when a review finds findings at or above this
   * level, spawn follow-up agents automatically. "off" disables cascading,
   * "high" cascades on High+, "critical" cascades only on Critical.
   * Default: "off".
   */
  cascadeOn?: 'off' | 'critical' | 'high' | undefined;
  /**
   * Maximum cascade iterations (fix → re-review cycles) before the
   * self-correcting loop stops. Prevents infinite cycles. Default: 2.
   * 0 disables re-review (cascade agents investigate/fix once, no re-check).
   */
  maxCascadeDepth?: number | undefined;
}

export interface ResolvedAutoReviewConfig {
  enabled: boolean;
  provider: string;
  model: string;
  fallbackModels: string[];
  debounceMs: number;
  maxFilesPerBatch: number;
  maxConcurrentReviews: number;
  cascadeOn: 'off' | 'critical' | 'high';
  maxCascadeDepth: number;
}

const DEFAULT_DEBOUNCE_MS = 15_000;
const DEFAULT_MAX_FILES_PER_BATCH = 15;
const DEFAULT_MAX_CONCURRENT_REVIEWS = 2;
const DEFAULT_MAX_CASCADE_DEPTH = 2;

/**
 * Primary + fallback assignment for a single Chimera reviewer spawn.
 * Produced by {@link selectRoundRobinReviewerAssignment} so concurrent
 * reviewers start on different models and only share a provider after
 * their own in-place retries are exhausted.
 */
export interface ReviewerModelAssignment {
  provider: string;
  model: string;
  /** Remaining pool entries after the selected primary, wrap-around order. */
  fallbackModels: string[];
  /** Cursor to pass on the next spawn (`cursor + 1`). */
  nextCursor: number;
}

/**
 * Build the deduped provider/model pool a reviewer can start on.
 *
 * Order is stable: configured primary first, then the fallback chain.
 * Entries must be `provider/model` (or parseable refs); bare blanks are dropped.
 */
export function buildReviewerModelPool(
  provider: string,
  model: string,
  fallbackModels: readonly string[] = [],
): string[] {
  const primaryProvider = provider.trim();
  const primaryModel = model.trim();
  const primaryRef = primaryProvider && primaryModel ? `${primaryProvider}/${primaryModel}` : '';
  const seen = new Set<string>();
  const pool: string[] = [];
  for (const raw of [primaryRef, ...fallbackModels]) {
    const ref = raw.trim();
    if (!ref || seen.has(ref)) continue;
    const parsed = parseModelRef(ref);
    // Need a provider so the subagent never spawns with a bare model id that
    // 401s as "Model is not supported" on multi-provider hosts.
    if (!parsed.provider?.trim() || !parsed.model.trim()) continue;
    const normalized = `${parsed.provider.trim()}/${parsed.model.trim()}`;
    if (seen.has(normalized)) continue;
    // Track both spellings: `ref` rejects exact repeats cheaply, while
    // `normalized` collapses equivalent refs whose parsed whitespace differs.
    seen.add(ref);
    seen.add(normalized);
    pool.push(normalized);
  }
  return pool;
}

/**
 * Pick primary + fallback chain for the Nth concurrent reviewer via round-robin.
 *
 * Index `cursor % pool.length` becomes the primary; the rest of the pool is
 * rotated so the former primary lands last (still available after rate limits).
 * The pool must be pre-filtered by {@link buildReviewerModelPool} so every
 * non-empty entry contains both a provider and a model.
 * Pure: the caller owns the cursor (typically a process-local counter).
 */
export function selectRoundRobinReviewerAssignment(
  pool: readonly string[],
  cursor: number,
  /** Used only when the selected ref is somehow unparseable — defensive. */
  fallbackProvider = '',
  fallbackModel = '',
): ReviewerModelAssignment {
  if (pool.length === 0) {
    return {
      provider: fallbackProvider,
      model: fallbackModel,
      fallbackModels: [],
      nextCursor: cursor + 1,
    };
  }
  const len = pool.length;
  const idx = ((cursor % len) + len) % len;
  const primaryRef = pool[idx]!;
  const parsed = parseModelRef(primaryRef);
  const provider = parsed.provider?.trim() || fallbackProvider;
  const model = parsed.model.trim() || fallbackModel;
  const fallbackModels = [...pool.slice(idx + 1), ...pool.slice(0, idx)];
  return {
    provider,
    model,
    fallbackModels,
    nextCursor: (idx + 1) % len,
  };
}

export function resolveAutoReviewConfig(
  cfg: AutoReviewConfig,
  sessionConfig: Config,
): ResolvedAutoReviewConfig {
  const mgr = new FallbackProfileManager(sessionConfig);
  const chain = cfg.fallbackProfile
    ? mgr.resolve(cfg.fallbackProfile)
    : mgr.resolveEffective({ fallbackAuto: true });
  // Normalize: empty strings are equivalent to undefined — treat them the same
  // so a config with provider: "" doesn't produce an empty provider string that
  // bypasses the ?? fallback below.
  const rawProvider = cfg.provider?.trim();
  const rawModel = cfg.model?.trim();
  const resolvedProvider =
    rawProvider || (chain.length > 0 ? chain[0]!.providerId : sessionConfig.provider);
  const resolvedModel = rawModel || (chain.length > 0 ? chain[0]!.model : sessionConfig.model);
  const profileFallbackModels = chain
    .filter((entry) => entry.providerId !== resolvedProvider || entry.model !== resolvedModel)
    .map((entry) => `${entry.providerId}/${entry.model}`);

  // Use only configured/effective fallback-profile entries plus the session's
  // own provider/model as a final known-working target. Chimera must not inject
  // a hard-coded provider/model rotation of its own.
  const sessionRef = `${sessionConfig.provider}/${sessionConfig.model}`;
  const fallbackModels = [
    ...profileFallbackModels.filter((ref) => ref !== sessionRef),
    sessionRef,
  ].filter((ref) => ref !== `${resolvedProvider}/${resolvedModel}`);

  return {
    enabled: cfg.enabled === true,
    provider: resolvedProvider,
    model: resolvedModel,
    fallbackModels,
    debounceMs: cfg.debounceMs ?? DEFAULT_DEBOUNCE_MS,
    maxFilesPerBatch: cfg.maxFilesPerBatch ?? DEFAULT_MAX_FILES_PER_BATCH,
    maxConcurrentReviews: cfg.maxConcurrentReviews ?? DEFAULT_MAX_CONCURRENT_REVIEWS,
    cascadeOn: cfg.cascadeOn ?? 'off',
    maxCascadeDepth: cfg.maxCascadeDepth ?? DEFAULT_MAX_CASCADE_DEPTH,
  };
}

// ---------------------------------------------------------------------------
// Severity parsing + cascade decision (exported for unit testing)
// ---------------------------------------------------------------------------

export interface ParsedSeverities {
  critical: number;
  high: number;
  medium: number;
}

/**
 * Extract Critical/High/Medium finding counts from a Chimera review report.
 *
 * The report format (from llm/chimera-review.md) uses section headers like
 * `### Critical (2)`, `### High (1)`, `### Medium (3)`. We match the count
 * in parentheses. Falls back to counting `1.`, `2.` list-item markers under
 * a severity heading when no `(N)` is present (defensive — the prompt asks
 * for both, but LLMs sometimes omit the count).
 *
 * Returns all-zero when the text doesn't match (clean report or unparseable).
 */
export function parseReviewSeverity(text: string): ParsedSeverities {
  const result: ParsedSeverities = { critical: 0, high: 0, medium: 0 };
  if (!text) return result;

  for (const level of ['critical', 'high', 'medium'] as const) {
    // Primary pattern: "### Critical (2)" — the canonical report format
    const countRe = new RegExp(`###\\s*${level}\\s*\\((\\d+)\\)`, 'i');
    const countMatch = text.match(countRe);
    if (countMatch?.[1]) {
      result[level] = Number.parseInt(countMatch[1], 10);
      continue;
    }
    // Fallback: count ordered-list items under the heading until the next
    // heading or end. Matches "1. [BUG] ..." style entries.
    const sectionRe = new RegExp(`###\\s*${level}[^\\n]*\\n([\\s\\S]*?)(?=###|$)`, 'i');
    const sectionMatch = text.match(sectionRe);
    if (sectionMatch?.[1]) {
      const items = sectionMatch[1].match(/^\s*\d+\.\s/gm);
      result[level] = items ? items.length : 0;
    }
  }
  return result;
}

/**
 * Keywords that indicate a security-class finding. When present in a
 * Critical or High finding line, the security-scanner cascade agent is
 * selected alongside bug-hunter.
 */
const SECURITY_KEYWORDS = [
  'injection',
  'xss',
  'csrf',
  'ssrf',
  'sql',
  'secret',
  'credential',
  'password',
  'api key',
  'token',
  'auth',
  'shell injection',
  'command injection',
  'innerhtml',
  'deserialization',
  'path traversal',
  'hardcoded',
  'privilege',
  'owasp',
] as const;

/**
 * Decide which follow-up cascade agents to spawn based on the review text.
 *
 * - `security-scanner` is selected when any Critical/High finding mentions
 *   a security keyword (injection, secret, XSS, etc.).
 * - `bug-hunter` is selected whenever the threshold is crossed at all —
 *   any High+ finding warrants a focused bug hunt.
 *
 * Both may be returned in parallel when a finding is both severe and
 * security-related.
 */
export function decideCascadeAgents(
  text: string,
  severities: ParsedSeverities,
): CascadeAgentKind[] {
  const agents = new Set<CascadeAgentKind>();

  // Any High+ finding → bug-hunter investigates the correctness concerns
  if (severities.critical > 0 || severities.high > 0) {
    agents.add('bug-hunter');
  }

  // Scan only the Critical and High sections for security keywords
  const lower = text.toLowerCase();
  const criticalHighRe = /###\s*(?:critical|high)[^\n]*\n([\s\S]*?)(?=###|$)/gi;
  let section = criticalHighRe.exec(lower);
  while (section !== null) {
    const body = section[1] ?? '';
    if (SECURITY_KEYWORDS.some((kw) => body.includes(kw))) {
      agents.add('security-scanner');
      break;
    }
    section = criticalHighRe.exec(lower);
  }
  return [...agents];
}

/**
 * Determine whether a review result should trigger a cascade, given the
 * configured threshold and parsed severities. Returns the crossed
 * threshold, or `null` when the cascade should not fire.
 *
 *  - `'high'`      → fires on any High OR Critical finding
 *  - `'critical'`  → fires only on Critical findings
 *  - `'off'`       → never fires
 */
export function shouldCascade(
  cascadeOn: 'off' | 'critical' | 'high',
  severities: ParsedSeverities,
): 'high' | 'critical' | null {
  if (cascadeOn === 'off') return null;
  if (severities.critical > 0) return 'critical';
  if (cascadeOn === 'high' && severities.high > 0) return 'high';
  return null;
}

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------
async function runGit(
  args: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn('git', args, {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        signal: AbortSignal.timeout(15_000),
        windowsHide: true,
      });
    } catch (err) {
      reject(err);
      return;
    }
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d) => {
      stdout += d;
    });
    child.stderr?.on('data', (d) => {
      stderr += d;
    });
    child.on('error', () => resolve({ stdout, stderr, code: 1 }));
    child.on('close', (code) => resolve({ stdout, stderr, code: code ?? 0 }));
  });
}

async function isGitRepo(cwd: string): Promise<boolean> {
  const r = await runGit(['rev-parse', '--git-dir'], cwd);
  return r.code === 0;
}

interface ChangedFile {
  path: string;
  status: 'added' | 'modified';
}

async function getChangedFiles(cwd: string): Promise<ChangedFile[]> {
  const r = await runGit(['status', '--porcelain', '--untracked-files=no'], cwd);
  if (r.code !== 0) return [];
  const files: ChangedFile[] = [];
  for (const line of r.stdout.split('\n')) {
    if (!line.trim()) continue;
    const x = line[0] ?? ' ';
    const y = line[1] ?? ' ';
    const rawPath = line.slice(3).trim();
    // R (rename) / C (copy) porcelain format: "R  old -> new"
    const filePath =
      x === 'R' || x === 'C' ? (rawPath.split(' -> ').pop()?.trim() ?? rawPath) : rawPath;
    if (x === 'A' || y === 'A') {
      files.push({ path: filePath, status: 'added' });
    } else if (x === 'M' || y === 'M' || x === 'R' || x === 'C') {
      files.push({ path: filePath, status: 'modified' });
    }
  }
  return files;
}

interface ChangedFileSnapshot extends ChangedFile {
  content: string;
  fingerprint: string;
}

/**
 * A single file bigger than this is not review material (lockfiles, changelogs,
 * generated i18n bundles, architecture dumps). Reading them only inflates the
 * snapshot: the reviewer never gets a useful signal out of them.
 */
const MAX_SNAPSHOT_FILE_BYTES = 256 * 1024;

/**
 * Ceiling on the bytes one snapshot pass may hold at once. Reached only on
 * unusually large working trees; the remaining files are simply not snapshotted
 * this pass and get picked up once the earlier ones stop being reported.
 */
const MAX_SNAPSHOT_TOTAL_BYTES = 8 * 1024 * 1024;

async function snapshotChangedFiles(cwd: string): Promise<ChangedFileSnapshot[]> {
  const snapshots: ChangedFileSnapshot[] = [];
  let budget = MAX_SNAPSHOT_TOTAL_BYTES;
  for (const file of await getChangedFiles(cwd)) {
    // Filter before reading, not after — the caller drops these anyway, and
    // reading them first is what makes the pass expensive.
    if (file.path.startsWith('.wrongstack/')) continue;
    if (budget <= 0) break;
    try {
      const stat = await fsp.stat(path.join(cwd, file.path));
      if (!stat.isFile() || stat.size > MAX_SNAPSHOT_FILE_BYTES) continue;
      const content = await fsp.readFile(path.join(cwd, file.path), 'utf8');
      budget -= content.length;
      snapshots.push({
        ...file,
        content,
        fingerprint: createHash('sha256').update(content).digest('hex'),
      });
    } catch {
      // File deleted, unreadable, or not a regular UTF-8 file — skip it.
    }
  }
  return snapshots;
}

// ---------------------------------------------------------------------------
// In-flight review tracking
// ---------------------------------------------------------------------------
interface InFlightReview {
  files: string[]; // file paths being reviewed
  startedAt: number;
  subagentType: 'review' | 'cascade';
}

// ---------------------------------------------------------------------------
// Slash command
// ---------------------------------------------------------------------------
function buildAutoReviewCommand(
  getConfig: () => ResolvedAutoReviewConfig,
  getInFlightCount: () => number,
): SlashCommand {
  return {
    name: 'auto-review',
    category: 'Session',
    description: 'Show continuous auto-review status and configuration.',
    help: [
      '╔═══ Auto Review ═══╗',
      '',
      'Continuous code review that fires on every change during a session.',
      'Detects git-tracked file edits and dispatches review subagents',
      'with configurable provider/model/fallback.',
      '',
      'When a review report contains findings at or above the cascadeOn',
      'threshold, follow-up agents (security-scanner, bug-hunter) are',
      'automatically spawned to investigate.',
      '',
      'Commands:',
      '  /auto-review           Show current status and config',
      '  /auto-review on        Enable auto-review',
      '  /auto-review off       Disable auto-review',
      '',
      'Configuration (edit config.json extensions.wstack-auto-review):',
      '  enabled              true | false',
      '  provider             provider id for review agents',
      '  model                model id for review agents',
      '  fallbackProfile      named profile from config.fallbackProfiles',
      '  debounceMs           debounce window (default 15000)',
      '  maxFilesPerBatch     max files per review (default 15)',
      '  maxConcurrentReviews max parallel reviews (default 2)',
      '  cascadeOn            "off" | "critical" | "high" (default off)',
      '                       Spawns security-scanner/bug-hunter when',
      '                       findings reach this severity. "high" fires',
      '                       on any High+ finding; "critical" only on Critical.',
      '  maxCascadeDepth      max fix+re-review cycles (default 2, 0=off)',
    ].join('\n'),
    async run(args: string) {
      const cfg = getConfig();
      const trimmed = (args ?? '').trim().toLowerCase();
      if (trimmed === 'on' || trimmed === 'enable') {
        return {
          message:
            'Auto-review enable/disable via config.json extensions.wstack-auto-review.enabled',
        };
      }
      if (trimmed === 'off' || trimmed === 'disable') {
        return {
          message:
            'Auto-review enable/disable via config.json extensions.wstack-auto-review.enabled',
        };
      }

      const inFlight = getInFlightCount();
      const cascadeDesc =
        cfg.cascadeOn === 'off'
          ? 'disabled'
          : `on ${cfg.cascadeOn}+ → spawns security-scanner/bug-hunter`;
      return {
        message: [
          `📋 Auto Review — ${cfg.enabled ? '✅ enabled' : '⏸️  disabled'}`,
          '',
          `  Provider:       ${cfg.provider}`,
          `  Model:          ${cfg.model}`,
          `  Fallback:       ${cfg.fallbackModels.length > 0 ? cfg.fallbackModels.join(', ') : '(none)'}`,
          `  Debounce:       ${cfg.debounceMs} ms`,
          `  Max files:      ${cfg.maxFilesPerBatch}`,
          `  Max parallel:   ${cfg.maxConcurrentReviews}`,
          `  Cascade:        ${cascadeDesc}`,
          `  Max depth:      ${cfg.maxCascadeDepth} re-review cycle(s)`,
          `  In-flight:      ${inFlight} review(s)`,
          '',
          'Fires on every git-tracked file change during the session.',
          'Disabled by default. Enable via config.json.',
        ].join('\n'),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------
export function createAutoReviewPlugin(): Plugin {
  return {
    name: 'wstack-auto-review',
    version: '1.0.0',
    description: 'Continuous auto-review that fires on every code change during a session.',
    apiVersion: '^0.1',
    capabilities: { slashCommands: true },
    defaultConfig: {},

    setup(api) {
      // ── Reactive config ──────────────────────────────────────────
      const recompute = (): ResolvedAutoReviewConfig => {
        const raw: AutoReviewConfig =
          (api.config.extensions?.['wstack-auto-review'] as AutoReviewConfig | undefined) ?? {};
        return resolveAutoReviewConfig(raw, api.config);
      };
      let resolved = recompute();
      const inFlight: InFlightReview[] = [];
      const expireInFlight = (entry: InFlightReview): void => {
        const timer = setTimeout(
          () => {
            const idx = inFlight.indexOf(entry);
            if (idx !== -1) inFlight.splice(idx, 1);
          },
          5 * 60 * 1000,
        );
        timer.unref();
      };

      api.onConfigChange(() => {
        const old = resolved;
        resolved = recompute();
        if (
          old.enabled !== resolved.enabled ||
          old.provider !== resolved.provider ||
          old.model !== resolved.model
        ) {
          api.log.info(
            `[auto-review] config changed — enabled=${resolved.enabled} provider=${resolved.provider} model=${resolved.model}`,
          );
        }
      });

      if (!resolved.enabled) {
        api.log.info('[auto-review] disabled by config');
        return;
      }

      api.log.info(
        `[auto-review] loaded — provider=${resolved.provider} model=${resolved.model} debounce=${resolved.debounceMs}ms cascade=${resolved.cascadeOn}`,
      );

      // ── State: track reviewed content and changes awaiting review ─
      const knownFingerprints = new Map<string, string>();
      const pendingFiles = new Map<string, ChangedFileSnapshot>();
      let reviewCounter = 0;
      let pendingReviewTimer: ReturnType<typeof setTimeout> | undefined;
      let pendingReviewWork: Promise<void> | undefined;
      let sessionEnded = false;
      let latestIterationPayload: EventMap['iteration.completed'] | undefined;

      /**
       * A snapshot pass reads every changed file in the working tree, so it can
       * easily outlast one agent iteration. Without this guard the passes
       * overlap and each in-flight pass retains every file it has read so far —
       * on a tree with ~90 changed files that measured 1.28GB of live strings
       * held by ~180 stacked passes. One pass at a time; skip, don't queue,
       * because the next iteration re-reads the same tree anyway.
       */
      let snapshotInFlight = false;
      const withSnapshotLock = async <T>(fn: () => Promise<T>): Promise<T | undefined> => {
        if (snapshotInFlight) {
          api.log.info('[auto-review] snapshot pass already in flight, skipping');
          return undefined;
        }
        snapshotInFlight = true;
        try {
          return await fn();
        } finally {
          snapshotInFlight = false;
        }
      };

      // Seed current snapshots on session start; only later content changes trigger.
      api.onEvent('agent.run.started', async () => {
        try {
          const cwd = api.config.cwd ?? process.cwd();
          if (!(await isGitRepo(cwd))) return;
          const snapshots = await withSnapshotLock(() => snapshotChangedFiles(cwd));
          if (!snapshots) return;
          for (const file of snapshots) {
            knownFingerprints.set(file.path, file.fingerprint);
          }
          api.log.info(`[auto-review] seeded ${knownFingerprints.size} known file snapshot(s)`);
        } catch {
          /* best-effort */
        }
      });

      // ── /auto-review command ─────────────────────────────────────
      api.slashCommands.register(
        buildAutoReviewCommand(
          () => resolved,
          () => inFlight.length,
        ),
      );

      const cancelPendingReviewTimer = (): void => {
        if (!pendingReviewTimer) return;
        clearTimeout(pendingReviewTimer);
        pendingReviewTimer = undefined;
      };

      let handleIterationCompleted:
        | ((
            payload: EventMap['iteration.completed'] | undefined,
            fromQuietTimer?: boolean,
          ) => Promise<void>)
        | undefined;

      const schedulePendingReview = (delayMs: number): void => {
        cancelPendingReviewTimer();
        if (sessionEnded || pendingFiles.size === 0) return;

        const timer = setTimeout(
          async () => {
            if (pendingReviewTimer === timer) pendingReviewTimer = undefined;
            if (sessionEnded) return;
            const work = handleIterationCompleted?.(latestIterationPayload, true);
            if (!work) return;
            pendingReviewWork = work;
            try {
              await work;
            } finally {
              if (pendingReviewWork === work) pendingReviewWork = undefined;
            }
          },
          Math.max(0, delayMs),
        );
        pendingReviewTimer = timer;
        timer.unref();
      };

      const refreshPendingFiles = (snapshots: ChangedFileSnapshot[]): boolean => {
        let pendingChanged = false;
        const observedPaths = new Set<string>();
        for (const file of snapshots) {
          if (file.path.startsWith('.wrongstack/')) continue;
          observedPaths.add(file.path);
          if (knownFingerprints.get(file.path) !== file.fingerprint) {
            if (pendingFiles.get(file.path)?.fingerprint !== file.fingerprint) {
              pendingChanged = true;
            }
            pendingFiles.set(file.path, file);
          } else if (pendingFiles.delete(file.path)) {
            // The file reverted to the last reviewed content while queued.
            pendingChanged = true;
          }
        }
        for (const pendingPath of pendingFiles.keys()) {
          if (!observedPaths.has(pendingPath)) {
            // The path was reverted clean, deleted, or became unreadable.
            pendingFiles.delete(pendingPath);
            pendingChanged = true;
          }
        }
        return pendingChanged;
      };

      // ── iteration.completed → detect changes → wait for quiet → emit review ──
      handleIterationCompleted = async (payload, fromQuietTimer = false) => {
        try {
          const cfg = resolved;
          if (!cfg.enabled || sessionEnded) return;
          if (payload) latestIterationPayload = payload;

          const cwd = api.config.cwd ?? process.cwd();
          if (!(await isGitRepo(cwd))) return;

          // Extract todos from ctx for P1 enrichment.
          // iteration.completed payload carries { ctx: Context } which has todos.
          const ctxTodos = payload?.ctx?.todos;

          const snapshots = await withSnapshotLock(() => snapshotChangedFiles(cwd));
          if (!snapshots) {
            if (fromQuietTimer) schedulePendingReview(cfg.debounceMs);
            return; // a pass is already walking the tree
          }
          if (sessionEnded) return;
          const now = Date.now();

          // Queue the latest content snapshot for every tracked file whose content
          // differs from the last emitted snapshot. Pending entries survive both
          // debounce and concurrency limits and are replaced by newer edits.
          const pendingChanged = refreshPendingFiles(snapshots);

          if (pendingFiles.size === 0) {
            cancelPendingReviewTimer();
            return;
          }

          if (cfg.debounceMs > 0) {
            if (!fromQuietTimer) {
              // A newly observed edit restarts the trailing quiet window. An
              // unchanged iteration leaves the existing deadline alone.
              if (pendingChanged || !pendingReviewTimer) {
                schedulePendingReview(cfg.debounceMs);
                api.log.info(
                  `[auto-review] waiting ${cfg.debounceMs}ms for ${pendingFiles.size} pending file(s) to settle`,
                );
              }
              return;
            }

            // Re-read at timer expiry. If content changed without another
            // iteration event, wait for a fresh quiet window instead of
            // reviewing the stale snapshot.
            if (pendingChanged) {
              schedulePendingReview(cfg.debounceMs);
              api.log.info(
                `[auto-review] file activity continued, restarting ${cfg.debounceMs}ms quiet window for ${pendingFiles.size} pending file(s)`,
              );
              return;
            }
          }

          if (inFlight.length >= cfg.maxConcurrentReviews) {
            api.log.info(
              `[auto-review] at max concurrent (${cfg.maxConcurrentReviews}), retaining ${pendingFiles.size} pending file(s)`,
            );
            return;
          }

          // Batch: drain only the emitted entries; overflow remains pending.
          const toReview = [...pendingFiles.values()].slice(0, cfg.maxFilesPerBatch);
          if (toReview.length === 0) return;

          const filesWithContent: ChimeraReviewNeededPayload['files'] = toReview.map((file) => ({
            path: file.path,
            status: file.status,
            content: file.content,
          }));

          reviewCounter++;

          // ── Build enriched review context (diffs, siblings, commits) ──
          const bundle = await buildReviewContext({
            cwd,
            config: {
              enabled: true,
              provider: cfg.provider,
              model: cfg.model,
              maxFiles: cfg.maxFilesPerBatch,
              autoFix: 'off',
              cascadeOn: 'off',
              maxCascadeDepth: 0,
            },
            files: filesWithContent,
            activeTodos: ctxTodos,
            cascadeOn: cfg.cascadeOn,
            maxCascadeDepth: cfg.maxCascadeDepth,
          });
          bundle.reviewFallbackModels = [...cfg.fallbackModels];
          const trackedChangedPaths = new Set(
            snapshots
              .filter((file) => !file.path.startsWith('.wrongstack/'))
              .map((file) => file.path),
          );
          bundle.allChangedFiles = bundle.allChangedFiles?.filter((file) =>
            trackedChangedPaths.has(file.path),
          );

          // session.ended owns all work from this point forward. This second
          // check closes the race where the quiet timer started building
          // context immediately before the session transitioned.
          if (sessionEnded) return;

          api.log.info(
            `[auto-review] #${reviewCounter} emitting review_needed (${filesWithContent.length} files, provider=${cfg.provider} model=${cfg.model})`,
          );

          const emittedBundle = emitReviewIfChanged(api, bundle);
          if (!emittedBundle) {
            api.log.info(
              `[auto-review] #${reviewCounter} skipped — file content already has a review in progress`,
            );
            return;
          }
          const emittedPaths = new Set(emittedBundle.files.map((file) => file.path));
          const inflightEntry: InFlightReview = {
            files: [...emittedPaths],
            startedAt: now,
            subagentType: 'review',
          };
          inFlight.push(inflightEntry);
          for (const file of toReview) {
            if (!emittedPaths.has(file.path)) continue;
            knownFingerprints.set(file.path, file.fingerprint);
            pendingFiles.delete(file.path);
          }
          // requires the Director (--director flag). Without it, reviews are
          // silently skipped. If reviews don't appear, check that the session
          // runs with --director or enable Director in your config.
          api.log.info(
            `[auto-review] #${reviewCounter} event emitted — ${emittedBundle.files.length}/${filesWithContent.length} files; requires Director (--director) for subagent spawning`,
          );

          // ── Cascade: handled by the chimera.review_complete listener ──
          // When the review subagent finishes, execution.ts emits
          // chimera.review_complete. The listener registered below parses
          // severity from the report and emits chimera.cascade_needed when
          // findings cross the cascadeOn threshold. execution.ts then spawns
          // follow-up agents (security-scanner, bug-hunter).

          // Clean in-flight after a timeout (reviews complete asynchronously)
          expireInFlight(inflightEntry);

          if (pendingFiles.size > 0 && cfg.debounceMs > 0) {
            schedulePendingReview(cfg.debounceMs);
          }
        } catch (err) {
          api.log.warn(`[auto-review] iteration.completed handler failed: ${toErrorMessage(err)}`);
        }
      };

      api.onEvent('iteration.completed', async (payload) => {
        await handleIterationCompleted?.(payload);
      });

      // ── session.ended → final review of everything ───────────────
      api.onEvent('session.ended', async () => {
        sessionEnded = true;
        const handedOffFiles = pendingFiles.size;
        cancelPendingReviewTimer();
        if (handedOffFiles > 0) {
          api.log.info(
            `[auto-review] session ended — handed ${handedOffFiles} pending mid-session file(s) to post-session review`,
          );
        }
        // If the quiet timer already started reading, wait for that pass to
        // observe sessionEnded and unwind before post-session claims the files.
        await pendingReviewWork;
        try {
          const cfg = resolved;
          if (!cfg.enabled) return;

          const cwd = api.config.cwd ?? process.cwd();
          if (!(await isGitRepo(cwd))) return;

          const allChanged = await getChangedFiles(cwd);
          const existing: ChangedFile[] = [];
          for (const f of allChanged) {
            if (f.path.startsWith('.wrongstack/')) continue;
            try {
              await fsp.access(path.join(cwd, f.path));
              existing.push(f);
            } catch {
              /* deleted */
            }
          }

          if (existing.length === 0) return;

          const toReview = existing.slice(0, cfg.maxFilesPerBatch);

          const filesWithContent: ChimeraReviewNeededPayload['files'] = [];
          for (const f of toReview) {
            try {
              const absPath = path.join(cwd, f.path);
              const content = await fsp.readFile(absPath, 'utf8');
              filesWithContent.push({ path: f.path, status: f.status, content });
            } catch {
              /* skip */
            }
          }

          if (filesWithContent.length === 0) return;

          // Track in-flight (honors maxConcurrentReviews cap)
          if (inFlight.length >= cfg.maxConcurrentReviews) {
            api.log.info(
              `[auto-review] session end — at max concurrent (${cfg.maxConcurrentReviews}), skipping final review`,
            );
            return;
          }

          // ── Build enriched review context (diffs, siblings, commits) ──
          const bundle = await buildReviewContext({
            cwd,
            config: {
              enabled: true,
              provider: cfg.provider,
              model: cfg.model,
              maxFiles: cfg.maxFilesPerBatch,
              autoFix: 'off',
              cascadeOn: 'off',
              maxCascadeDepth: 0,
            },
            files: filesWithContent,
            cascadeOn: cfg.cascadeOn,
            maxCascadeDepth: cfg.maxCascadeDepth,
          });
          bundle.reviewFallbackModels = [...cfg.fallbackModels];
          const trackedChangedPaths = new Set(existing.map((file) => file.path));
          bundle.allChangedFiles = bundle.allChangedFiles?.filter((file) =>
            trackedChangedPaths.has(file.path),
          );

          const emittedBundle = emitReviewIfChanged(api, bundle);
          if (!emittedBundle) {
            api.log.info(
              '[auto-review] session end — unchanged files already have reviews in progress',
            );
            return;
          }
          const inflightEntry: InFlightReview = {
            files: emittedBundle.files.map((file) => file.path),
            startedAt: Date.now(),
            subagentType: 'review',
          };
          inFlight.push(inflightEntry);
          expireInFlight(inflightEntry);

          api.log.info(
            `[auto-review] session end — final review (${emittedBundle.files.length} files)`,
          );
        } catch (err) {
          api.log.warn(`[auto-review] session.ended handler failed: ${toErrorMessage(err)}`);
        }
      });

      // ── chimera.review_complete → parse severity → emit cascade_needed ──
      //
      // When the review subagent finishes, execution.ts emits
      // chimera.review_complete carrying the report text + the original
      // bundle. Here we:
      //   1. Parse the finding counts from the report.
      //   2. Gate on bundle.cascadeOn (only auto-review triggers set it).
      //   3. If the threshold is crossed, decide which follow-up agents
      //      to spawn (security-scanner, bug-hunter) and emit
      //      chimera.cascade_needed — which execution.ts consumes to
      //      spawn the follow-up subagents via the Director.
      //
      // This listener fires synchronously within the pendingChimeraWork
      // IIFE, so the cascade_needed emission reaches execution.ts before
      // the session-close await resolves.
      api.onPattern('chimera.review_complete', (_event, payload) => {
        try {
          const p = payload as ChimeraReviewCompletePayload;
          if (!p.reviewText) return; // failed review or empty report

          const cascadeOn = p.bundle.cascadeOn ?? 'off';
          if (cascadeOn === 'off') return;

          const severities = parseReviewSeverity(p.reviewText);
          const threshold = shouldCascade(cascadeOn, severities);
          if (!threshold) return;

          const agents = decideCascadeAgents(p.reviewText, severities);
          if (agents.length === 0) {
            // Threshold crossed but no agent selected — shouldn't happen
            // (High+ always selects bug-hunter), but guard defensively.
            return;
          }

          const cascadePayload: ChimeraCascadeNeededPayload = {
            bundle: p.bundle,
            reviewText: p.reviewText,
            severities,
            threshold,
            agents,
          };

          api.emitCustom('chimera.cascade_needed', cascadePayload);
          api.log.info(
            `[auto-review] cascade_needed emitted — ${severities.critical} critical, ${severities.high} high, ${severities.medium} medium; agents: ${agents.join(', ')}`,
          );
        } catch (err) {
          api.log.warn(
            `[auto-review] review_complete cascade handler failed: ${toErrorMessage(err)}`,
          );
        }
      });
    },

    teardown(api) {
      api.slashCommands.unregister('auto-review');
      api.log.info('[auto-review] unloaded');
    },

    async health() {
      return { ok: true, message: 'auto-review ready' };
    },
  };
}
