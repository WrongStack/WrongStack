import type {
  Config,
  ModelsRegistry,
  SecretVault,
  SessionStore,
  SkillLoader,
  ToolRegistry,
  WstackPaths,
} from '@wrongstack/core';
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
  /**
   * Parsed top-level CLI flags (e.g. `--yolo`, `--tools`). The dispatcher
   * strips flags from the positional args, so handlers that need them (e.g.
   * `mcp serve --yolo`) read them here.
   */
  flags?: Record<string, string | boolean>;
}

import { acpCmd } from './handlers/acp.js';
import { auditCmd } from './handlers/audit.js';
import { authCmd } from './handlers/auth.js';
import { benchCmd } from './handlers/bench.js';
import { diagCmd, doctorCmd } from './handlers/diag-doctor.js';
import { exportCmd } from './handlers/export.js';
import { hqCmd } from './handlers/hq.js';
import { initCmd } from './handlers/init.js';
import { mailboxServeCmd } from './handlers/mailbox-serve.js';
import { mcpCmd } from './handlers/mcp.js';
import { modeldiagCmd } from './handlers/modeldiag.js';
import { pluginCmd, usageCmd } from './handlers/plugin-usage.js';
import { projectsCmd } from './handlers/projects.js';
import { modelsCmd, providersCmd } from './handlers/providers-models.js';
import { quickCmd } from './handlers/quick.js';
import { replayCmd } from './handlers/replay.js';
import { rewindCmd } from './handlers/rewind.js';
import { configCmd, sessionsCmd } from './handlers/sessions-config.js';
import { skillsCmd, toolsCmd } from './handlers/tools-skills.js';
import { updateCmd } from './handlers/update.js';
import { helpCmd, versionCmd } from './handlers/version-help.js';

export const subcommands: Record<string, SubcommandHandler> = {
  acp: acpCmd,
  init: initCmd,
  auth: authCmd,
  update: updateCmd,
  sessions: sessionsCmd,
  config: configCmd,
  rewind: rewindCmd,
  replay: replayCmd,
  audit: auditCmd,
  tools: toolsCmd,
  skills: skillsCmd,
  providers: providersCmd,
  models: modelsCmd,
  mcp: mcpCmd,
  plugin: pluginCmd,
  plugins: pluginCmd,
  diag: diagCmd,
  doctor: doctorCmd,
  export: exportCmd,
  usage: usageCmd,
  version: versionCmd,
  help: helpCmd,
  projects: projectsCmd,
  modeldiag: modeldiagCmd,
  quick: quickCmd,
  bench: benchCmd,
  hq: hqCmd,
  mailbox: mailboxServeCmd,
};
