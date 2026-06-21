import { expectDefined } from '@wrongstack/core';
// Slash command registry and matching utilities for ChatInput

export type SlashCategory = 'Run' | 'Session' | 'Inspect' | 'Agent' | 'Config' | 'App';

export interface SlashCommandDef {
  name: string;
  aliases?: string[] | undefined;
  description: string;
  category: SlashCategory;
  /** Hidden commands don't appear in the picker when query is empty. */
  hidden?: boolean | undefined;
}

export const SLASH_COMMANDS: SlashCommandDef[] = [
  // Session
  { name: '/new', category: 'Session', description: 'Start a brand-new session (fresh on disk and in memory)' },
  { name: '/clear', category: 'Session', description: 'Wipe current context (keeps session id, disk record stays)' },
  { name: '/compact', category: 'Session', description: 'Shrink context — elide ancient tool output' },
  { name: '/compact!', category: 'Session', description: 'Aggressively shrink context now' },
  { name: '/repair', category: 'Session', description: 'Repair orphan tool-use / tool-result protocol blocks' },
  { name: '/save', category: 'Session', description: 'Force-flush the session (auto-saved already)' },
  { name: '/load', category: 'Session', aliases: ['/resume'], description: 'Resume a previous session from disk' },
  { name: '/export', category: 'Session', description: 'Download the current chat as markdown' },

  // Inspect
  { name: '/debug', category: 'Inspect', aliases: ['/context'], description: 'Context size breakdown per section' },
  { name: '/tools', category: 'Inspect', description: 'List every registered tool the model can call' },
  { name: '/memory', category: 'Inspect', description: 'Manage memory: show, remember, forget, clear, stats' },
  { name: '/todos', category: 'Inspect', description: 'List current todos' },
  { name: '/stats', category: 'Inspect', description: 'Session stats: tokens, cost, elapsed' },
  { name: '/skill', category: 'Inspect', aliases: ['/skills'], description: 'List active skills' },
  { name: '/diag', category: 'Inspect', description: 'Runtime diagnostics (provider, tools, mode, usage)' },
  { name: '/agents', category: 'Inspect', description: 'Show status of spawned subagents' },
  { name: '/brain', category: 'Inspect', description: 'Brain status, risk ceiling (risk <level>), or decision support (ask <question>)' },
  { name: '/plan', category: 'Inspect', description: 'Strategic plan board: show, add, start, done, promote, clear' },
  { name: '/suggest', category: 'Inspect', aliases: ['/next-steps'], description: 'Ask the agent for concrete next steps' },
  { name: '/next', category: 'Inspect', description: 'Show or run numbered next-step suggestions' },

  // Agent / autonomy
  { name: '/review', category: 'Agent', aliases: ['/cr'], description: 'Ask the agent to review the pending changes (optional focus)' },
  { name: '/fix', category: 'Agent', description: 'Diagnose and fix an error (paste it) or the latest failure' },
  { name: '/autonomy', category: 'Agent', description: 'Switch self-driving mode: off | suggest | auto | eternal | eternal-parallel' },
  { name: '/goal', category: 'Agent', description: 'Show the current goal (opens the Goal dock chip)' },
  { name: '/fleet', category: 'Agent', description: 'Open the Fleet orchestration monitor' },
  { name: '/terminal', category: 'App', aliases: ['/term'], description: 'Open the integrated terminal (Ctrl+`)' },
  { name: '/collab', category: 'Agent', description: 'Open the live collaboration panel' },
  { name: '/worktree', category: 'Agent', aliases: ['/worktrees'], description: 'Open the worktree view' },
  { name: '/autophase', category: 'Agent', description: 'AutoPhase: start <title> | pause | resume | stop' },
  { name: '/mode', category: 'Agent', description: 'Switch session mode (no arg lists available modes)' },
  { name: '/mcp', category: 'Agent', description: 'Open MCP server settings and refresh the server list' },
  { name: '/working-dir', category: 'Agent', aliases: ['/cwd'], description: 'Show or change the working directory' },

  // Config
  { name: '/settings', category: 'Config', aliases: ['/model'], description: 'Open settings (provider/model/keys)' },
  { name: '/enhance', category: 'Config', description: 'Toggle prompt refinement before sending' },
  { name: '/interrupt', category: 'Run', aliases: ['/abort', '/stop', '/int'], description: 'Stop the current run (abort the in-flight request)' },

  // App
  { name: '/help', category: 'App', description: 'Show every slash command and what it does' },
  { name: '/exit', category: 'App', description: 'Exit the session and close WebUI' },

  // F-key panels (shown as numbered options under /f)
  { name: '/f', category: 'App', description: 'Open F-key panels (F1–F12). Type /f for numbered options.' },
  // Hidden aliases — not shown in the main picker but dispatchable directly
  { name: '/f1', category: 'App', description: 'Project switcher', hidden: true },
  { name: '/f2', category: 'App', description: 'Fleet orchestration monitor', hidden: true },
  { name: '/f3', category: 'App', description: 'Agents live monitor', hidden: true },
  { name: '/f4', category: 'App', description: 'Worktree monitor', hidden: true },
  { name: '/f5', category: 'App', description: 'Autonomy settings', hidden: true },
  { name: '/f6', category: 'App', description: 'Todos monitor overlay', hidden: true },
  { name: '/f7', category: 'App', description: 'Queue panel', hidden: true },
  { name: '/f8', category: 'App', description: 'Process list overlay', hidden: true },
  { name: '/f9', category: 'App', description: 'Goal panel', hidden: true },
  { name: '/f10', category: 'App', description: 'Live sessions panel', hidden: true },
  { name: '/f11', category: 'App', description: 'Coordinator monitor', hidden: true },
  { name: '/f12', category: 'App', description: 'Status line picker', hidden: true },
];

export const SLASH_CATEGORY_ORDER: SlashCategory[] = ['Run', 'Session', 'Inspect', 'Agent', 'Config', 'App'];

export function matchSlash(query: string): SlashCommandDef[] {
  const q = query.toLowerCase();
  if (q === '/' || q === '') {
    // When no query is given, hide commands marked as hidden.
    return SLASH_COMMANDS.filter((c) => !c.hidden);
  }
  return SLASH_COMMANDS.filter(
    (c) => c.name.startsWith(q) || (c.aliases?.some((a) => a.startsWith(q)) ?? false),
  );
}

export function detectAtMention(value: string, cursor: number): { start: number; query: string } | null {
  let i = cursor - 1;
  while (i >= 0) {
    const c = expectDefined(value[i]);
    if (c === '@') {
      const prev = i > 0 ? value[i - 1] : '';
      if (i === 0 || /\s/.test(prev ?? '')) {
        return { start: i, query: value.slice(i + 1, cursor) };
      }
      return null;
    }
    if (/\s/.test(c)) return null;
    i--;
  }
  return null;
}
