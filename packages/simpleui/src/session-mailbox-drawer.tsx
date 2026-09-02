import type { ComponentProps } from 'react';
import { Mail, X } from 'lucide-react';
import { MailboxSidebar } from './mailbox-sidebar.js';

export interface SessionMailboxDrawerProps {
  open: boolean;
  onClose: () => void;
  store: ComponentProps<typeof MailboxSidebar>['store'];
  onRefresh: () => void;
  onSend: ComponentProps<typeof MailboxSidebar>['onSend'];
  onAction: ComponentProps<typeof MailboxSidebar>['onAction'];
}

export function SessionMailboxDrawer({
  open,
  onClose,
  store,
  onRefresh,
  onSend,
  onAction,
}: SessionMailboxDrawerProps) {
  if (!open) return null;

  return (
    <>
      <button
        type="button"
        className="sidebar-overlay"
        aria-label="Close email panel"
        onClick={onClose}
      />
      <aside className="email-panel" aria-label="Email panel">
        <header className="tool-sidebar-header">
          <div>
            <Mail size={14} aria-hidden="true" />
            <span>EMAIL</span>
            <b>PROJECT MAILBOX</b>
          </div>
          <button type="button" aria-label="Close email panel" onClick={onClose}>
            <X size={15} aria-hidden="true" />
          </button>
        </header>
        <div className="tool-sidebar-list">
          <MailboxSidebar store={store} onRefresh={onRefresh} onSend={onSend} onAction={onAction} />
        </div>
      </aside>
    </>
  );
}
