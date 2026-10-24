import { TOKENS } from '@wrongstack/contracts/kernel';
import type { Config, SecretVault } from '@wrongstack/contracts/types';
import { normalizeTokenSavingTier } from '@wrongstack/contracts/types';
import type { DefaultLogger } from '@wrongstack/core/infrastructure';
import type { DefaultModelsRegistry } from '@wrongstack/core/models';
import { ToolRegistry } from '@wrongstack/core/registry';
import type { WstackPaths } from '@wrongstack/core/utils';
import { createDefaultContainer } from '@wrongstack/runtime';
import { registerBuiltinToolTier } from '@wrongstack/tools/tool-tier';
import { resolveBundledPromptsDir, resolveBundledSkillsDir } from './boot-provider-selection.js';
import type { ReadlineInputReader } from './input-reader.js';
import type { TerminalRenderer } from './renderer.js';
import { renderDeepHelp, renderFocusedHelp } from './subcommands/handlers/per-subcommand-help.js';
import { subcommands } from './subcommands/index.js';

export interface BootSubcommandInput {
  first: string | undefined;
  positional: string[];
  flags: Record<string, string | boolean>;
  config: Config;
  vault: SecretVault;
  wpaths: WstackPaths;
  cwd: string;
  projectRoot: string;
  userHome: string;
  renderer: TerminalRenderer;
  reader: ReadlineInputReader;
  logger: DefaultLogger;
  modelsRegistry: DefaultModelsRegistry;
}

/** Run the matching subcommand and return its exit code; undefined when none matches. */
export async function dispatchBootSubcommand(
  input: BootSubcommandInput,
): Promise<number | undefined> {
  const {
    first,
    positional,
    flags,
    config,
    vault,
    wpaths,
    cwd,
    projectRoot,
    userHome,
    renderer,
    reader,
    logger,
    modelsRegistry,
  } = input;
  const subcommandHandler = first ? subcommands[first] : undefined;
  if (first && subcommandHandler) {
    if (flags['help'] === true || flags['h'] === true) {
      const deepSub = positional[1];
      if (deepSub && renderDeepHelp(`${first}:${deepSub}`, renderer)) {
        await reader.close();
        return 0;
      }
      if (renderFocusedHelp(first, renderer)) {
        await reader.close();
        return 0;
      }
    }

    // Create container to get the SAME skillLoader instance that the main
    // interactive CLI uses. This ensures cache invalidation after
    // /skill-install propagates correctly to /skill and other commands.
    const container = createDefaultContainer({
      config,
      wpaths,
      logger,
      modelsRegistry,
      bundledSkillsDir: config.features.skills ? resolveBundledSkillsDir() : undefined,
      bundledPromptsDir: config.features.prompts === false ? undefined : resolveBundledPromptsDir(),
    });
    const sessionStore = container.resolve(TOKENS.SessionStore);
    const skillLoader = container.resolve(TOKENS.SkillLoader);
    const toolRegistryForSubcmd = new ToolRegistry();
    registerBuiltinToolTier({
      registry: toolRegistryForSubcmd,
      tier: normalizeTokenSavingTier(config.features.tokenSavingMode),
    });
    const code = await subcommandHandler(positional.slice(1), {
      config,
      renderer,
      reader,
      sessionStore,
      skillLoader,
      toolRegistry: toolRegistryForSubcmd,
      modelsRegistry,
      paths: wpaths,
      vault,
      cwd,
      projectRoot,
      userHome,
      flags,
    });
    await reader.close();
    return code;
  }
  return undefined;
}
