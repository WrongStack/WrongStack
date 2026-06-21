import { useSessionStore, useUIStore } from '@/stores';
import type { WSClientMessage } from '@/types';
import { downloadChatAsMarkdown } from '../CommandPalette';
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
  | { type: 'working_dir.set' }
  | { type: 'autophase.start' }
  | { type: 'autophase.pause' }
  | { type: 'autophase.resume' }
  | { type: 'autophase.stop' }
>;

interface SlashRoutingClient {
  send?: (message: SlashRoutingClientMessage) => void;
  clearContext?: () => void;
  newSession?: () => void;
  compactContext?: (aggressive?: boolean) => void;
  repairContext?: () => void;
  clearTodos?: () => void;
}

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
  queue: readonly string[];
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
    setCurrentView,
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
  const sp = trimmed.indexOf(' ');
  const head = (sp === -1 ? trimmed : trimmed.slice(0, sp)).toLowerCase();
  const args = sp === -1 ? '' : trimmed.slice(sp + 1).trim();
  const cmd = head;
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
      clearMessages();
      client?.clearContext?.();
      return true;
    case '/new':
      client?.newSession?.();
      return true;
    case '/exit':
      client?.send?.({ type: 'webui.shutdown' });
      addMessage({ role: 'assistant', content: '👋 Shutting down WebUI server…' });
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
      ws.listMemory();
      return true;
    case '/skill':
    case '/skills':
      ws.listSkills();
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
      setCurrentView('sessions');
      return true;
    case '/agents':
      useUIStore.getState().setAgentsMonitorOpen(true);
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
        addMessage({ role: 'assistant', content: `Unknown autonomy mode \`${mode}\`. Try: ${valid.join(', ')}.` });
        return true;
      }
      client?.send?.({ type: 'autonomy.switch', payload: { mode } });
      addMessage({ role: 'assistant', content: `🤖 Autonomy mode → **${mode}**.` });
      return true;
    }
    case '/goal':
      client?.send?.({ type: 'goal.get' });
      useUIStore.getState().setDockSection('goal');
      return true;
    case '/fleet':
      useUIStore.getState().setFleetMonitorOpen(true);
      return true;
    case '/terminal':
    case '/term':
      useUIStore.getState().setTerminalOpen(true);
      return true;
    case '/collab':
      useUIStore.getState().setDockSection('collab');
      return true;
    case '/worktree':
    case '/worktrees':
      useUIStore.getState().setDockSection('worktrees');
      return true;
    case '/mode': {
      // No arg → list available modes; arg → switch.
      const id = args.trim();
      if (!id) {
        client?.send?.({ type: 'modes.list' });
        addMessage({ role: 'assistant', content: 'Fetching available modes… (or pass `/mode <name>` to switch).' });
        return true;
      }
      client?.send?.({ type: 'mode.switch', payload: { id } });
      addMessage({ role: 'assistant', content: `Mode → **${id}**.` });
      return true;
    }
    case '/mcp':
      client?.send?.({ type: 'mcp.list' });
      setCurrentView('settings');
      return true;
    case '/working-dir':
    case '/cwd': {
      const path = args.trim();
      if (!path) {
        const cwd = useSessionStore.getState().cwd;
        addMessage({
          role: 'assistant',
          content: cwd ? `📂 Working directory: \`${cwd}\`\n\n_Pass \`/working-dir <path>\` to change it._` : 'Working directory unknown. Pass `/working-dir <path>` to set it.',
        });
        return true;
      }
      client?.send?.({ type: 'working_dir.set', payload: { path } });
      addMessage({ role: 'assistant', content: `📂 Working directory → \`${path}\`.` });
      return true;
    }
    case '/autophase': {
      // start <title> | pause | resume | stop. No arg → open the full view.
      const [sub, ...rest] = args.split(/\s+/).filter(Boolean);
      const subcmd = (sub ?? '').toLowerCase();
      if (subcmd === 'start') {
        const title = rest.join(' ').trim();
        if (!title) {
          addMessage({ role: 'assistant', content: 'Usage: `/autophase start <title>`' });
          return true;
        }
        client?.send?.({ type: 'autophase.start', payload: { title } });
        useUIStore.getState().setCurrentView('autophase');
        return true;
      }
      if (subcmd === 'pause') {
        client?.send?.({ type: 'autophase.pause', payload: {} });
        return true;
      }
      if (subcmd === 'resume') {
        client?.send?.({ type: 'autophase.resume', payload: {} });
        return true;
      }
      if (subcmd === 'stop') {
        client?.send?.({ type: 'autophase.stop', payload: {} });
        return true;
      }
      useUIStore.getState().setCurrentView('autophase');
      return true;
    }
    case '/brain': {
      // Mirrors the CLI's /brain: status (default), risk <level>, ask <question>.
      const [sub, ...rest] = args.split(/\s+/).filter(Boolean);
      const subcmd = (sub ?? '').toLowerCase();
      if (subcmd === 'risk') {
        client?.send?.({ type: 'brain.risk', payload: { level: (rest[0] ?? '').toLowerCase() } });
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
      setCurrentView('chat');
      // Surface the Work section of the dock strip above the chat.
      useUIStore.getState().setDockSection('work');
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
      setCurrentView('settings');
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
      sendMsg('What are the next steps I should take? Be specific and actionable.');
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
          const preview = item.length > 80 ? `${item.slice(0, 77)}…` : item;
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
    case '/next': {
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
        '/f1': 'projectPicker',
        '/f2': 'fleetMonitor',
        '/f3': 'agentsMonitor',
        '/f4': 'worktreeMonitor',
        '/f5': 'autonomySettings',
        '/f6': 'todosMonitor',
        '/f7': 'queuePanel',
        '/f8': 'processList',
        '/f9': 'goalPanel',
        '/f10': 'sessionsPanel',
        '/f11': 'coordinatorMonitor',
        '/f12': 'statuslinePicker',
      };
      const panel = panelMap[cmd];
      if (!panel) {
        // /f with no args — show the list
        const lines = [
          '🎛️  **F-key panels**',
          '',
          '/f 1 — Project switcher',
          '/f 2 — Fleet orchestration monitor',
          '/f 3 — Agents live monitor',
          '/f 4 — Worktree monitor',
          '/f 5 — Autonomy settings',
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
      if (panel === 'fleetMonitor') {
        ui.setFleetMonitorOpen(true);
        return true;
      }
      if (panel === 'agentsMonitor') {
        ui.setAgentsMonitorOpen(true);
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
      addMessage({
        role: 'assistant',
        content: `Panel \`${panel}\` is not available in the WebUI. Try the TUI for full F-key panel support.`,
      });
      return true;
    }
    default:
      return false;
  }
}
