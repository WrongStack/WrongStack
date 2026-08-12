/**
 * package-outdated-watcher — Periodically checks installed packages for outdated
 * versions and notifies the agent that originally added each package.
 *
 * Architecture:
 *   1. Polls the mailbox for `assign` messages from the tech-stack agent
 *      containing outdated package results.
 *   2. For each outdated package, looks up the original author via
 *      `package-author-tracker`.
 *   3. Sends a high-priority `note` message to the original author (or
 *      broadcasts to `*` if the author is unknown or no longer online).
 *
 * The watcher can also be triggered directly via `checkOutdated` for
 * on-demand checks (e.g. on a timer, or when the user requests it).
 *
 * Usage:
 *   const dispose = startPackageOutdatedWatcher({
 *     mailbox,
 *     storageDir: wpaths.globalDir,
 *     projectRoot,
 *     pollIntervalMs: 60 * 60 * 1000, // 1 hour
 *     onNotify: async (msg) => mailbox.send(msg),
 *     onLog: (m) => console.log(`[pkg-outdated-watcher] ${m}`),
 *   });
 *
 * @module package-outdated-watcher
 */

import type { Mailbox, MailboxMessage } from './mailbox-types.js';
import { isMailboxSenderInFamily } from './mailbox-types.js';
import { toErrorMessage } from '../utils/error.js';
import {
  detectEcosystem,
  getPackageAuthor,
  type PackageAuthorTrackerOptions,
} from './package-author-tracker.js';

export interface PackageOutdatedEntry {
  /** Package name. */
  name: string;
  /** Currently installed version. */
  currentVersion: string;
  /** Latest stable version available. */
  latestVersion: string;
  /** semver major.minor.patch wanted range (from lockfile). */
  wantedVersion: string;
  /** Manifest file this package belongs to. */
  manifestPath: string;
  /** Ecosystem: 'npm', 'cargo', 'go', etc. */
  ecosystem: string;
}

export interface PackageOutdatedResult {
  /** All outdated entries. */
  outdated: PackageOutdatedEntry[];
  /** Packages that are up-to-date. */
  upToDate: string[];
  /** Whether the check failed. */
  checkFailed: boolean;
}

export interface PackageOutdatedWatcherOptions {
  /** The mailbox for sending notifications and receiving tech-stack results. */
  mailbox: Mailbox;
  /** Package-author-tracker options. */
  packageTrackerOpts: Pick<PackageAuthorTrackerOptions, 'storageDir' | 'projectRoot'>;
  /** Polling interval in ms. Default: 60 * 60 * 1000 (1 hour). */
  pollIntervalMs?: number | undefined;
  /** Agent id that runs this watcher. Default: 'pkg-outdated-watcher'. */
  watcherAgentId?: string | undefined;
  /**
   * The only sender whose `result` messages this watcher acts on. Default:
   * `'tech-stack'`. Matched as an agent family, so the worker the tech-stack
   * consumer spawns as `tech-stack-<manifest>` also passes — `ctx.agentId`
   * comes from the spawn name, so its mail arrives from
   * `tech-stack-package.json@<tag>`, not from a bare `tech-stack`.
   *
   * This option was declared and documented from the start but never read:
   * it appeared exactly once in the codebase, in this interface. The watcher
   * therefore acted on a `result` addressed to it from ANY sender, and the
   * body chose both the package names and — through `getPackageAuthor` —
   * whether the resulting HIGH-priority notification went to one agent or was
   * broadcast to `*`. Any agent on the project could use it to push
   * attacker-chosen text to everyone, under a watcher's identity.
   */
  techStackAgentId?: string | undefined;
  /** Called to send a notification to an agent. */
  onNotify: (msg: OutdatedNotifyMessage) => Promise<void>;
  /** Called for log output. */
  onLog?: ((msg: string) => void) | undefined;
  /** Called on errors. */
  onError?: ((err: unknown) => void) | undefined;
}

export interface OutdatedNotifyMessage {
  from: string;
  to: string;
  subject: string;
  body: string;
  priority: 'high' | 'normal' | 'low';
}

/** Parse a tech-stack `result` message body for outdated package entries. */
function parseOutdatedPackages(body: string): PackageOutdatedEntry[] {
  const results: PackageOutdatedEntry[] = [];

  // The tech-stack agent returns a markdown table or structured text.
  // Try to extract package rows from markdown table format:
  // | Package | Current | Latest | Wanted | Manifest |
  // The header row has alphabetic content, the separator row has dashes,
  // and data rows have version numbers or package names.
  const tableRows = body.matchAll(
    /^\|\s*([^-][^|]*?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|/gm,
  );
  for (const rowMatch of tableRows) {
    const cols = rowMatch[0]
      .split('|')
      .map((c) => c.trim())
      .filter(Boolean);
    // cols[0]=Package, cols[1]=Current, cols[2]=Latest, cols[3]=Wanted, cols[4]=Manifest
    // The [^-] at the start of the regex skips the separator row (|----...|)
    if (cols.length >= 5 && cols[0] && cols[0] !== 'Package') {
      results.push({
        name: cols[0] ?? '',
        currentVersion: cols[1] ?? '',
        latestVersion: cols[2] ?? '',
        wantedVersion: cols[3] ?? '',
        manifestPath: cols[4] ?? '',
        ecosystem: detectEcosystem(cols[4] ?? ''),
      });
    }
  }

  // Fallback: try key=value lines like "Package: xyz, Current: 1.0, Latest: 2.0"
  if (results.length === 0) {
    const kvMatches = body.matchAll(
      /(?:package|name)[\s:=]+([\w@/-]+).*?(?:current|version)[\s:=]+([\d.]+).*?latest[\s:=]+([\d.]+)/gi,
    );
    for (const m of kvMatches) {
      results.push({
        name: m[1] ?? '',
        currentVersion: m[2] ?? '',
        latestVersion: m[3] ?? '',
        wantedVersion: m[2] ?? '',
        manifestPath: '',
        ecosystem: 'unknown',
      });
    }
  }

  return results;
}

/** Max processed message IDs retained for duplicate suppression. */
const MAX_PROCESSED_IDS = 500;

interface WatcherState {
  running: boolean;
  timer: ReturnType<typeof setInterval> | null;
  processedIds: Set<string>;
  processedIdsQueue: string[];
}

/**
 * Start the package outdated watcher.
 *
 * Returns a dispose function that stops polling and cleans up.
 */
export function startPackageOutdatedWatcher(opts: PackageOutdatedWatcherOptions): () => void {
  const {
    mailbox,
    packageTrackerOpts,
    pollIntervalMs = 60 * 60 * 1000,
    watcherAgentId = 'pkg-outdated-watcher',
    techStackAgentId = 'tech-stack',
    onNotify,
    onLog,
    onError,
  } = opts;

  const log = (msg: string) => onLog?.(msg);
  const handleError = (err: unknown) => onError?.(err);

  const state: WatcherState = {
    running: true,
    timer: null,
    processedIds: new Set<string>(),
    processedIdsQueue: [],
  };

  async function pollOnce(): Promise<void> {
    /* v8 ignore next -- defensive: dispose() clears the interval, so pollOnce is never called after stop */
    if (!state.running) return;

    try {
      const messages = await mailbox.query({
        to: watcherAgentId,
        type: 'result',
        unreadBy: watcherAgentId,
        limit: 10,
      });

      for (const msg of messages) {
        if (state.processedIds.has(msg.id)) continue;
        // Cap processedIds to prevent unbounded memory growth from
        // retaining every message id forever. When the cap is reached,
        // evict the oldest entry before adding the new one.
        if (state.processedIds.size >= MAX_PROCESSED_IDS) {
          const oldest = state.processedIdsQueue.shift();
          if (oldest !== undefined) state.processedIds.delete(oldest);
        }
        state.processedIds.add(msg.id);
        state.processedIdsQueue.push(msg.id);

        await mailbox.ack({
          messageId: msg.id,
          readerId: watcherAgentId,
          read: true,
        });

        // Sender gate — see `techStackAgentId`. Acked above so an unexpected
        // sender is consumed rather than re-polled, but it never reaches the
        // notify path.
        if (!isMailboxSenderInFamily(msg.from, techStackAgentId)) {
          log(
            `[pkg-outdated-watcher] Ignoring result from "${msg.from}" (only "${techStackAgentId}" may drive notifications)`,
          );
          continue;
        }

        await processResultMessage(msg);
      }
    } catch (err) {
      handleError(err);
    }
  }

  async function processResultMessage(msg: MailboxMessage): Promise<void> {
    const entries = parseOutdatedPackages(msg.body ?? '');
    if (entries.length === 0) {
      log(`[pkg-outdated-watcher] No outdated packages found in message ${msg.id}`);
      return;
    }

    log(`[pkg-outdated-watcher] Processing ${entries.length} outdated package(s) from ${msg.from}`);

    for (const entry of entries) {
      try {
        const author = await getPackageAuthor(packageTrackerOpts, entry.manifestPath, entry.name);

        const notifyTarget = author?.agentId ?? '*';
        const notifyBody = buildNotifyBody(entry, author?.agentName);

        const notifyMsg: OutdatedNotifyMessage = {
          from: watcherAgentId,
          to: notifyTarget,
          subject: `Outdated package: ${entry.name}@${entry.currentVersion} → ${entry.latestVersion}`,
          body: notifyBody,
          priority: 'high',
        };

        await onNotify(notifyMsg);
        log(
          `[pkg-outdated-watcher] Notified ${notifyTarget} about outdated ${entry.name} ` +
            `(${entry.currentVersion} → ${entry.latestVersion}) in ${entry.manifestPath}`,
        );
      } catch (err) {
        handleError(err);
        log(`[pkg-outdated-watcher] Failed to notify for ${entry.name}: ${toErrorMessage(err)}`);
      }
    }
  }

  // Start polling
  state.timer = setInterval(() => {
    void pollOnce();
  }, pollIntervalMs);
  // Background watcher: never keep the host process alive on its own. The
  // REPL/TUI/server that started it owns the real keep-alive, and dispose()
  // clears this timer; without unref the poll interval blocks a clean exit.
  state.timer.unref?.();

  // Run immediately on start
  void pollOnce();

  return () => {
    state.running = false;
    if (state.timer) {
      clearInterval(state.timer);
      state.timer = null;
    }
  };
}

function buildNotifyBody(entry: PackageOutdatedEntry, authorName?: string): string {
  const lines = [
    `The package **${entry.name}** is outdated.`,
    '',
    `| Field | Value |`,
    `|-------|-------|`,
    `| Package | ${entry.name} |`,
    `| Installed | ${entry.currentVersion} |`,
    `| Latest | ${entry.latestVersion} |`,
    `| Wanted | ${entry.wantedVersion} |`,
    `| Manifest | ${entry.manifestPath} |`,
    `| Ecosystem | ${entry.ecosystem} |`,
    '',
  ];

  if (authorName) {
    lines.push(
      `You added this package${authorName !== 'unknown' ? ` (as ${authorName})` : ''}. ` +
        `Consider updating it with the install tool.`,
    );
  } else {
    lines.push(
      `This package appears to have been added by an agent no longer on record. ` +
        `Consider reviewing and updating it.`,
    );
  }

  lines.push('', `Update with:`, `\`\`\``, `${getUpdateCommand(entry)}`, `\`\`\``);

  return lines.join('\n');
}

function getUpdateCommand(entry: PackageOutdatedEntry): string {
  switch (entry.ecosystem) {
    case 'npm':
      return `pnpm add ${entry.name}@latest  # or: pnpm update ${entry.name}`;
    case 'cargo':
      return `cargo update ${entry.name}`;
    case 'go':
      return `go get ${entry.name}@latest`;
    case 'pip':
      return `pip install --upgrade ${entry.name}`;
    case 'gem':
      return `gem install ${entry.name}`;
    case 'composer':
      return `composer require ${entry.name}:^${entry.latestVersion} --update-with-dependencies`;
    case 'nuget':
      return `dotnet add package ${entry.name}`;
    case 'maven':
      return `# Update the <version> in pom.xml or run:\nmvn versions:use-latest-versions`;
    case 'dart':
      return `dart pub upgrade ${entry.name}`;
    default:
      return `# Update ${entry.name} to ${entry.latestVersion} using your package manager`;
  }
}
