export type { SubcommandDeps } from './contracts.js';

/**
 * Subcommand handlers are loaded on invocation, not at boot.
 *
 * This module is reached from `boot.ts` on EVERY `wstack` invocation, so 27
 * static imports meant `wstack version` and `wstack mailbox serve` evaluated
 * the union of every handler — including `bench`, `hq`, `modeldiag`, `replay`
 * and `chronicle` — plus everything those handlers pull in. `@wrongstack/bench`
 * for example is imported by exactly one handler and nothing else in the CLI.
 *
 * The dispatch in `boot.ts` was already short-circuited correctly; the problem
 * was purely that the module graph had been resolved and evaluated before it
 * ever ran.
 *
 * Bundling note: the build runs with `splitting: false`, so esbuild inlines
 * these in-repo modules into one file. That still defers *evaluation* (esbuild
 * wraps each in a lazy `__esm` initializer), which is where the heap goes. But
 * a WORKSPACE package a handler imports statically is hoisted to a top-level
 * import of the bundle and stays eager — such a handler has to import it
 * dynamically itself. See `tools/src/codebase-index/ts-parser.ts` for that
 * pattern and why it is the only boundary that survives bundling.
 */
type SubcommandLoader = () => Promise<unknown>;

const loaders: Record<string, SubcommandLoader> = {
  acp: async () => (await import('./handlers/acp.js')).acpCmd,
  init: async () => (await import('./handlers/init.js')).initCmd,
  auth: async () => (await import('./handlers/auth.js')).authCmd,
  update: async () => (await import('./handlers/update.js')).updateCmd,
  sessions: async () => (await import('./handlers/sessions-config.js')).sessionsCmd,
  config: async () => (await import('./handlers/sessions-config.js')).configCmd,
  rewind: async () => (await import('./handlers/rewind.js')).rewindCmd,
  replay: async () => (await import('./handlers/replay.js')).replayCmd,
  audit: async () => (await import('./handlers/audit.js')).auditCmd,
  tools: async () => (await import('./handlers/tools-skills.js')).toolsCmd,
  skills: async () => (await import('./handlers/tools-skills.js')).skillsCmd,
  providers: async () => (await import('./handlers/providers-models.js')).providersCmd,
  models: async () => (await import('./handlers/providers-models.js')).modelsCmd,
  mcp: async () => (await import('./handlers/mcp.js')).mcpCmd,
  plugin: async () => (await import('./handlers/plugin-usage.js')).pluginCmd,
  plugins: async () => (await import('./handlers/plugin-usage.js')).pluginCmd,
  diag: async () => (await import('./handlers/diag-doctor.js')).diagCmd,
  doctor: async () => (await import('./handlers/diag-doctor.js')).doctorCmd,
  export: async () => (await import('./handlers/export.js')).exportCmd,
  usage: async () => (await import('./handlers/plugin-usage.js')).usageCmd,
  version: async () => (await import('./handlers/version-help.js')).versionCmd,
  help: async () => (await import('./handlers/version-help.js')).helpCmd,
  projects: async () => (await import('./handlers/projects.js')).projectsCmd,
  modeldiag: async () => (await import('./handlers/modeldiag.js')).modeldiagCmd,
  quick: async () => (await import('./handlers/quick.js')).quickCmd,
  bench: async () => (await import('./handlers/bench.js')).benchCmd,
  chronicle: async () => (await import('./handlers/chronicle.js')).chronicleCmd,
  hq: async () => (await import('./handlers/hq.js')).hqCmd,
  mailbox: async () => (await import('./handlers/mailbox-serve.js')).mailboxServeCmd,
  permissions: async () => (await import('./handlers/permissions.js')).permissionsCmd,
  project: async () => (await import('./handlers/project.js')).projectCmd,
  governance: async () => (await import('./handlers/governance.js')).governanceCmd,
};

/**
 * Name -> handler map. Each entry keeps the plain `SubcommandHandler` shape, so
 * existence checks (`subcommands[name]`) and direct invocation both behave
 * exactly as before; the handler module is imported on first call.
 */
export const subcommands = Object.fromEntries(
  Object.entries(loaders).map(
    ([name, load]): [string, (args: string[], deps: unknown) => Promise<number>] => [
      name,
      async (args, deps) =>
        ((await load()) as (a: string[], d: unknown) => Promise<number>)(args, deps),
    ],
  ),
) as Record<string, (args: string[], deps: unknown) => Promise<number>>;

/** Every registered subcommand name, resolvable without loading a handler. */
export const subcommandNames: readonly string[] = Object.keys(loaders);
