import {
  ArrowUpRight,
  BookOpen,
  ClipboardList,
  Coins,
  Folder,
  History,
  KeyRound,
  ListChecks,
  Plug,
  ShieldCheck,
  Terminal,
  X,
} from 'lucide-react';
import { useEffect, useRef } from 'react';

export function WorkspaceTools({
  onClose,
  onActivity,
  onHistory,
  onSkills,
  onMcpTasks,
  onProcesses,
  onSideEffects,
  onUsage,
  onPlan,
  onProject,
  onSettings,
}: {
  onClose: () => void;
  onActivity: () => void;
  onHistory: () => void;
  onSkills: () => void;
  onMcpTasks: () => void;
  onProcesses: () => void;
  onSideEffects: () => void;
  onUsage: () => void;
  onPlan: () => void;
  onProject: () => void;
  onSettings: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="tools-dialog session-tools-dialog"
      aria-label="Session tools"
      onCancel={onClose}
    >
      <header>
        <div>
          <span className="eyebrow">THIS CONVERSATION</span>
          <h2>Follow the work.</h2>
        </div>
        <button
          type="button"
          className="icon-button"
          aria-label="Close session tools"
          onClick={onClose}
        >
          <X size={17} />
        </button>
      </header>
      <div className="session-tool-choices">
        <button type="button" onClick={onUsage}>
          <Coins size={21} />
          <div>
            <strong>Usage & cost</strong>
            <span>
              Session tokens, last-request cache behavior, routed providers and priced estimates.
            </span>
          </div>
          <ArrowUpRight size={15} />
        </button>
        <button type="button" onClick={onSideEffects}>
          <ShieldCheck size={21} />
          <div>
            <strong>Side effects</strong>
            <span>Audit recorded commands, packages, network and configuration operations.</span>
          </div>
          <ArrowUpRight size={15} />
        </button>
        <button type="button" onClick={onProcesses}>
          <Terminal size={21} />
          <div>
            <strong>Processes</strong>
            <span>
              Inspect this conversation's commands, background output and reviewed termination.
            </span>
          </div>
          <ArrowUpRight size={15} />
        </button>
        <button type="button" onClick={onMcpTasks}>
          <Plug size={21} />
          <div>
            <strong>MCP tasks</strong>
            <span>
              Observe remote work, recover results and request cancellation for this session.
            </span>
          </div>
          <ArrowUpRight size={15} />
        </button>
        <button type="button" onClick={onHistory}>
          <History size={21} />
          <div>
            <strong>History & recovery</strong>
            <span>Recorded events, file activity and reviewed checkpoint rewind.</span>
          </div>
          <ArrowUpRight size={15} />
        </button>
        <button type="button" onClick={onActivity}>
          <ListChecks size={21} />
          <div>
            <strong>Run activity</strong>
            <span>Tool calls, execution output, and verification in this conversation.</span>
          </div>
          <ArrowUpRight size={15} />
        </button>
        <button type="button" onClick={onPlan}>
          <ClipboardList size={21} />
          <div>
            <strong>Plan templates</strong>
            <span>Start this conversation's plan from a ready-made list of steps.</span>
          </div>
          <ArrowUpRight size={15} />
        </button>
        <button type="button" onClick={onSkills}>
          <BookOpen size={21} />
          <div>
            <strong>Available skills</strong>
            <span>Read the skills available to this agent.</span>
          </div>
          <ArrowUpRight size={15} />
        </button>
      </div>
      <div className="session-tool-shared">
        <p>Project knowledge and settings have their own workspace.</p>
        <button type="button" onClick={onProject}>
          <Folder size={16} />
          Project workspace
          <span className="session-project-tools-hint">Memory · Kanban · Code Atlas</span>
          <ArrowUpRight size={14} />
        </button>
        <button type="button" onClick={onSettings}>
          <KeyRound size={16} />
          WrongStack settings
          <ArrowUpRight size={14} />
        </button>
      </div>
    </dialog>
  );
}
