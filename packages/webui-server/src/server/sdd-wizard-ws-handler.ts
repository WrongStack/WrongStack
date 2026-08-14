import type { AISpecPhase, SddInterviewDriver, SddInterviewSnapshot } from '@wrongstack/sdd';
import type { WebSocket } from 'ws';
import { sendSerialized } from './ws-utils.js';

interface WSClient {
  ws: WebSocket;
  id: string;
}

interface WizardMessage {
  type: string;
  payload?: Record<string, unknown>;
}

/** Short, single-line heading derived from a (possibly long) goal prompt. */
function deriveTitle(goal: string): string {
  const firstLine = goal
    .split('\n')
    .map((l) => l.trim())
    .find(Boolean);
  if (!firstLine) return 'New SDD Project';
  const sentence = firstLine.split(/(?<=[.!?])\s/)[0] ?? firstLine;
  return sentence.length <= 64 ? sentence : `${sentence.slice(0, 63).trimEnd()}…`;
}

export interface SddRunStartOpts {
  parallelSlots?: number | undefined;
  defaultModel?: string | undefined;
  defaultProvider?: string | undefined;
  fallbackModels?: string[] | undefined;
  /** Per-run worktree-isolation override; undefined → env default. */
  worktrees?: boolean | undefined;
  /** Planning-time non-atomic task split before dispatch. */
  planDecompose?: boolean | undefined;
}

/**
 * Dependencies each webui server supplies. The handler is deliberately
 * agent-agnostic: every surface decides how to build a driver, how to run an
 * interview turn (on an isolated agent, off the main chat bus), and how to
 * start the real multi-agent run (CLI's director-backed factory vs the runtime
 * light factory). This keeps the wizard protocol identical across both servers.
 */
export interface SddWizardDeps {
  /** Build a fresh interview driver (artifact stores + durable session owner). */
  makeDriver: () => SddInterviewDriver;
  /**
   * Await before the first message / client snapshot so project context and any
   * durable resume finish loading. Optional for unit tests that inject a ready driver.
   */
  ensureReady?: (() => Promise<void>) | undefined;
  /**
   * Run one interview turn: feed the AI prompt to an isolated agent and return
   * its final text. MUST NOT run on the main chat agent's bus — the wizard owns
   * this conversation, separate from the user's chat.
   */
  runInterviewTurn: (prompt: string) => Promise<string>;
  /**
   * Start the real multi-agent SDD run for the driver's task graph. Returns the
   * runId; the live board flows through the existing board handler.
   */
  startRun: (driver: SddInterviewDriver, opts: SddRunStartOpts) => Promise<{ runId: string }>;
  /**
   * Start a multi-agent SDD run from an already-persisted task graph (Specs
   * "Run as SDD"). Omit → `sdd.run.from_graph` / `sdd.run.from_spec` error.
   */
  startRunFromGraphId?:
    | ((graphId: string, opts: SddRunStartOpts) => Promise<{ runId: string }>)
    | undefined;
  /**
   * Resolve the latest task-graph id for a persisted spec. Used by
   * `sdd.run.from_spec`. Omit → that message type is unavailable.
   */
  resolveGraphIdForSpec?: ((specId: string) => Promise<string | null>) | undefined;
}

/**
 * SddWizardWebSocketHandler — drives the interactive "New SDD Project" wizard
 * (goal → Q&A → spec → task graph → start run) over WebSocket. Shared by both
 * webui servers; server-specific construction (agent, factory) is injected via
 * {@link SddWizardDeps}.
 *
 * Continuity: on construction (and before the first client message) the handler
 * rehydrates the durable interview session so a browser refresh or process
 * restart resumes mid-Q&A / mid-review without re-running the model.
 */
export class SddWizardWebSocketHandler {
  private readonly clients = new Set<WSClient>();
  private driver: SddInterviewDriver | null = null;
  /** The agent's most recent question — paired with the next user answer. */
  private lastAgentText = '';
  /** Guards against overlapping interview turns (one in flight at a time). */
  private busy = false;
  /** Set when authoritative session state could not be read during bootstrap. */
  private resumeError: string | null = null;
  /** Resolves once project-context gather + durable resume finish. */
  private readonly ready: Promise<void>;
  /**
   * Single-flight slot for the resume probe. `handleMessage` awaits this
   * when `resumeError` is set, so concurrent frames cannot race the retry
   * — one probe either clears the gate or re-latches it, then every
   * queued frame re-checks and proceeds. `null` when no probe is in
   * flight (or after the probe has settled).
   */
  private resumeProbe: Promise<void> | null = null;
  private disposed = false;

  constructor(private readonly deps: SddWizardDeps) {
    this.ready = this.bootstrap();
  }

  private async bootstrap(): Promise<void> {
    try {
      await this.deps.ensureReady?.();
    } catch {
      // Context gather is best-effort.
    }
    await this.tryResume();
  }

  /** Rehydrate a persisted interview if one exists. */
  private async tryResume(): Promise<void> {
    if (this.driver) return;
    // Keep any previous error latched while the probe is in flight. Clearing
    // it before `loadExisting()` settles would let another concurrent frame
    // bypass the fail-closed gate and start a second session. The error is
    // released only after the authoritative read succeeds.
    try {
      const driver = this.deps.makeDriver();
      const loaded = await driver.loadExisting();
      if (this.disposed) return;
      if (loaded) {
        this.driver = driver;
        this.lastAgentText = driver.getLastAgentText() ?? '';
      }
      this.resumeError = null;
    } catch (error) {
      if (this.disposed) return;
      // IPC failure cannot prove that no session exists. Fail closed so a fresh
      // start cannot overwrite another process's interview.
      this.driver = null;
      this.lastAgentText = '';
      this.resumeError = error instanceof Error ? error.message : String(error);
    }
  }

  addClient(ws: WebSocket): void {
    if (this.disposed) return;
    const client: WSClient = { ws, id: crypto.randomUUID() };
    this.clients.add(client);
    ws.on('close', () => this.clients.delete(client));
    ws.on('error', () => this.clients.delete(client));
    // Catch up reconnecting clients after resume completes.
    void this.ready.then(() => {
      if (this.disposed || !this.clients.has(client)) return;
      if (this.resumeError) {
        this.send(client, { type: 'sdd.spec.error', payload: { message: this.resumeError } });
        return;
      }
      if (this.driver) {
        this.send(client, this.snapshotMsg());
        if (this.lastAgentText) {
          this.send(client, { type: 'sdd.spec.agent_text', payload: { text: this.lastAgentText } });
        }
      }
    });
  }

  dispose(): void {
    this.disposed = true;
    this.clients.clear();
    this.driver = null;
    this.lastAgentText = '';
    this.busy = false;
    this.resumeProbe = null;
  }

  async handleMessage(msg: WizardMessage): Promise<void> {
    if (this.disposed) return;
    try {
      await this.ready;
      if (this.resumeError) {
        // Latched transient failure. A surviving client message must not
        // be silently dropped — re-probe the IPC layer so a recovered
        // daemon unblocks the wizard on the very next frame. Concurrent
        // frames await the same in-flight probe to avoid stampeding the
        // IPC client (single-flight via `resumeProbe`).
        if (this.resumeProbe === null) {
          // Defer the actual probe by one microtask so the single-flight slot
          // is published before `makeDriver` or `loadExisting` can re-enter.
          const probe = Promise.resolve().then(() => this.tryResume());
          this.resumeProbe = probe;
          void probe.finally(() => {
            // Keep a settled probe visible through the rest of this event-loop
            // turn. Concurrent WebSocket frames may resume from `await ready`
            // in separate microtasks; clearing immediately would let the later
            // frame start a duplicate IPC probe after the first one settled.
            setTimeout(() => {
              if (this.resumeProbe === probe) this.resumeProbe = null;
            }, 0);
          });
        }
        await this.resumeProbe;
        if (this.resumeError) {
          // Re-probe did not recover; broadcast the error and reject.
          this.broadcast({ type: 'sdd.spec.error', payload: { message: this.resumeError } });
          return;
        }
      }
      switch (msg.type) {
        case 'sdd.spec.start':
          await this.onStart(String(msg.payload?.goal ?? '').trim(), {
            force: msg.payload?.force === true,
          });
          break;
        case 'sdd.spec.message':
          await this.onMessage(String(msg.payload?.text ?? ''));
          break;
        case 'sdd.spec.approve':
          await this.onApprove();
          break;
        case 'sdd.spec.rewind':
          await this.onRewind(msg.payload?.targetPhase as AISpecPhase | undefined);
          break;
        case 'sdd.spec.get':
          if (this.driver) {
            this.broadcast(this.snapshotMsg());
            if (this.lastAgentText) {
              this.broadcast({
                type: 'sdd.spec.agent_text',
                payload: { text: this.lastAgentText },
              });
            }
          }
          break;
        case 'sdd.spec.discard':
          await this.onDiscard();
          break;
        case 'sdd.run.start':
          await this.onRunStart(this.parseRunOpts(msg.payload));
          break;
        case 'sdd.run.from_graph':
          await this.onRunFromGraph(
            String(msg.payload?.graphId ?? '').trim(),
            this.parseRunOpts(msg.payload),
          );
          break;
        case 'sdd.run.from_spec':
          await this.onRunFromSpec(
            String(msg.payload?.specId ?? '').trim(),
            this.parseRunOpts(msg.payload),
          );
          break;
      }
    } catch (err) {
      this.busy = false;
      this.broadcast({
        type: 'sdd.spec.error',
        payload: { message: err instanceof Error ? err.message : String(err) },
      });
    }
  }

  // ── message handlers ──────────────────────────────────────────────────────

  private parseRunOpts(payload?: Record<string, unknown>): SddRunStartOpts {
    return {
      parallelSlots: payload?.parallelSlots as number | undefined,
      defaultModel:
        (payload?.model as string | undefined) ?? (payload?.defaultModel as string | undefined),
      defaultProvider:
        (payload?.provider as string | undefined) ??
        (payload?.defaultProvider as string | undefined),
      fallbackModels: Array.isArray(payload?.fallbackModels)
        ? (payload?.fallbackModels as string[])
        : undefined,
      worktrees: typeof payload?.worktrees === 'boolean' ? payload.worktrees : undefined,
      planDecompose:
        typeof payload?.planDecompose === 'boolean' ? payload.planDecompose : undefined,
    };
  }

  private async onStart(goal: string, opts: { force?: boolean }): Promise<void> {
    if (!goal) {
      this.broadcast({ type: 'sdd.spec.error', payload: { message: 'A goal is required.' } });
      return;
    }
    if (this.busy) return;

    // Resume-friendly: an in-progress interview is kept unless the operator
    // explicitly forces a new start (discard-then-start, or force: true).
    if (this.driver && !opts.force) {
      const phase = this.driver.phase();
      const midInterview =
        phase === 'questioning' ||
        phase === 'spec_review' ||
        phase === 'implementation' ||
        phase === 'task_review';
      if (midInterview) {
        // Still mid-flow — surface the existing session instead of clobbering.
        this.broadcast(this.snapshotMsg());
        if (this.lastAgentText) {
          this.broadcast({ type: 'sdd.spec.agent_text', payload: { text: this.lastAgentText } });
        }
        this.broadcast({
          type: 'sdd.spec.error',
          payload: {
            message:
              'An interview is already in progress. Continue it, or discard and start a new one.',
          },
        });
        return;
      }
    }

    // Force / post-completion restart: drop any leftover on-disk session first so
    // a crash mid-start cannot rehydrate the previous interview.
    if (opts.force || this.driver) {
      try {
        if (this.driver) await this.driver.discard();
        else await this.deps.makeDriver().discard();
      } catch {
        /* best-effort */
      }
    }
    this.driver = this.deps.makeDriver();
    this.lastAgentText = '';
    // Keep the operator's full prompt as the interview's intent/goal, but give
    // the session a short readable title — pasting the whole prompt as the title
    // made the wizard header unreadable.
    const prompt = this.driver.start(deriveTitle(goal), goal);
    await this.runTurn(prompt);
  }

  private async onDiscard(): Promise<void> {
    if (this.busy) return;
    if (this.driver) {
      await this.driver.discard();
    } else {
      // Still clear any on-disk session even if we never loaded a driver.
      const d = this.deps.makeDriver();
      await d.discard();
    }
    this.driver = null;
    this.lastAgentText = '';
    this.broadcast({
      type: 'sdd.spec.snapshot',
      payload: { phase: 'idle', busy: false, discarded: true },
    });
  }

  private async onMessage(text: string): Promise<void> {
    if (!this.driver || this.busy) return;
    // In the questioning phase, the user's message answers the agent's last
    // question. In review phases a free-form message is fed back as context.
    if (this.driver.phase() === 'questioning' && this.lastAgentText) {
      this.driver.submitAnswer(this.lastAgentText, text);
    } else {
      this.driver.submitAnswer(this.lastAgentText || '(feedback)', text);
    }
    await this.runTurn(this.driver.currentPrompt());
  }

  private async onApprove(): Promise<void> {
    if (!this.driver || this.busy) return;
    const { phase, prompt } = await this.driver.approve();
    // Executing phase needs no further AI turn — the graph is ready to run.
    if (phase === 'executing') {
      this.broadcast(this.snapshotMsg());
      return;
    }
    await this.runTurn(prompt);
  }

  private async onRewind(targetPhase?: AISpecPhase): Promise<void> {
    if (!this.driver || this.busy) return;
    const { phase, prompt } = await this.driver.rewind(targetPhase);
    this.broadcast(this.snapshotMsg());
    if (phase === 'questioning' || phase === 'implementation') {
      await this.runTurn(prompt);
    }
  }

  private async onRunStart(opts: SddRunStartOpts): Promise<void> {
    if (!this.driver) {
      this.broadcast({ type: 'sdd.spec.error', payload: { message: 'No active spec session.' } });
      return;
    }
    // Guarantee a graph exists (deterministic fallback if the agent never
    // emitted a task array).
    const graph = await this.driver.ensureTaskGraph();
    if (!graph) {
      this.broadcast({
        type: 'sdd.spec.error',
        payload: { message: 'No spec yet — finish the interview before starting a run.' },
      });
      return;
    }
    const { runId } = await this.deps.startRun(this.driver, opts);
    await this.driver.setLastRunId(runId);
    // Persist "executing" so a restart can deep-link to the live board.
    if (this.driver.phase() !== 'executing' && this.driver.phase() !== 'done') {
      try {
        // Approve into executing if still on task_review.
        if (this.driver.phase() === 'task_review') await this.driver.approve();
      } catch {
        /* phase already advanced */
      }
    }
    await this.driver.builder.saveSession();
    this.broadcast({ type: 'sdd.run.started', payload: { runId } });
    this.broadcast(this.snapshotMsg());
  }

  private async onRunFromGraph(graphId: string, opts: SddRunStartOpts): Promise<void> {
    if (!graphId) {
      this.broadcast({ type: 'sdd.spec.error', payload: { message: 'graphId is required.' } });
      return;
    }
    if (!this.deps.startRunFromGraphId) {
      this.broadcast({
        type: 'sdd.spec.error',
        payload: { message: 'SDD run-from-graph is not available on this host.' },
      });
      return;
    }
    const { runId } = await this.deps.startRunFromGraphId(graphId, opts);
    this.broadcast({ type: 'sdd.run.started', payload: { runId, graphId } });
  }

  private async onRunFromSpec(specId: string, opts: SddRunStartOpts): Promise<void> {
    if (!specId) {
      this.broadcast({ type: 'sdd.spec.error', payload: { message: 'specId is required.' } });
      return;
    }
    if (!this.deps.resolveGraphIdForSpec || !this.deps.startRunFromGraphId) {
      this.broadcast({
        type: 'sdd.spec.error',
        payload: { message: 'SDD run-from-spec is not available on this host.' },
      });
      return;
    }
    const graphId = await this.deps.resolveGraphIdForSpec(specId);
    if (!graphId) {
      this.broadcast({
        type: 'sdd.spec.error',
        payload: { message: 'No task graph found for this specification.' },
      });
      return;
    }
    const { runId } = await this.deps.startRunFromGraphId(graphId, opts);
    this.broadcast({ type: 'sdd.run.started', payload: { runId, graphId, specId } });
  }

  // ── internals ───────────────────────────────────────────────────────────

  /** Run one interview turn against the isolated agent, then ingest + broadcast. */
  private async runTurn(prompt: string): Promise<void> {
    this.busy = true;
    this.broadcast(this.snapshotMsg());
    try {
      const text = await this.deps.runInterviewTurn(prompt);
      if (this.disposed) return;
      this.lastAgentText = text;
      if (this.driver) {
        await this.driver.ingestAgentOutput(text);
        await this.driver.setLastAgentText(text);
      }
      this.broadcast({ type: 'sdd.spec.agent_text', payload: { text } });
    } finally {
      this.busy = false;
      this.broadcast(this.snapshotMsg());
    }
  }

  private snapshotMsg(): { type: string; payload: SddInterviewSnapshot & { busy: boolean } } {
    const snap = this.driver?.snapshot();
    return {
      type: 'sdd.spec.snapshot',
      payload: { ...(snap as SddInterviewSnapshot), busy: this.busy },
    };
  }

  private broadcast(msg: { type: string; payload: unknown }): void {
    const data = JSON.stringify(msg);
    for (const client of this.clients) {
      sendSerialized(client.ws, data);
    }
  }

  private send(client: WSClient, msg: { type: string; payload: unknown }): void {
    if (!this.clients.has(client)) return;
    sendSerialized(client.ws, JSON.stringify(msg));
  }
}
