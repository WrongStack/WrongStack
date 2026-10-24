/** Provider routes context + credential hot-reload for the CLI-embedded WebUI host. */

import type { ProviderConfig } from '@wrongstack/contracts/types';
import {
  createEmbeddedProviderOperations,
  type EmbeddedProviderContext,
} from '@wrongstack/webui-server';
import { acpLeaderPickable } from '../acp-leader/acp-leader-picker.js';
import type { CliWebUIOptions } from '../webui-server-options.js';
import { wrongForgeLeaderPickable } from '../wrongforge-leader/wrongforge-leader-picker.js';
import { startWebuiCredentialWatcher } from './credential-watcher.js';
import { createProviderConfigStore } from './provider-config.js';
import type { WebuiTransport } from './transport.js';

export function createEmbeddedProviderPlane(input: {
  opts: CliWebUIOptions;
  profileConfigPath: string;
  send: WebuiTransport['send'];
  broadcast: WebuiTransport['broadcast'];
}) {
  const { opts, profileConfigPath, send, broadcast } = input;
  const wsHandlerCtx: EmbeddedProviderContext = {
    providerStore: createProviderConfigStore(
      profileConfigPath,
      () => (opts.appConfig?.providers as Record<string, ProviderConfig> | undefined) ?? {},
    ),
    modelsRegistry: opts.modelsRegistry,
    providerAuthRegistry: opts.providerAuthRegistry,
    getDisabledModels: () => opts.appConfig?.disabledModels ?? [],
    getDisabledProviders: () => opts.appConfig?.disabledProviders ?? [],
    // `acp` with the installed ACP agents: an agent such as Claude Code can
    // lead a tab like a model (see docs/slash/acp.md).
    // `wrongforge` with the models the machine's WrongForge serves.
    hostProviders: () => [...acpLeaderPickable(opts.appConfig), ...wrongForgeLeaderPickable()],
    send,
    broadcast,
    log: (m) => console.log(m),
  };
  const embeddedProviderOperations = createEmbeddedProviderOperations(wsHandlerCtx);

  const credentialWatcherClose: (() => void) | undefined = startWebuiCredentialWatcher({
    opts,
    profileConfigPath,
    broadcast,
    broadcastSaved: (providers) =>
      embeddedProviderOperations.broadcastSaved(providers as Record<string, ProviderConfig>),
  });
  return { wsHandlerCtx, credentialWatcherClose };
}
