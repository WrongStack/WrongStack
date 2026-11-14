import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { EventMap } from '@wrongstack/contracts/kernel/events';
import type { Plugin } from '@wrongstack/contracts/types/plugin';
import type { SlashCommand } from '@wrongstack/contracts/types/slash-command';
import { resolveChronicleFileLineage } from '@wrongstack/core/agent';
import { areSubagentsAllowed } from '@wrongstack/core/security';
import { projectSlug, toErrorMessage } from '@wrongstack/core/utils';
import {
  type AutoReviewConfig,
  buildReviewerModelPool,
  decideCascadeAgents,
  MAX_KNOWN_FINGERPRINTS,
  parseReviewSeverity,
  type ResolvedAutoReviewConfig,
  type ReviewerModelAssignment,
  resolveAutoReviewConfig,
  selectRoundRobinReviewerAssignment,
  severitiesFromFindings,
  shouldCascade,
  trimKnownFingerprints,
} from './auto-review-config.js';

export type { ReviewerModelAssignment };

import {
  type ChangedFile,
  type ChangedFileSnapshot,
  getChangedFilesWithMetaIfRepo,
  snapshotChangedFilesIfRepo,
  snapshotChangedFilesWithMetaIfRepo,
} from './auto-review-git.js';
import type {
  ChimeraCascadeNeededPayload,
  ChimeraReviewCompletePayload,
  ChimeraReviewNeededPayload,
} from './chimera-plugin.js';
import {
  emitReviewIfChanged,
  getCompletedReviewSnapshots,
  hydrateCompletedSnapshotsFromReportStore,
  isFileContentAlreadyReviewed,
  recordCompletedReview,
} from './review-claim-registry.js';
import {
  buildReviewContext,
  extractSessionIntentSnippets,
  isIgnoredReviewNoisePath,
  prioritizeReviewCandidates,
} from './review-context-builder.js';
import type { ReviewSkippedFile } from './review-types.js';

export {
  buildReviewerModelPool,
  decideCascadeAgents,
  parseReviewSeverity,
  resolveAutoReviewConfig,
  selectRoundRobinReviewerAssignment,
  severitiesFromFindings,
  shouldCascade,
  trimKnownFingerprints,
};

interface InFlightReview {
  bundle: ChimeraReviewNeededPayload;
  files: string[];
  startedAt: number;
  subagentType: 'review' | 'cascade';
  timer?: ReturnType<typeof setTimeout> | undefined;
}

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
      'with configurable provider/model/fallback and profile selection.',
      '',
      'Reports are persisted and shown as passive notifications. With',
      '`cascadeOn` (on by default) a High or Critical finding additionally',
      'dispatches follow-up security-scanner/bug-hunter agents that can edit code.',
      '',
      'Commands:',
      '  /auto-review           Show current status and config',
      '  /auto-review on        Enable auto-review',
      '  /auto-review off       Disable auto-review',
      '',
      'Configuration (edit config.json extensions.wstack-auto-review):',
      '  enabled              true | false (default true — on after a fresh install)',
      '  provider             provider id for review agents',
      '  model                model id for review agents',
      '  fallbackProfile      named profile from config.fallbackProfiles',
      '  modelSelection       round-robin | random (default round-robin)',
      '  debounceMs           debounce window (default 15000)',
      '  maxFilesPerBatch     max files per review (default 15)',
      '  maxConcurrentReviews max parallel reviews (default 2)',
      '  cascadeOn            off | critical | high (default high)',
      '  maxCascadeDepth      max fix+re-review cycles (default 2)',
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
      return {
        message: [
          `📋 Auto Review — ${cfg.enabled ? '✅ enabled' : '⏸️  disabled'}`,
          '',
          `  Provider:       ${cfg.provider}`,
          `  Model:          ${cfg.model}`,
          `  Fallback / RR:  ${cfg.fallbackModels.length > 0 ? cfg.fallbackModels.join(', ') : '(none)'}`,
          `  Selection:      ${cfg.modelSelection}`,
          `  Debounce:       ${cfg.debounceMs} ms`,
          `  Max files:      ${cfg.maxFilesPerBatch}`,
          `  Max parallel:   ${cfg.maxConcurrentReviews}`,
          `  Cascade:        ${cfg.cascadeOn === 'off' ? 'off' : `on ${cfg.cascadeOn}+ → spawns security-scanner/bug-hunter`}`,
          `  Max depth:      ${cfg.maxCascadeDepth} re-review cycle(s)`,
          `  In-flight:      ${inFlight} review(s)`,
          '',
          'Fires on every git-tracked file change during the session.',
          'On by default. Disable via config.json extensions.wstack-auto-review.enabled.',
        ].join('\n'),
      };
    },
  };
}

export function createAutoReviewPlugin(): Plugin {
  let teardownHook: (() => void) | undefined;

  return {
    name: 'wstack-auto-review',
    version: '1.0.0',
    description: 'Continuous auto-review that fires on every code change during a session.',
    apiVersion: '^0.1',
    capabilities: { slashCommands: true },
    defaultConfig: {},

    setup(api) {
      teardownHook?.();
      teardownHook = undefined;
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
        entry.timer = timer;
        timer.unref();
      };
      const releaseInFlight = (bundle: ChimeraReviewNeededPayload | undefined): boolean => {
        if (!bundle) return false;
        let idx = inFlight.findIndex((entry) => entry.bundle === bundle);
        if (idx === -1 && Array.isArray(bundle.files)) {
          const paths = bundle.files.map((file) => file.path);
          idx = inFlight.findIndex(
            (entry) =>
              entry.files.length === paths.length &&
              entry.files.every((file, i) => file === paths[i]),
          );
        }
        if (idx === -1) return false;
        const [removed] = inFlight.splice(idx, 1);
        if (removed?.timer) clearTimeout(removed.timer);
        return true;
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

      const knownFingerprints = new Map<string, string>();
      const pendingFiles = new Map<string, ChangedFileSnapshot>();
      let reviewCounter = 0;
      let pendingReviewTimer: ReturnType<typeof setTimeout> | undefined;
      let pendingReviewWork: Promise<void> | undefined;
      let sessionEnded = false;
      let latestIterationPayload: EventMap['iteration.completed'] | undefined;

      const rememberKnownFingerprint = (filePath: string, fingerprint: string): void => {
        if (knownFingerprints.has(filePath)) knownFingerprints.delete(filePath);
        knownFingerprints.set(filePath, fingerprint);
        trimKnownFingerprints(knownFingerprints, MAX_KNOWN_FINGERPRINTS);
      };

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

      const recentUserInputs: string[] = [];

      api.onEvent('agent.run.started', async (ev) => {
        if (ev?.inputText && (!ev.ctx || areSubagentsAllowed(ev.ctx))) {
          recentUserInputs.push(ev.inputText);
          if (recentUserInputs.length > 6) recentUserInputs.shift();
        }
        try {
          const cwd = api.config.cwd ?? process.cwd();
          const result = await withSnapshotLock(async () => ({
            files: await snapshotChangedFilesIfRepo(cwd),
          }));
          if (!result?.files) return;
          for (const file of result.files) {
            rememberKnownFingerprint(file.path, file.fingerprint);
          }
          api.log.info(`[auto-review] seeded ${knownFingerprints.size} known file snapshot(s)`);
        } catch {
          /* best-effort */
        }
      });

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

      const skippedNoisePaths = new Map<string, string>();
      const resolveProjectDir = (cwd: string): string =>
        path.join(os.homedir(), '.wrongstack', 'projects', projectSlug(cwd));

      const refreshPendingFiles = (snapshots: ChangedFileSnapshot[]): boolean => {
        let pendingChanged = false;
        const observedPaths = new Set<string>();
        for (const file of snapshots) {
          if (file.path.startsWith('.wrongstack/')) continue;
          const noiseReason = isIgnoredReviewNoisePath(file.path);
          if (noiseReason) {
            skippedNoisePaths.set(file.path, noiseReason);
            if (pendingFiles.delete(file.path)) pendingChanged = true;
            continue;
          }
          skippedNoisePaths.delete(file.path);
          observedPaths.add(file.path);
          if (knownFingerprints.get(file.path) !== file.fingerprint) {
            if (pendingFiles.get(file.path)?.fingerprint !== file.fingerprint) {
              pendingChanged = true;
            }
            pendingFiles.set(file.path, file);
          } else if (pendingFiles.delete(file.path)) {
            pendingChanged = true;
          }
        }
        for (const pendingPath of pendingFiles.keys()) {
          if (!observedPaths.has(pendingPath)) {
            pendingFiles.delete(pendingPath);
            pendingChanged = true;
          }
        }
        return pendingChanged;
      };

      handleIterationCompleted = async (payload, fromQuietTimer = false) => {
        try {
          const cfg = resolved;
          if (!cfg.enabled || sessionEnded) return;
          if (payload?.ctx && !areSubagentsAllowed(payload.ctx)) return;
          if (payload) latestIterationPayload = payload;

          const cwd = api.config.cwd ?? process.cwd();
          const ctxTodos = payload?.ctx?.todos;

          const snapResult = await withSnapshotLock(async () => ({
            meta: await snapshotChangedFilesWithMetaIfRepo(cwd),
          }));
          if (!snapResult) {
            if (fromQuietTimer) schedulePendingReview(cfg.debounceMs);
            return;
          }
          if (!snapResult.meta) return;
          const snapshots = snapResult.meta.snapshots;
          const iterGitIsolation = snapResult.meta.isolation;
          const iterAllChangedFiles = snapResult.meta.allChangedFiles;
          if (sessionEnded) return;
          const now = Date.now();

          const pendingChanged = refreshPendingFiles(snapshots);

          if (pendingFiles.size === 0) {
            cancelPendingReviewTimer();
            return;
          }

          if (cfg.debounceMs > 0) {
            if (!fromQuietTimer) {
              if (pendingChanged || !pendingReviewTimer) {
                schedulePendingReview(cfg.debounceMs);
                api.log.info(
                  `[auto-review] waiting ${cfg.debounceMs}ms for ${pendingFiles.size} pending file(s) to settle`,
                );
              }
              return;
            }

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

          const pendingValues = [...pendingFiles.values()];
          const prioritizedPending = prioritizeReviewCandidates(
            pendingValues,
            cfg.maxFilesPerBatch,
          );
          const toReview = prioritizedPending.selected;
          if (toReview.length === 0) return;

          const iterSkipped: ReviewSkippedFile[] = [
            ...[...skippedNoisePaths.entries()].map(
              ([p, detail]): ReviewSkippedFile => ({
                path: p,
                reason: 'ignored_non_source',
                detail,
              }),
            ),
            ...prioritizedPending.capped.map(
              (c): ReviewSkippedFile => ({ path: c.path, reason: 'max_files_cap' }),
            ),
          ];

          const filesWithContent: ChimeraReviewNeededPayload['files'] = toReview.map((file) => ({
            path: file.path,
            status: file.status,
            content: file.content,
          }));

          reviewCounter++;

          const bundle = await buildReviewContext({
            cwd,
            projectDir: resolveProjectDir(cwd),
            preResolvedIsolation: iterGitIsolation,
            precomputedChangedFiles: iterAllChangedFiles,
            previousSnapshots: getCompletedReviewSnapshots(api.events, cwd),
            skippedFiles: iterSkipped,
            fileLineage: resolveChronicleFileLineage(api.container),
            config: {
              enabled: true,
              provider: cfg.provider,
              model: cfg.model,
              maxFiles: cfg.maxFilesPerBatch,
              autoFix: 'off',
              cascadeOn: 'off',
              maxCascadeDepth: 0,
              fallbackModels: [...cfg.fallbackModels],
              fallbackProfile: undefined,
            },
            files: filesWithContent,
            activeTodos: ctxTodos,
            sessionIntent: extractSessionIntentSnippets({
              messages: payload?.ctx?.messages,
              extraInputs: recentUserInputs,
            }),
            cascadeOn: cfg.cascadeOn,
            maxCascadeDepth: cfg.maxCascadeDepth,
          });
          bundle.reviewFallbackModels = [...cfg.fallbackModels];
          bundle.reviewModelSelection = cfg.modelSelection;
          const trackedChangedPaths = new Set(
            snapshots
              .filter((file) => !file.path.startsWith('.wrongstack/'))
              .map((file) => file.path),
          );
          bundle.allChangedFiles = bundle.allChangedFiles?.filter((file) =>
            trackedChangedPaths.has(file.path),
          );

          if (sessionEnded) return;

          api.log.info(
            `[auto-review] #${reviewCounter} emitting review_needed (${filesWithContent.length} files, provider=${cfg.provider} model=${cfg.model})`,
          );

          const emittedBundle = await emitReviewIfChanged(api, bundle);
          if (!emittedBundle) {
            api.log.info(
              `[auto-review] #${reviewCounter} skipped — file content already has a review in progress`,
            );
            return;
          }
          const emittedPaths = new Set(emittedBundle.files.map((file) => file.path));
          const inflightEntry: InFlightReview = {
            bundle: emittedBundle,
            files: [...emittedPaths],
            startedAt: now,
            subagentType: 'review',
          };
          inFlight.push(inflightEntry);
          for (const file of toReview) {
            if (!emittedPaths.has(file.path)) continue;
            rememberKnownFingerprint(file.path, file.fingerprint);
            pendingFiles.delete(file.path);
          }
          api.log.info(
            `[auto-review] #${reviewCounter} event emitted — ${emittedBundle.files.length}/${filesWithContent.length} files; requires Director (--director) for subagent spawning`,
          );

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

      api.onEvent('session.ended', (event) => {
        const work = (async () => {
          sessionEnded = true;
          const handedOffFiles = pendingFiles.size;
          cancelPendingReviewTimer();
          if (handedOffFiles > 0) {
            api.log.info(
              `[auto-review] session ended — handed ${handedOffFiles} pending mid-session file(s) to post-session review`,
            );
          }
          await pendingReviewWork;
          try {
            const cfg = resolved;
            if (!cfg.enabled) return;

            const cwd = api.config.cwd ?? process.cwd();
            const repoMeta = await getChangedFilesWithMetaIfRepo(cwd);
            if (!repoMeta) return;
            const allChanged = repoMeta.files;
            const existing: ChangedFile[] = [];
            const sessionEndSkipped: ReviewSkippedFile[] = [];
            for (const f of allChanged) {
              if (f.path.startsWith('.wrongstack/')) continue;
              const noiseDetail = isIgnoredReviewNoisePath(f.path);
              if (noiseDetail) {
                sessionEndSkipped.push({
                  path: f.path,
                  reason: 'ignored_non_source',
                  detail: noiseDetail,
                });
                continue;
              }
              try {
                await fsp.access(path.join(cwd, f.path));
                existing.push(f);
              } catch {
                /* deleted */
              }
            }

            if (existing.length === 0) return;

            const prioritized = prioritizeReviewCandidates(existing, cfg.maxFilesPerBatch);
            const toReview = prioritized.selected;
            for (const capped of prioritized.capped) {
              sessionEndSkipped.push({ path: capped.path, reason: 'max_files_cap' });
            }

            const projectDir = resolveProjectDir(cwd);
            await hydrateCompletedSnapshotsFromReportStore(api.events, cwd, projectDir);

            const filesWithContent: ChimeraReviewNeededPayload['files'] = [];
            let alreadyReviewedCount = 0;
            for (const f of toReview) {
              try {
                const absPath = path.join(cwd, f.path);
                const content = await fsp.readFile(absPath, 'utf8');
                if (isFileContentAlreadyReviewed(api.events, cwd, f.path, content)) {
                  alreadyReviewedCount++;
                  sessionEndSkipped.push({ path: f.path, reason: 'already_reviewed' });
                  continue;
                }
                filesWithContent.push({ path: f.path, status: f.status, content });
              } catch {
                sessionEndSkipped.push({ path: f.path, reason: 'unreadable' });
              }
            }

            if (filesWithContent.length === 0) {
              if (alreadyReviewedCount > 0) {
                api.log.info(
                  '[auto-review] session end — all changed files already reviewed in this session',
                );
              }
              return;
            }

            if (inFlight.length >= cfg.maxConcurrentReviews) {
              api.log.info(
                `[auto-review] session end — at max concurrent (${cfg.maxConcurrentReviews}), skipping final review`,
              );
              return;
            }

            const bundle = await buildReviewContext({
              cwd,
              projectDir,
              preResolvedIsolation: repoMeta.isolation,
              precomputedChangedFiles: repoMeta.allChangedFiles,
              previousSnapshots: getCompletedReviewSnapshots(api.events, cwd),
              skippedFiles: sessionEndSkipped,
              fileLineage: resolveChronicleFileLineage(api.container),
              config: {
                enabled: true,
                provider: cfg.provider,
                model: cfg.model,
                maxFiles: cfg.maxFilesPerBatch,
                autoFix: 'off',
                cascadeOn: 'off',
                maxCascadeDepth: 0,
                fallbackModels: [...cfg.fallbackModels],
                fallbackProfile: undefined,
              },
              files: filesWithContent,
              activeTodos: latestIterationPayload?.ctx?.todos,
              sessionIntent: extractSessionIntentSnippets({
                messages: latestIterationPayload?.ctx?.messages,
                extraInputs: recentUserInputs,
              }),
              cascadeOn: cfg.cascadeOn,
              maxCascadeDepth: cfg.maxCascadeDepth,
            });
            bundle.reviewFallbackModels = [...cfg.fallbackModels];
            bundle.reviewModelSelection = cfg.modelSelection;
            const trackedChangedPaths = new Set(existing.map((file) => file.path));
            bundle.allChangedFiles = bundle.allChangedFiles?.filter((file) =>
              trackedChangedPaths.has(file.path),
            );

            const emittedBundle = await emitReviewIfChanged(api, bundle);
            if (!emittedBundle) {
              api.log.info(
                '[auto-review] session end — unchanged files already have reviews in progress',
              );
              return;
            }
            const inflightEntry: InFlightReview = {
              bundle: emittedBundle,
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
        })();
        event?.waitUntil?.(work);
        return work;
      });

      api.onPattern('chimera.review_complete', (_event, payload) => {
        try {
          void recordCompletedReview(api.events, payload).catch(() => undefined);
          const p = payload as ChimeraReviewCompletePayload;
          if (
            releaseInFlight(p?.bundle) &&
            !sessionEnded &&
            pendingFiles.size > 0 &&
            !pendingReviewTimer
          ) {
            schedulePendingReview(resolved.debounceMs);
          }
          if (!p?.reviewText) return;

          const cascadeOn = p.bundle.cascadeOn ?? 'off';
          if (cascadeOn === 'off') return;

          const parsed = p.parsedReport;
          const verifiedFindings =
            parsed?.findings.filter((f) => f.verification?.status === 'verified') ?? [];
          const severities = parsed
            ? severitiesFromFindings(verifiedFindings)
            : parseReviewSeverity(p.reviewText);
          const threshold = shouldCascade(cascadeOn, severities);
          if (!threshold) return;

          const agents = decideCascadeAgents(
            p.reviewText,
            severities,
            parsed ? verifiedFindings : undefined,
          );
          if (agents.length === 0) return;

          const cascadePayload: ChimeraCascadeNeededPayload = {
            bundle: p.bundle,
            ...(p.reportId ? { reportId: p.reportId } : {}),
            reviewText: p.reviewText,
            severities,
            threshold,
            agents,
            ...(parsed ? { verifiedFindings } : {}),
          };

          api.emitCustom('chimera.cascade_needed', cascadePayload);
          api.log.info(
            `[auto-review] cascade_needed emitted — ${severities.critical} critical, ${severities.high} high, ${severities.medium} medium; agents: ${agents.join(', ')}${parsed ? ` (gated on ${verifiedFindings.length} verified finding(s))` : ''}`,
          );
        } catch (err) {
          api.log.warn(
            `[auto-review] review_complete cascade handler failed: ${toErrorMessage(err)}`,
          );
        }
      });

      teardownHook = () => {
        sessionEnded = true;
        cancelPendingReviewTimer();
        pendingFiles.clear();
        for (const entry of inFlight.splice(0)) {
          if (entry.timer) clearTimeout(entry.timer);
        }
      };
    },

    teardown(api) {
      teardownHook?.();
      teardownHook = undefined;
      api.slashCommands.unregister('auto-review');
      api.log.info('[auto-review] unloaded');
    },

    async health() {
      return { ok: true, message: 'auto-review ready' };
    },
  };
}
