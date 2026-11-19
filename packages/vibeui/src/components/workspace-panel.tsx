'use client';

import {
  Check,
  ChevronRight,
  FileCode2,
  FileDiff,
  ListChecks,
  RefreshCw,
  TerminalSquare,
  Users,
  X,
} from 'lucide-react';
import { Tabs } from 'radix-ui';
import { useEffect, useState } from 'react';
import { compareLines } from '../lib/diff';
import { record, text } from '../lib/session';
import type { SessionController } from '../lib/use-session';
import { AgentMonitor } from './agent-monitor';
import { CodePanel } from './code-panel';
import { ContentView } from './content-view';
import { Modal } from './dialogs';
import { ToolInspector } from './tool-inspector';
import { EmptyArtwork } from './vibe-visuals';

export function WorkspacePanel({
  controller,
  onClose,
  revealAgents = 0,
  requestedView,
}: {
  controller: SessionController;
  onClose: () => void;
  revealAgents?: number;
  requestedView?: { tab: string; key: number };
}) {
  const { state, send, connection, refreshWorkspace } = controller;
  const [tab, setTab] = useState('activity');
  const [selectedPath, setSelectedPath] = useState('');
  const selectedDiff = selectedPath ? state.diffs[selectedPath] : undefined;
  const [inspectedTool, setInspectedTool] = useState('');
  const selectedTool = state.tools.find((tool) => tool.id === inspectedTool);
  useEffect(() => {
    if (requestedView?.key) setTab(requestedView.tab);
  }, [requestedView]);
  useEffect(() => {
    if (revealAgents) setTab('agents');
  }, [revealAgents]);
  useEffect(() => {
    setSelectedPath('');
    setInspectedTool('');
  }, [state.id]);
  return (
    <aside className="workspace-panel" aria-label="Workspace">
      <header>
        <span className="eyebrow">WORKSPACE</span>
        <div>
          <button
            type="button"
            className="icon-button"
            aria-label="Refresh workspace"
            disabled={connection !== 'open'}
            onClick={refreshWorkspace}
          >
            <RefreshCw size={14} />
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label="Close workspace"
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </div>
      </header>
      <Tabs.Root value={tab} onValueChange={setTab} className="workspace-tabs">
        <Tabs.List aria-label="Workspace views" className="tab-list">
          <Tabs.Trigger value="activity">
            <TerminalSquare size={14} />
            Activity
          </Tabs.Trigger>
          <Tabs.Trigger value="changes">
            <FileDiff size={14} />
            Changes <span>{state.files.length}</span>
          </Tabs.Trigger>
          <Tabs.Trigger value="tasks">
            <ListChecks size={14} />
            Tasks
          </Tabs.Trigger>

          <Tabs.Trigger value="agents">
            <Users size={14} />
            Agents
          </Tabs.Trigger>
        </Tabs.List>
        <Tabs.Content value="agents" className="panel-content">
          <AgentMonitor key={state.id} agents={state.agents} connected={connection === 'open'} />
        </Tabs.Content>

        <Tabs.Content value="changes" className="panel-content">
          <div className="panel-section-heading">
            <h2>Working changes</h2>
            <span>{state.files.length} files</span>
          </div>
          {!state.files.length && (
            <PanelEmpty
              kind="changes"
              title="A clean slate"
              detail="Changed files will appear here as you build."
            />
          )}
          <div className="changed-files">
            {state.files.map((file) => (
              <div key={file.path}>
                <button
                  type="button"
                  className={`file-row ${selectedPath === file.path ? 'selected' : ''}`}
                  disabled={connection !== 'open'}
                  onClick={() => {
                    setSelectedPath(file.path);
                    send('git.diff', { sessionId: state.id, path: file.path });
                  }}
                >
                  <FileCode2 size={15} />
                  <span title={file.path}>{file.path}</span>
                  <small className="diff-add">{file.additions ? `+${file.additions}` : ''}</small>
                  <small className="diff-remove">
                    {file.deletions ? `−${file.deletions}` : ''}
                  </small>
                  <b>{file.status}</b>
                </button>
              </div>
            ))}
          </div>
          {selectedPath && (
            <Modal
              open
              onOpenChange={(open) => {
                if (!open) setSelectedPath('');
              }}
              title={selectedPath}
              icon={<FileDiff size={20} />}
              description="Working tree changes · compare diff, before and after."
              wide
            >
              <div className="diff-view">
                {!selectedDiff ? (
                  <p className="panel-hint">Loading file…</p>
                ) : selectedDiff.error ? (
                  <p role="status">{selectedDiff.error}</p>
                ) : (
                  <Tabs.Root defaultValue="diff">
                    <Tabs.List className="diff-tabs" aria-label="File version">
                      <Tabs.Trigger value="diff">Diff</Tabs.Trigger>
                      <Tabs.Trigger value="before">Before</Tabs.Trigger>
                      <Tabs.Trigger value="after">After</Tabs.Trigger>
                    </Tabs.List>
                    <Tabs.Content value="diff">
                      <div className="file-lines">
                        <pre>
                          {compareLines(selectedDiff.oldText, selectedDiff.newText)
                            .slice(0, 2000)
                            .map((line, i) => (
                              <span className={`code-line line-${line.kind}`} key={i}>
                                <span>{line.newLine ?? line.oldLine}</span>
                                {line.kind === 'add' ? '+' : line.kind === 'remove' ? '−' : ' '}{' '}
                                {line.text || ' '}
                              </span>
                            ))}
                        </pre>
                      </div>
                    </Tabs.Content>
                    <Tabs.Content value="before">
                      <CodePanel
                        value={selectedDiff.oldText}
                        label="Before"
                        language={selectedPath}
                        formatJson={false}
                      />
                    </Tabs.Content>
                    <Tabs.Content value="after">
                      <CodePanel
                        value={selectedDiff.newText}
                        label="After"
                        language={selectedPath}
                        formatJson={false}
                      />
                    </Tabs.Content>
                  </Tabs.Root>
                )}
              </div>
            </Modal>
          )}
        </Tabs.Content>
        <Tabs.Content value="tasks" className="panel-content">
          {!state.todos.length && !state.tasks.length && !state.plan.length && (
            <PanelEmpty
              kind="tasks"
              title="Room for a plan"
              detail="The agent’s plan and tasks will appear here when available."
            />
          )}
          {[
            { title: 'To-do', items: state.todos },
            { title: 'Plan', items: state.plan },
            { title: 'Tasks', items: state.tasks },
          ]
            .filter((group) => group.items.length)
            .map((group) => (
              <section className="task-section" key={group.title}>
                <h2>{group.title}</h2>
                {group.items.map((task) => (
                  <div
                    className={`task-row ${task.status === 'completed' || task.status === 'done' ? 'complete' : ''}`}
                    key={task.id}
                  >
                    <span className="task-check">
                      {task.status === 'completed' || task.status === 'done' ? (
                        <Check size={12} />
                      ) : task.status === 'in_progress' ? (
                        <span className="status-dot busy" />
                      ) : null}
                    </span>
                    <span>
                      {task.title}
                      <small>{task.status.replaceAll('_', ' ')}</small>
                    </span>
                  </div>
                ))}
              </section>
            ))}
        </Tabs.Content>
        <Tabs.Content value="activity" className="panel-content">
          {state.artifacts.length > 0 && (
            <section className="task-section">
              <h2>Outputs</h2>
              {state.artifacts.map((artifact) => (
                <button
                  type="button"
                  className="file-row"
                  key={artifact.id}
                  disabled={connection !== 'open'}
                  onClick={() => controller.openArtifact(artifact)}
                >
                  <FileCode2 size={15} />
                  <span>{artifact.title}</span>
                  <ChevronRight size={13} />
                </button>
              ))}
            </section>
          )}
          {state.preview && (
            <section className="artifact-preview">
              <div className="panel-section-heading">
                <h3>{state.preview.artifact.title}</h3>
                <button
                  type="button"
                  className="icon-button"
                  aria-label="Close output preview"
                  onClick={controller.closeArtifact}
                >
                  <X size={14} />
                </button>
              </div>
              {state.preview.loading ? (
                <p className="panel-hint">Loading output…</p>
              ) : state.preview.error ? (
                <p role="status" className="panel-hint">
                  {state.preview.error}
                </p>
              ) : state.preview.artifact.kind === 'image' ? (
                <img src={state.preview.content} alt={state.preview.artifact.title} />
              ) : (
                <ContentView value={state.preview.content} label="Output" />
              )}
            </section>
          )}
          <div className="panel-section-heading">
            <h2>Behind the scenes</h2>
            <span>{state.tools.length} calls</span>
          </div>
          {!state.tools.length && (
            <PanelEmpty
              kind="activity"
              title="Quiet for now"
              detail="Tool calls and their results stay here, out of your way."
            />
          )}
          {state.tools
            .slice()
            .reverse()
            .map((tool) => (
              <details className="tool-card" key={tool.id}>
                <summary>
                  <span
                    className={`status-dot ${tool.status === 'running' ? 'busy' : tool.status === 'error' || tool.status === 'interrupted' ? 'error' : ''}`}
                  />
                  <span>{tool.name}</span>
                  <small>{tool.status}</small>
                  <ChevronRight size={13} />
                </summary>
                <div className="tool-card-preview">
                  <p>
                    {text(record(tool.input).path) ||
                      text(record(tool.input).file_path) ||
                      text(record(tool.input).command) ||
                      text(record(tool.input).query) ||
                      'Tool arguments and full result are available to inspect.'}
                  </p>
                  {tool.output && (
                    <p className="tool-result-preview">
                      {tool.output.replace(/\s+/g, ' ').slice(0, 200)}
                    </p>
                  )}
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => setInspectedTool(tool.id)}
                  >
                    Inspect call
                  </button>
                </div>
              </details>
            ))}
        </Tabs.Content>
      </Tabs.Root>
      {selectedTool && (
        <ToolInspector
          key={selectedTool.id}
          tool={selectedTool}
          onClose={() => setInspectedTool('')}
        />
      )}
      <footer>
        <span className={`status-dot ${connection === 'open' ? '' : 'error'}`} />
        {connection === 'open' ? 'Local workspace' : 'Connection interrupted — reconnecting'}
      </footer>
    </aside>
  );
}

function PanelEmpty({
  kind,
  title,
  detail,
}: {
  kind: 'activity' | 'changes' | 'tasks';
  title: string;
  detail: string;
}) {
  return (
    <div className="panel-empty">
      <EmptyArtwork kind={kind} />
      <h3>{title}</h3>
      <p>{detail}</p>
    </div>
  );
}
