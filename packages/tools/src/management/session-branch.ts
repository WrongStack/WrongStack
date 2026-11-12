/**
 * `session_branch` — leader-only session tree branching & fold-back tool.
 *
 * Allows autonomous `/goal` and Brain-supervised runs that hit consecutive
 * regressions or risky architectural forks to inspect the current session's
 * branch tree, fork an isolated exploratory branch (backed by CAS workspace
 * checkpoints), switch branches, or fold verified findings / dead-end lessons
 * back into the parent branch without polluting main context.
 */

import * as path from 'node:path';
import type { EventBus } from '@wrongstack/contracts/kernel/events';
import type { Config } from '@wrongstack/contracts/types/config';
import type { AgentContext } from '@wrongstack/contracts/types/context';
import { ToolValidationError } from '@wrongstack/contracts/types/errors';
import type { ExtensionRegistryPort } from '@wrongstack/contracts/types/extension-points';
import type { MemoryStore } from '@wrongstack/contracts/types/memory';
import type {
  SessionBranchDescriptor,
  SessionStore,
  SessionWriter,
} from '@wrongstack/contracts/types/session';
import type { JSONSchema, Tool } from '@wrongstack/contracts/types/tool';
import { DefaultSecretScrubber, ToolCapabilities } from '@wrongstack/core/security';
import { SessionCheckpointCas, SessionTreeCoordinator } from '@wrongstack/core/storage';

export const SESSION_BRANCH_TOOL_NAME = 'session_branch';

export type SessionBranchToolAction = 'status' | 'branch' | 'switch' | 'fold';

export interface SessionBranchToolInput {
  action: SessionBranchToolAction;
  name?: string | undefined;
  label?: string | undefined;
  target?: string | undefined;
  source?: string | undefined;
  focus?: string | undefined;
  keepFiles?: boolean | undefined;
  archiveSource?: boolean | undefined;
}

export interface SessionBranchToolOptions {
  /** Explicit coordinator factory override (used in unit tests or custom hosts). */
  resolveCoordinator?:
    | ((
        ctx: AgentContext,
      ) => SessionTreeCoordinator | undefined | Promise<SessionTreeCoordinator | undefined>)
    | undefined;
  /** Session store backing the current session JSONL. */
  getSessionStore?: (() => SessionStore | undefined) | undefined;
  /** Directory containing project session logs (used to anchor `_cas`). */
  getSessionsDir?: (() => string | undefined) | undefined;
  /** Live config accessor for `session.branchFoldMaxTokens` and `features.sageBranchInsights`. */
  getConfig?: (() => Partial<Config> | undefined) | undefined;
  /** Optional SAGE memory store for promoting branch fold insights. */
  getMemoryStore?: (() => MemoryStore | undefined) | undefined;
  /** Optional extension registry for `beforeCompact` hooks during fold-back. */
  getExtensionRegistry?: (() => ExtensionRegistryPort | undefined) | undefined;
  /** EventBus for announcing `session.branch_switched` and `workspace.files_materialized`. */
  events?: EventBus | undefined;
}

const SCHEMA: JSONSchema = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['status', 'branch', 'switch', 'fold'],
      description:
        'Operation to perform: "status" lists branches, "branch" forks a new exploratory branch from the current point and switches onto it, "switch" checks out an existing branch, and "fold" distills a branch into a secret-scrubbed summary on its parent/target branch.',
    },
    name: {
      type: 'string',
      description: 'Branch slug for action="branch" (e.g. "spike-redis-lock").',
    },
    label: {
      type: 'string',
      description: 'Optional human-readable rationale for action="branch".',
    },
    target: {
      type: 'string',
      description:
        'Target branch name or id for action="switch", or destination branch for action="fold" (defaults to parent branch).',
    },
    source: {
      type: 'string',
      description: 'Source branch name or id for action="fold" (defaults to active branch).',
    },
    focus: {
      type: 'string',
      description: 'Optional synthesis focus prompt for action="fold".',
    },
    keepFiles: {
      type: 'boolean',
      description: 'When true on action="switch", skip CAS workspace file materialization.',
    },
    archiveSource: {
      type: 'boolean',
      description: 'When true on action="fold", archive the source branch after folding.',
    },
  },
  required: ['action'],
  additionalProperties: false,
};

function isSessionWriterLike(candidate: unknown): candidate is SessionWriter {
  return (
    typeof candidate === 'object' &&
    candidate !== null &&
    typeof (candidate as SessionWriter).append === 'function'
  );
}

function buildDefaultCoordinator(
  ctx: AgentContext,
  opts: SessionBranchToolOptions,
): SessionTreeCoordinator | undefined {
  const store = opts.getSessionStore?.();
  const writer =
    ctx?.activeRunSessionWriter ?? (isSessionWriterLike(ctx?.session) ? ctx.session : undefined);
  const sessionId =
    (typeof ctx?.eventSessionId === 'function' ? ctx.eventSessionId() : undefined) || writer?.id;
  if (!store || !writer || !sessionId) return undefined;

  const sessionsDir = opts.getSessionsDir?.();
  const projectRoot = ctx.projectRoot;
  const checkpointCas =
    sessionsDir && projectRoot
      ? new SessionCheckpointCas({
          rootDir: path.join(sessionsDir, '_cas'),
          projectRoot,
        })
      : undefined;

  const cfg = opts.getConfig?.();
  const rawMax = cfg?.session?.branchFoldMaxTokens;
  const branchFoldMaxTokens =
    typeof rawMax === 'number' && Number.isFinite(rawMax) && rawMax > 0
      ? Math.floor(rawMax)
      : undefined;

  const provider = ctx.provider;
  const model = ctx.model || cfg?.model;
  const synthesizeSummary =
    provider && typeof provider.complete === 'function' && model
      ? async (prompt: string): Promise<string> => {
          const ac = new AbortController();
          const timer = setTimeout(() => ac.abort(), 30_000);
          timer.unref?.();
          try {
            const resp = await provider.complete(
              {
                model,
                system: [
                  {
                    type: 'text',
                    text: 'You distill exploratory coding session branches into concise, technical Markdown fold-back handoff briefs without fabricating details.',
                  },
                ],
                messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
                temperature: 0.2,
                ...(branchFoldMaxTokens !== undefined ? { maxTokens: branchFoldMaxTokens } : {}),
              },
              { signal: ac.signal },
            );
            return resp.content
              .filter(
                (b): b is { type: 'text'; text: string } =>
                  b.type === 'text' && typeof (b as { text?: unknown }).text === 'string',
              )
              .map((b) => b.text)
              .join('\n')
              .trim();
          } finally {
            clearTimeout(timer);
          }
        }
      : undefined;

  const memoryStore = opts.getMemoryStore?.();
  const onFoldInsight = memoryStore
    ? async ({
        sessionId: sid,
        sourceBranch,
        targetBranch,
        summary,
        touchedFiles,
      }: {
        sessionId: string;
        sourceBranch: SessionBranchDescriptor;
        targetBranch: SessionBranchDescriptor;
        summary: string;
        touchedFiles: readonly string[];
      }) => {
        const liveCfg = opts.getConfig?.();
        if (
          liveCfg?.features?.memory === false ||
          liveCfg?.features?.sageBranchInsights === false
        ) {
          return undefined;
        }
        await memoryStore.remember(
          `[Branch Fold: ${sourceBranch.name} -> ${targetBranch.name}]\n${summary}`,
          'project-memory',
          {
            type: 'decision',
            priority: 'medium',
            confidence: 0.85,
            source: sid,
            tags: ['branch-fold', sourceBranch.name, ...touchedFiles.slice(0, 5)],
          },
        );
        return [`sage:${sid}:${sourceBranch.id}`];
      }
    : undefined;

  return new SessionTreeCoordinator({
    sessionId,
    writer,
    getEvents: async () => {
      await writer.flush?.();
      const loaded = await store.load(sessionId);
      return loaded.events;
    },
    checkpointCas,
    projectRoot,
    secretScrubber: new DefaultSecretScrubber(),
    events: opts.events,
    extensionRegistry: opts.getExtensionRegistry?.(),
    ...(synthesizeSummary ? { synthesizeSummary } : {}),
    ...(branchFoldMaxTokens !== undefined ? { branchFoldMaxTokens } : {}),
    ...(onFoldInsight ? { onFoldInsight } : {}),
    onMessagesReplaced: (messages) => {
      ctx.clearFileTracking?.();
      if (ctx.state) {
        ctx.state.replaceMessages(messages);
      } else if (Array.isArray(ctx.messages)) {
        ctx.messages.splice(0, ctx.messages.length, ...messages);
      }
    },
  });
}

export function createSessionBranchTool(
  opts: SessionBranchToolOptions,
): Tool<SessionBranchToolInput, string> {
  return {
    name: SESSION_BRANCH_TOOL_NAME,
    description:
      'Inspect, fork, switch, or fold exploratory branches in the current session tree ' +
      '(backed by content-addressed workspace checkpoints). Useful during autonomous runs ' +
      'when testing a risky hypothesis or folding dead-end findings back into the parent branch.',
    category: 'session',
    inputSchema: SCHEMA,
    permission: 'confirm',
    mutating: true,
    riskTier: 'standard',
    capabilities: [ToolCapabilities.SESSION_MODE],
    icon: 'tree',

    async execute(input, ctx) {
      const action = input?.action;
      if (action !== 'status' && action !== 'branch' && action !== 'switch' && action !== 'fold') {
        throw new ToolValidationError({
          message: 'action must be one of: status, branch, switch, fold',
          field: 'action',
        });
      }

      const coordinator = opts.resolveCoordinator
        ? await opts.resolveCoordinator(ctx)
        : buildDefaultCoordinator(ctx, opts);
      if (!coordinator) {
        throw new Error('session_branch: unavailable (no active persisted session).');
      }

      if (action === 'status') {
        const tree = await coordinator.getTree();
        const branches = Object.values(tree.branches);
        const lines = [
          `Session tree (${ctx.eventSessionId()}) — activeBranchId=${tree.activeBranchId}:`,
          ...branches.map(
            (b) =>
              `  ${b.id === tree.activeBranchId ? '*' : ' '} ${b.name} (${b.id}) [${b.status}] turns=${b.turnCount}${b.parentBranchId ? ` parent=${b.parentBranchId}` : ''}`,
          ),
        ];
        return lines.join('\n');
      }

      if (action === 'branch') {
        const name = typeof input.name === 'string' ? input.name.trim() : '';
        if (!name) {
          throw new ToolValidationError({
            message: 'name is required when action="branch"',
            field: 'name',
          });
        }
        const created = await coordinator.createBranch({
          name,
          ...(typeof input.label === 'string' && input.label.trim()
            ? { label: input.label.trim() }
            : {}),
          switchImmediately: true,
        });
        return `Created and switched to session branch "${created.branch.name}" (${created.branch.id}).`;
      }

      if (action === 'switch') {
        const target = typeof input.target === 'string' ? input.target.trim() : '';
        if (!target) {
          throw new ToolValidationError({
            message: 'target is required when action="switch"',
            field: 'target',
          });
        }
        const switched = await coordinator.switchBranch(target, {
          keepFiles: input.keepFiles === true,
          reactivateArchived: true,
        });
        const baseOut =
          `Switched session branch "${switched.fromBranch.name}" -> "${switched.toBranch.name}" ` +
          `(${switched.workspaceRestored ? 'workspace checkpoint restored' : 'workspace left as-is'}).`;
        return switched.staleFilesNotice ? `${baseOut}\n\n${switched.staleFilesNotice}` : baseOut;
      }

      const folded = await coordinator.foldBranch({
        ...(typeof input.source === 'string' && input.source.trim()
          ? { sourceBranch: input.source.trim() }
          : {}),
        ...(typeof input.target === 'string' && input.target.trim()
          ? { targetBranch: input.target.trim() }
          : {}),
        ...(typeof input.focus === 'string' && input.focus.trim()
          ? { focusPrompt: input.focus.trim() }
          : {}),
        ...(input.archiveSource === true ? { archiveSource: true } : {}),
      });
      const approxTokens = Math.max(1, Math.ceil(folded.summary.length / 4));
      return (
        `Folded branch "${folded.sourceBranch.name}" -> "${folded.targetBranch.name}" ` +
        `(~${approxTokens} tokens).\n\n${folded.summary}`
      );
    },
  };
}
