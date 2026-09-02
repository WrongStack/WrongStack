import { ChevronDown } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { AgentTab } from './lib/agent-model.js';

interface FinishedAgentsMenuProps {
  agents: AgentTab[];
  activeAgentId: string;
  onSelect: (id: string) => void;
}

/**
 * Dropdown that collects finished (completed/failed/idle/offline) worker tabs so
 * they don't overflow the agent strip. Opens on click, and closes on Escape,
 * outside click, or after a selection — keeping it keyboard-accessible.
 */
export function FinishedAgentsMenu({
  agents,
  activeAgentId,
  onSelect,
}: FinishedAgentsMenuProps): React.JSX.Element | null {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setOpen(false);
      toggleRef.current?.focus();
    };
    const onPointerDown = (event: PointerEvent): void => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [open]);

  // Move focus to the first menuitem when the menu opens so arrow-key
  // navigation works immediately without a preliminary Tab.
  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector<HTMLButtonElement>('.agent-finished-item')?.focus();
  }, [open]);

  const focusItemAt = (index: number): void => {
    const items = menuRef.current?.querySelectorAll<HTMLButtonElement>('.agent-finished-item');
    if (!items || items.length === 0) return;
    const wrapped = ((index % items.length) + items.length) % items.length;
    items[wrapped]?.focus();
  };

  const onItemKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, index: number): void => {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        focusItemAt(index + 1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        focusItemAt(index - 1);
        break;
      case 'Home':
        event.preventDefault();
        focusItemAt(0);
        break;
      case 'End':
        event.preventDefault();
        focusItemAt(-1);
        break;
      default:
        break;
    }
  };

  // If every finished agent drained (e.g. pruned), don't leave a stale toggle.
  if (agents.length === 0) return null;

  return (
    <div className="agent-finished" ref={containerRef}>
      <button
        type="button"
        ref={toggleRef}
        className={`agent-finished-toggle${open ? ' open' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <ChevronDown size={13} aria-hidden="true" />
        Finished ({agents.length})
      </button>
      {open && (
        <div className="agent-finished-menu" role="menu" aria-label="Finished agents" ref={menuRef}>
          {agents.map((agent, index) => (
            <button
              type="button"
              key={agent.id}
              role="menuitem"
              // Roving tabindex: only the first item is in the Tab order; arrow
              // keys move focus between items, so Tab enters/leaves the menu once.
              tabIndex={index === 0 ? 0 : -1}
              className={`agent-finished-item${activeAgentId === agent.id ? ' active' : ''}`}
              title={agent.task ?? `${agent.name} · ${agent.status}`}
              onKeyDown={(event) => onItemKeyDown(event, index)}
              onClick={() => {
                onSelect(agent.id);
                setOpen(false);
              }}
            >
              <span className={`agent-dot ${agent.status}`} aria-hidden="true" />
              <strong>{agent.name}</strong>
              <span>{agent.status}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
