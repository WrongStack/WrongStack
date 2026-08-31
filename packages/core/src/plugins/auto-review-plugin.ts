import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { EventMap } from '../kernel/events.js';
import { areSubagentsAllowed } from '../coordination/session-subagent-policy.js';
import type { Plugin } from '../types/plugin.js';
import type { SlashCommand } from '../types/slash-command.js';
import { toErrorMessage } from '../utils/error.js';
import {
  type AutoReviewConfig,
  buildReviewerModelPool,
  decideCascadeAgents,
  MAX_KNOWN_FINGERPRINTS,
  parseReviewSeverity,
  resolveAutoReviewConfig,
  type ResolvedAutoReviewConfig,
  type ReviewerModelAssignment,
  selectRoundRobinReviewerAssignment,
  severitiesFromFindings,
  shouldCascade,
  trimKnownFingerprints,
} from './auto-review-config.js';

export type { ReviewerModelAssignment };
import {
  type ChangedFile,
  type ChangedFileSnapshot,
  getChangedFiles,
  isGitRepo,
  snapshotChangedFiles,
} from './auto-review-git.js';
import type {
  ChimeraCascadeNeededPayload,
  ChimeraReviewCompletePayload,
  ChimeraReviewNeededPayload,
} from './chimera-plugin.js';
import { emitReviewIfChanged } from './review-claim-registry.js';
import { buildReviewContext } from './review-context-builder.js';

export { buildReviewerModelPool, decideCascadeAgents, parseReviewSeverity, resolveAutoReviewConfig, selectRoundRobinReviewerAssignment, severitiesFromFindings, shouldCascade, trimKnownFingerprints };;

interface InFlightReview {
  files: string[];
  startedAt: number;
  subagentType: 'review' | 'cascade';
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
      'Reports are persisted and shown as passive notifications.',
      'They never wake the leader or spawn mutating follow-up agents.',
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
      '  modelSelection       round-robin | random (default round-robin)',
      '  debounceMs           debounce window (default 15000)',
      '  maxFilesPerBatch     max files per review (default 15)',
      '  maxConcurrentReviews max parallel reviews (default 2)',
      '  cascadeOn            off | critical | high (default off)',
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
          'Disabled by default. Enable via config.json.',
        ].join('\n'),
      };
    },
  };
}

export function createAutoReviewPlugin(): Plugin {
  return {
    name: 'wstack-auto-review',
    version: '1.0.0',
    description: 'Continuous auto-review that fires on every code change during a session.',
    apiVersion: '^0.1',
    capabilities: { slashCommands: true },
    defaultConfig: {},

    setup(api) {
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

      api.onEvent('agent.run.started', async () => {
        try {
          const cwd = api.config.cwd ?? process.cwd();
          if (!(await isGitRepo(cwd))) return;
          const snapshots = await withSnapshotLock(() => snapshotChangedFiles(cwd));
          if (!snapshots) return;
          for (const file of snapshots) {
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
          if (!(await isGitRepo(cwd))) return;

          const ctxTodos = payload?.ctx?.todos;

          const snapshots = await withSnapshotLock(() => snapshotChangedFiles(cwd));
          if (!snapshots) {
            if (fromQuietTimer) schedulePendingReview(cfg.debounceMs);
            return;
          }
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

          const toReview = [...pendingFiles.values()].slice(0, cfg.maxFilesPerBatch);
          if (toReview.length === 0) return;

          const filesWithContent: ChimeraReviewNeededPayload['files'] = toReview.map((file) => ({
            path: file.path,
            status: file.status,
            content: file.content,
          }));

          reviewCounter++;

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
              fallbackModels: [...cfg.fallbackModels],
              fallbackProfile: undefined,
            },
            files: filesWithContent,
            activeTodos: ctxTodos,
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

            if (inFlight.length >= cfg.maxConcurrentReviews) {
              api.log.info(
                `[auto-review] session end — at max concurrent (${cfg.maxConcurrentReviews}), skipping final review`,
              );
              return;
            }

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
                fallbackModels: [...cfg.fallbackModels],
                fallbackProfile: undefined,
              },
              files: filesWithContent,
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
          const p = payload as ChimeraReviewCompletePayload;
          if (!p.reviewText) return;

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
