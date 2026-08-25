import type { ToolRegistry } from '@wrongstack/core/registry';
import type {
  Config,
  ModelsRegistry,
  SecretVault,
  SessionStore,
  SkillLoader,
} from '@wrongstack/core/types';
import type { WstackPaths } from '@wrongstack/core/utils';
import type { ReadlineInputReader } from '../input-reader.js';
import type { TerminalRenderer } from '../renderer.js';

export type SubcommandHandler = (args: string[], deps: SubcommandDeps) => Promise<number>;

export interface SubcommandDeps {
  config: Config;
  renderer: TerminalRenderer;
  reader: ReadlineInputReader;
  sessionStore?: SessionStore | undefined;
  skillLoader?: SkillLoader | undefined;
  toolRegistry?: ToolRegistry | undefined;
  modelsRegistry: ModelsRegistry;
  paths: WstackPaths;
  vault: SecretVault;
  cwd: string;
  projectRoot: string;
  userHome: string;
  /** Parsed top-level flags after they have been removed from positional args. */
  flags?: Record<string, string | boolean>;
  /**
   * Live EventBus when a subcommand is invoked from a host that holds one
   * (e.g. an in-process diagnostics surface). Standalone `wstack doctor`
   * runs in a fresh process and has none — the handler then omits the
   * listener-pressure line instead of fabricating counts.
   */
  events?: import('@wrongstack/core/kernel').EventBus | undefined;
}
