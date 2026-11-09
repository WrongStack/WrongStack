'use client';

import {
  ArrowDown,
  BookOpen,
  Brain,
  Check,
  Command,
  Compass,
  Copy,
  FileDiff,
  Folder,
  KeyRound,
  ListChecks,
  Menu,
  MessageSquare,
  Moon,
  PanelRight,
  Pencil,
  Plug,
  Plus,
  Search,
  Settings2,
  Sparkles,
  Sun,
  Users,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { hasAgentWork } from '../lib/agent-state';
import { uiVersion } from '../lib/build-info';
import { escapeClosesPanels } from '../lib/component-guards';
import { groupTranscript } from '../lib/transcript-view';
import { useSession } from '../lib/use-session';
import { AcpRuntime } from './acp-runtime';
import { ArtifactNavigation } from './artifact-navigation';
import { AssistantContent } from './assistant-content';
import { CommandPalette, type WorkspaceCommand } from './command-palette';
import { Composer } from './composer';
import { ContentView } from './content-view';
import { ContextDialog } from './context-dialog';
import { ConversationSearch } from './conversation-search';
import { Modal, PendingInteractions, Settings } from './dialogs';
import { FileBrowser } from './file-browser';
import { GettingStarted } from './getting-started';
import { InstructionsEditor } from './instructions-editor';
import { MarkdownContent } from './markdown-content';
import { EffortSelect, ModelPicker } from './model-picker';
import { DetailSwitch, usePresentation } from './presentation-mode';
import { ProviderManager } from './provider-manager';
import { ProviderQuotas } from './provider-quotas';
import { ResourceHub, type ResourceTab } from './resource-hub';
import { RoamingMascot } from './roaming-mascot';
import { SessionActions } from './session-actions';
import { SessionWorkStatus } from './session-work-status';
import { StartSpace } from './start-space';
import { StopAllDialog } from './stop-all-dialog';
import { StreamMeter } from './stream-meter';
import { ToolInspector } from './tool-inspector';
import { VibeBuddy, VibeMark } from './vibe-visuals';
import { WorkingActivity } from './working-activity';
import { WorkspaceNotes } from './workspace-notes';
import { WorkspacePanel } from './workspace-panel';
import { useWorkspacePreferences, WorkspaceViewMenu } from './workspace-preferences';

export function Workspace() {
  const { mode: presentation } = usePresentation();
  const { preferences, update: updatePreferences } = useWorkspacePreferences();
  const controller = useSession();
  const { state, connection, ready, modelPending, switchSession, switchModel, notice, send } =
    controller;
  const [sidebar, setSidebar] = useState(false);
  const [panel, setPanel] = useState(false);
  const [inspectedToolId, setInspectedToolId] = useState('');
  const [settings, setSettings] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const [agentView, setAgentView] = useState(0);
  const [filesOpen, setFilesOpen] = useState(false);
  const [providersOpen, setProvidersOpen] = useState(false);
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const [stopConfirm, setStopConfirm] = useState(false);
  const [resources, setResources] = useState<ResourceTab | null>(null);
  const [commandOpen, setCommandOpen] = useState(false);
  const [conversationSearch, setConversationSearch] = useState(false);
  const [instructionsOpen, setInstructionsOpen] = useState(false);
  const [panelRequest, setPanelRequest] = useState<{ tab: string; key: number }>({
    tab: 'activity',
    key: 0,
  });
  const [theme, setTheme] = useState('dark');
  const [palette, setPalette] = useState('sage');
  const [search, setSearch] = useState('');
  const [copied, setCopied] = useState('');
  const [hasDraft, setHasDraft] = useState(false);
  const [showLatest, setShowLatest] = useState(false);
  const [smallerModel, setSmallerModel] = useState<{
    provider: string;
    model: string;
    context: number;
  } | null>(null);
  const scroll = useRef<HTMLElement>(null);
  const stick = useRef(true);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    setPanel(preferences.view === 'studio' && window.innerWidth >= 1100);
    setSidebar(false);
  }, [preferences.view]);

  useEffect(() => {
    try {
      setTheme(localStorage.getItem('wrongstack.vibeui.theme') === 'light' ? 'light' : 'dark');
      const savedPalette = localStorage.getItem('wrongstack.vibeui.palette');
      if (savedPalette && ['sage', 'ocean', 'amber', 'violet'].includes(savedPalette))
        setPalette(savedPalette);
    } catch {
      /* Default theme. */
    }
    if (window.innerWidth < 1100) setPanel(false);
    return () => clearTimeout(copyTimer.current);
  }, []);
  useEffect(() => {
    const query = window.matchMedia('(max-width: 1099px)');
    const onChange = (event: MediaQueryListEvent) => {
      // Keep the panel while a dialog is open; yanking it mid-read is worse than overflow.
      if (event.matches && !document.querySelector('.modal-content')) setPanel(false);
    };
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem('wrongstack.vibeui.theme', theme);
    } catch {
      /* Optional preference. */
    }
  }, [theme]);
  useEffect(() => {
    document.documentElement.dataset.palette = palette;
    try {
      localStorage.setItem('wrongstack.vibeui.palette', palette);
    } catch {
      /* Optional preference. */
    }
  }, [palette]);
  useEffect(() => {
    if (stick.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [state.messages, state.running, state.tools, state.agents, state.runOutcome]);
  useEffect(() => {
    stick.current = true;
    setShowLatest(false);
    setInspectedToolId('');
  }, [state.id]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || document.querySelector('.modal-content')) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'p') {
        event.preventDefault();
        setCommandOpen(true);
      }
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'f') {
        event.preventDefault();
        setConversationSearch(true);
      }
      if ((event.metaKey || event.ctrlKey) && event.key === ',') {
        event.preventDefault();
        setSettings((open) => !open);
      }
      // Escape while typing belongs to the field, not to the layout.
      if (escapeClosesPanels(event)) {
        setSidebar(false);
        setPanel(false);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
  const toggleTheme = () => setTheme((value) => (value === 'dark' ? 'light' : 'dark'));
  const locked =
    !ready ||
    connection !== 'open' ||
    state.running ||
    state.agents.some((agent) =>
      ['running', 'busy', 'starting', 'spawned', 'working', 'active'].includes(agent.status),
    ) ||
    modelPending ||
    controller.compactPending;
  const latestAssistantId = state.messages
    .filter((message) => message.role === 'assistant')
    .at(-1)?.id;
  const liveAgents = state.agents.filter((a) =>
    ['running', 'busy', 'starting', 'spawned', 'working', 'active'].includes(a.status),
  );
  const activeSession = state.sessions.find((s) => s.id === state.id);
  const inspectedTool = state.tools.find((tool) => tool.id === inspectedToolId);
  const requestStop = () => {
    if (!controller.hasActiveWork || !ready || connection !== 'open') return;
    setStopConfirm(true);
  };
  const commands: WorkspaceCommand[] = [
    {
      id: 'guide',
      title: 'Getting started',
      detail: 'A friendly guide to your creative workspace',
      run: () => setGuideOpen(true),
    },
    {
      id: 'chat',
      title: 'Focus message',
      detail: 'Return to the composer',
      run: () =>
        document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')?.focus(),
    },
    {
      id: 'new',
      title: 'New session',
      detail: 'Start a fresh conversation',
      disabled: locked,
      run: () => switchSession(),
    },
    {
      id: 'history',
      title: 'Session history',
      detail: 'Find and resume a project conversation',
      run: () => setSessionsOpen(true),
    },
    {
      id: 'find',
      title: 'Search conversation',
      detail: 'Ctrl/Cmd+Shift+F · Find loaded messages',
      run: () => setConversationSearch(true),
    },
    {
      id: 'files',
      title: 'Files',
      detail: 'Browse project files and previews',
      run: () => setFilesOpen(true),
    },
    ...(['changes', 'tasks', 'agents'] as const).map((tab) => ({
      id: tab,
      title: tab[0]!.toUpperCase() + tab.slice(1),
      detail: 'Open workspace panel',
      run: () => {
        setPanel(true);
        setPanelRequest((v) => ({ tab, key: v.key + 1 }));
      },
    })),
    ...(['prompts', 'skills', 'tools', 'mcp', 'memory'] as const).map((tab) => ({
      id: tab,
      title: tab === 'mcp' ? 'MCP connections' : tab[0]!.toUpperCase() + tab.slice(1),
      detail: 'Open workspace resources',
      run: () => setResources(tab),
    })),
    {
      id: 'providers',
      title: 'Providers & accounts',
      detail: 'API keys and subscription sign-in',
      run: () => setProvidersOpen(true),
    },
    {
      id: 'context',
      title: 'Context window',
      detail: 'Tokens, cache and conversation content',
      run: () => setContextOpen(true),
    },
    {
      id: 'instructions',
      title: 'Personal instructions',
      detail: 'Review and edit global agent instructions',
      run: () => setInstructionsOpen(true),
    },
    {
      id: 'settings',
      title: 'Settings',
      detail: 'Ctrl/Cmd+, · Agent behavior and appearance',
      run: () => setSettings(true),
    },
    {
      id: 'theme',
      title: 'Toggle appearance',
      detail: 'Switch light / dark theme',
      run: () => toggleTheme(),
    },
    {
      id: 'stop',
      title: 'Stop all tasks',
      detail: 'Stop this session and its agents; pause queued messages',
      disabled: !controller.hasActiveWork || !ready || connection !== 'open',
      run: requestStop,
    },
    ...state.sessions.map((session) => ({
      id: `session-${session.id}`,
      title: session.title,
      detail: 'Resume session',
      disabled: locked,
      run: () => {
        if (session.id !== state.id) switchSession(session.id);
      },
    })),
  ];
  const chooseModel = useCallback(
    (provider: string, model: string, context: number) => {
      if (provider === state.provider && model === state.model) return;
      if (context > 0 && state.maxContext > context) setSmallerModel({ provider, model, context });
      else switchModel(provider, model);
    },
    [state.provider, state.model, state.maxContext, switchModel],
  );
  const refreshModels = useCallback(() => {
    send('providers.saved');
    send('providers.list');
  }, [send]);
  const copy = async (id: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(id);
      clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(''), 1800);
    } catch {
      notice('Clipboard is unavailable in this browser. Select the text to copy it.');
    }
  };
  return (
    <ArtifactNavigation.Provider
      value={(path) => {
        controller.openArtifact({
          id: `file:${path}`,
          sessionId: state.id,
          path,
          title: path.split('/').at(-1) || path,
          kind: /\.(png|jpe?g|webp|gif)$/i.test(path) ? 'image' : 'text',
        });
        setFilesOpen(true);
      }}
    >
      <div
        data-view={preferences.view}
        className={`vibe-shell ${sidebar ? 'sidebar-open' : ''} ${panel ? 'panel-open' : ''}`}
      >
        {sidebar && (
          <button
            type="button"
            className="sidebar-backdrop"
            aria-label="Close sessions"
            onClick={() => setSidebar(false)}
          />
        )}
        <aside className="session-sidebar" aria-label="Workspace navigation">
          <a className="brand" href="/" aria-label="VibeUI home">
            <span className="brand-mark">
              <VibeMark />
            </span>
            <strong>
              vibe<span>ui</span>
            </strong>
            <span className="brand-tag">by WrongStack</span>
          </a>
          <button
            type="button"
            className="new-session"
            disabled={locked}
            onClick={() => {
              switchSession();
              setSidebar(false);
            }}
          >
            <Plus size={17} />
            New session<span>↗</span>
          </button>
          <nav className="workspace-navigation" aria-label="Workspace shortcuts">
            <button
              type="button"
              className="quick-actions"
              onClick={() => {
                setSidebar(false);
                setCommandOpen(true);
              }}
            >
              <Command size={13} />
              Quick actions<kbd>Ctrl P</kbd>
            </button>
            <span className="nav-section-label">Workspace</span>
            <button
              type="button"
              aria-current="page"
              onClick={() => {
                setSidebar(false);
                document.querySelector('textarea[aria-label="Message"]')?.scrollIntoView();
              }}
            >
              <MessageSquare size={16} />
              Chat
            </button>
            <button
              type="button"
              aria-expanded={filesOpen}
              onClick={() => {
                setSidebar(false);
                setFilesOpen(true);
              }}
            >
              <Folder size={16} />
              Files
            </button>
            <button
              type="button"
              onClick={() => {
                setSidebar(false);
                setPanel(true);
                setPanelRequest((v) => ({ tab: 'changes', key: v.key + 1 }));
              }}
            >
              <FileDiff size={16} />
              Changes {state.files.length > 0 && <small>{state.files.length}</small>}
            </button>
            <button
              type="button"
              onClick={() => {
                setSidebar(false);
                setPanel(true);
                setPanelRequest((v) => ({ tab: 'tasks', key: v.key + 1 }));
              }}
            >
              <ListChecks size={16} />
              Tasks
            </button>
            <button
              type="button"
              onClick={() => {
                setSidebar(false);
                setPanel(true);
                setAgentView((v) => v + 1);
              }}
            >
              <Users size={16} />
              Agents <small>{liveAgents.length || ''}</small>
            </button>
            <span className="nav-section-label">Resources</span>
            <button
              type="button"
              aria-expanded={providersOpen}
              onClick={() => {
                setSidebar(false);
                setProvidersOpen(true);
              }}
            >
              <KeyRound size={16} />
              Providers
            </button>
            <button
              type="button"
              aria-expanded={
                resources === 'prompts' || resources === 'skills' || resources === 'memory'
              }
              onClick={() => {
                setSidebar(false);
                setResources('prompts');
              }}
            >
              <BookOpen size={16} />
              Library
            </button>
            <button
              type="button"
              aria-expanded={resources === 'tools' || resources === 'mcp'}
              onClick={() => {
                setSidebar(false);
                setResources('tools');
              }}
            >
              <Plug size={16} />
              Tools & MCP
            </button>
          </nav>
          <div className="sidebar-section-title">
            RECENT SESSIONS
            <button
              type="button"
              onClick={() => {
                setSidebar(false);
                setSessionsOpen(true);
              }}
            >
              View all
            </button>
          </div>
          <nav className="session-list" aria-label="Recent sessions">
            {!state.sessions.length && (
              <p className="session-placeholder">Your conversations will find a home here.</p>
            )}
            {state.sessions.slice(0, 5).map((session) => (
              <button
                type="button"
                className={`session-row ${session.id === state.id ? 'active' : ''}`}
                key={session.id}
                disabled={locked}
                onClick={() => {
                  if (session.id !== state.id) switchSession(session.id);
                  setSidebar(false);
                }}
              >
                <MessageSquare size={14} />
                <span>{session.title}</span>
                {session.id === state.id && (
                  <span className={`status-dot ${state.running ? 'busy' : ''}`} />
                )}
              </button>
            ))}
          </nav>
          <div className="sidebar-bottom">
            <ProviderQuotas controller={controller} />
            <div className="project-card">
              <span className="project-icon">
                <Folder size={16} />
              </span>
              <span>
                <strong>{state.project || 'Your workspace'}</strong>
                <small title={state.cwd}>{state.cwd || 'Connecting to WrongStack'}</small>
              </span>
            </div>
            <div className="sidebar-footer">
              <button type="button" onClick={() => setSettings(true)}>
                <Settings2 size={15} />
                Settings
              </button>
              <button
                type="button"
                className="icon-button"
                aria-label="Getting started"
                title="Getting started"
                onClick={() => setGuideOpen(true)}
              >
                <Compass size={16} />
              </button>
              <button
                type="button"
                className="icon-button"
                aria-label={`Use ${theme === 'dark' ? 'light' : 'dark'} theme`}
                onClick={toggleTheme}
              >
                {theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}
              </button>
            </div>
            <button type="button" className="version-info" onClick={() => setSettings(true)}>
              VibeUI v{uiVersion}
              {state.appVersion && <span> · WrongStack v{state.appVersion}</span>}
              {state.updateAvailable && <span> · Update available</span>}
            </button>
          </div>
        </aside>

        <div className="main-workspace">
          <header className="workspace-header">
            <div className="header-project">
              <button
                type="button"
                className="icon-button mobile-menu"
                aria-label="Open sessions"
                onClick={() => setSidebar((open) => !open)}
              >
                <Menu size={18} />
              </button>
              {preferences.view === 'cozy' ? (
                <RoamingMascot
                  working={controller.hasActiveWork}
                  connected={connection === 'open'}
                  outcome={state.runOutcome}
                  attention={state.agents.some(
                    (agent) =>
                      hasAgentWork(agent) &&
                      [
                        'failed',
                        'error',
                        'stopped',
                        'interrupted',
                        'cancelled',
                        'aborted',
                      ].includes(agent.status),
                  )}
                  onFiles={() => setFilesOpen(true)}
                  onIdeas={() => setResources('prompts')}
                  onMemory={() => setResources('memory')}
                  onNewChat={() => switchSession()}
                  newChatLocked={locked}
                />
              ) : (
                preferences.view === 'focus' && (
                  <span className="cozy-brand">
                    <VibeBuddy small />
                  </span>
                )
              )}
              <Folder size={15} />
              <span>{state.project || 'Workspace'}</span>
              <span className="breadcrumb">/</span>
              <strong>{activeSession?.title || 'New session'}</strong>
            </div>
            <div className="header-actions">
              <WorkspaceViewMenu
                onChoose={() => {
                  setSidebar(false);
                  setPanel(false);
                }}
              />
              <button
                type="button"
                className="icon-button"
                aria-label="Files"
                title="Files"
                onClick={() => setFilesOpen(true)}
              >
                <Folder size={17} />
              </button>
              <SessionActions
                controller={controller}
                title={activeSession?.title || 'New session'}
              />
              <span className="connection-chip">
                <span
                  className={`status-dot ${connection !== 'open' ? 'error' : controller.hasActiveWork ? 'busy' : ''}`}
                />
                {connection !== 'open'
                  ? 'Reconnecting'
                  : controller.hasActiveWork
                    ? 'Working'
                    : 'Ready'}
              </span>
              <button
                type="button"
                className={`icon-button ${panel ? 'is-active' : ''}`}
                aria-label="Toggle workspace"
                aria-expanded={panel}
                onClick={() => setPanel((open) => !open)}
              >
                <PanelRight size={18} />
              </button>
            </div>
          </header>
          {preferences.view === 'studio' && (
            <div className="experience-bar">
              <span>
                <Sparkles size={13} /> Your creative workspace
              </span>
              <div>
                <DetailSwitch />
                <button
                  type="button"
                  className="experience-guide"
                  onClick={() => setGuideOpen(true)}
                >
                  <Compass size={14} />
                  <span>Quick tour</span>
                </button>
              </div>
            </div>
          )}
          {preferences.view === 'cozy' && preferences.shortcuts && (
            <nav className="cozy-shortcuts" aria-label="Handy shortcuts">
              <span>A little help?</span>
              <button type="button" onClick={() => setFilesOpen(true)}>
                <Folder size={14} /> My files
              </button>
              <button type="button" onClick={() => setResources('prompts')}>
                <BookOpen size={14} /> Ideas & skills
              </button>
              <button type="button" onClick={() => setResources('memory')}>
                <Brain size={14} /> Memory
              </button>
              <button
                type="button"
                className="icon-button"
                aria-label="Hide quick shortcuts"
                title="Tuck these away"
                onClick={() => updatePreferences({ shortcuts: false })}
              >
                <X size={13} />
              </button>
            </nav>
          )}
          {controller.sessionTransition && (
            <div className="notice" role="status">
              Switching session: {controller.sessionTransition}. Input stays locked until the new
              session is loaded.
            </div>
          )}
          {state.notice && (
            <div className="notice" role="status">
              <span>{state.notice}</span>
              <button
                type="button"
                className="icon-button"
                aria-label="Dismiss notice"
                onClick={() => notice('')}
              >
                <X size={13} />
              </button>
            </div>
          )}
          <main
            className="conversation"
            ref={scroll}
            onScroll={() => {
              const el = scroll.current;
              if (!el) return;
              stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
              setShowLatest(!stick.current);
            }}
          >
            {!state.messages.length ? (
              <StartSpace
                key={state.id || 'connecting'}
                project={state.project}
                canPrepare={
                  ready &&
                  Boolean(state.id) &&
                  connection === 'open' &&
                  !controller.sessionTransition
                }
                needsProvider={ready && !state.model}
                onPrepare={controller.prepareDraft}
                onConnect={() => setProvidersOpen(true)}
              />
            ) : (
              <div className="transcript">
                {groupTranscript(
                  state.messages.filter(
                    (message) =>
                      message.role !== 'thinking' || state.prefs.showModelReasoning !== false,
                  ),
                ).map((row) => {
                  if (row.kind === 'workspace')
                    return <WorkspaceNotes key={row.id} notes={row.notes} />;
                  const message = row.message;
                  return (
                    <article
                      className={`message message-${message.role}`}
                      key={message.id}
                      id={`chat-${message.id}`}
                      tabIndex={-1}
                    >
                      <div className="message-heading">
                        <span
                          className={`message-avatar ${message.role} ${message.streaming ? 'is-writing' : ''}`}
                        >
                          {message.role === 'user' ? (
                            'Y'
                          ) : message.role === 'assistant' ? (
                            <VibeMark />
                          ) : message.role === 'system' ? (
                            '·'
                          ) : (
                            <Sparkles size={13} />
                          )}
                        </span>
                        <strong>
                          {message.role === 'user'
                            ? 'You'
                            : message.role === 'assistant'
                              ? 'WrongStack'
                              : message.role === 'thinking'
                                ? 'Thinking'
                                : 'Workspace'}
                        </strong>
                        {message.delivery === 'btw' && (
                          <small className="streaming-label">BTW · sent during this run</small>
                        )}
                        {message.streaming && (
                          <span className="streaming-label">
                            writing<span>…</span>
                          </span>
                        )}
                        {message.role === 'assistant' && !message.streaming && (
                          <button
                            type="button"
                            className="icon-button copy-message"
                            aria-label="Copy response"
                            title={copied === message.id ? 'Copied' : 'Copy response'}
                            onClick={() => void copy(message.id, message.text)}
                          >
                            {copied === message.id ? <Check size={13} /> : <Copy size={13} />}
                          </button>
                        )}
                        {message.role === 'user' && (
                          <button
                            type="button"
                            className="icon-button copy-message"
                            aria-label="Restore message to composer"
                            title="Restore to composer"
                            onClick={() =>
                              controller.prepareDraft(
                                message.text,
                                (message.images ?? []).map((image, i) => ({
                                  ...image,
                                  id: `${message.id}-${i}`,
                                  name: `Attachment ${i + 1}`,
                                })),
                              )
                            }
                          >
                            <Pencil size={13} />
                          </button>
                        )}
                      </div>
                      {message.images && message.images.length > 0 && (
                        <div className="chat-images">
                          {message.images
                            .filter((image) =>
                              ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(
                                image.mediaType,
                              ),
                            )
                            .map((image, i) => (
                              <img
                                key={i}
                                src={`data:${image.mediaType};base64,${image.data}`}
                                alt={`Attachment ${i + 1}`}
                              />
                            ))}
                        </div>
                      )}
                      {message.role === 'thinking' ? (
                        <details className="thinking-block">
                          <summary>
                            <Brain size={13} />
                            {message.streaming ? 'Thinking…' : 'Thinking / reasoning'}
                          </summary>
                          <MarkdownContent text={message.text} />
                        </details>
                      ) : message.role === 'assistant' ? (
                        <AssistantContent
                          text={message.text}
                          showSteps={
                            !state.running &&
                            !state.runFailure &&
                            message.final === true &&
                            message.id === latestAssistantId
                          }
                          onPick={controller.prepareDraft}
                          onSubmit={(value, automatic) =>
                            controller.submitNext(value, message.id, automatic)
                          }
                          automatic={
                            state.prefs.autonomy === 'auto' &&
                            (state.prefs.yolo === true || state.prefs.yoloPlus === true) &&
                            message.autoEligible === true &&
                            !hasDraft &&
                            !controller.queue.length &&
                            !controller.autoLimitReached &&
                            connection === 'open' &&
                            ready &&
                            !locked
                          }
                          autoDelayMs={Number(state.prefs.autonomyDelayMs) || 15000}
                        />
                      ) : message.text === 'Runtime context' &&
                        message.runtimeContext?.length ? null : (
                        <MarkdownContent text={message.text} />
                      )}
                      {message.runtimeContext && (
                        <details
                          className="runtime-context"
                          key={presentation}
                          open={presentation === 'extended'}
                        >
                          <summary>
                            Runtime context · {message.runtimeContext.length}{' '}
                            {message.runtimeContext.length === 1 ? 'note' : 'notes'} added by
                            WrongStack
                          </summary>
                          {message.runtimeContext.map((note, index) => (
                            <ContentView key={index} value={note} label="Runtime context" />
                          ))}
                        </details>
                      )}
                    </article>
                  );
                })}
                {state.running && (
                  <WorkingActivity
                    compact={preferences.view !== 'studio'}
                    tools={state.tools}
                    onInspect={setInspectedToolId}
                    onViewActivity={() => {
                      setPanel(true);
                      setAgentView(0);
                      setPanelRequest((v) => ({ tab: 'activity', key: v.key + 1 }));
                    }}
                  />
                )}
              </div>
            )}
            <SessionWorkStatus
              state={state}
              connected={connection === 'open'}
              canStop={ready && !controller.sessionTransition}
              onStop={requestStop}
              onWatch={() => {
                setPanel(true);
                setAgentView((value) => value + 1);
              }}
            />
          </main>
          {showLatest && state.messages.length > 0 && (
            <button
              type="button"
              className="jump-latest"
              onClick={() => {
                if (scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
                stick.current = true;
                setShowLatest(false);
              }}
            >
              <ArrowDown size={13} />
              Latest
            </button>
          )}
          <StreamMeter activity={state.streamActivity} running={state.running} />
          <div className="session-toolbar">
            <div className="model-controls">
              <ModelPicker
                models={state.models}
                providers={state.providers}
                provider={state.provider}
                model={state.model}
                locked={locked}
                pending={modelPending}
                onChoose={chooseModel}
                onSettings={setProvidersOpen}
                onRefresh={refreshModels}
              />
              {state.provider === 'acp' ? (
                <AcpRuntime
                  state={state}
                  disabled={locked}
                  send={controller.send}
                  subscribe={controller.subscribe}
                />
              ) : (
                <EffortSelect state={state} disabled={locked} onChange={controller.setEffort} />
              )}
            </div>
            <button
              type="button"
              aria-label="View context"
              onClick={() => setContextOpen(true)}
              className="context-summary"
              title={`${state.tokens.toLocaleString()} / ${state.maxContext.toLocaleString()} context tokens${state.cache ? ` · cache hit ${Math.round((state.cache.lastHitRatio ?? state.cache.hitRatio) * 100)}%` : ''}`}
            >
              <span className="context-track">
                <span style={{ width: `${Math.min(100, state.load * 100)}%` }} />
              </span>
              <span className="context-label">
                {presentation === 'simple' ? (
                  <>Conversation space · {Math.round(state.load * 100)}%</>
                ) : (
                  <>
                    {Intl.NumberFormat('en', {
                      notation: 'compact',
                      maximumFractionDigits: 1,
                    }).format(state.tokens)}{' '}
                    /{' '}
                    {Intl.NumberFormat('en', {
                      notation: 'compact',
                      maximumFractionDigits: 1,
                    }).format(state.maxContext)}{' '}
                    <span className="context-percentage"> · {Math.round(state.load * 100)}%</span>
                    {state.cache && (
                      <span className="context-cache">
                        {' '}
                        · cache{' '}
                        {Math.round((state.cache.lastHitRatio ?? state.cache.hitRatio) * 100)}%
                      </span>
                    )}
                  </>
                )}
              </span>
            </button>
            {typeof state.prefs.autonomy === 'string' && (
              <button
                type="button"
                className="runtime-chip"
                aria-label="Agent settings"
                onClick={() => setSettings(true)}
              >
                {state.mode || 'Default'} · {state.prefs.autonomy}
                {state.prefs.yoloPlus === true
                  ? ' · YOLO+'
                  : state.prefs.yolo === true
                    ? ' · YOLO'
                    : ''}
              </button>
            )}
            {liveAgents.length > 0 && (
              <button
                type="button"
                className="agent-count"
                aria-label="View agents"
                title={`${liveAgents.length} active ${liveAgents.length === 1 ? 'agent' : 'agents'}`}
                onClick={() => {
                  setPanel(true);
                  setAgentView((value) => value + 1);
                }}
              >
                <Users size={13} /> {liveAgents.length}
              </button>
            )}
          </div>
          <Composer
            key={`${state.id || 'connecting'}-${controller.clearGeneration}`}
            controller={controller}
            onDraftChange={setHasDraft}
            onStopRequest={requestStop}
          />
        </div>
        {panel && (
          <>
            {preferences.view !== 'studio' && (
              <button
                type="button"
                className="workspace-backdrop"
                aria-label="Close workspace panel"
                onClick={() => setPanel(false)}
              />
            )}
            <WorkspacePanel
              controller={controller}
              revealAgents={agentView}
              requestedView={panelRequest}
              onClose={() => setPanel(false)}
            />
          </>
        )}
        {inspectedTool && (
          <ToolInspector
            key={inspectedTool.id}
            tool={inspectedTool}
            onClose={() => setInspectedToolId('')}
          />
        )}
        <Settings
          controller={controller}
          open={settings}
          onClose={() => setSettings(false)}
          theme={theme}
          palette={palette}
          setPalette={setPalette}
          toggleTheme={toggleTheme}
          onProviders={() => {
            setSettings(false);
            setProvidersOpen(true);
          }}
          onInstructions={() => {
            setSettings(false);
            setInstructionsOpen(true);
          }}
        />
        <GettingStarted
          open={guideOpen}
          onOpenChange={setGuideOpen}
          onFocus={() => {
            setGuideOpen(false);
            requestAnimationFrame(() =>
              document
                .querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')
                ?.focus(),
            );
          }}
          onChanges={() => {
            setGuideOpen(false);
            setPanel(true);
            setPanelRequest((value) => ({ tab: 'changes', key: value.key + 1 }));
          }}
          onSettings={() => {
            setGuideOpen(false);
            setSettings(true);
          }}
        />
        <StopAllDialog
          open={stopConfirm}
          leaderRunning={state.running}
          agentNames={liveAgents.map((agent) => agent.name || agent.id)}
          onCancel={() => setStopConfirm(false)}
          onConfirm={() => {
            if (controller.stopAll()) setStopConfirm(false);
          }}
        />
        <ContextDialog controller={controller} open={contextOpen} onOpenChange={setContextOpen} />
        <Modal
          open={filesOpen}
          onOpenChange={setFilesOpen}
          title="Files"
          detailToggle
          icon={<Folder size={20} />}
          description="Read a file or add it to your next message."
          wide
        >
          {filesOpen && (
            <FileBrowser
              key={state.id}
              controller={controller}
              onReference={() => setFilesOpen(false)}
            />
          )}
        </Modal>
        {providersOpen && (
          <ProviderManager controller={controller} onClose={() => setProvidersOpen(false)} />
        )}
        {resources && (
          <ResourceHub
            key={`${state.id}-${resources}`}
            controller={controller}
            initialTab={resources}
            onClose={() => setResources(null)}
          />
        )}
        {instructionsOpen && (
          <InstructionsEditor
            key={state.id}
            controller={controller}
            onClose={() => setInstructionsOpen(false)}
          />
        )}
        {conversationSearch && (
          <ConversationSearch
            messages={state.messages}
            onClose={() => setConversationSearch(false)}
            onJump={(id) => {
              stick.current = false;
              setShowLatest(true);
              requestAnimationFrame(() => {
                const target = document.getElementById(`chat-${id}`);
                let ancestor = target?.parentElement;
                while (ancestor) {
                  if (ancestor instanceof HTMLDetailsElement) ancestor.open = true;
                  ancestor = ancestor.parentElement;
                }
                target?.scrollIntoView({ block: 'center' });
                target?.focus({ preventScroll: true });
              });
            }}
          />
        )}
        {commandOpen && (
          <CommandPalette commands={commands} onClose={() => setCommandOpen(false)} />
        )}
        <Modal
          open={sessionsOpen}
          onOpenChange={setSessionsOpen}
          title="Sessions"
          icon={<MessageSquare size={20} />}
          description="Search and resume conversations in this project."
        >
          <label className="session-search">
            <Search size={14} />
            <input
              aria-label="Search sessions"
              placeholder="Find a session…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </label>
          <nav className="all-sessions" aria-label="All sessions">
            {state.sessions
              .filter((session) => session.title.toLowerCase().includes(search.toLowerCase()))
              .map((session) => (
                <button
                  type="button"
                  key={session.id}
                  className={`session-row ${session.id === state.id ? 'active' : ''}`}
                  disabled={locked}
                  onClick={() => {
                    if (session.id !== state.id) switchSession(session.id);
                    setSessionsOpen(false);
                  }}
                >
                  <MessageSquare size={14} />
                  <span>{session.title}</span>
                </button>
              ))}
          </nav>
        </Modal>
        <PendingInteractions controller={controller} />
        <Modal
          open={Boolean(smallerModel)}
          onOpenChange={(open) => {
            if (!open) setSmallerModel(null);
          }}
          title="A smaller context window"
          description={`This model supports ${smallerModel?.context.toLocaleString() ?? ''} tokens. Switching may compact the conversation.`}
        >
          <div className="dialog-actions">
            <button
              type="button"
              className="secondary-button"
              onClick={() => setSmallerModel(null)}
            >
              Keep current model
            </button>
            <button
              type="button"
              className="primary-button"
              onClick={() => {
                if (smallerModel) switchModel(smallerModel.provider, smallerModel.model);
                setSmallerModel(null);
              }}
            >
              Switch model
            </button>
          </div>
        </Modal>
      </div>
    </ArtifactNavigation.Provider>
  );
}
