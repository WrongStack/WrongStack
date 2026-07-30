import type { Specification, SpecRequirement, SpecSection } from '@wrongstack/core/types';
import { ERROR_CODES, SddError } from '@wrongstack/core/types';
import { expectDefined, toErrorMessage } from '@wrongstack/core/utils';
import type { SpecStore } from './spec-store.js';

// ─── Session Types ────────────────────────────────────────────────────────────

export type AISpecPhase =
  | 'questioning' // AI is asking questions
  | 'spec_review' // Spec generated, waiting for user approval
  | 'implementation' // Implementation plan phase
  | 'task_review' // Tasks generated, waiting for execution
  | 'executing' // Running tasks
  | 'done'; // Everything complete

export interface CollectedAnswer {
  question: string;
  answer: string;
  timestamp: number;
}

export interface AISpecSession {
  id: string;
  phase: AISpecPhase;
  title: string;
  userIntent: string;
  projectContext: string;
  answers: CollectedAnswer[];
  questionCount: number;
  spec?: Specification | undefined;
  implementation?: string | undefined;
  taskGraphId?: string | undefined;
  /**
   * Last agent message shown to the operator (open question or plan prose).
   * Persisted so a reconnect/restart can re-pair the next user answer and
   * re-render the transcript without re-running the model.
   */
  lastAgentText?: string | undefined;
  /** Most recent SDD run id started from this interview (continuity deep-link). */
  lastRunId?: string | undefined;
  approved: boolean;
  createdAt: number;
  updatedAt: number;
}

// ─── Builder Options ──────────────────────────────────────────────────────────

export interface AISpecBuilderOptions {
  store: SpecStore;
  /** Minimum questions the AI should ask. Default: 2 */
  minQuestions?: number | undefined;
  /** Maximum questions before forcing spec generation. Default: 10 */
  maxQuestions?: number | undefined;
  /** Project context string (package.json, file structure, etc.) */
  projectContext?: string | undefined;
  /** Path to persist session state. If set, session survives process restarts. */
  sessionPath?: string | undefined;
}

// ─── AI Prompts ───────────────────────────────────────────────────────────────

function buildQuestioningPrompt(session: AISpecSession, min: number, max: number): string {
  const answered = session.answers.length;
  const remaining = Math.max(0, min - answered);
  const budget = max - answered;

  const lines: string[] = [
    `═══ SDD Spec Builder ═══`,
    `Feature: "${session.title}"`,
    session.userIntent ? `Intent: ${session.userIntent}` : '',
    `Phase: Questioning (${answered} answered, ${budget} remaining budget)`,
    '',
    '**Instructions for AI:**',
    '',
    'You are conducting a specification interview. Your job is to ask the user',
    'intelligent, contextual questions to understand what they want to build.',
    '',
    `You have asked ${answered} questions so far.`,
  ];

  if (remaining > 0) {
    lines.push(`You MUST ask at least ${remaining} more question(s) before generating the spec.`);
  } else if (budget <= 0) {
    lines.push('You have reached the maximum question budget. Generate the spec NOW.');
  } else {
    lines.push(
      'You may ask more questions if needed, or generate the spec if you have enough information.',
      'Ask a question ONLY if it reveals something you genuinely need to know.',
    );
  }

  lines.push(
    '',
    '**Rules:**',
    '- Ask ONE question at a time',
    '- Questions must be specific and contextual — never generic',
    '- Adapt based on previous answers',
    '- Cover: scope, constraints, edge cases, integrations, security, performance as relevant',
    '- When you have enough info, respond with the full specification in JSON format',
    '- This is a planning interview: respond with TEXT ONLY (a question, or the spec JSON).',
    '  Do NOT write or edit files, and do NOT run shell/terminal commands — the code is',
    '  written later, after the plan is approved.',
    '',
    `**Question budget:** ${budget}/${max} remaining`,
    `**Minimum required:** ${remaining > 0 ? remaining : 'met'}`,
  );

  if (session.projectContext) {
    lines.push('', '**Project Context:**', '```', session.projectContext, '```');
  }

  if (answered > 0) {
    lines.push('', '**Conversation so far:**');
    for (let i = 0; i < answered; i++) {
      const a = expectDefined(session.answers[i]);
      lines.push(``, `Q${i + 1}: ${a.question}`, `A${i + 1}: ${a.answer}`);
    }
  }

  lines.push(
    '',
    '---',
    'Now either:',
    `1. Ask your next question (if you need more info)`,
    `2. Generate the complete specification as JSON (if ready)`,
    '',
    'If generating spec, output JSON inside ```json code block with this structure:',
    '```json',
    '{',
    '  "title": "...",',
    '  "overview": "...",',
    '  "sections": [{ "type": "overview|requirements|architecture|api|data|security|acceptance", "title": "...", "content": "...", "level": 1 }],',
    '  "requirements": [{ "id": "REQ-1", "type": "functional|non-functional|security|performance|ux", "priority": "critical|high|medium|low", "description": "...", "acceptanceCriteria": ["..."] }]',
    '}',
    '```',
  );

  return lines.filter(Boolean).join('\n');
}

function buildSpecReviewPrompt(session: AISpecSession): string {
  const spec = session.spec;
  if (!spec) return 'No spec generated yet.';

  const reqSummary = spec.requirements.map((r) => `  [${r.priority}] ${r.description}`).join('\n');

  return [
    `═══ Spec Review ═══`,
    `Feature: "${spec.title}"`,
    `Requirements: ${spec.requirements.length}`,
    '',
    '**Specification:**',
    spec.overview,
    '',
    '**Requirements:**',
    reqSummary,
    '',
    '---',
    'Approve this spec? The AI will then generate an implementation plan and tasks.',
    'Say "approve" to proceed, or describe what needs to change.',
  ].join('\n');
}

function buildImplementationPrompt(session: AISpecSession): string {
  const spec = session.spec;
  if (!spec) return 'No spec to implement.';

  const reqList = spec.requirements.map((r) => `  - [${r.priority}] ${r.description}`).join('\n');

  return [
    `═══ Implementation Planning ═══`,
    `Feature: "${spec.title}"`,
    `Requirements: ${spec.requirements.length}`,
    '',
    '**Requirements to implement:**',
    reqList,
    '',
    '**Instructions for AI:**',
    'Generate a detailed implementation plan for this specification.',
    'This is a PLANNING step — describe the plan and emit the task JSON as TEXT. Do NOT',
    'create or edit files and do NOT run shell/terminal commands here; the tasks you list',
    'are executed later, one by one, after you approve them.',
    'Include:',
    '1. Architecture decisions',
    '2. File structure changes',
    '3. Key implementation details',
    '4. Dependency requirements',
    '5. Testing strategy',
    '',
    '**IMPORTANT:** After the plan, you MUST generate executable tasks as a JSON array.',
    'Each task should be a concrete, actionable step. Output the JSON inside a ```json code block:',
    '```json',
    '[',
    '  {',
    '    "id": "t1",',
    '    "title": "Create auth middleware",',
    '    "description": "Implement JWT verification middleware for protected routes",',
    '    "type": "feature",',
    '    "priority": "critical",',
    '    "estimateHours": 3,',
    '    "dependsOn": [],',
    '    "tags": ["auth", "middleware"]',
    '  },',
    '  {',
    '    "id": "t2",',
    '    "title": "Write auth tests",',
    '    "description": "Unit and integration tests for authentication flow",',
    '    "type": "test",',
    '    "priority": "high",',
    '    "estimateHours": 2,',
    '    "dependsOn": ["t1"],',
    '    "tags": ["test", "auth"]',
    '  }',
    ']',
    '```',
    '',
    'Rules:',
    '- Give every task a short stable "id" (t1, t2, …). Reference prerequisites in "dependsOn"',
    '  as a list of those ids — this builds the real dependency graph that drives parallel vs',
    '  sequential execution.',
    '- "dependsOn": [] means the task is independent and may run in parallel with other roots.',
    '- A task with dependsOn runs ONLY after every listed task completes. Model true ordering:',
    '  tests depend on the feature they test, docs/integration depend on the parts they cover.',
    '- Do NOT create cycles (t1→t2→t1). Keep chains as shallow as correctness allows so',
    '  independent work runs concurrently.',
    '- Use type: "feature" for code, "test" for tests, "docs" for documentation, "chore" for config',
    '- Use priority: "critical" for blockers, "high" for core features, "medium" for nice-to-haves, "low" for polish',
  ].join('\n');
}

function buildTaskReviewPrompt(session: AISpecSession): string {
  return [
    `═══ Task Review ═══`,
    `Feature: "${session.spec?.title ?? session.title}"`,
    '',
    session.implementation ?? 'No implementation plan yet.',
    '',
    '---',
    'Ready to execute these tasks? Say "execute" to begin, or describe changes needed.',
  ].join('\n');
}

function buildExecutingPrompt(session: AISpecSession): string {
  return [
    `═══ Task Execution ═══`,
    `Feature: "${session.spec?.title ?? session.title}"`,
    '',
    '**Instructions for AI:**',
    'Execute the tasks one by one in the order shown in the task list above.',
    '',
    'For each task:',
    '1. Implement the code (create/modify files)',
    '2. Write tests if applicable',
    '3. After completing a task, tell the user to run: /sdd done <task number or title>',
    '4. Then move to the next task',
    '',
    '**Important:**',
    '- Focus on ONE task at a time',
    '- After completing each task, explicitly state what you did',
    '- Tell the user: "Run /sdd done <N> to mark this task complete"',
    '- Then proceed to the next task automatically',
    '- When ALL tasks are done, provide a summary of everything implemented',
    '',
    'Start executing the first pending task now.',
  ].join('\n');
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
  private readonly sessionPath?: string | undefined;

  constructor(opts: AISpecBuilderOptions) {
    this.store = opts.store;
    this.minQuestions = opts.minQuestions ?? 2;
    this.maxQuestions = opts.maxQuestions ?? 10;
    this.sessionPath = opts.sessionPath;
    this.session = {
      id: crypto.randomUUID(),
      phase: 'questioning',
      title: '',
      userIntent: '',
      projectContext: opts.projectContext ?? '',
      answers: [],
      questionCount: 0,
      approved: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
  }

  // ── Session Persistence ──────────────────────────────────────────────────

  /** Save session state to disk. */
  async saveSession(): Promise<void> {
    if (!this.sessionPath) return;
    try {
      const fsp = await import('node:fs/promises');
      const path = await import('node:path');
      const { atomicWrite } = await import('@wrongstack/core/utils');
      await fsp.mkdir(path.dirname(this.sessionPath), { recursive: true });
      // atomicWrite: torn save would corrupt the SDD session JSON and the
      // next load would silently fall back to a fresh session.
      await atomicWrite(this.sessionPath, JSON.stringify(this.session, null, 2));
    } catch (error) {
      // Best-effort persistence — don't crash if save fails
      console.warn(JSON.stringify({ level: 'warn', event: 'sdd.persist.failed', message: String(error), timestamp: Date.now() }));
    }
  }

  /** Load session state from disk. Returns true if a session was loaded. */
  async loadSession(): Promise<boolean> {
    if (!this.sessionPath) return false;
    try {
      const fsp = await import('node:fs/promises');
      const raw = await fsp.readFile(this.sessionPath, 'utf8');
      const loaded = JSON.parse(raw) as AISpecSession;
      // Validate basic structure
      if (loaded?.id && loaded?.phase && loaded?.title) {
        this.session = loaded;
        return true;
      }
    } catch {
      // No saved session or invalid file
    }
    return false;
  }

  /** Delete saved session from disk. */
  async deleteSession(): Promise<void> {
    if (!this.sessionPath) return;
    try {
      const fsp = await import('node:fs/promises');
      await fsp.unlink(this.sessionPath);
    } catch {
      // File might not exist
    }
  }

  /** Auto-save helper. saveSession() already handles best-effort persistence. */
  private autoSave(): void {
    void this.saveSession();
  }

  // ── Session Lifecycle ─────────────────────────────────────────────────────

  /** Start a new session with a title and optional intent. */
  startSession(title: string, intent?: string): void {
    this.session.title = title;
    this.session.userIntent = intent ?? '';
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
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonStr);
    } catch (e) {
      throw new SddError({
        message: 'Invalid JSON for spec',
        code: ERROR_CODES.SDD_PARSE_FAILED,
        cause: e,
        context: { detail: toErrorMessage(e) },
      });
    }

    if (!parsed || typeof parsed !== 'object') {
      throw new SddError({
        message: 'Spec JSON must be an object',
        code: ERROR_CODES.SDD_VALIDATION_FAILED,
        context: { actualType: typeof parsed },
      });
    }

    const raw = parsed as Record<string, unknown>;
    const now = Date.now();

    const title = String(raw.title ?? this.session.title);
    const overview = String(raw.overview ?? '');

    // Validate overview is not empty
    if (!overview || overview === 'undefined') {
      throw new SddError({
        message: 'Spec must have an overview',
        code: ERROR_CODES.SDD_VALIDATION_FAILED,
        context: { field: 'overview', title },
      });
    }

    const rawSections = Array.isArray(raw.sections) ? raw.sections : [];
    const sections: SpecSection[] = rawSections
      .filter((s: unknown) => s && typeof s === 'object')
      .map((s: Record<string, unknown>) => ({
        type: ([
          'overview',
          'requirements',
          'architecture',
          'api',
          'data',
          'security',
          'acceptance',
        ].includes(String(s.type))
          ? String(s.type)
          : 'overview') as SpecSection['type'],
        title: String(s.title ?? ''),
        content: String(s.content ?? ''),
        level: Number(s.level) || 1,
      }));

    const rawReqs = Array.isArray(raw.requirements) ? raw.requirements : [];
    const requirements: SpecRequirement[] = rawReqs
      .filter((r: unknown) => r && typeof r === 'object')
      .map((r: Record<string, unknown>, i: number) => ({
        id: String(r.id ?? `REQ-${i + 1}`),
        type: (['functional', 'non-functional', 'security', 'performance', 'ux'].includes(
          String(r.type),
        )
          ? String(r.type)
          : 'functional') as SpecRequirement['type'],
        priority: (['critical', 'high', 'medium', 'low'].includes(String(r.priority))
          ? String(r.priority)
          : 'medium') as SpecRequirement['priority'],
        description: String(r.description ?? ''),
        acceptanceCriteria: Array.isArray(r.acceptanceCriteria)
          ? r.acceptanceCriteria.map(String)
          : [],
      }));

    const spec: Specification = {
      id: crypto.randomUUID(),
      title,
      version: '0.1.0',
      status: 'draft',
      overview,
      sections,
      requirements,
      createdAt: now,
      updatedAt: now,
      metadata: {
        generatedBy: 'AISpecBuilder',
        sessionId: this.session.id,
      },
    };

    return spec;
  }

  /**
   * Extract JSON from AI output (handles ```json blocks and raw JSON).
   */
  extractJSON(text: string): string | null {
    // Try ```json ... ``` first
    const codeBlockMatch = text.match(/```json\s*([\s\S]*?)```/);
    if (codeBlockMatch?.[1]) {
      return codeBlockMatch[1].trim();
    }

    // Try ``` ... ``` without language tag
    const genericBlockMatch = text.match(/```\s*([\s\S]*?)```/);
    if (genericBlockMatch?.[1]) {
      const trimmed = genericBlockMatch[1].trim();
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        return trimmed;
      }
    }

    // Try raw JSON object
    const jsonMatch = text.match(/(\{[\s\S]*\})/);
    if (jsonMatch?.[1]) {
      try {
        JSON.parse(jsonMatch[1]);
        return jsonMatch[1];
      } catch {
        // not valid JSON
      }
    }

    return null;
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
    const codeBlockMatch = text.match(/```json\s*([\s\S]*?)```/);
    if (codeBlockMatch?.[1]) {
      const trimmed = codeBlockMatch[1].trim();
      if (trimmed.startsWith('[')) return trimmed;
    }

    const arrayMatch = text.match(/(\[[\s\S]*\])/);
    if (arrayMatch?.[1]) {
      try {
        const parsed = JSON.parse(arrayMatch[1]);
        if (Array.isArray(parsed)) return arrayMatch[1];
      } catch {
        // not valid
      }
    }

    return null;
  }
}
