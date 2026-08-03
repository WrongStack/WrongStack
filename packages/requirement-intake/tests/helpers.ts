/**
 * Test harness for the requirement-intake package.
 */
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach } from 'vitest';
import { AllowAllIntakeAuthorizer, type IntakeAuthorizer } from '../src/authorization.js';
import { IntakeEventEmitter } from '../src/events.js';
import { InMemoryIntakeLogger } from '../src/logger.js';
import { InMemoryIntakeMetrics } from '../src/metrics.js';
import { RequirementIntakeService } from '../src/service.js';
import type { LlmSuggestionGenerator, LlmSuggestionOutput } from '../src/suggestions.js';
import { RequirementIntakeStore } from '../src/store.js';
import type { IntakeContext, IntakeEvent } from '../src/types.js';

export interface Harness {
  dir: string;
  store: RequirementIntakeStore;
  service: RequirementIntakeService;
  logger: InMemoryIntakeLogger;
  metrics: InMemoryIntakeMetrics;
  events: IntakeEvent[];
  cleanup(): Promise<void>;
}

export interface HarnessOptions {
  authorizer?: IntakeAuthorizer | undefined;
  generator?: LlmSuggestionGenerator | undefined;
}

/** Active project context for Alice (owner of project alpha). */
export const ALICE: IntakeContext = { id: 'user-alice', type: 'user', projectId: 'proj_alpha' };
/** Second user with access to the same project. */
export const BOB: IntakeContext = { id: 'user-bob', type: 'user', projectId: 'proj_alpha' };
/** User of a different project — used for cross-project access tests. */
export const CAROL: IntakeContext = { id: 'user-carol', type: 'user', projectId: 'proj_beta' };
/** Automation identity — must only receive minimum permissions. */
export const BOT: IntakeContext = { id: 'agent-bot', type: 'automation', projectId: 'proj_alpha' };

const registeredDirs: string[] = [];

afterEach(async () => {
  const dirs = registeredDirs.splice(0);
  await Promise.all(
    dirs.map((dir) => fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined)),
  );
});

export function makeHarness(options: HarnessOptions = {}): Harness {
  const dir = path.join(
    os.tmpdir(),
    `intake-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  registeredDirs.push(dir);
  const store = new RequirementIntakeStore({ baseDir: dir });
  const emitter = new IntakeEventEmitter();
  const logger = new InMemoryIntakeLogger();
  const metrics = new InMemoryIntakeMetrics();
  const service = new RequirementIntakeService({
    store,
    authorizer: options.authorizer ?? new AllowAllIntakeAuthorizer(),
    generator: options.generator,
    emitter,
    logger,
    metrics,
  });
  const events: IntakeEvent[] = [];
  const dispose = service.subscribe((event) => events.push(event));
  return {
    dir,
    store,
    service,
    logger,
    metrics,
    events,
    async cleanup() {
      dispose();
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

/** A stub LLM generator that returns a fixed output. */
export function stubGenerator(output: LlmSuggestionOutput | Error): LlmSuggestionGenerator {
  return {
    async generate() {
      if (output instanceof Error) throw output;
      return output;
    },
  };
}
