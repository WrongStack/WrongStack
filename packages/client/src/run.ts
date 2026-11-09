import type {
  CoreServerMessage,
  WSRunResult,
  WSToolConfirmResult,
} from '@wrongstack/webui-protocol';
import { WrongStackError } from './errors.js';

/** The frames a run streams, exactly as the protocol defines them. */
export type RunEvent = Extract<
  CoreServerMessage,
  {
    type:
      | 'provider.text_delta'
      | 'provider.thinking_delta'
      | 'tool.started'
      | 'tool.progress'
      | 'tool.executed'
      | 'tool.confirm_needed'
      | 'tool.confirm_resolved'
      | 'iteration.started'
      | 'iteration.completed'
      | 'provider.retry'
      | 'provider.error';
  }
>;

export const RUN_EVENT_TYPES: ReadonlySet<string> = new Set<RunEvent['type']>([
  'provider.text_delta',
  'provider.thinking_delta',
  'tool.started',
  'tool.progress',
  'tool.executed',
  'tool.confirm_needed',
  'tool.confirm_resolved',
  'iteration.started',
  'iteration.completed',
  'provider.retry',
  'provider.error',
]);

export type ConfirmDecision = WSToolConfirmResult['payload']['decision'];

/** How a run ended, as the server reported it. */
export interface RunResult {
  /** The prompt's id; the server echoes it as `run.result.requestId`. */
  requestId: string;
  sessionId: string;
  status: WSRunResult['payload']['status'];
  iterations: number;
  /** The final answer; the streamed text when the server sent none. */
  text: string;
  /** Set when `status` is not `done`. */
  error?: WrongStackError | undefined;
}

interface RunHooks {
  abort(sessionId: string): void;
  confirm(id: string, decision: ConfirmDecision): void;
}

/**
 * One prompt and everything the server streamed for it. Iterate it for the
 * events, await `result` for how it ended, or `text()` for the answer.
 */
export class Run implements AsyncIterable<RunEvent> {
  /** Settles when the server reports the run's end; rejects only when no report can come. */
  readonly result: Promise<RunResult>;
  private streamed = '';
  private readonly queue: RunEvent[] = [];
  private readonly waiters: Array<(next: IteratorResult<RunEvent>) => void> = [];
  private readonly listeners = new Set<(event: RunEvent) => void>();
  private settled = false;
  private resolveResult!: (result: RunResult) => void;
  private rejectResult!: (error: WrongStackError) => void;

  constructor(
    readonly id: string,
    readonly sessionId: string,
    private readonly hooks: RunHooks,
  ) {
    this.result = new Promise<RunResult>((resolve, reject) => {
      this.resolveResult = resolve;
      this.rejectResult = reject;
    });
    // A caller that only iterates must not see an unhandled rejection.
    this.result.catch(() => undefined);
  }

  get done(): boolean {
    return this.settled;
  }

  /** The final answer; throws the run's error when it did not finish. */
  async text(): Promise<string> {
    const result = await this.result;
    if (result.error) throw result.error;
    return result.text;
  }

  /** Called for every event; returns an unsubscribe. */
  onEvent(listener: (event: RunEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  abort(): void {
    if (!this.settled) this.hooks.abort(this.sessionId);
  }

  /** Answer a `tool.confirm_needed` this run raised. */
  confirm(id: string, decision: ConfirmDecision): void {
    if (!this.settled) this.hooks.confirm(id, decision);
  }

  [Symbol.asyncIterator](): AsyncIterator<RunEvent> {
    let returned = false;
    const pending = new Set<(next: IteratorResult<RunEvent>) => void>();
    return {
      next: () => {
        if (returned) return Promise.resolve({ value: undefined, done: true });
        const event = this.queue.shift();
        if (event) return Promise.resolve({ value: event, done: false });
        if (this.settled) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => {
          const waiter = (next: IteratorResult<RunEvent>) => {
            pending.delete(waiter);
            resolve(next);
          };
          pending.add(waiter);
          this.waiters.push(waiter);
        });
      },
      return: () => {
        returned = true;
        for (const waiter of [...pending]) {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          waiter({ value: undefined, done: true });
        }
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }

  /** @internal */
  push(event: RunEvent): void {
    if (this.settled) return;
    if (event.type === 'provider.text_delta' && typeof event.payload?.text === 'string') {
      this.streamed += event.payload.text;
    }
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: event, done: false });
    else this.queue.push(event);
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A throwing listener must not stop the stream for the others.
      }
    }
  }

  /** @internal */
  finish(payload: WSRunResult['payload']): void {
    if (this.settled) return;
    const error =
      payload.status === 'done'
        ? undefined
        : new WrongStackError({
            kind: payload.status === 'aborted' ? 'aborted' : 'run',
            code: payload.error?.code ?? payload.status,
            ...(payload.error?.message ? { detail: payload.error.message } : {}),
            ...(payload.error ? { retryable: payload.error.recoverable } : {}),
          });
    this.settle();
    this.resolveResult({
      requestId: this.id,
      sessionId: this.sessionId,
      status: payload.status,
      iterations: payload.iterations,
      text: payload.finalText ?? this.streamed,
      ...(error ? { error } : {}),
    });
  }

  /** @internal */
  fail(error: WrongStackError): void {
    if (this.settled) return;
    this.settle();
    this.rejectResult(error);
  }

  private settle(): void {
    this.settled = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
  }
}
