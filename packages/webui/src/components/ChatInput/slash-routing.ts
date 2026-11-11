import { clearChatContext } from '@/lib/clear-chat-context';
import { navigateToView, openMainView, showPanel } from '@/lib/view-navigation';
import { useGoalRunStore, useSessionStore, useUIStore } from '@/stores';
import { useGoalCatalogStore } from '@/stores/goal-catalog-store';
import { useSystemPromptStore } from '@/stores/system-prompt-store';
import { downloadChatAsMarkdown } from '../CommandPalette/export-utils.js';
import { openPluginUiModal } from '../PluginUiModal.js';
import { SLASH_COMMANDS } from './slash-commands.js';

import {
  engineSlashCommands,
  runDirectEngineSlashCommand,
  runEngineSlashCommand,
} from './slash-routing-engine.js';
import { runFKeyPanelCommand } from './slash-routing-fkeys.js';
import { runGoalSlashCommand } from './slash-routing-goal.js';
import { runHuntSlashCommand } from './slash-routing-hunt.js';
import { runBrainSlashCommand, runMcpSlashCommand } from './slash-routing-mcp-brain.js';
import { runNextStepsModeCommand, runYoloCommand } from './slash-routing-prefs.js';
import type {
  ChatAssistantMessage,
  SlashQueueItem,
  SlashRoutingClient,
  SlashRoutingView,
  SlashRoutingWs,
} from './slash-routing-types.js';

export interface RunChatSlashCommandOptions {
  raw: string;
  sessionId?: string | null | undefined;
  addMessage: (message: ChatAssistantMessage) => void;
  clearMessages: () => void;
  /**
   * Does the lane believe a run is in flight? `/clear` needs the answer:
   * wiping the transcript without settling the run flag leaves the pane in
   * its loading branch over zero rows — a blank box where the welcome screen
   * belongs. See the `/clear` case.
   */
  isLoading: boolean;
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
    isLoading,
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
    sessionId,
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
      const engine = engineSlashCommands(SLASH_COMMANDS);
      if (engine.length) {
        lines.push('', '🧰 **Engine commands**', '');
        for (const c of engine) lines.push(`• \`${c.name}\` — ${c.description}`);
      }
      addMessage({ role: 'assistant', content: lines.join('\n') });
      return true;
    }
    case '/clear':
      // Single sequence, shared with Ctrl+L and the desktop menu — see
      // `clear-chat-context.ts` for why the run flag has to be settled here.
      clearChatContext({ client, isLoading, clearMessages, setLoading, sendAbort, sessionId });
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
    case '/goals':
      client?.send?.({ type: 'goal.list', payload: {} });
      if (args.trim()) {
        useGoalCatalogStore.getState().selectGoal(args.trim());
        useGoalRunStore.getState().clear();
        client?.send?.({ type: 'goal.status', payload: { goalId: args.trim() } });
      }
      openMainView('goal');
      return true;
    case '/goal': // mission set/status + phase-run start/pause/resume/stop.
      return runGoalSlashCommand(args, client, addMessage);
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
      useUIStore.getState().setChangesPanelTab('worktrees');
      showPanel('changes');
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
    case '/mcp':
      return runMcpSlashCommand(args, client, addMessage);
    case '/browser':
    case '/network':
      // Runs on the host against the project policy file: sent as a prompt,
      // the model could only repeat the instruction back.
      client?.send?.({
        type: 'browser.policy',
        payload: client.withSession?.({ args }) ?? { args },
      });
      return true;
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
    case '/brain':
      return runBrainSlashCommand(args, client, addMessage);
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
    case '/auth': {
      const sub = args.split(/\s+/)[0]?.toLowerCase() ?? '';
      if (sub === 'help' || sub === '--help') {
        addMessage({
          role: 'assistant',
          content:
            'Use `/auth` to manage provider API keys and OAuth accounts in Settings → Providers. `/auth login` opens the same sign-in section.',
        });
        return true;
      }
      if (!['', 'open', 'menu', 'login', 'oauth', 'signin', 'status'].includes(sub)) {
        addMessage({ role: 'assistant', content: 'Usage: `/auth [login|status|open|help]`' });
        return true;
      }
      useUIStore.getState().setSettingsActiveTab('provider');
      openMainView('settings');
      return true;
    }
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
    case '/nextsteps':
      return runNextStepsModeCommand(args, client, addMessage);
    case '/yolo':
      return runYoloCommand(args, client, addMessage);
    case '/suggest':
    case '/next-steps':
      // Ask the agent to suggest next steps
      sendMsg(
        'Suggest exact prompt messages I can submit back to you. Each must ask you to perform the work and must not assign a manual chore to me. Be specific and actionable.',
      );
      return true;
    case '/bughunt':
    case '/sechunt':
    case '/secproof':
    case '/racehunt':
    case '/leakhunt':
    case '/flakehunt':
    case '/debloat':
    case '/deadcode':
    case '/excise':
    case '/uipolish':
    case '/a11yhunt':
    case '/uihunt':
    case '/typehunt':
    case '/boundaryhunt':
    case '/testgap':
    case '/covhunt':
    case '/invarianthunt':
      return runHuntSlashCommand({
        cmd,
        args,
        sessionId,
        isLoading,
        client,
        addMessage,
        setLoading,
      });
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
    case '/f12':
      return runFKeyPanelCommand(cmd, args, client, ws, addMessage);
    case '/design': {
      const sub = args.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
      if (sub === 'gallery' || sub === 'studio' || sub === 'open') {
        showPanel('design');
        return true;
      }
      if (runEngineSlashCommand(cmd, args, client, addMessage, sendMsg)) return true;
      // Fallback if engine command catalog hasn't hydrated yet: open studio on bare `/design`,
      // or forward `/design extract|compare|inspect ...` directly as a structured agent prompt.
      if (!sub) {
        showPanel('design');
        return true;
      }
      if (sub === 'extract' || sub === 'compare' || sub === 'inspect') {
        sendMsg(`/${cmd.slice(1)} ${args}`);
        return true;
      }
      return false;
    }
    case '/panel': {
      const tokens = args.trim().split(/\s+/).filter(Boolean);
      const sub = tokens[0]?.toLowerCase() ?? '';
      if (!sub || sub === 'open') {
        const targetId = sub === 'open' ? tokens[1] : undefined;
        if (openPluginUiModal(targetId)) return true;
      }
      return (
        runEngineSlashCommand(cmd, args, client, addMessage, sendMsg) ||
        runDirectEngineSlashCommand('panel', args, client, addMessage, sendMsg)
      );
    }
    case '/tree':
    case '/plugin':
    case '/image': {
      const bare = cmd.slice(1);
      return (
        runEngineSlashCommand(cmd, args, client, addMessage, sendMsg) ||
        runDirectEngineSlashCommand(bare, args, client, addMessage, sendMsg)
      );
    }
    default:
      // The engine's own commands (the TUI's that need no terminal) before the model.
      return runEngineSlashCommand(cmd, args, client, addMessage, sendMsg);
  }
}
