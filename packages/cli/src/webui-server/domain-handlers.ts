/**
 * Domain-specific WebSocket handlers (Goal, Worktree, Terminal, Specs, SDD).
 *
 * @module webui-server/domain-handlers
 */

import * as os from 'node:os';
import * as path from 'node:path';
import type { Context } from '@wrongstack/core/agent';
import type { TrustBoundary } from '@wrongstack/core/security';
import { resolveWstackPaths } from '@wrongstack/core/utils';
import {
  buildSddWizardDeps,
  GoalWebSocketHandler,
  SddBoardWebSocketHandler,
  SddWizardWebSocketHandler,
  SpecsWebSocketHandler,
  TerminalWebSocketHandler,
  WorktreeWebSocketHandler,
} from '@wrongstack/webui-server';
import type { CliWebUIOptions } from '../webui-server-options.js';
import type { KanbanRunMirror } from './kanban-run-mirror.js';
import { consoleLogger } from './logger-shim.js';
import { createNodePtyLoader } from './node-pty-loader.js';

export interface DomainHandlersResult {
  goalHandler: GoalWebSocketHandler;
  worktreeHandler: WorktreeWebSocketHandler;
  terminalHandler: TerminalWebSocketHandler;
  specsHandler: SpecsWebSocketHandler;
  sddBoardHandler: SddBoardWebSocketHandler;
  sddWizardHandler: SddWizardWebSocketHandler | null;
  specsPaths: ReturnType<typeof resolveWstackPaths> | null;
}

export function createWebuiDomainHandlers(
  opts: CliWebUIOptions,
  trustBoundary: TrustBoundary,
  kanbanRunMirror: KanbanRunMirror | null,
): DomainHandlersResult {
  const goalStoreDir = opts.projectRoot
    ? path.join(opts.projectRoot, '.wrongstack', 'goal')
    : path.join(os.tmpdir(), '.wrongstack', 'goal');

  const goalHandler = new GoalWebSocketHandler(
    opts.agent,
    opts.agent.ctx as Context,
    consoleLogger,
    goalStoreDir,
    opts.events,
    opts.projectRoot,
    kanbanRunMirror ? (graphId, state) => kanbanRunMirror.onGoalState(graphId, state) : undefined,
  );
  const worktreeHandler = new WorktreeWebSocketHandler(opts.events, consoleLogger);

  const loadNodePtyViaWebui = createNodePtyLoader(import.meta.url, consoleLogger);
  const terminalHandler = new TerminalWebSocketHandler(
    () => (opts.agent.ctx as Context).cwd ?? opts.projectRoot ?? process.cwd(),
    consoleLogger,
    loadNodePtyViaWebui as ConstructorParameters<typeof TerminalWebSocketHandler>[2],
    undefined,
    trustBoundary,
  );

  const specsPaths = opts.projectRoot
    ? resolveWstackPaths({ projectRoot: opts.projectRoot })
    : null;
  const specsHandler = new SpecsWebSocketHandler(
    specsPaths?.projectSpecs ?? path.join(os.tmpdir(), '.wrongstack', 'specs'),
    specsPaths?.projectTaskGraphs ?? path.join(os.tmpdir(), '.wrongstack', 'task-graphs'),
  );

  const sddBoardHandler = new SddBoardWebSocketHandler(
    specsPaths?.projectSddBoards ?? path.join(os.tmpdir(), '.wrongstack', 'sdd-boards'),
    opts.events,
    specsPaths && opts.projectRoot
      ? {
          projectRoot: opts.projectRoot,
          paths: {
            projectSpecs: specsPaths.projectSpecs,
            projectTaskGraphs: specsPaths.projectTaskGraphs,
            projectSddSession: specsPaths.projectSddSession,
            projectSddBoards: specsPaths.projectSddBoards,
          },
        }
      : undefined,
    { trustBoundary, logger: consoleLogger },
  );

  const sddWizardHandler =
    opts.sddSubagentFactory && specsPaths
      ? new SddWizardWebSocketHandler(
          buildSddWizardDeps({
            agent: opts.agent,
            events: opts.events,
            projectRoot: opts.projectRoot ?? process.cwd(),
            subagentFactory: opts.sddSubagentFactory,
            ...(opts.brain ? { brain: opts.brain } : {}),
            paths: {
              projectSpecs: specsPaths.projectSpecs,
              projectTaskGraphs: specsPaths.projectTaskGraphs,
              projectSddBoards: specsPaths.projectSddBoards,
              projectDir: specsPaths.projectDir,
              projectSddSession: specsPaths.projectSddSession,
            },
          }),
        )
      : null;

  return {
    goalHandler,
    worktreeHandler,
    terminalHandler,
    specsHandler,
    sddBoardHandler,
    sddWizardHandler,
    specsPaths,
  };
}
