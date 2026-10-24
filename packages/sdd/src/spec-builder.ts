import type { Specification } from '@wrongstack/contracts/types';
import { ERROR_CODES, SddError } from '@wrongstack/contracts/types';
import { expectDefined } from '@wrongstack/core/utils';
import {
  type AISpecPhase,
  type AISpecSession,
  type AISpecSessionPersistence,
  isAISpecSession,
} from './sdd-session-types.js';
import {
  extractJSONArrayFromText,
  extractJSONFromText,
  parseSpecificationJSON,
} from './spec-builder-parsing.js';
import {
  buildExecutingPrompt,
  buildImplementationPrompt,
  buildQuestioningPrompt,
  buildSpecReviewPrompt,
  buildTaskReviewPrompt,
} from './spec-builder-prompts.js';
import {
  deleteAISpecSessionFile,
  readAISpecSessionFile,
  writeAISpecSessionFile,
} from './spec-builder-session-file.js';
import type { SpecStore } from './spec-store.js';

// ─── Session Types ────────────────────────────────────────────────────────────

export {
  type AISpecPhase,
  type AISpecSession,
  type AISpecSessionPersistence,
  type CollectedAnswer,
  isAISpecSession,
} from './sdd-session-types.js';

// ─── Builder Options ──────────────────────────────────────────────────────────

export interface AISpecBuilderOptions {
  store: SpecStore;
  /** Minimum questions the AI should ask. Default: 2 */
  minQuestions?: number | undefined;
  /** Maximum questions before forcing spec generation. Default: 10 */
  maxQuestions?: number | undefined;
  /** Project context string (package.json, file structure, etc.) */
  projectContext?: string | undefined;
  /** Legacy file persistence path. Production hosts provide `sessionPersistence`. */
  sessionPath?: string | undefined;
  /** Durable session owner. Takes precedence over `sessionPath`. */
  sessionPersistence?: AISpecSessionPersistence | undefined;
}

// ─── Spec Builder Class ───────────────────────────────────────────────────────

/**
 * AI-driven specification builder. Instead of static questions, this builder
 * tracks conversation state and generates prompts that instruct the AI agent
 * to ask contextual questions and build specifications interactively.
 */
export class AISpecBuilder {
  private session: AISpecSession;
  private readonly store: SpecStore;
  private readonly minQuestions: number;
  private readonly maxQuestions: number;
  private readonly projectContext: string;
  private readonly sessionPath?: string | undefined;
  private readonly sessionPersistence?: AISpecSessionPersistence | undefined;
  private pendingSessionWrite: Promise<void> = Promise.resolve();

  constructor(opts: AISpecBuilderOptions) {
    this.store = opts.store;
    this.minQuestions = opts.minQuestions ?? 2;
    this.maxQuestions = opts.maxQuestions ?? 10;
    this.projectContext = opts.projectContext ?? '';
    this.sessionPath = opts.sessionPath;
    this.sessionPersistence = opts.sessionPersistence;
    this.session = {
      id: crypto.randomUUID(),
      phase: 'questioning',
      title: '',
      userIntent: '',
      projectContext: this.projectContext,
      answers: [],
      questionCount: 0,
      approved: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
  }

  // ── Session Persistence ──────────────────────────────────────────────────

  /** Save session state to the configured durable owner. */
  async saveSession(): Promise<void> {
    if (!this.sessionPersistence && !this.sessionPath) return;
    const snapshot = structuredClone(this.session);
    this.pendingSessionWrite = this.pendingSessionWrite.then(async () => {
      try {
        if (this.sessionPersistence) {
          await this.sessionPersistence.save(snapshot);
          return;
        }
        await writeAISpecSessionFile(expectDefined(this.sessionPath), snapshot);
      } catch (error) {
        // Best-effort persistence — don't crash if save fails
        console.warn(
          JSON.stringify({
            level: 'warn',
            event: 'sdd.persist.failed',
            message: String(error),
            timestamp: Date.now(),
          }),
        );
      }
    });
    await this.pendingSessionWrite;
  }

  /** Load session state from the configured durable owner. */
  async loadSession(): Promise<boolean> {
    if (this.sessionPersistence) {
      const loaded = await this.sessionPersistence.load();
      if (isAISpecSession(loaded)) {
        this.session = loaded;
        return true;
      }
      return false;
    }
    if (!this.sessionPath) return false;
    const loaded = await readAISpecSessionFile(this.sessionPath);
    if (loaded) {
      this.session = loaded;
      return true;
    }
    return false;
  }

  /** Delete the saved session from the configured durable owner. */
  async deleteSession(): Promise<void> {
    // Drain fire-and-forget auto-saves before deleting. Otherwise an older
    // atomic write may rename its temp file after unlink and resurrect the
    // session the caller just discarded.
    await this.pendingSessionWrite;
    if (this.sessionPersistence) {
      await this.sessionPersistence.delete();
      return;
    }
    if (!this.sessionPath) return;
    await deleteAISpecSessionFile(this.sessionPath);
  }

  /** Auto-save helper. saveSession() already handles best-effort persistence. */
  private autoSave(): void {
    void this.saveSession();
  }

  // ── Session Lifecycle ─────────────────────────────────────────────────────

  /** Start a new session with a title, optional intent, and per-session context. */
  startSession(title: string, intent?: string, projectContext?: string): void {
    this.session.title = title;
    this.session.userIntent = intent ?? '';
    this.session.projectContext = projectContext ?? this.projectContext;
    this.session.phase = 'questioning';
    this.session.updatedAt = Date.now();
    this.autoSave();
  }

  /** Get current session state (readonly). */
  getSession(): Readonly<AISpecSession> {
    return { ...this.session };
  }

  /** Get the current phase. */
  getPhase(): AISpecPhase {
    return this.session.phase;
  }

  // ── AI Prompt Generation ──────────────────────────────────────────────────

  /**
   * Get the AI prompt for the current phase.
   * This prompt is injected into the conversation so the AI agent knows
   * what to do next (ask a question, generate a spec, etc.).
   */
  getAIPrompt(): string {
    switch (this.session.phase) {
      case 'questioning':
        return buildQuestioningPrompt(this.session, this.minQuestions, this.maxQuestions);
      case 'spec_review':
        return buildSpecReviewPrompt(this.session);
      case 'implementation':
        return buildImplementationPrompt(this.session);
      case 'task_review':
        return buildTaskReviewPrompt(this.session);
      case 'executing':
        return buildExecutingPrompt(this.session);
      case 'done':
        return 'All tasks completed. Specification is fully implemented.';
    }
  }

  // ── Answer Processing ─────────────────────────────────────────────────────

  /**
   * Record a question/answer pair from the AI conversation.
   * Call this when the AI asks a question and the user responds.
   */
  addAnswer(question: string, answer: string): void {
    this.session.answers.push({ question, answer, timestamp: Date.now() });
    this.session.questionCount++;
    this.session.updatedAt = Date.now();
    this.autoSave();
  }

  /**
   * Check if more questions should be asked.
   * Returns false if max reached or if the AI has signaled it has enough info.
   */
  shouldContinueQuestioning(): boolean {
    return this.session.questionCount < this.maxQuestions;
  }

  /**
   * Check if minimum questions have been asked.
   */
  hasMetMinimumQuestions(): boolean {
    return this.session.questionCount >= this.minQuestions;
  }

  // ── Phase Transitions ─────────────────────────────────────────────────────

  /**
   * Set the generated specification and move to spec_review phase.
   */
  setSpec(spec: Specification): void {
    this.session.spec = spec;
    this.session.phase = 'spec_review';
    this.session.updatedAt = Date.now();
    this.autoSave();
  }

  /**
   * Approve the current phase and advance to the next.
   * questioning → spec_review (requires spec to be set)
   * spec_review → implementation
   * implementation → task_review (requires implementation to be set)
   * task_review → executing
   * executing → done
   */
  approve(): AISpecPhase {
    switch (this.session.phase) {
      case 'questioning':
        if (!this.session.spec) {
          throw new SddError({
            message: 'Cannot approve: no spec generated yet.',
            code: ERROR_CODES.SDD_INVALID_STATE,
            context: { phase: 'questioning', sessionId: this.session.id },
          });
        }
        this.session.phase = 'spec_review';
        break;
      case 'spec_review':
        this.session.phase = 'implementation';
        break;
      case 'implementation':
        this.session.phase = 'task_review';
        break;
      case 'task_review':
        this.session.phase = 'executing';
        break;
      case 'executing':
        this.session.phase = 'done';
        break;
      case 'done':
        break;
    }
    this.session.approved = true;
    this.session.updatedAt = Date.now();
    this.autoSave();
    return this.session.phase;
  }

  /**
   * Rewind the session to an earlier phase (e.g. rejecting plan to re-specify,
   * or moving from spec review back to questioning).
   */
  rewindTo(targetPhase: AISpecPhase): AISpecPhase {
    if (targetPhase === this.session.phase) return this.session.phase;
    this.session.phase = targetPhase;
    this.session.approved = false;
    if (targetPhase === 'questioning') {
      this.session.spec = undefined;
      this.session.implementation = undefined;
      this.session.taskGraphId = undefined;
    } else if (targetPhase === 'spec_review') {
      this.session.implementation = undefined;
      this.session.taskGraphId = undefined;
    } else if (targetPhase === 'implementation') {
      this.session.implementation = undefined;
      this.session.taskGraphId = undefined;
    }
    this.session.updatedAt = Date.now();
    this.autoSave();
    return this.session.phase;
  }

  /**
   * Set the implementation plan text.
   */
  setImplementation(plan: string): void {
    this.session.implementation = plan;
    this.session.phase = 'task_review';
    this.session.updatedAt = Date.now();
    this.autoSave();
  }

  /**
   * Mark session as done.
   */
  markDone(): void {
    this.session.phase = 'done';
    this.session.updatedAt = Date.now();
    this.autoSave();
  }

  /**
   * Set the task graph ID for this session. Awaits the save so a caller that
   * immediately follows with `await saveSession()` cannot end up with the
   * awaited write committing first and the fire-and-forget rename reverting
   * the persisted `taskGraphId` to its pre-set value. Same race window that
   * broke `setLastAgentText`/`setLastRunId` on the resume test.
   */
  async setTaskGraphId(graphId: string): Promise<void> {
    this.session.taskGraphId = graphId;
    await this.saveSession();
  }

  /**
   * Get the task graph ID for this session.
   */
  getTaskGraphId(): string | undefined {
    return this.session.taskGraphId;
  }

  /**
   * Persist the last agent utterance so resume can rehydrate the UI + Q/A
   * pairing. Awaits the save so the next mutation in the call chain (e.g.
   * `setLastRunId`) cannot fire a concurrent save that overwrites this one
   * with a stale snapshot — the fire-and-forget `autoSave()` pattern leaves
   * a race window where an earlier queued save may commit its rename after
   * a later one, silently reverting the persisted state.
   */
  async setLastAgentText(text: string): Promise<void> {
    this.session.lastAgentText = text;
    this.session.updatedAt = Date.now();
    await this.saveSession();
  }

  getLastAgentText(): string | undefined {
    return this.session.lastAgentText;
  }

  /** Record a run kicked off from this interview (board deep-link after restart). See {@link setLastAgentText} for the awaited-save rationale. */
  async setLastRunId(runId: string): Promise<void> {
    this.session.lastRunId = runId;
    this.session.updatedAt = Date.now();
    await this.saveSession();
  }

  getLastRunId(): string | undefined {
    return this.session.lastRunId;
  }

  /**
   * Hard-reset in-memory session fields while keeping the same session id /
   * store binding. Used when the operator abandons a resumed interview and
   * starts a brand-new goal (the next save overwrites the session file).
   */
  resetForNewInterview(): void {
    this.session.phase = 'questioning';
    this.session.title = '';
    this.session.userIntent = '';
    this.session.projectContext = this.projectContext;
    this.session.answers = [];
    this.session.questionCount = 0;
    this.session.spec = undefined;
    this.session.implementation = undefined;
    this.session.taskGraphId = undefined;
    this.session.lastAgentText = undefined;
    this.session.lastRunId = undefined;
    this.session.approved = false;
    this.session.updatedAt = Date.now();
  }

  // ── Spec Persistence ──────────────────────────────────────────────────────

  /**
   * Save the current spec to the store.
   */
  async saveSpec(): Promise<Specification> {
    if (!this.session.spec) {
      throw new SddError({
        message: 'No spec to save.',
        code: ERROR_CODES.SDD_NOT_READY,
        context: { sessionId: this.session.id },
      });
    }
    await this.store.save(this.session.spec);
    return this.session.spec;
  }

  // ── Spec Generation Helpers ───────────────────────────────────────────────

  /**
   * Parse a spec from a JSON string (from AI output).
   * Validates and normalizes the structure.
   */
  parseSpecFromJSON(jsonStr: string): Specification {
    return parseSpecificationJSON(jsonStr, this.session.title, this.session.id);
  }

  /**
   * Extract JSON from AI output (handles ```json blocks and raw JSON).
   */
  extractJSON(text: string): string | null {
    return extractJSONFromText(text);
  }

  /**
   * Detect if AI output contains a spec (JSON block).
   */
  hasSpecInOutput(text: string): boolean {
    return this.extractJSON(text) !== null;
  }

  /**
   * Try to parse a spec from AI output text.
   * Returns null if no valid spec found.
   */
  tryParseSpecFromOutput(text: string): Specification | null {
    const json = this.extractJSON(text);
    if (!json) return null;

    try {
      return this.parseSpecFromJSON(json);
    } catch {
      return null;
    }
  }

  // ── JSON Array Extraction (for tasks) ─────────────────────────────────────

  /**
   * Extract a JSON array from AI output (for task lists).
   */
  extractJSONArray(text: string): string | null {
    return extractJSONArrayFromText(text);
  }
}
