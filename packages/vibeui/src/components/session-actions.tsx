'use client';

import { Copy, Download, GitBranch, MoreHorizontal, Pencil, Trash2 } from 'lucide-react';
import { DropdownMenu } from 'radix-ui';
import { useEffect, useRef, useState } from 'react';
import type { SessionController } from '../lib/use-session';
import { transcriptMarkdown } from '../lib/workspace-model';
import { Modal } from './dialogs';
import { SessionBranchDialog } from './session-branch-dialog';

export function SessionActions({
  controller,
  title,
}: {
  controller: SessionController;
  title: string;
}) {
  const { state, connection, notice } = controller;
  const [renaming, setRenaming] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [branching, setBranching] = useState(false);
  const [name, setName] = useState('');
  const download = useRef<{ url: string; timer: ReturnType<typeof setTimeout> } | null>(null);
  useEffect(
    () => () => {
      if (download.current) {
        clearTimeout(download.current.timer);
        URL.revokeObjectURL(download.current.url);
      }
    },
    [],
  );
  const exportChat = () => {
    if (download.current) {
      clearTimeout(download.current.timer);
      URL.revokeObjectURL(download.current.url);
    }
    const url = URL.createObjectURL(
      new Blob([transcriptMarkdown(state)], { type: 'text/markdown;charset=utf-8' }),
    );
    const link = document.createElement('a');
    link.href = url;
    link.download = `wrongstack-${state.id.split('/').at(-1) || 'conversation'}.md`;
    document.body.append(link);
    link.click();
    link.remove();
    download.current = {
      url,
      timer: setTimeout(() => {
        URL.revokeObjectURL(url);
        download.current = null;
      }, 1000),
    };
  };
  return (
    <>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger
          className="icon-button"
          aria-label="Session actions"
          disabled={!state.id}
        >
          <MoreHorizontal size={18} />
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            className="model-menu session-actions-menu"
            sideOffset={8}
            align="end"
          >
            <DropdownMenu.Item
              disabled={connection !== 'open'}
              onSelect={() => {
                setName(title === 'New session' ? '' : title);
                setRenaming(true);
              }}
            >
              <Pencil size={14} />
              Rename session
            </DropdownMenu.Item>
            <DropdownMenu.Item disabled={connection !== 'open'} onSelect={() => setBranching(true)}>
              <GitBranch size={14} />
              Session branches
            </DropdownMenu.Item>
            <DropdownMenu.Item disabled={!state.messages.length} onSelect={exportChat}>
              <Download size={14} />
              Export conversation
            </DropdownMenu.Item>
            <DropdownMenu.Item
              disabled={controller.sessionLocked || !state.messages.length}
              onSelect={() => setClearing(true)}
            >
              <Trash2 size={14} />
              Clear current context
            </DropdownMenu.Item>
            <DropdownMenu.Item
              onSelect={async () => {
                try {
                  await navigator.clipboard.writeText(state.cwd);
                  notice('Project path copied.');
                } catch {
                  notice('Clipboard is unavailable. The path is shown in Settings.');
                }
              }}
            >
              <Copy size={14} />
              Copy project path
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      <Modal
        open={renaming}
        onOpenChange={setRenaming}
        title="Name this session"
        description="Give this conversation a name you can find later."
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (name.trim() && controller.renameSession(state.id, name)) {
              setRenaming(false);
              notice('Rename requested. Waiting for the workspace to confirm.');
            }
          }}
        >
          <label className="form-label" htmlFor="session-name">
            Session name
          </label>
          <input
            className="wide-input"
            id="session-name"
            value={name}
            maxLength={120}
            onChange={(event) => setName(event.target.value)}
          />
          <div className="dialog-actions">
            <button type="button" className="secondary-button" onClick={() => setRenaming(false)}>
              Cancel
            </button>
            <button
              type="submit"
              className="primary-button"
              disabled={connection !== 'open' || !name.trim()}
            >
              Save name
            </button>
          </div>
        </form>
      </Modal>
      <Modal
        open={clearing}
        onOpenChange={setClearing}
        title="Clear current context?"
        description={`Clear the loaded conversation, draft and queue for “${title}”. Saved session journals and project files remain available.`}
        icon={<Trash2 size={20} />}
      >
        <div className="dialog-actions">
          <button type="button" className="secondary-button" onClick={() => setClearing(false)}>
            Keep conversation
          </button>
          <button
            type="button"
            className="secondary-button danger-button"
            disabled={controller.sessionLocked}
            onClick={() => {
              if (controller.clearContext()) setClearing(false);
            }}
          >
            Clear current context
          </button>
        </div>
      </Modal>
      <SessionBranchDialog open={branching} onOpenChange={setBranching} controller={controller} />
    </>
  );
}
