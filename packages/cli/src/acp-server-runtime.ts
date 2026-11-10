/**
 * The real-agent half of `wstack acp`, built lazily so the server can start
 * before a model provider is configured.
 *
 * An editor that installs WrongStack from the ACP registry launches it on a
 * machine where `wstack auth` has never run. The server used to exit 1 before
 * answering `initialize`, so the editor saw a dead process instead of a login
 * prompt. Now the server always starts; `authGate` answers `auth_required`
 * until a provider is configured, and re-reads the saved configuration each
 * time it is asked, so a login done from the editor's terminal-auth flow (or
 * any terminal) takes effect without restarting the agent.
 */

import * as path from 'node:path';
import type {
  AuthGateResult,
  McpServer,
  RunTurnApi,
  SessionConfigOption,
} from '@wrongstack/acp/agent';
import type { Config } from '@wrongstack/contracts/types';
import type { Agent } from '@wrongstack/core/agent';
import { flagsToConfigPatch } from '@wrongstack/core/boot';
import { DefaultLogger } from '@wrongstack/core/infrastructure';
import { DefaultConfigLoader } from '@wrongstack/core/storage';
import { toErrorMessage } from '@wrongstack/core/utils';
import { type AcpHqTelemetry, startAcpHqTelemetry } from './acp-hq-telemetry.js';
import { buildAcpModelOption, selectedAcpModel } from './acp-model-option.js';
import {
  type AcpServerAgentFactory,
  AcpServerConfigError,
  buildAcpServerAgentFactory,
} from './acp-server-agent.js';
import { type AcpServerCommands, createAcpServerCommands } from './acp-server-commands.js';
import type { SubcommandDeps } from './subcommands/contracts.js';

/** Shown to the user while no provider is configured. */
export const ACP_LOGIN_HINT =
  'No model provider is configured. Run `wstack auth` (or `wstack acp auth`) in a terminal, then retry.';

export interface AcpServerRuntime {
  /** Per-session agent factory; waits on `authGate` while unconfigured. */
  readonly agentFor: AcpServerAgentFactory;
  /** Credential check for `ProtocolHandlerOptions.authGate`. */
  authGate(): Promise<AuthGateResult>;
  /**
   * Wrap the turn adapter's per-session teardown: detach HQ telemetry, drop
   * the Agent, then stop the MCP servers the client supplied for the session.
   */
  composeDispose(disposeTurn: (sessionId: string) => void): (sessionId: string) => void;
  /**
   * The model picker for a new session (`ProtocolHandlerOptions.sessionConfigOptions`):
   * empty until a provider is configured.
   */
  sessionConfigOptions(): Promise<SessionConfigOption[]>;
  /**
   * Put a session's agent on the model its picker selects
   * (`ACPServerAgentTurnOptions.applyConfigOptions`).
   */
  applyConfigOptions(agent: Agent, configOptions: readonly SessionConfigOption[]): Promise<void>;
  /**
   * The slash commands every session offers (`ProtocolHandlerOptions.sessionCommands`):
   * WrongStack's portable and plugin commands this host can run.
   */
  sessionCommands(sessionId: string): ReturnType<AcpServerCommands['list']>;
  /** Run the command a prompt names (`ACPServerAgentTurnOptions.runCommand`). */
  runCommand: AcpServerCommands['run'];
  /** Whether a provider is configured and the real agent is built. */
  ready(): boolean;
  /** Provider/model the agent runs with, once ready. */
  describe(): string | undefined;
  /** Stop HQ telemetry (publishes `session.ended` for live sessions). */
  stop(): void;
}

export interface AcpServerRuntimeOptions {
  /** Re-read the saved configuration. Defaults to the CLI's config loader. */
  reloadConfig?: (() => Promise<Config>) | undefined;
  /** Test seam for the model picker; defaults to `buildAcpModelOption`. */
  buildModelOption?: typeof buildAcpModelOption | undefined;
}

interface Built {
  config: Config;
  raw: AcpServerAgentFactory;
  wrapped: AcpServerAgentFactory;
  telemetry: AcpHqTelemetry;
}

function isConfigured(config: Config): boolean {
  return Boolean(config.provider && config.model);
}

function defaultReload(deps: SubcommandDeps): () => Promise<Config> {
  const logger = new DefaultLogger({ stderr: true });
  return () =>
    // A fresh loader per call: the loader memoizes the files it read, and the
    // point of reloading is to see what `wstack auth` just wrote.
    new DefaultConfigLoader({ paths: deps.paths, vault: deps.vault, logger }).load({
      cliFlags: flagsToConfigPatch(deps.flags ?? {}),
      skipIdentityValidation: true,
    });
}

export function createAcpServerRuntime(
  deps: SubcommandDeps,
  options: AcpServerRuntimeOptions = {},
): AcpServerRuntime {
  const reloadConfig = options.reloadConfig ?? defaultReload(deps);
  const projectRoot = deps.cwd ?? process.cwd();
  let built: Built | undefined;
  let pending: Promise<AuthGateResult> | undefined;
  const commands = createAcpServerCommands({
    paths: deps.paths,
    vault: deps.vault,
    projectRoot,
  });

  const build = (config: Config): Built => {
    // Throws AcpServerConfigError only for a missing provider/model, which
    // the callers rule out first; anything else is a real boot failure.
    const raw = buildAcpServerAgentFactory({ ...deps, config });
    // An editor driving WrongStack over ACP runs real turns; HQ never saw any
    // of them. One publisher for the process, one session node per session.
    const telemetry = startAcpHqTelemetry({
      projectRoot,
      projectName: path.basename(projectRoot),
      appConfig: config,
    });
    return { config, raw, wrapped: telemetry.wrapAgentFactory(raw), telemetry };
  };

  if (isConfigured(deps.config)) built = build(deps.config);

  const check = async (): Promise<AuthGateResult> => {
    if (built) return { ok: true };
    let config: Config;
    try {
      config = await reloadConfig();
    } catch (err) {
      const reason = toErrorMessage(err);
      return {
        ok: false,
        message: `${ACP_LOGIN_HINT} (configuration could not be read: ${reason})`,
      };
    }
    if (!isConfigured(config)) return { ok: false, message: ACP_LOGIN_HINT };
    // Another caller may have finished building while the reload ran.
    built ??= build(config);
    return { ok: true };
  };

  const authGate = (): Promise<AuthGateResult> => {
    if (built) return Promise.resolve({ ok: true });
    // Concurrent session/new requests share one reload and one build.
    pending ??= check().finally(() => {
      pending = undefined;
    });
    return pending;
  };

  const agentFor = Object.assign(
    async (
      sessionId: string,
      cwd: string,
      api?: RunTurnApi,
      mcpServers?: readonly McpServer[],
    ): Promise<Agent> => {
      if (!built) {
        const gate = await authGate();
        if (!gate.ok) throw new AcpServerConfigError(gate.message);
      }
      return built!.wrapped(sessionId, cwd, api, mcpServers);
    },
    {
      disposeSession(sessionId: string): void {
        built?.raw.disposeSession(sessionId);
      },
      async selectModel(agent: Agent, providerId: string, modelId: string): Promise<void> {
        if (!built) throw new AcpServerConfigError(ACP_LOGIN_HINT);
        await built.raw.selectModel(agent, providerId, modelId);
      },
    },
  ) as AcpServerAgentFactory;

  return {
    agentFor,
    authGate,
    composeDispose: (disposeTurn) => (sessionId) => {
      try {
        if (built) built.telemetry.wrapDispose(disposeTurn)(sessionId);
        else disposeTurn(sessionId);
      } finally {
        commands.dispose(sessionId);
        built?.raw.disposeSession(sessionId);
      }
    },
    sessionCommands: () => commands.list(),
    runCommand: commands.run,
    sessionConfigOptions: async () => {
      if (!built) return [];
      const option = await (options.buildModelOption ?? buildAcpModelOption)({
        config: built.config,
        modelsRegistry: deps.modelsRegistry,
      });
      return option ? [option] : [];
    },
    applyConfigOptions: async (agent, configOptions) => {
      const selected = selectedAcpModel(configOptions);
      if (!selected) return;
      await agentFor.selectModel(agent, selected.providerId, selected.modelId);
    },
    ready: () => built !== undefined,
    describe: () => (built ? `${built.config.provider}/${built.config.model}` : undefined),
    stop: () => built?.telemetry.stop(),
  };
}
