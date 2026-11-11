import { randomUUID } from 'node:crypto';
import type { EventBus } from '@wrongstack/contracts/kernel';
import type { ExtensionRegistryPort } from '@wrongstack/contracts/types/extension-points';
import type { Message } from '@wrongstack/contracts/types/messages';
import type { SecretScrubber } from '@wrongstack/contracts/types/secret-scrubber';
import type {
  SessionBranchDescriptor,
  SessionBranchStatus,
  SessionEvent,
  SessionTreeSnapshot,
  SessionWriter,
  WorkspaceCheckpointRef,
  WorkspaceMaterializationResult,
} from '@wrongstack/contracts/types/session';
import { DefaultSecretScrubber } from '../security/secret-scrubber.js';
import type { SessionCheckpointCas } from './session-checkpoint-cas.js';
import {
  buildBranchLineageSegments,
  eventBelongsToLineage,
  MAIN_BRANCH_ID,
  reconstructSessionTree,
} from './session-store/tree-replay.js';
import {
  BRANCH_NAME_PATTERN,
  buildDeterministicFoldSummary,
  buildFoldSynthesisPrompt,
  DEFAULT_BRANCH_FOLD_MAX_TOKENS,
  enforceFoldSummaryTokenCap,
  extractBranchTouchedFiles,
  resolveBranch,
  validateBranchName,
} from './session-tree-fold.js';

export { BRANCH_NAME_PATTERN };

export interface BranchFoldInsightContext {
  sessionId: string;
  sourceBranch: SessionBranchDescriptor;
  targetBranch: SessionBranchDescriptor;
  summary: string;
  touchedFiles: readonly string[];
}

export interface SessionTreeCoordinatorOptions {
  sessionId: string;
  writer: SessionWriter;
  /**
   * Returns the session's chronological event log (including events appended
   * during the current session).
   */
  getEvents: () => readonly SessionEvent[] | Promise<readonly SessionEvent[]>;
  checkpointCas?: SessionCheckpointCas | undefined;
  projectRoot?: string | undefined;
  secretScrubber?: SecretScrubber | undefined;
  /** Optional typed kernel EventBus for branch switch & CAS materialization notifications. */
  events?: EventBus | undefined;
  /** Optional extension registry consulted for `beforeCompact` hooks on `foldBranch`. */
  extensionRegistry?: ExtensionRegistryPort | undefined;
  /**
   * Optional LLM synthesis hook used by `foldBranch` to distill an exploratory
   * branch into a concise structured handoff. Falls back to a deterministic
   * local digest when omitted or if the call throws.
   */
  synthesizeSummary?: ((prompt: string) => Promise<string>) | undefined;
  /**
   * Maximum estimated token budget for folded branch summaries (default: 1,200 tokens).
   */
  branchFoldMaxTokens?: number | undefined;
  /**
   * Optional SAGE insight hook invoked with the scrubbed fold summary. Any
   * returned memory IDs are persisted onto the `branch_folded` event.
   */
  onFoldInsight?:
    | ((
        ctx: BranchFoldInsightContext,
      ) => readonly string[] | undefined | Promise<readonly string[] | undefined>)
    | undefined;
  /**
   * Invoked whenever an active branch switch or fold-back replaces the live
   * conversation message array.
   */
  onMessagesReplaced?: ((messages: Message[], branch: SessionBranchDescriptor) => void) | undefined;
}

export interface CreateBranchOptions {
  name: string;
  label?: string | undefined;
  fromBranch?: string | undefined;
  atSeq?: number | undefined;
  atPromptIndex?: number | undefined;
  switchImmediately?: boolean | undefined;
}

export interface CreateBranchResult {
  branch: SessionBranchDescriptor;
  switched: boolean;
  messages?: Message[] | undefined;
}

export interface SwitchBranchOptions {
  /** Skip workspace CAS materialization and leave the working copy untouched. */
  keepFiles?: boolean | undefined;
  /** Allow switching directly onto an archived branch by reactivating it first. */
  reactivateArchived?: boolean | undefined;
}

export interface SwitchBranchResult {
  fromBranch: SessionBranchDescriptor;
  toBranch: SessionBranchDescriptor;
  messages: Message[];
  workspaceRestored: boolean;
  materialization?: WorkspaceMaterializationResult | undefined;
}

export interface FoldBranchOptions {
  /** Source branch name or ID (defaults to active branch when not on `main`). */
  sourceBranch?: string | undefined;
  /** Target branch name or ID (defaults to source branch's `parentBranchId ?? 'main'`). */
  targetBranch?: string | undefined;
  /** Optional guidance telling the synthesizer what findings matter most. */
  focusPrompt?: string | undefined;
  /** Mark the folded source branch `'archived'` so exclusive CAS blobs become GC-eligible. */
  archiveSource?: boolean | undefined;
  /** Override the summary token cap for this fold operation (default: `branchFoldMaxTokens`). */
  maxSummaryTokens?: number | undefined;
}

export interface FoldBranchResult {
  sourceBranch: SessionBranchDescriptor;
  targetBranch: SessionBranchDescriptor;
  summary: string;
  summaryMessage: Message;
  messages: Message[];
  sageMemoryIds?: readonly string[] | undefined;
}

/**
 * Coordinates in-session DAG branching (`/tree`), branch switching with
 * optional CAS workspace restoration, and secret-scrubbed fold-back synthesis.
 */
export class SessionTreeCoordinator {
  private readonly sessionId: string;
  private readonly writer: SessionWriter;
  private readonly getEvents: () => readonly SessionEvent[] | Promise<readonly SessionEvent[]>;
  private readonly checkpointCas: SessionCheckpointCas | undefined;
  private readonly projectRoot: string | undefined;
  private readonly secretScrubber: SecretScrubber;
  private readonly events: EventBus | undefined;
  private readonly extensionRegistry: ExtensionRegistryPort | undefined;
  private readonly synthesizeSummary: ((prompt: string) => Promise<string>) | undefined;
  private readonly branchFoldMaxTokens: number;
  private readonly onFoldInsight: SessionTreeCoordinatorOptions['onFoldInsight'];
  private readonly onMessagesReplaced:
    | ((messages: Message[], branch: SessionBranchDescriptor) => void)
    | undefined;

  constructor(opts: SessionTreeCoordinatorOptions) {
    this.sessionId = opts.sessionId;
    this.writer = opts.writer;
    this.getEvents = opts.getEvents;
    this.checkpointCas = opts.checkpointCas;
    this.projectRoot = opts.projectRoot;
    this.secretScrubber = opts.secretScrubber ?? new DefaultSecretScrubber();
    this.events = opts.events;
    this.extensionRegistry = opts.extensionRegistry;
    this.synthesizeSummary = opts.synthesizeSummary;
    this.branchFoldMaxTokens = opts.branchFoldMaxTokens ?? DEFAULT_BRANCH_FOLD_MAX_TOKENS;
    this.onFoldInsight = opts.onFoldInsight;
    this.onMessagesReplaced = opts.onMessagesReplaced;
  }

  private scrubText(text: string): string {
    return this.secretScrubber.scrub(text);
  }

  async getTree(): Promise<SessionTreeSnapshot> {
    const events = await this.getEvents();
    return reconstructSessionTree(events, { sessionId: this.sessionId }).tree;
  }

  /**
   * Resolve a historical fork point along `parentBranchId`'s lineage for `--at <promptIndex>`.
   */
  private resolvePromptForkPoint(
    events: readonly SessionEvent[],
    tree: SessionTreeSnapshot,
    parentBranchId: string,
    atPromptIndex: number,
  ): { forkSeq: number; checkpoint?: WorkspaceCheckpointRef | undefined } {
    if (!Number.isInteger(atPromptIndex) || atPromptIndex < 0) {
      throw new Error(`Invalid prompt index: ${atPromptIndex}`);
    }
    const segments = buildBranchLineageSegments(tree.branches, parentBranchId);

    // Collect lineage events with their sequence numbers.
    const lineage: Array<{ ev: SessionEvent; seq: number }> = [];
    for (let i = 0; i < events.length; i += 1) {
      const ev = events[i]!;
      const seq = typeof ev.seq === 'number' ? ev.seq : i;
      if (eventBelongsToLineage(ev, seq, segments)) {
        lineage.push({ ev, seq });
      }
    }

    // Prefer an explicit `checkpoint` event matching `promptIndex` (same anchor as `/rewind`).
    for (let idx = 0; idx < lineage.length; idx += 1) {
      const item = lineage[idx]!;
      if (item.ev.type === 'checkpoint' && item.ev.promptIndex === atPromptIndex) {
        // Cut right before the user_input / message_appended that opened this prompt.
        let cutIdx = idx;
        while (cutIdx > 0) {
          const prev = lineage[cutIdx - 1]!;
          if (
            prev.ev.type === 'user_input' ||
            (prev.ev.type === 'message_appended' &&
              prev.ev.version === 1 &&
              prev.ev.message.role === 'user')
          ) {
            cutIdx -= 1;
            continue;
          }
          break;
        }
        const forkSeq = cutIdx > 0 ? lineage[cutIdx - 1]!.seq : -1;
        return {
          forkSeq,
          checkpoint: item.ev.workspaceCheckpoint,
        };
      }
    }

    // Fallback: count 0-based user prompt turns along the lineage.
    let seenPrompts = 0;
    let pendingInputEcho = false;
    for (let idx = 0; idx < lineage.length; idx += 1) {
      const { ev } = lineage[idx]!;
      const isUserPrompt =
        ev.type === 'user_input' ||
        (ev.type === 'message_appended' &&
          ev.version === 1 &&
          ev.message.role === 'user' &&
          !(
            Array.isArray(ev.message.content) &&
            ev.message.content.length > 0 &&
            ev.message.content.every((b) => b.type === 'tool_result')
          ));
      if (isUserPrompt) {
        if (ev.type === 'message_appended' && pendingInputEcho) {
          pendingInputEcho = false;
          continue;
        }
        if (ev.type === 'user_input') pendingInputEcho = true;
        if (seenPrompts === atPromptIndex) {
          const forkSeq = idx > 0 ? lineage[idx - 1]!.seq : -1;
          return { forkSeq };
        }
        seenPrompts += 1;
      } else if (
        ev.type === 'llm_response' ||
        (ev.type === 'message_appended' && ev.version === 1 && ev.message.role === 'assistant')
      ) {
        pendingInputEcho = false;
      }
    }

    throw new Error(
      `Prompt index ${atPromptIndex} not found on branch "${parentBranchId}" (saw ${seenPrompts} prompt(s)).`,
    );
  }

  async createBranch(opts: CreateBranchOptions): Promise<CreateBranchResult> {
    const events = await this.getEvents();
    const { tree } = reconstructSessionTree(events, { sessionId: this.sessionId });
    const name = validateBranchName(opts.name, tree);
    const parentBranch = opts.fromBranch
      ? resolveBranch(tree, opts.fromBranch)
      : resolveBranch(tree, tree.activeBranchId);

    let forkSeq = tree.headSeq;
    let forkPromptIndex: number | undefined;
    let baseWorkspaceCheckpoint: WorkspaceCheckpointRef | undefined;

    if (opts.atSeq !== undefined) {
      if (!Number.isInteger(opts.atSeq) || opts.atSeq < -1) {
        throw new Error(`Invalid forkSeq: ${opts.atSeq}`);
      }
      forkSeq = opts.atSeq;
    } else if (opts.atPromptIndex !== undefined) {
      const resolved = this.resolvePromptForkPoint(
        events,
        tree,
        parentBranch.id,
        opts.atPromptIndex,
      );
      forkSeq = resolved.forkSeq;
      forkPromptIndex = opts.atPromptIndex;
      baseWorkspaceCheckpoint = resolved.checkpoint;
    } else if (this.checkpointCas && parentBranch.id === tree.activeBranchId) {
      baseWorkspaceCheckpoint = await this.checkpointCas.capture(
        this.sessionId,
        parentBranch.turnCount,
      );
    } else {
      baseWorkspaceCheckpoint =
        parentBranch.latestWorkspaceCheckpoint ?? parentBranch.baseWorkspaceCheckpoint;
    }

    const newBranchId = `br_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const ts = new Date().toISOString();
    await this.writer.append({
      type: 'branch_created',
      ts,
      newBranchId,
      name,
      ...(opts.label ? { label: this.scrubText(opts.label) } : {}),
      parentBranchId: parentBranch.id,
      forkSeq,
      ...(forkPromptIndex !== undefined ? { forkPromptIndex } : {}),
      ...(baseWorkspaceCheckpoint ? { baseWorkspaceCheckpoint } : {}),
    });

    const switchImmediately = opts.switchImmediately ?? true;
    if (switchImmediately) {
      // If we forked from a historical point with a checkpoint, materialize it on switch;
      // if we forked from the live active head, files already match so skip redundant write.
      const forkedFromLiveHead =
        parentBranch.id === tree.activeBranchId &&
        opts.atSeq === undefined &&
        opts.atPromptIndex === undefined;
      const switched = await this.switchBranch(newBranchId, {
        keepFiles: forkedFromLiveHead,
      });
      return {
        branch: switched.toBranch,
        switched: true,
        messages: switched.messages,
      };
    }

    const updatedEvents = await this.getEvents();
    const updatedTree = reconstructSessionTree(updatedEvents, { sessionId: this.sessionId }).tree;
    const branch = resolveBranch(updatedTree, newBranchId);
    return { branch, switched: false };
  }

  async switchBranch(
    targetNameOrId: string,
    opts?: SwitchBranchOptions,
  ): Promise<SwitchBranchResult> {
    const events = await this.getEvents();
    const { tree } = reconstructSessionTree(events, { sessionId: this.sessionId });
    const fromBranch = resolveBranch(tree, tree.activeBranchId);
    let toBranch = resolveBranch(tree, targetNameOrId);

    if (toBranch.status === 'archived') {
      if (!opts?.reactivateArchived) {
        throw new Error(
          `Branch "${toBranch.name}" (${toBranch.id}) is archived. Reactivate or pass reactivateArchived to switch.`,
        );
      }
      await this.writer.append({
        type: 'branch_status_changed',
        ts: new Date().toISOString(),
        targetBranchId: toBranch.id,
        status: 'active',
      });
    }

    if (fromBranch.id === toBranch.id) {
      const current = reconstructSessionTree(await this.getEvents(), {
        sessionId: this.sessionId,
        targetBranchId: toBranch.id,
      });
      const refreshed = resolveBranch(current.tree, toBranch.id);
      return {
        fromBranch: refreshed,
        toBranch: refreshed,
        messages: current.messages,
        workspaceRestored: false,
      };
    }

    let departureCheckpoint: WorkspaceCheckpointRef | undefined;
    if (this.checkpointCas) {
      departureCheckpoint = await this.checkpointCas.capture(this.sessionId, fromBranch.turnCount);
    }

    let workspaceRestored = false;
    let materialization: WorkspaceMaterializationResult | undefined;
    const targetCheckpoint = toBranch.latestWorkspaceCheckpoint ?? toBranch.baseWorkspaceCheckpoint;
    if (!opts?.keepFiles && this.checkpointCas && this.projectRoot && targetCheckpoint) {
      materialization = await this.checkpointCas.materialize(targetCheckpoint, this.projectRoot);
      workspaceRestored = materialization.errors.length === 0;
    }

    this.writer.setActiveBranch?.(toBranch.id);
    await this.writer.append({
      type: 'branch_switched',
      ts: new Date().toISOString(),
      fromBranchId: fromBranch.id,
      toBranchId: toBranch.id,
      ...(departureCheckpoint ? { departureCheckpoint } : {}),
      workspaceRestored,
    });

    const postSwitchEvents = await this.getEvents();
    const reconstructed = reconstructSessionTree(postSwitchEvents, {
      sessionId: this.sessionId,
      targetBranchId: toBranch.id,
    });
    toBranch = resolveBranch(reconstructed.tree, toBranch.id);
    const updatedFrom = resolveBranch(reconstructed.tree, fromBranch.id);
    this.onMessagesReplaced?.(reconstructed.messages, toBranch);

    if (materialization && targetCheckpoint && this.projectRoot) {
      this.events?.emit('workspace.files_materialized', {
        sessionId: this.sessionId,
        branchId: toBranch.id,
        targetRoot: this.projectRoot,
        writtenFiles: materialization.writtenFiles,
        deletedFiles: materialization.deletedFiles,
        manifestHash: targetCheckpoint.manifestHash,
        at: Date.now(),
      });
    }
    this.events?.emit('session.branch_switched', {
      sessionId: this.sessionId,
      fromBranchId: updatedFrom.id,
      toBranchId: toBranch.id,
      branchName: toBranch.name,
      workspaceRestored,
    });

    return {
      fromBranch: updatedFrom,
      toBranch,
      messages: reconstructed.messages,
      workspaceRestored,
      ...(materialization ? { materialization } : {}),
    };
  }

  async foldBranch(opts?: FoldBranchOptions): Promise<FoldBranchResult> {
    const events = await this.getEvents();
    const { tree } = reconstructSessionTree(events, { sessionId: this.sessionId });

    const sourceRef = opts?.sourceBranch ?? tree.activeBranchId;
    const sourceBranch = resolveBranch(tree, sourceRef);
    if (sourceBranch.id === MAIN_BRANCH_ID) {
      throw new Error('Cannot fold the root "main" branch into another branch.');
    }

    const targetRef = opts?.targetBranch ?? sourceBranch.parentBranchId ?? MAIN_BRANCH_ID;
    const targetBranch = resolveBranch(tree, targetRef);
    if (targetBranch.id === sourceBranch.id) {
      throw new Error('Cannot fold a branch into itself.');
    }

    // Collect events authored exclusively on `sourceBranch` and scrub before synthesis.
    const rawBranchEvents = events.filter((ev) => ev.branchId === sourceBranch.id);
    const scrubbedBranchEvents = rawBranchEvents.map((ev) => this.secretScrubber.scrubObject(ev));

    const sourceLineage = reconstructSessionTree(events, {
      sessionId: this.sessionId,
      targetBranchId: sourceBranch.id,
    });
    const scrubbedLineageMessages = sourceLineage.messages.map((msg) => ({
      ...msg,
      content:
        typeof msg.content === 'string'
          ? this.scrubText(msg.content)
          : this.secretScrubber.scrubObject(msg.content),
    }));
    const hookDirective = this.extensionRegistry
      ? await this.extensionRegistry.runBeforeCompact({
          sessionId: this.sessionId,
          branchId: sourceBranch.id,
          branchName: sourceBranch.name,
          messages: scrubbedLineageMessages,
          reason: 'branch_fold',
        })
      : undefined;

    const scrubbedFocus = opts?.focusPrompt ? this.scrubText(opts.focusPrompt) : undefined;
    const scrubbedInstructions = hookDirective?.additionalInstructions
      ? this.scrubText(hookDirective.additionalInstructions)
      : undefined;
    const scrubbedCustomSummary = hookDirective?.customSummary
      ? this.scrubText(hookDirective.customSummary).trim()
      : undefined;

    const deterministicDigest = this.scrubText(
      buildDeterministicFoldSummary(sourceBranch, scrubbedBranchEvents, scrubbedFocus),
    );

    let synthesized: string;
    if (scrubbedCustomSummary && scrubbedCustomSummary.length > 0) {
      synthesized = scrubbedCustomSummary;
    } else if (this.synthesizeSummary) {
      synthesized = deterministicDigest;
      try {
        const candidate = await this.synthesizeSummary(
          buildFoldSynthesisPrompt(
            sourceBranch,
            deterministicDigest,
            scrubbedFocus,
            scrubbedInstructions,
          ),
        );
        if (candidate.trim().length > 0) {
          synthesized = this.scrubText(candidate.trim());
        }
      } catch {
        // Fall back to deterministic digest on synthesis failure.
      }
    } else if (scrubbedInstructions) {
      synthesized = `${deterministicDigest}\nNotes: ${scrubbedInstructions}`;
    } else {
      synthesized = deterministicDigest;
    }

    synthesized = enforceFoldSummaryTokenCap(
      synthesized,
      opts?.maxSummaryTokens ?? this.branchFoldMaxTokens,
    );

    let sageMemoryIds: string[] | undefined;
    if (this.onFoldInsight) {
      try {
        const recorded = await this.onFoldInsight({
          sessionId: this.sessionId,
          sourceBranch,
          targetBranch,
          summary: synthesized,
          touchedFiles: extractBranchTouchedFiles(scrubbedBranchEvents),
        });
        const valid = (recorded ?? []).filter(
          (id): id is string => typeof id === 'string' && id.trim().length > 0,
        );
        if (valid.length > 0) sageMemoryIds = valid;
      } catch {
        // SAGE insight recording is best-effort and must never fail a branch fold.
      }
    }

    // Switch back to `targetBranch` first when folding the currently active branch.
    if (tree.activeBranchId === sourceBranch.id) {
      await this.switchBranch(targetBranch.id);
    }

    const ts = new Date().toISOString();
    const summaryMessage: Message = {
      role: 'user',
      content: `[Branch Fold-Back: ${sourceBranch.name}]\n${synthesized}`,
      ts,
    };
    const archiveSource = opts?.archiveSource ?? false;

    await this.writer.append({
      type: 'branch_folded',
      ts,
      sourceBranchId: sourceBranch.id,
      targetBranchId: targetBranch.id,
      summary: synthesized,
      summaryMessage,
      archiveSource,
      ...(sageMemoryIds ? { sageMemoryIds } : {}),
    });

    const postFoldEvents = await this.getEvents();
    const activeTargetId = reconstructSessionTree(postFoldEvents, { sessionId: this.sessionId })
      .tree.activeBranchId;
    const reconstructed = reconstructSessionTree(postFoldEvents, {
      sessionId: this.sessionId,
      targetBranchId: targetBranch.id,
    });
    const updatedSource = resolveBranch(reconstructed.tree, sourceBranch.id);
    const updatedTarget = resolveBranch(reconstructed.tree, targetBranch.id);

    if (activeTargetId === targetBranch.id) {
      this.onMessagesReplaced?.(reconstructed.messages, updatedTarget);
    }

    return {
      sourceBranch: updatedSource,
      targetBranch: updatedTarget,
      summary: synthesized,
      summaryMessage,
      messages: reconstructed.messages,
      ...(sageMemoryIds ? { sageMemoryIds } : {}),
    };
  }

  async renameBranch(targetNameOrId: string, newName: string): Promise<SessionBranchDescriptor> {
    const events = await this.getEvents();
    const { tree } = reconstructSessionTree(events, { sessionId: this.sessionId });
    const target = resolveBranch(tree, targetNameOrId);
    if (target.id === MAIN_BRANCH_ID) {
      throw new Error('Cannot rename the root "main" branch.');
    }
    const validated = validateBranchName(newName, tree, target.id);
    await this.writer.append({
      type: 'branch_status_changed',
      ts: new Date().toISOString(),
      targetBranchId: target.id,
      name: validated,
    });
    const updated = reconstructSessionTree(await this.getEvents(), {
      sessionId: this.sessionId,
    }).tree;
    return resolveBranch(updated, target.id);
  }

  async archiveBranch(
    targetNameOrId: string,
    status: SessionBranchStatus = 'archived',
  ): Promise<SessionBranchDescriptor> {
    const events = await this.getEvents();
    const { tree } = reconstructSessionTree(events, { sessionId: this.sessionId });
    const target = resolveBranch(tree, targetNameOrId);
    if (target.id === MAIN_BRANCH_ID) {
      throw new Error('Cannot archive the root "main" branch.');
    }
    if (status === 'archived' && tree.activeBranchId === target.id) {
      throw new Error(
        `Cannot archive active branch "${target.name}". Switch to another branch first.`,
      );
    }
    await this.writer.append({
      type: 'branch_status_changed',
      ts: new Date().toISOString(),
      targetBranchId: target.id,
      status,
    });
    const updated = reconstructSessionTree(await this.getEvents(), {
      sessionId: this.sessionId,
    }).tree;
    return resolveBranch(updated, target.id);
  }
}
