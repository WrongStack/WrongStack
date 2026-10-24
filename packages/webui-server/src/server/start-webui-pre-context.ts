import * as path from 'node:path';
import type { Config } from '@wrongstack/contracts/types';
import type { VectorMemoryStore } from '@wrongstack/vector-memory';
import { createPreContextServices } from './pre-context-services.js';
import { touchProjectEntry } from './start-webui-project.js';
import { createStandaloneTodosCheckpointLifecycle } from './start-webui-todos.js';
import { initVectorMemoryStore, setupVectorMemoryMirror } from './start-webui-vector.js';

type PreContextInput = Parameters<typeof createPreContextServices>[0];
type PreContext = Awaited<ReturnType<typeof createPreContextServices>>;

export interface WebuiPreContextPhase {
  preContext: PreContext;
  vectorMemoryStore: VectorMemoryStore | undefined;
  vectorMemoryModelCacheDir: string;
  /** SAGE store, wrapped by the vector mirror when the vector store is up. */
  memoryStore: PreContext['memoryStore'];
  disposeVectorMirror: (() => void) | undefined;
  todosCheckpoint: ReturnType<typeof createStandaloneTodosCheckpointLifecycle>;
}

/**
 * Pre-context phase of `startWebUI`: the optional vector-memory store, the
 * pre-context services (registries, stores, session, system prompt, provider,
 * context), the todos checkpoint lifecycle, and the SAGE→vector mirror.
 */
export async function createWebuiPreContextPhase(input: {
  config: Config;
  wpaths: PreContextInput['wpaths'];
  logger: PreContextInput['logger'];
  opts: PreContextInput['opts'];
  vault: PreContextInput['vault'];
  globalConfigPath: string;
  projectRoot: string;
  workingDir: string;
  needsProvider: boolean;
}): Promise<WebuiPreContextPhase> {
  const {
    config,
    wpaths,
    logger,
    opts,
    vault,
    globalConfigPath,
    projectRoot,
    workingDir,
    needsProvider,
  } = input;
  // Vector memory is an optional sibling to SAGE — embed locally via
  // @huggingface/transformers, persist to its own SQLite file. Mirrors the
  // production path in packages/cli/src/cli-main.ts so the standalone WebUI
  // host exposes the same surface as `wstack --webui`. The model cache lives
  // under `.wrongstack/cache/transformers-models` (outside the store's data
  // directory) so a future store-side cleanup never sweeps cached model
  // files. Constructor failures (read-only filesystem, unwritable project
  // root, corrupt SQLite parent) fall back to `undefined` so the standalone
  // WebUI still boots on the SAGE-only surface — the routes then report
  // `enabled: false` instead of failing to start.
  let vectorMemoryStore: VectorMemoryStore | undefined;
  /** Set once the live SAGE→vector mirror is subscribed; run at shutdown. */
  let disposeVectorMirror: (() => void) | undefined;
  const vectorMemoryModelCacheDir = path.join(
    projectRoot,
    '.wrongstack',
    'cache',
    'transformers-models',
  );
  vectorMemoryStore = initVectorMemoryStore({
    projectRoot,
    config: config as unknown as Record<string, unknown>,
    logger,
    vectorMemoryModelCacheDir,
  });

  // ── Pre-context services (registries, stores, session, system prompt,
  // provider, context) — built in ./pre-context-services.ts (Phase 1f).
  // The factory returns all services + the initial values of the mutable
  // bindings the route layer swaps at runtime (session, sessionStore,
  // sessionStartedAt, modeId). Those stay as `let` in `startWebUI` so state setters
  // can update them.
  const preContext = await createPreContextServices({
    config,
    wpaths,
    logger,
    opts,
    vault,
    globalConfigPath,
    projectRoot,
    workingDir,
    needsProvider,
    vectorMemoryStore,
    touchProject: (root, wd) => touchProjectEntry(globalConfigPath, root, wd),
  });
  // Reassigned below when the vector store comes up — see the vector-recall
  // wiring after the first-boot sync.
  let memoryStore = preContext.memoryStore;
  const { context, events } = preContext;
  const session = preContext.session;
  const todosCheckpoint = createStandaloneTodosCheckpointLifecycle({
    state: context.state,
    sessionsDir: wpaths.projectSessions,
    sessionId: session.id,
    events,
    traceId: context.traceId,
    warn: (message) => logger.warn(message),
  });

  // First boot per project: mirror the active SAGE corpus into the vector
  // store so semantic search starts warm instead of empty. Fire-and-forget
  // — the first run pays the ONNX model download, and boot must not block
  // on it. Skips instantly once the sage-sync marker says complete.
  // Mirrors the CLI host (cli-main.ts:133-139) so both surfaces expose
  // the same warm-start semantics. Safe to skip when the store
  // constructor failed (read-only FS, etc.) — the SAGE-only fallback
  // already covers that path.
  if (vectorMemoryStore) {
    const mirror = setupVectorMemoryMirror({
      vectorMemoryStore,
      baseMemoryStore: memoryStore,
      config: config as unknown as Record<string, unknown>,
      logger,
    });
    memoryStore = mirror.memoryStore;
    disposeVectorMirror = mirror.disposeVectorMirror;
  }

  return {
    preContext,
    vectorMemoryStore,
    vectorMemoryModelCacheDir,
    memoryStore,
    disposeVectorMirror,
    todosCheckpoint,
  };
}
