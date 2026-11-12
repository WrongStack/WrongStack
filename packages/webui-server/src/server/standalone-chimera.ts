import {
  createAutoReviewPlugin,
  createChimeraFollowupExtension,
  createChimeraPlugin,
} from '@wrongstack/builtin-plugins';
import { type Container, EventBus, TOKENS } from '@wrongstack/contracts/kernel';
import type { EventName, Listener } from '@wrongstack/contracts/kernel/events';
import type { Config, Logger, ModelsRegistry, SessionWriter } from '@wrongstack/contracts/types';
import {
  type Director,
  getSharedProjectMailbox,
  type RemoteMailbox,
} from '@wrongstack/coordination';
import type { Agent, AgentPipelines } from '@wrongstack/core/agent';
import {
  DefaultPluginAPI,
  loadPlugins,
  type PluginHostHandle,
  resolvePluginEnablement,
} from '@wrongstack/core/plugin';
import type { ProviderRegistry, ToolRegistry } from '@wrongstack/core/registry';
import {
  createChimeraWorkRegistry,
  installChimeraReviewHandler,
} from '@wrongstack/runtime/chimera';

/** Join the plugins' async event listeners before disposing their session owner. */
class ReviewEventBus extends EventBus {
  readonly work = createChimeraWorkRegistry();
  override on<E extends EventName>(event: E, fn: Listener<E>): () => void {
    return super.on(event, (payload) => {
      const result: unknown = fn(payload);
      if (result && typeof (result as PromiseLike<unknown>).then === 'function') {
        this.work.track(Promise.resolve(result).then(() => undefined));
      }
    });
  }
  async join(): Promise<void> {
    while (this.work.size) await this.work.pending();
  }
}

type ReviewDirector = Pick<Director, 'spawn' | 'assign' | 'awaitTasks' | 'terminate'>;
interface Owner {
  bus: ReviewEventBus;
  reviews: ReturnType<typeof createChimeraWorkRegistry>;
  ready: Promise<void>;
  session: SessionWriter;
  config?: Config | undefined;
  host?: PluginHostHandle | undefined;
  mailbox?: RemoteMailbox | undefined;
  teardown: Array<() => void>;
  ran: boolean;
  closing?: Promise<void> | undefined;
}

/** Canonical producers + executor, isolated by leader session, never by worker run. */
export function createStandaloneChimera(options: {
  container: Container;
  events: EventBus;
  pipelines: AgentPipelines;
  toolRegistry: ToolRegistry;
  providerRegistry: ProviderRegistry;
  modelsRegistry: ModelsRegistry;
  getConfig: () => Config;
  projectDir: string;
  getProjectDir?: ((agent: Agent) => string) | undefined;
  cwd: string;
  logger: Logger;
  ensureDirector: () => Promise<Director | null>;
}) {
  const owners = new Map<string, Owner>();
  const contexts = new WeakSet<Agent['ctx']>();
  const agents = new Set<WeakRef<Agent>>();
  const detach: Array<() => void> = [];
  let disposed: Promise<void> | undefined;

  const ensureOwner = (agent: Agent): Owner => {
    const session = agent.ctx.activeRunSessionWriter ?? agent.ctx.session;
    const id = agent.ctx.activeRunSessionId ?? session.id;
    const existing = owners.get(id);
    if (existing) return existing;
    const bus = new ReviewEventBus();
    const owner: Owner = {
      bus,
      reviews: createChimeraWorkRegistry(),
      session,
      ready: Promise.resolve(),
      teardown: [],
      ran: false,
    };
    owners.set(id, owner);
    owner.ready = (async () => {
      const config = { ...options.getConfig(), cwd: agent.ctx.cwd ?? options.cwd };
      owner.config = config;
      const projectDir = options.getProjectDir?.(agent) ?? options.projectDir;
      const plugins = [createChimeraPlugin(), createAutoReviewPlugin()].filter(
        (plugin) =>
          resolvePluginEnablement({
            name: plugin.name,
            aliases: plugin.configAliases,
            defaultState: 'active',
            config,
          }).enabled,
      );
      if (!plugins.length) return;
      // Reuse the existing fleet lazily; every reviewer belongs to its originating tab.
      const director = async () => {
        const value = await options.ensureDirector();
        if (!value) throw new Error('Chimera reviewer fleet is unavailable');
        return value;
      };
      const reviewDirector: ReviewDirector = {
        spawn: async (config, price) =>
          (await director()).spawn({ ...config, originSessionId: id }, price),
        assign: async (task) => (await director()).assign(task),
        awaitTasks: async (ids) => (await director()).awaitTasks(ids),
        terminate: async (id) => (await director()).terminate(id),
      };
      const mailbox = getSharedProjectMailbox(projectDir, bus);
      owner.mailbox = mailbox;
      const statusTracker = options.container.safeResolve(TOKENS.ProviderModelStatusTracker);
      const configStore = options.container.safeResolve(TOKENS.ConfigStore);
      installChimeraReviewHandler({
        events: bus,
        director: reviewDirector,
        session,
        mailbox,
        agent: { ctx: { activeRunSessionId: id, session } },
        config,
        projectDir,
        ...(statusTracker ? { statusTracker } : {}),
        trackWork: (work) => {
          owner.reviews.track(work);
        },
        teardownHandlers: owner.teardown,
      });
      // Only passive report/diagnostic events leave this owner. No cascade executor
      // or leader auto-wake is installed, including when a report has findings.
      owner.teardown.push(
        bus.onPattern(
          'chimera.*',
          (event, payload) => {
            if (event !== 'chimera.review_needed' && event !== 'chimera.cascade_needed') {
              options.events.emitCustom(event, payload);
            }
          },
          'standalone-chimera-forward',
        ),
      );
      owner.host = await loadPlugins(plugins, {
        log: options.logger,
        apiFactory: (plugin) =>
          new DefaultPluginAPI({
            ownerName: plugin.name,
            container: options.container,
            events: bus,
            // DefaultPluginAPI converts concrete pipelines via asReadonly(), as
            // in the CLI host; PluginAPIInit currently types the resulting view.
            pipelines: options.pipelines as unknown as ConstructorParameters<
              typeof DefaultPluginAPI
            >[0]['pipelines'],
            toolRegistry: options.toolRegistry,
            providerRegistry: options.providerRegistry,
            modelsRegistry: options.modelsRegistry,
            config,
            ...(configStore ? { configStore } : {}),
            log: options.logger,
            mailbox,
            sessionWriter: {
              transcriptPath: session.transcriptPath,
              append: (event) =>
                session.append(event as unknown as Parameters<SessionWriter['append']>[0]),
            },
          }),
      });
    })();
    return owner;
  };

  const finish = (id: string): Promise<void> => {
    const owner = owners.get(id);
    if (!owner) return Promise.resolve();
    owner.closing ??= (async () => {
      try {
        await owner.ready;
        if (owner.ran) {
          const work: Promise<void>[] = [];
          owner.bus.emit('session.ended', {
            id,
            sessionId: id,
            usage: { input: 0, output: 0 },
            waitUntil: (promise) => {
              work.push(promise);
            },
          });
          await Promise.allSettled(work);
        }
        await owner.bus.work.drainAndClose();
        await owner.reviews.drainAndClose();
      } finally {
        await owner.host?.dispose();
        await owner.mailbox?.close();
        for (const off of owner.teardown.splice(0)) off();
        owners.delete(id);
      }
    })();
    return owner.closing;
  };

  detach.push(
    options.events.on('iteration.completed', (payload) => {
      if (!contexts.has(payload.ctx)) return; // Worker/reviewer iterations cannot start another review.
      const id = payload.ctx.activeRunSessionId ?? payload.ctx.session.id;
      const owner = owners.get(id);
      if (owner && !owner.closing) owner.bus.emit('iteration.completed', payload);
    }),
  );
  detach.push(
    options.events.on('session.ended', (event) => {
      const work = finish(event.sessionId ?? event.id);
      event.waitUntil?.(work);
      void work.catch((error: unknown) =>
        options.logger.warn('Chimera session drain failed', { error: String(error) }),
      );
    }),
  );

  const attach = (agent: Agent): void => {
    if (contexts.has(agent.ctx) || disposed) return;
    contexts.add(agent.ctx);
    for (const ref of agents) if (!ref.deref()) agents.delete(ref);
    agents.add(new WeakRef(agent));
    const followupExt = createChimeraFollowupExtension({
      getCwd: (ctx) => ctx.projectRoot || ctx.cwd || agent.ctx.cwd || options.cwd,
      getProjectDir: () => options.getProjectDir?.(agent) ?? options.projectDir,
      events: options.events,
    });
    agent.extensions.register({
      name: 'standalone-chimera-owner',
      beforeRun: async (ctx, input) => {
        if (disposed) return;
        const owner = ensureOwner(agent);
        await owner.ready;
        if (owner.closing) return;
        if (owner.config) {
          Object.assign(owner.config, options.getConfig(), {
            cwd: agent.ctx.cwd ?? options.cwd,
          });
        }
        owner.ran = true;
        // Await baseline collection before tools/provider can change files. The
        // process EventBus is observe-only and does not join async listeners.
        owner.bus.emit('agent.run.started', {
          sessionId: owner.session.id,
          ctx: agent.ctx,
          model: agent.ctx.model,
          at: new Date().toISOString(),
          ...(input.text ? { inputText: input.text } : {}),
        });
        await owner.bus.join();
        await followupExt.beforeRun?.(ctx, input);
      },
      beforeIteration: followupExt.beforeIteration,
      afterToolExecution: followupExt.afterToolExecution,
      beforeTurnEnd: followupExt.beforeTurnEnd,
      afterRun: followupExt.afterRun,
    });
  };

  return {
    attach,
    finish,
    // Eviction ends this producer owner's lifetime, not the transcript's.
    release: finish,
    dispose(): Promise<void> {
      disposed ??= (async () => {
        for (const off of detach.splice(0)) off();
        await Promise.all([...owners.keys()].map((id) => finish(id)));
        for (const ref of agents) ref.deref()?.extensions.unregister('standalone-chimera-owner');
        agents.clear();
      })();
      return disposed;
    },
  };
}
