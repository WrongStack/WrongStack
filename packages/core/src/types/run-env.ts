/**
 * RunEnv — the read-only environment view of the agent run.
 *
 * Dependency-leaf module (Roadmap 10A): imports ONLY from sibling `types/*`
 * modules, never from `core/`. The concrete `Context` class satisfies this
 * interface structurally; `extractRunEnv()` (in `core/run-env.ts`) builds a
 * frozen view for subsystems that want to declare "env-only" access.
 *
 * Consumers that only need these fields should type their parameters as
 * `RunEnv` — not `Context` — so the type module graph stays acyclic.
 */
import type { Provider } from './provider.js';
import type { SessionWriter } from './session.js';
import type { TextBlock } from './blocks.js';
import type { TokenCounter } from './token-counter.js';
import type { Tool } from './tool.js';

export interface RunEnv {
  readonly provider: Provider;
  readonly session: SessionWriter;
  readonly signal: AbortSignal;
  readonly tokenCounter: TokenCounter;
  readonly cwd: string;
  readonly projectRoot: string;
  /** Mutable working directory — starts as `cwd`. */
  readonly workingDir: string;
  readonly model: string;
  readonly systemPrompt: readonly TextBlock[];
  readonly tools: readonly Tool[];
  readonly agentId: string;
  readonly agentName: string;
}
