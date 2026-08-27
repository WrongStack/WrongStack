import { streamCoalescer } from '@/lib/stream-coalescer';
import { navigateToView, openMainView, showPanel } from '@/lib/view-navigation';
import { useSessionStore, useUIStore } from '@/stores';
import { useSystemPromptStore } from '@/stores/system-prompt-store';
import type { WSClientMessage } from '@/types';
import { downloadChatAsMarkdown } from '../CommandPalette/export-utils.js';
import { SLASH_COMMANDS } from './slash-commands.js';

interface ChatAssistantMessage {
  role: 'assistant';
  content: string;
}

type SlashRoutingView = 'chat' | 'sessions' | 'settings';

type SlashRoutingClientMessage = Extract<
  WSClientMessage,
  | { type: 'webui.shutdown' }
  | { type: 'brain.risk' }
  | { type: 'brain.ask' }
  | { type: 'brain.status' }
  | { type: 'autonomy.switch' }
  | { type: 'goal.get' }
  | { type: 'mode.switch' }
  | { type: 'modes.list' }
  | { type: 'mcp.list' }
  | { type: 'mcp.resources' }
  | { type: 'mcp.prompts' }
  | { type: 'mcp.resource.read' }
  | { type: 'mcp.prompt.get' }
  | { type: 'working_dir.set' }
  | { type: 'goal.start' }
  | { type: 'goal.pause' }
  | { type: 'goal.resume' }
  | { type: 'goal.stop' }
  | { type: 'config.doctor' }
>;

interface SlashRoutingClient {
  send?: (message: SlashRoutingClientMessage) => void;
  /**
   * Stamp a payload with the foreground session's id, when one is bound.
   * Session-sensitive commands (/autonomy, /mode) MUST route through this —
   * a raw `send` left them unstamped, so the runtime applied them to
   * whichever tab it currently considered active instead of the tab the
   * command was typed in.
   */
  withSession?: <T extends Record<string, unknown>>(payload: T) => T;
  clearContext?: () => void;
  newSession?: () => void;
  compactContext?: (aggressive?: boolean) => void;
  repairContext?: () => void;
  clearTodos?: () => void;
}

/** Stripped-down queue item for slash-command routing — only the text
 *  is meaningful for `/queue` listing. */
type SlashQueueItem = { text: string };

interface SlashRoutingWs {
  listTools: () => void;
  listMemory: () => void;
  listSkills: () => void;
  getDiag: () => void;
  getStats: () => void;
  saveSession: () => void;
  listSessions: (limit?: number) => void;
  getPlan: () => void;
}

export interface RunChatSlashCommandOptions {
  raw: string;
  addMessage: (message: ChatAssistantMessage) => void;
  clearMessages: () => void;
  client: SlashRoutingClient | null | undefined;
  queue: readonly SlashQueueItem[];
  sendAbort: () => void;
  sendMsg: (content: string) => void;
  setLoading: (loading: boolean) => void;
  setCurrentView: (view: SlashRoutingView) => void;
  toggleRefineEnabled: () => void;
  setProcessMonitorOpen: (open: boolean) => void;
  setQueuePanelOpen: (open: boolean) => void;
  ws: SlashRoutingWs;
  onOpenBreakdown?: (() => void) | undefined;
  handleNextList: () => boolean;
  handleNextSelect: (args: string) => boolean;
}

export function runChatSlashCommand(options: RunChatSlashCommandOptions): boolean {
  const {
    raw,
    addMessage,
    clearMessages,
    client,
    queue,
    sendAbort,
    sendMsg,
    setLoading,
    toggleRefineEnabled,
    setProcessMonitorOpen,
    setQueuePanelOpen,
    ws,
    onOpenBreakdown,
    handleNextList,
    handleNextSelect,
  } = options;

  const trimmed = raw.trim();
  // Split into head (with leading slash) + the rest. Lowercase the
  // head so `/Todos` and `/TODOS` route the same; preserve case on
  // the args because the user might be inserting a content string.
  const firstWhitespace = trimmed.search(/\s/);
  const head = (firstWhitespace === -1 ? trimmed : trimmed.slice(0, firstWhitespace)).toLowerCase();
  const args = firstWhitespace === -1 ? '' : trimmed.slice(firstWhitespace).trim();
  const cmd = head;
  const openWorkTab = (tab: 'todos' | 'tasks' | 'plan') => {
    const ui = useUIStore.getState();
    showPanel('chat');
    ui.setDockSection('work');
    ui.setWorkDashboardTab(tab);
  };

  switch (cmd) {
    case '/help': {
      // Render the registry inline as an assistant message.
      const lines = [
        '📖 **Slash commands**',
        '',
        ...SLASH_COMMANDS.map(
          (c) =>
            `• \`${c.name}\`${c.aliases?.length ? ` (${c.aliases.map((a) => `\`${a}\``).join(', ')})` : ''} — ${c.description}`,
        ),
      ];
      addMessage({ role: 'assistant', content: lines.join('\n') });
      return true;
    }
    case '/clear':
      streamCoalescer.dropAll();
      clearMessages();
      client?.clearContext?.();
      return true;
    case '/new':
      // Same hand-off as the New Session button: the picker sends `session.new`
      // once a variant is confirmed.
      useSystemPromptStore.getState().openPicker({ startsSession: true });
      showPanel('chat');
      return true;
    case '/exit':
      client?.send?.({ type: 'webui.shutdown' });
      addMessage({
        role: 'assistant',
        content:
          '👋 Shutting down WebUI server… Detached background processes will remain running.',
      });
      return true;
    case '/compact':
    case '/compact!':
      client?.compactContext?.(cmd === '/compact!');
      return true;
    case '/repair':
      client?.repairContext?.();
      return true;
    case '/debug':
    case '/context':
      onOpenBreakdown?.();
      return true;
    case '/tools':
      ws.listTools();
      return true;
    case '/memory':
      openMainView('memory');
      return true;
    case '/skill':
    case '/skills':
      ws.listSkills();
      return true;
    case '/prompt':
    case '/prompts':
      useUIStore.getState().setPromptLibraryOpen(true);
      return true;
    case '/diag':
      ws.getDiag();
      return true;
    case '/stats':
      ws.getStats();
      return true;
    case '/save':
      ws.saveSession();
      return true;
    case '/load':
    case '/resume':
      ws.listSessions(50);
      showPanel('chat');
      return true;
    case '/agents':
      useUIStore.getState().setAgentsMonitorOpen(true);
      return true;
    case '/roster':
      openMainView('roster');
      return true;
    case '/autonomy': {
      // Mirrors the CLI's /autonomy: off | suggest | auto | eternal | eternal-parallel.
      const mode = args.trim().toLowerCase();
      const valid = ['off', 'suggest', 'auto', 'eternal', 'eternal-parallel'];
      if (!mode) {
        addMessage({
          role: 'assistant',
          content: `Usage: \`/autonomy <mode>\` — one of: ${valid.map((m) => `\`${m}\``).join(', ')}.`,
        });
        return true;
      }
      if (!valid.includes(mode)) {
        addMessage({
          role: 'assistant',
          content: `Unknown autonomy mode \`${mode}\`. Try: ${valid.join(', ')}.`,
        });
        return true;
      }
      client?.send?.({
        type: 'autonomy.switch',
        // Stamped with the foreground tab: autonomy is per-session, and an
        // unstamped send let tab 2's /autonomy reconfigure tab 1.
        payload: client.withSession?.({ mode }) ?? { mode },
      });
      addMessage({ role: 'assistant', content: `🤖 Autonomy mode → **${mode}**.` });
      return true;
    }
    case '/goal': // start <title> | pause | resume | stop. No arg → open the full view.
      {
        const [sub, ...rest] = args.split(/\s+/).filter(Boolean);
        const subcmd = (sub ?? '').toLowerCase();
        if (subcmd === 'start') {
          const title = rest.join(' ').trim();
          if (!title) {
            addMessage({ role: 'assistant', content: 'Usage: `/goal start <title>`' });
            return true;
          }
          client?.send?.({ type: 'goal.start', payload: { title } });
          openMainView('goal');
          return true;
        }
        if (subcmd === 'pause') {
          client?.send?.({ type: 'goal.pause', payload: {} });
          return true;
        }
        if (subcmd === 'resume') {
          client?.send?.({ type: 'goal.resume', payload: {} });
          return true;
        }
        if (subcmd === 'stop') {
          client?.send?.({ type: 'goal.stop', payload: {} });
          return true;
        }
        openMainView('goal');
        return true;
      }
    case '/fleet':
      useUIStore.getState().setFleetMonitorOpen(true);
      return true;
    case '/terminal':
    case '/term':
      useUIStore.getState().setTerminalOpen(true);
      return true;
    case '/collab':
      showPanel('chat');
      useUIStore.getState().setDockSection('collab');
      return true;
    case '/worktree':
    case '/worktrees':
      showPanel('worktrees');
      useUIStore.getState().setDockSection('worktrees');
      return true;
    case '/mode': {
      // No arg → list available modes; arg → switch.
      const id = args.trim();
      if (!id) {
        client?.send?.({ type: 'modes.list' });
        addMessage({
          role: 'assistant',
          content: 'Fetching available modes… (or pass `/mode <name>` to switch).',
        });
        return true;
      }
      client?.send?.({
        type: 'mode.switch',
        // Same stamping rule as /autonomy: the mode belongs to this tab.
        payload: client.withSession?.({ id }) ?? { id },
      });
      addMessage({ role: 'assistant', content: `Mode → **${id}**.` });
      return true;
    }
    case '/mcp': {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const action = parts[0];
      const server = parts[1];
      if ((action === 'resources' || action === 'prompts') && server) {
        client?.send?.({
          type: action === 'resources' ? 'mcp.resources' : 'mcp.prompts',
          payload: { name: server, refresh: parts.includes('--refresh') },
        });
        addMessage({ role: 'assistant', content: `Fetching MCP ${action} from **${server}**…` });
        return true;
      }
      if (action === 'read' && server && parts[2]) {
        client?.send?.({ type: 'mcp.resource.read', payload: { name: server, uri: parts[2] } });
        addMessage({
          role: 'assistant',
          content: `Reading selected MCP resource from **${server}**…`,
        });
        return true;
      }
      if (action === 'get' && server && parts[2]) {
        const promptArgs: Record<string, string> = {};
        for (const token of parts.slice(3)) {
          const separator = token.indexOf('=');
          if (separator <= 0) {
            addMessage({
              role: 'assistant',
              content: `Invalid MCP prompt argument \`${token}\`; expected \`key=value\`.`,
            });
            return true;
          }
          promptArgs[token.slice(0, separator)] = token.slice(separator + 1);
        }
        client?.send?.({
          type: 'mcp.prompt.get',
          payload: { name: server, prompt: parts[2], arguments: promptArgs },
        });
        addMessage({
          role: 'assistant',
          content: `Getting selected MCP prompt from **${server}**…`,
        });
        return true;
      }
      if (action) {
        addMessage({
          role: 'assistant',
          content:
            'Usage: `/mcp resources <server>`, `/mcp prompts <server>`, `/mcp read <server> <uri>`, or `/mcp get <server> <prompt> [key=value...]`.',
        });
        return true;
      }
      client?.send?.({ type: 'mcp.list' });
      openMainView('settings');
      addMessage({
        role: 'assistant',
        content:
          '🖥️ **MCP Servers** — settings opened to the MCP tab.\n\nConfigure, enable/disable, or restart servers from the MCP section.',
      });
      return true;
    }
    case '/doctor': {
      const subcommand = args.trim().toLowerCase();
      if (subcommand && subcommand !== 'fix') {
        addMessage({
          role: 'assistant',
          content: 'Usage: `/doctor` to preview or `/doctor fix` to repair and create a backup.',
        });
        return true;
      }
      client?.send?.({ type: 'config.doctor', payload: { apply: subcommand === 'fix' } });
      addMessage({
        role: 'assistant',
        content:
          subcommand === 'fix'
            ? '🩺 Config Doctor is repairing the active profile config…'
            : '🩺 Config Doctor is checking the active profile config…',
      });
      return true;
    }
    case '/working-dir':
    case '/cwd': {
      const path = args.trim();
      if (!path) {
        const cwd = useSessionStore.getState().cwd;
        addMessage({
          role: 'assistant',
          content: cwd
            ? `📂 Working directory: \`${cwd}\`\n\n_Pass \`/working-dir <path>\` to change it._`
            : 'Working directory unknown. Pass `/working-dir <path>` to set it.',
        });
        return true;
      }
      client?.send?.({ type: 'working_dir.set', payload: { path } });
      addMessage({ role: 'assistant', content: `📂 Working directory → \`${path}\`.` });
      return true;
    }
    case '/brain': {
      // Mirrors the CLI's /brain: status (default), risk <level>, ask <question>.
      const [sub, ...rest] = args.split(/\s+/).filter(Boolean);
      const subcmd = (sub ?? '').toLowerCase();
      if (subcmd === 'risk') {
        const level = (rest[0] ?? '').toLowerCase();
        const valid = ['off', 'low', 'medium', 'high', 'all'];
        if (!level) {
          addMessage({
            role: 'assistant',
            content: `Usage: \`/brain risk <level>\` — one of: ${valid.map((m) => `\`${m}\``).join(', ')}.`,
          });
          return true;
        }
        if (!valid.includes(level)) {
          addMessage({
            role: 'assistant',
            content: `Unknown risk level \`${level}\`. Try: ${valid.join(', ')}.`,
          });
          return true;
        }
        client?.send?.({ type: 'brain.risk', payload: { level } });
        addMessage({ role: 'assistant', content: `🧠 Brain — risk → **${level}**.` });
      } else if (subcmd === 'ask') {
        const question = rest.join(' ').trim();
        if (!question) {
          addMessage({ role: 'assistant', content: 'Usage: `/brain ask <question>`' });
        } else {
          client?.send?.({ type: 'brain.ask', payload: { question } });
        }
      } else {
        client?.send?.({ type: 'brain.status' });
      }
      return true;
    }
    case '/plan':
      ws.getPlan();
      // Surface the Work section of the dock strip above the chat.
      openWorkTab('plan');
      return true;
    case '/todos': {
      // Sub-commands: `/todos` (default = list), `/todos clear`. We
      // pull live state from the session store so the rendered output
      // matches what the sidebar already shows — no separate fetch.
      const sub = args.toLowerCase();
      if (sub === 'clear') {
        client?.clearTodos?.();
        return true;
      }
      openWorkTab('todos');
      const list = useSessionStore.getState().todos;
      if (list.length === 0) {
        addMessage({
          role: 'assistant',
          content:
            "✅ **Todos** — _empty. Ask the agent to plan something and they'll show up here._",
        });
        return true;
      }
      const lines: string[] = [
        `✅ **Todos** (${list.filter((t) => t.status === 'completed').length}/${list.length} done)`,
        '',
      ];
      for (const t of list) {
        const mark = t.status === 'completed' ? '[x]' : t.status === 'in_progress' ? '[~]' : '[ ]';
        const text = t.status === 'in_progress' && t.activeForm ? t.activeForm : t.content;
        lines.push(`- ${mark} ${text}`);
      }
      lines.push('', '_Use `/todos clear` to wipe the list._');
      addMessage({ role: 'assistant', content: lines.join('\n') });
      return true;
    }
    case '/export':
      downloadChatAsMarkdown();
      addMessage({ role: 'assistant', content: '📥 Chat exported to your downloads folder.' });
      return true;
    case '/interrupt':
    case '/abort':
    case '/stop':
    case '/int':
      sendAbort();
      setLoading(false);
      return true;
    case '/settings':
    case '/model':
      openMainView('settings');
      return true;
    case '/setup':
      navigateToView('setup');
      return true;
    case '/enhance': {
      const enabled = !useUIStore.getState().refineEnabled;
      toggleRefineEnabled();
      addMessage({
        role: 'assistant',
        content: `Prompt refinement ${enabled ? 'enabled' : 'disabled'}.`,
      });
      return true;
    }
    case '/suggest':
    case '/next-steps':
      // Ask the agent to suggest next steps
      sendMsg(
        'Suggest exact prompt messages I can submit back to you. Each must ask you to perform the work and must not assign a manual chore to me. Be specific and actionable.',
      );
      return true;
    case '/review':
    case '/cr': {
      // Prompt-based code review — the agent uses its own git/read tools.
      const focus = args.trim();
      const focusLine = focus
        ? `Focus especially on: ${focus}.`
        : 'Cover correctness bugs, security issues, performance, and obvious simplifications.';
      sendMsg(
        `Review the pending git changes (run \`git diff\` and \`git status\` to see them). ${focusLine} ` +
          'For each finding give the file, a short description, severity, and a concrete fix. ' +
          'If there are no changes, review the most recently edited files instead.',
      );
      return true;
    }
    case '/fix': {
      const err = args.trim();
      sendMsg(
        err
          ? `Diagnose and fix this error. Find the root cause, then apply the fix and explain it:\n\n${err}`
          : 'Investigate the most recent error or failing test, find the root cause, fix it, and verify the fix.',
      );
      return true;
    }
    case '/kill':
    case '/ps':
      // /kill — open the Process Monitor overlay
      // /ps  — open it too (read-only view is the same component)
      setProcessMonitorOpen(true);
      return true;
    case '/queue': {
      // Show queue state: count + items preview
      const q = queue;
      if (q.length === 0) {
        addMessage({
          role: 'assistant',
          content:
            '📋 **Message Queue** — empty.\n\nType while the agent is running to queue messages; they are sent automatically when the agent finishes.',
        });
      } else {
        const lines = [`📋 **Message Queue** (${q.length} queued)`, ''];
        q.forEach((item, i) => {
          const preview = item.text.length > 80 ? `${item.text.slice(0, 77)}…` : item.text;
          lines.push(`${i + 1}. ${preview}`);
        });
        lines.push('', '_Use `/queue open` to manage, or `/queue clear` to wipe._');
        addMessage({ role: 'assistant', content: lines.join('\n') });
      }
      // /queue open — show the overlay panel
      if (args.toLowerCase() === 'open') {
        setQueuePanelOpen(true);
      }
      return true;
    }
    case '/next':
    case '/enxt': {
      const narg = args.trim().toLowerCase();
      if (!narg || narg === 'list' || narg === 'ls' || narg === 'show') return handleNextList();
      if (narg === 'clear' || narg === 'reset') {
        addMessage({ role: 'assistant', content: '💡 _Suggestion list cleared._' });
        return true;
      }
      return handleNextSelect(args.trim());
    }
    case '/f':
    case '/f1':
    case '/f2':
    case '/f3':
    case '/f4':
    case '/f5':
    case '/f6':
    case '/f7':
    case '/f8':
    case '/f9':
    case '/f10':
    case '/f11':
    case '/f12': {
      const panelMap: Record<string, string> = {
        '/f': '',
        '/f1': 'sessionPanel',
        '/f2': 'fleetMonitor',
        '/f3': 'agentsMonitor',
        '/f4': 'worktreeMonitor',
        '/f5': 'planPanel',
        '/f6': 'todosMonitor',
        '/f7': 'queuePanel',
        '/f8': 'processList',
        '/f9': 'goalPanel',
        '/f10': 'sessionsPanel',
        '/f11': 'coordinatorMonitor',
        '/f12': 'statuslinePicker',
      };
      const panel = cmd === '/f' && args ? panelMap[`/f${args.trim()}`] : panelMap[cmd];
      if (!panel) {
        // /f with no args — show the list
        const lines = [
          '🎛️  **F-key panels**',
          '',
          '/f 1 — Session panel',
          '/f 2 — Fleet orchestration monitor',
          '/f 3 — Agents live monitor',
          '/f 4 — Worktree monitor',
          '/f 5 — Plan panel',
          '/f 6 — Todos monitor overlay',
          '/f 7 — Queue panel',
          '/f 8 — Process list overlay',
          '/f 9 — Goal panel',
          '/f 10 — Live sessions panel',
          '/f 11 — Coordinator monitor',
          '/f 12 — Status line picker',
          '',
          '_Or use /f1 … /f12 directly._',
        ];
        addMessage({ role: 'assistant', content: lines.join('\n') });
        return true;
      }
      // Dispatch to the appropriate WebUI store action
      const ui = useUIStore.getState();
      showPanel('chat');
      ui.setDockCustomizeOpen(false);
      if (panel === 'sessionPanel') {
        showPanel('chat');
        return true;
      }
      if (panel === 'fleetMonitor') {
        ui.setFleetMonitorOpen(true);
        return true;
      }
      if (panel === 'agentsMonitor') {
        ui.setAgentsMonitorOpen(true);
        return true;
      }
      if (panel === 'worktreeMonitor') {
        showPanel('worktrees');
        ui.setDockSection('worktrees');
        return true;
      }
      if (panel === 'planPanel') {
        ws.getPlan();
        ui.setDockSection('work');
        ui.setWorkDashboardTab('plan');
        return true;
      }
      if (panel === 'todosMonitor') {
        ui.setDockSection('work');
        ui.setWorkDashboardTab('todos');
        return true;
      }
      if (panel === 'queuePanel') {
        ui.setQueuePanelOpen(true);
        return true;
      }
      if (panel === 'processList') {
        ui.setProcessMonitorOpen(true);
        return true;
      }
      if (panel === 'goalPanel') {
        client?.send?.({ type: 'goal.get' });
        showPanel('chat');
        ui.setDockSection('goal-state');
        return true;
      }
      if (panel === 'sessionsPanel') {
        ws.listSessions(50);
        showPanel('chat');
        return true;
      }
      if (panel === 'coordinatorMonitor') {
        showPanel('officemap');
        return true;
      }
      if (panel === 'statuslinePicker') {
        showPanel('chat');
        ui.setDockSection('work');
        ui.setDockCustomizeOpen(true);
        return true;
      }
      return true;
    }
    default:
      return false;
  }
}
