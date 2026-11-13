import * as path from 'node:path';
import type {
  Message,
  SessionBranchDescriptor,
  SessionTreeSnapshot,
  SessionWriter,
  SlashCommand,
} from '@wrongstack/contracts/types';
import { DefaultSecretScrubber } from '@wrongstack/core/security';
import {
  MAIN_BRANCH_ID,
  SessionCheckpointCas,
  SessionTreeCoordinator,
} from '@wrongstack/core/storage';
import { color, toErrorMessage } from '@wrongstack/core/utils';
import type { CommandSessionContext, TreeCommandHost } from './host.js';
import { createHostTreeFoldHooks } from './tree-synthesis.js';

export const TREE_COMMAND_DESCRIPTION =
  'Navigate, fork, switch, and fold in-session conversation branches.';

export const TREE_COMMAND_ARGS_HINT =
  '[list | branch <name> | switch <target> | fold [source] | rename <old> <new> | archive <target>]';

export const TREE_COMMAND_HELP = [
  'Usage:',
  '  /tree                                      List branches in the current session tree',
  '  /tree list                                 Render the full ASCII branch DAG',
  '  /tree branch <name> [--at <N>] [--no-switch] [--from <branch>] [--label "<text>"]',
  '                                             Create a new branch from head or prompt checkpoint N',
  '  /tree switch <target> [--keep-files]       Switch active conversation branch (restores CAS files)',
  '  /tree fold [source] [--into <target>] [--note|--focus "<text>"] [--keep-open|--archive]',
  '                                             Fold a scrubbed summary of source branch into target',
  '  /tree rename <target> <new-name>           Rename an existing non-root branch',
  '  /tree archive <target>                     Archive an inactive branch (releases exclusive CAS refs)',
].join('\n');

/**
 * Tokenize CLI-style arguments while preserving single/double-quoted phrases.
 */
export function tokenizeTreeArgs(raw: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let hasToken = false;
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i]!;
    if (quote) {
      const next = i + 1 < raw.length ? raw[i + 1] : undefined;
      // `quoteTreeArg` (WebUI / Desktop v2 fold controls) wraps values in double quotes and
      // escapes both `"` and `\`, so `\"` and `\\` must unescape here. Without the `\\` case a
      // trailing backslash swallows the closing quote and every flag that follows it.
      if (
        ch === '\\' &&
        next !== undefined &&
        (next === quote || (quote === '"' && next === '\\'))
      ) {
        current += next;
        i += 1;
      } else if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      hasToken = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (hasToken) {
        tokens.push(current);
        current = '';
        hasToken = false;
      }
      continue;
    }
    current += ch;
    hasToken = true;
  }
  if (hasToken) tokens.push(current);
  return tokens;
}

function statusGlyph(branch: SessionBranchDescriptor, isActive: boolean): string {
  if (isActive) return '●';
  if (branch.status === 'folded') return '◈';
  if (branch.status === 'archived') return '✕';
  return '○';
}

function formatBranchLine(
  branch: SessionBranchDescriptor,
  tree: SessionTreeSnapshot,
  prefix: string,
): string {
  const isActive = branch.id === tree.activeBranchId;
  const glyph = statusGlyph(branch, isActive);
  const turnsLabel = `${branch.turnCount} turn${branch.turnCount === 1 ? '' : 's'}`;
  const badges: string[] = [];

  if (isActive) badges.push('ACTIVE');
  if (branch.status === 'folded') {
    const intoName = branch.foldedIntoBranchId
      ? (tree.branches[branch.foldedIntoBranchId]?.name ?? branch.foldedIntoBranchId)
      : MAIN_BRANCH_ID;
    badges.push(`folded → ${intoName}`);
  } else if (branch.status === 'archived') {
    badges.push('archived');
  }

  if (branch.forkPromptIndex !== undefined) {
    badges.push(`@p${branch.forkPromptIndex}`);
  }
  const cpHash =
    branch.latestWorkspaceCheckpoint?.manifestHash ?? branch.baseWorkspaceCheckpoint?.manifestHash;
  if (cpHash) {
    badges.push(`cas:${cpHash.slice(0, 8)}`);
  }

  const badgeSuffix = badges.length > 0 ? ` [${badges.join(' · ')}]` : '';
  const labelSuffix = branch.label ? ` — ${branch.label}` : '';
  return `${prefix}${glyph} ${branch.name} (${turnsLabel})${badgeSuffix}${labelSuffix}`;
}

/**
 * Format a `SessionTreeSnapshot` as a deterministic Unicode DAG hierarchy.
 */
export function formatSessionTreeAscii(tree: SessionTreeSnapshot): string {
  const allBranches = Object.values(tree.branches);
  const activeName = tree.branches[tree.activeBranchId]?.name ?? tree.activeBranchId;
  const header = `Session Tree (${allBranches.length} branch${allBranches.length === 1 ? '' : 'es'} · active: ${activeName})`;

  const childrenMap = new Map<string, SessionBranchDescriptor[]>();
  for (const branch of allBranches) {
    if (branch.parentBranchId === null) continue;
    const parentId = tree.branches[branch.parentBranchId] ? branch.parentBranchId : MAIN_BRANCH_ID;
    const list = childrenMap.get(parentId) ?? [];
    list.push(branch);
    childrenMap.set(parentId, list);
  }
  for (const list of childrenMap.values()) {
    list.sort((a, b) => a.forkSeq - b.forkSeq || a.createdAt.localeCompare(b.createdAt));
  }

  const root = tree.branches[MAIN_BRANCH_ID] ??
    allBranches.find((b) => b.parentBranchId === null) ?? {
      id: MAIN_BRANCH_ID,
      name: MAIN_BRANCH_ID,
      parentBranchId: null,
      forkSeq: 0,
      createdAt: new Date(0).toISOString(),
      lastActivityAt: new Date(0).toISOString(),
      status: 'active' as const,
      turnCount: 0,
    };

  const lines = [header, formatBranchLine(root, tree, '')];
  const visited = new Set<string>([root.id]);

  const walk = (parentId: string, indent: string): void => {
    const kids = childrenMap.get(parentId) ?? [];
    for (let i = 0; i < kids.length; i += 1) {
      const child = kids[i]!;
      if (visited.has(child.id)) continue;
      visited.add(child.id);
      const isLast = i === kids.length - 1;
      const connector = isLast ? '└─ ' : '├─ ';
      lines.push(formatBranchLine(child, tree, `${indent}${connector}`));
      walk(child.id, `${indent}${isLast ? '   ' : '│  '}`);
    }
  };

  walk(root.id, '');
  return lines.join('\n');
}

function isSessionWriterLike(candidate: unknown): candidate is SessionWriter {
  return (
    Boolean(candidate) &&
    typeof candidate === 'object' &&
    typeof (candidate as { append?: unknown }).append === 'function'
  );
}

function resolveCoordinator(
  host: TreeCommandHost,
  callCtx?: CommandSessionContext,
): SessionTreeCoordinator | undefined {
  if (typeof host.treeCoordinator === 'function') {
    return host.treeCoordinator();
  }
  if (host.treeCoordinator) {
    return host.treeCoordinator;
  }

  const targetCtx = callCtx ?? host.context;
  const ctxWriter = isSessionWriterLike(targetCtx?.session) ? targetCtx.session : undefined;
  const writer = ctxWriter ?? host.sessionRef?.current;
  const store = host.sessionStore;
  const sessionId = writer?.id ?? targetCtx?.session?.id;
  if (!writer || !store || !sessionId) return undefined;

  const checkpointCas =
    host.paths?.projectSessions && host.projectRoot
      ? new SessionCheckpointCas({
          rootDir: path.join(host.paths.projectSessions, '_cas'),
          projectRoot: host.projectRoot,
        })
      : undefined;

  const foldHooks = createHostTreeFoldHooks({
    getConfig: () => host.configStore?.get?.(),
    getProvider: () => targetCtx?.provider ?? host.llmProvider,
    getModel: () => targetCtx?.model ?? host.llmModel,
    memoryStore: host.memoryStore,
  });

  return new SessionTreeCoordinator({
    sessionId,
    writer,
    getEvents: async () => {
      await writer.flush?.();
      const loaded = await store.load(sessionId);
      return loaded.events;
    },
    checkpointCas,
    projectRoot: host.projectRoot,
    secretScrubber: new DefaultSecretScrubber(),
    events: host.events,
    extensionRegistry: host.extensionRegistry,
    ...foldHooks,
    onMessagesReplaced: (messages: Message[], branch: SessionBranchDescriptor) => {
      targetCtx?.clearFileTracking?.();
      if (targetCtx?.state) {
        targetCtx.state.replaceMessages(messages);
      } else if (Array.isArray(targetCtx?.messages)) {
        targetCtx.messages.splice(0, targetCtx.messages.length, ...messages);
      }
      host.onTreeMessagesReplaced?.(messages, branch);
    },
  });
}

export function buildTreeCommand(host: TreeCommandHost): SlashCommand {
  return {
    name: 'tree',
    category: 'Session',
    description: TREE_COMMAND_DESCRIPTION,
    argsHint: TREE_COMMAND_ARGS_HINT,
    help: TREE_COMMAND_HELP,
    async run(rawArgs, callCtx) {
      const rawTokens = tokenizeTreeArgs(rawArgs.trim());
      const jsonMode = rawTokens.includes('--json');
      const tokens = rawTokens.filter((tok) => tok !== '--json');
      if (!jsonMode && tokens.length === 0 && host.onPanelOpen?.current?.('tree')) {
        return;
      }

      const coordinator = resolveCoordinator(host, callCtx as CommandSessionContext | undefined);
      if (!coordinator) {
        return {
          message: jsonMode
            ? JSON.stringify({ error: 'Session tree is unavailable: no active persisted session.' })
            : color.yellow('Session tree is unavailable: no active persisted session.'),
        };
      }

      const sub = tokens[0] ?? 'list';
      try {
        if (sub === 'list' || sub === 'ls' || sub === 'status') {
          const tree = await coordinator.getTree();
          return { message: jsonMode ? JSON.stringify(tree) : formatSessionTreeAscii(tree) };
        }

        if (sub === 'help' || sub === '--help' || sub === '-h') {
          return { message: TREE_COMMAND_HELP };
        }

        if (sub === 'branch' || sub === 'fork' || sub === 'new') {
          let name: string | undefined;
          let fromBranch: string | undefined;
          let atPromptIndex: number | undefined;
          let atSeq: number | undefined;
          let label: string | undefined;
          let switchImmediately = true;

          for (let i = 1; i < tokens.length; i += 1) {
            const tok = tokens[i]!;
            if (tok === '--no-switch') {
              switchImmediately = false;
            } else if (tok === '--from' && tokens[i + 1] !== undefined) {
              const val = tokens[++i]!;
              if (val.length > 0) fromBranch = val;
            } else if (tok === '--at' && tokens[i + 1] !== undefined) {
              const val = tokens[++i]!;
              if (val.length > 0) atPromptIndex = Number.parseInt(val, 10);
            } else if (tok === '--seq' && tokens[i + 1] !== undefined) {
              const val = tokens[++i]!;
              if (val.length > 0) atSeq = Number.parseInt(val, 10);
            } else if (tok === '--label' && tokens[i + 1] !== undefined) {
              const val = tokens[++i]!;
              if (val.length > 0) label = val;
            } else if (tok.length > 0 && !tok.startsWith('-') && !name) {
              name = tok;
            }
          }

          if (!name) {
            return {
              message: color.yellow(
                'Usage: /tree branch <name> [--at <promptIndex>] [--from <branch>] [--label "<text>"] [--no-switch]',
              ),
            };
          }

          const created = await coordinator.createBranch({
            name,
            ...(label ? { label } : {}),
            ...(fromBranch ? { fromBranch } : {}),
            ...(atPromptIndex !== undefined ? { atPromptIndex } : {}),
            ...(atSeq !== undefined ? { atSeq } : {}),
            switchImmediately,
          });
          const verb = created.switched ? 'Created and switched to' : 'Created';
          return {
            message: `${verb} branch ${color.cyan(created.branch.name)} (${created.branch.id}) from ${created.branch.parentBranchId ?? MAIN_BRANCH_ID}.`,
          };
        }

        if (sub === 'switch' || sub === 'checkout' || sub === 'sw') {
          let target: string | undefined;
          let keepFiles = false;
          let reactivateArchived = false;
          for (let i = 1; i < tokens.length; i += 1) {
            const tok = tokens[i]!;
            if (tok === '--keep-files') keepFiles = true;
            else if (tok === '--reactivate') reactivateArchived = true;
            else if (tok.length > 0 && !tok.startsWith('-') && !target) target = tok;
          }
          if (!target) {
            return {
              message: color.yellow('Usage: /tree switch <branch-name-or-id> [--keep-files]'),
            };
          }
          const switched = await coordinator.switchBranch(target, {
            keepFiles,
            reactivateArchived,
          });
          const wsSuffix = switched.workspaceRestored ? ' (workspace restored from CAS)' : '';
          const baseMsg = `Switched from ${switched.fromBranch.name} to ${color.cyan(switched.toBranch.name)} (${switched.messages.length} messages in context)${wsSuffix}.`;
          return {
            message: switched.staleFilesNotice
              ? `${baseMsg}\n${switched.staleFilesNotice}`
              : baseMsg,
          };
        }

        if (sub === 'fold') {
          let sourceBranch: string | undefined;
          let targetBranch: string | undefined;
          let focusPrompt: string | undefined;
          let archiveSource = false;
          let keepOpen = false;
          for (let i = 1; i < tokens.length; i += 1) {
            const tok = tokens[i]!;
            if (tok === '--archive') archiveSource = true;
            else if (tok === '--keep-open') keepOpen = true;
            else if ((tok === '--into' || tok === '--to') && tokens[i + 1] !== undefined) {
              const val = tokens[++i]!;
              if (val.length > 0) targetBranch = val;
            } else if ((tok === '--focus' || tok === '--note') && tokens[i + 1] !== undefined) {
              const val = tokens[++i]!;
              if (val.length > 0) focusPrompt = val;
            } else if (tok.length > 0 && !tok.startsWith('-') && !sourceBranch) {
              sourceBranch = tok;
            }
          }
          const folded = await coordinator.foldBranch({
            ...(sourceBranch ? { sourceBranch } : {}),
            ...(targetBranch ? { targetBranch } : {}),
            ...(focusPrompt ? { focusPrompt } : {}),
            archiveSource,
          });
          if (keepOpen && !archiveSource) {
            await coordinator.archiveBranch(folded.sourceBranch.id, 'active');
          }
          const statusSuffix = archiveSource ? ' (archived)' : keepOpen ? ' (kept open)' : '';
          return {
            message: [
              `Folded branch ${color.cyan(folded.sourceBranch.name)} → ${color.green(folded.targetBranch.name)}${statusSuffix}.`,
              folded.summary,
            ].join('\n'),
          };
        }

        if (sub === 'rename' || sub === 'mv') {
          const target = tokens[1];
          const newName = tokens[2];
          if (!target || !newName) {
            return { message: color.yellow('Usage: /tree rename <target> <new-name>') };
          }
          const renamed = await coordinator.renameBranch(target, newName);
          return {
            message: `Renamed branch ${renamed.id} to ${color.cyan(renamed.name)}.`,
          };
        }

        if (sub === 'archive') {
          const target = tokens[1];
          if (!target) {
            return { message: color.yellow('Usage: /tree archive <target>') };
          }
          const archived = await coordinator.archiveBranch(target);
          return {
            message: `Archived branch ${color.cyan(archived.name)} (${archived.id}).`,
          };
        }

        return {
          message: color.yellow(`Unknown /tree subcommand "${sub}".\n${TREE_COMMAND_HELP}`),
        };
      } catch (err) {
        return { message: color.yellow(`Session tree error: ${toErrorMessage(err)}`) };
      }
    },
  };
}
