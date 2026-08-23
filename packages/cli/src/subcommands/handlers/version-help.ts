import * as os from 'node:os';
import { color } from '@wrongstack/core/utils';
import { API_VERSION, CLI_VERSION } from '../../version.js';
import type { SubcommandHandler } from '../contracts.js';

export const versionCmd: SubcommandHandler = async (_args, deps) => {
  const bunVersion = (globalThis as { Bun?: { version?: string } }).Bun?.version;
  const runtime = bunVersion ? `bun v${bunVersion}` : `node ${process.version}`;
  deps.renderer.write(
    `WrongStack ${CLI_VERSION} (apiVersion ${API_VERSION}, ${runtime}, ${os.platform()})\n`,
  );
  return 0;
};

export const helpCmd: SubcommandHandler = async (_args, deps) => {
  const lines = [
    color.bold('WrongStack — usage'),
    '',
    '  wstack                       Start REPL',
    '  wstack "<task>"              Run task and exit',
    '  wstack desktop               Open WrongStack Desktop (alias: --desktop)',
    '  wstack webui                 Serve the project WebUI (alias: --webui)',
    '  wstack simpleui              Serve the minimal chat UI (alias: --simpleui)',
    '  wstack hq                    Start HQ command center (alias: --hq)',
    '  wstack --eternal "<mission>" Launch eternal-autonomy loop against a goal — Ctrl+C to stop',
    '  wstack resume [<id>]         Resume a session',
    '  wstack sessions              List recent sessions',
    '  wstack auth                  Interactive setup + key manager (add/edit/delete)',
    '  wstack auth list             Quick listing of saved providers and keys',
    '  wstack auth status <id>      Detailed view of one provider',
    '  wstack auth remove <id>      Delete a provider (asks for confirmation)',
    '  wstack auth <provider>       Add a key for a provider (--label, --family, …)',
    '  wstack auth local [...]      Quick-configure local Ollama / vLLM / LM Studio',
    '  wstack config [show|edit]    Show or edit effective config',
    '  wstack tools                 List registered tools',
    '  wstack skills                List discovered skills',
    '  wstack providers [--all]     List providers from models.dev',
    '  wstack models [<provider>]   List models',
    '  wstack models refresh        Force-refresh cache',
    '  wstack models add <mid>      Add/override custom model (--max-context, --tools, --vision, …)',
    '  wstack models remove <mid>   Remove a custom model',
    '  wstack models list           List all custom models',
    '  wstack mcp [list|add|serve]  Manage MCP servers',
    '  wstack plugin [list|install|toggle|remove|enable|disable]  Manage plugins',
    '  wstack project id|init|rekey Manage the committed repository identity',
    '  wstack governance status     Show advisory project-daemon governance health',
    '  wstack projects              List tracked projects',
    '  wstack audit [<id>] [--list] Tamper-evident session audit log',
    '  wstack replay [<id>] [--list] Recorded provider responses log',
    '  wstack rewind [<id>] [opts]  Rewind a session to an earlier point',
    '  wstack chronicle [opts]      Chronological session metrics and timeline',
    '  wstack mailbox serve [opts]  Start external-agent mailbox HTTP bridge',
    '  wstack permissions explain   Explain tool permission policy decisions',
    '  wstack modeldiag [test]      Model benchmarks and capability diagnostics',
    '  wstack bench [run|list]      Agentic benchmarks against standard suites',
    '  wstack acp [serve]           Agent Client Protocol (ACP) server',
    '  wstack update [--check-only] Self-update the CLI',
    '  wstack diag                  Full diagnostics',
    '  wstack doctor                Health checks',
    '  wstack export <id> [opts]    Render a session',
    '  wstack usage                 Token + cost summary',
    '  wstack version               Print version',
    '',
    color.bold('Common flags'),
    '  --yolo / --no-yolo           Force auto-approval on or off at startup',
    '  --confirm-destructive         Deprecated — YOLO no longer prompts by destructiveness',
    '  --yolo-destructive            Deprecated compatibility flag; YOLO no longer prompts by destructiveness',
    '  --tui / --no-tui             Force or disable TUI mode',
    '  --mouse                      Full mouse mode in the TUI (in-app scroll + clickable UI)',
    '  --desktop                    Open WrongStack Desktop (requires @wrongstack/desktop)',
    '  --hq [--host <h>] [--port <n>] [--password <secret>] [--tunnel] [--open]',
    '                               Start HQ; --tunnel publishes a temporary HTTPS URL',
    '  --webui [--host <h>] [--port <n>] [--webui-token <t>] [--open]',
    '          [--webui-public-url <url>] [--webui-public-ws-url <url>] [--webui-require-token]',
    '                               Serve the browser UI + WS bridge (prints a token URL,',
    "                               --open pops the browser; shares this terminal's agent)",
    '  --simpleui [same network flags as --webui] [--open]',
    '                               Serve the independent minimal chat UI',
    '  --full-auto                   SimpleUI: runtime-only YOLO + Director + autonomy override',
    '  --eternal "<mission>"        Start an eternal-autonomy loop',
    '  --no-hints                   Hide launch hints',
    '  --skip-index                 Skip codebase indexing on startup',
    '  --chimera-auto-fix off|ask|auto',
    '                               How to handle Chimera review findings (default: config value)',
  ];
  deps.renderer.write(lines.join('\n') + '\n');
  return 0;
};
