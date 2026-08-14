import type React from 'react';
import { FilePlus, FolderPlus, Trash2 } from 'lucide-react';
import { useAppTranslation } from '@/i18n';
import type { TreeNode } from '@/stores/file-store';
import type { CreatePromptState, CrumbContext, RenamePromptState } from './types';

export interface BreadcrumbContextMenuProps {
  contextMenu: { x: number; y: number; crumb: CrumbContext };
  copyToClipboard: (text: string) => void;
  handleStartCreate: (dirPath: string, type: 'file' | 'directory') => void;
  handleShellOpen: (dirPath: string, target: 'terminal' | 'file-manager') => void;
}

export function BreadcrumbContextMenu({
  contextMenu,
  copyToClipboard,
  handleStartCreate,
  handleShellOpen,
}: BreadcrumbContextMenuProps) {
  const { t } = useAppTranslation();
  return (
    <div
      className="fixed z-50 min-w-[140px] bg-popover border rounded-md shadow-md py-1 text-[11px]"
      style={{ left: contextMenu.x, top: contextMenu.y }}
    >
      <button
        type="button"
        onClick={() => copyToClipboard(contextMenu.crumb.absPath)}
        className="flex items-center gap-2 w-full text-left px-3 py-1.5 hover:bg-accent transition-colors"
      >
        {t('activity:fileExplorer.copyAbsPath')}
      </button>
      <button
        type="button"
        onClick={() => copyToClipboard(contextMenu.crumb.relPath)}
        className="flex items-center gap-2 w-full text-left px-3 py-1.5 hover:bg-accent transition-colors"
      >
        {t('activity:fileExplorer.copyRelPath')}
      </button>
      <div className="border-t border-border/50 my-0.5" />
      <button
        type="button"
        onClick={() =>
          handleStartCreate(
            contextMenu.crumb.relPath === '.' ? '' : contextMenu.crumb.relPath,
            'file',
          )
        }
        className="flex items-center gap-2 w-full text-left px-3 py-1.5 hover:bg-accent transition-colors"
      >
        <FilePlus className="h-3 w-3 shrink-0" />
        {t('activity:fileExplorer.newFile')}
      </button>
      <button
        type="button"
        onClick={() =>
          handleStartCreate(
            contextMenu.crumb.relPath === '.' ? '' : contextMenu.crumb.relPath,
            'directory',
          )
        }
        className="flex items-center gap-2 w-full text-left px-3 py-1.5 hover:bg-accent transition-colors"
      >
        <FolderPlus className="h-3 w-3 shrink-0" />
        {t('activity:fileExplorer.newFolder')}
      </button>
      <div className="border-t border-border/50 my-0.5" />
      <button
        type="button"
        onClick={() => handleShellOpen(contextMenu.crumb.absPath, 'terminal')}
        className="flex items-center gap-2 w-full text-left px-3 py-1.5 hover:bg-accent transition-colors"
      >
        {t('activity:fileExplorer.openInTerminal')}
      </button>
      <button
        type="button"
        onClick={() => handleShellOpen(contextMenu.crumb.absPath, 'file-manager')}
        className="flex items-center gap-2 w-full text-left px-3 py-1.5 hover:bg-accent transition-colors"
      >
        {t('activity:fileExplorer.openInFileManager')}
      </button>
      <div className="border-t border-border/50 mt-0.5 pt-0.5">
        <div className="px-3 py-1 text-[9px] text-muted-foreground/70 truncate max-w-[200px]">
          {contextMenu.crumb.absPath}
        </div>
      </div>
    </div>
  );
}

export interface NodeContextMenuProps {
  nodeMenu: { x: number; y: number; node: TreeNode };
  handleMentionInChat: (node: TreeNode) => void;
  copyNodePath: (path: string) => void;
  handleStartCreate: (dirPath: string, type: 'file' | 'directory') => void;
  handleStartRename: (node: TreeNode) => void;
  handleDelete: (node: TreeNode) => void;
}

export function NodeContextMenu({
  nodeMenu,
  handleMentionInChat,
  copyNodePath,
  handleStartCreate,
  handleStartRename,
  handleDelete,
}: NodeContextMenuProps) {
  const { t } = useAppTranslation();
  return (
    <div
      className="fixed z-50 min-w-[160px] bg-popover border rounded-md shadow-md py-1 text-[11px]"
      style={{ left: nodeMenu.x, top: nodeMenu.y }}
    >
      {nodeMenu.node.type === 'file' && (
        <button
          type="button"
          onClick={() => handleMentionInChat(nodeMenu.node)}
          className="flex items-center gap-2 w-full text-left px-3 py-1.5 hover:bg-accent transition-colors"
        >
          {t('activity:fileExplorer.mentionInChat')}
        </button>
      )}
      <button
        type="button"
        onClick={() => copyNodePath(nodeMenu.node.path)}
        className="flex items-center gap-2 w-full text-left px-3 py-1.5 hover:bg-accent transition-colors"
      >
        {t('activity:fileExplorer.copyPath')}
      </button>
      <div className="border-t border-border/50 my-0.5" />
      {nodeMenu.node.type === 'directory' && (
        <>
          <button
            type="button"
            onClick={() => handleStartCreate(nodeMenu.node.path, 'file')}
            className="flex items-center gap-2 w-full text-left px-3 py-1.5 hover:bg-accent transition-colors"
          >
            <FilePlus className="h-3 w-3 shrink-0" />
            {t('activity:fileExplorer.newFile')}
          </button>
          <button
            type="button"
            onClick={() => handleStartCreate(nodeMenu.node.path, 'directory')}
            className="flex items-center gap-2 w-full text-left px-3 py-1.5 hover:bg-accent transition-colors"
          >
            <FolderPlus className="h-3 w-3 shrink-0" />
            {t('activity:fileExplorer.newFolder')}
          </button>
        </>
      )}
      <button
        type="button"
        onClick={() => handleStartRename(nodeMenu.node)}
        className="flex items-center gap-2 w-full text-left px-3 py-1.5 hover:bg-accent transition-colors"
      >
        {t('activity:fileExplorer.rename')}
      </button>
      <button
        type="button"
        onClick={() => handleDelete(nodeMenu.node)}
        className="flex items-center gap-2 w-full text-left px-3 py-1.5 hover:bg-destructive/10 text-destructive transition-colors"
      >
        <Trash2 className="h-3 w-3 shrink-0" />
        {t('activity:fileExplorer.delete')}
      </button>
      <div className="border-t border-border/50 mt-0.5 pt-0.5">
        <div className="px-3 py-1 text-[9px] text-muted-foreground/70 truncate max-w-[200px]">
          {nodeMenu.node.path}
        </div>
      </div>
    </div>
  );
}

export interface CreatePromptModalProps {
  createPrompt: CreatePromptState;
  createName: string;
  setCreateName: (val: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
}

export function CreatePromptModal({
  createPrompt,
  createName,
  setCreateName,
  onCancel,
  onConfirm,
}: CreatePromptModalProps) {
  const { t } = useAppTranslation();
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-popover border rounded-md shadow-lg p-4 min-w-[300px]">
        <p className="text-[12px] font-medium mb-2">
          {createPrompt.type === 'file'
            ? t('activity:fileExplorer.newFileTitle')
            : t('activity:fileExplorer.newFolderTitle')}
        </p>
        <input
          type="text"
          value={createName}
          onChange={(e) => setCreateName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onConfirm();
            if (e.key === 'Escape') onCancel();
          }}
          placeholder={createPrompt.type === 'file' ? 'file.ts' : 'folder'}
          className="w-full px-2 py-1 text-[11px] border rounded bg-background outline-none focus:ring-1 ring-primary"
          // biome-ignore lint/a11y/noAutofocus: inline create dialog is a transient single-field prompt; focus must land in it on open
          autoFocus
        />
        <div className="flex justify-end gap-2 mt-3">
          <button
            type="button"
            onClick={onCancel}
            className="px-2 py-1 text-[10px] rounded border text-muted-foreground hover:text-foreground"
          >
            {t('common:action.cancel')}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={!createName.trim()}
            className="px-2 py-1 text-[10px] rounded border border-primary text-primary font-medium hover:bg-primary hover:text-primary-foreground disabled:opacity-40"
          >
            {t('common:action.create')}
          </button>
        </div>
      </div>
    </div>
  );
}

export interface RenamePromptModalProps {
  renamePrompt: RenamePromptState;
  renameValue: string;
  setRenameValue: (val: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
}

export function RenamePromptModal({
  renamePrompt,
  renameValue,
  setRenameValue,
  onCancel,
  onConfirm,
}: RenamePromptModalProps) {
  const { t } = useAppTranslation();
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-popover border rounded-md shadow-lg p-4 min-w-[300px]">
        <p className="text-[12px] font-medium mb-2">{t('activity:fileExplorer.renameTitle')}</p>
        <input
          type="text"
          value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onConfirm();
            if (e.key === 'Escape') onCancel();
          }}
          className="w-full px-2 py-1 text-[11px] border rounded bg-background outline-none focus:ring-1 ring-primary"
          // biome-ignore lint/a11y/noAutofocus: inline rename dialog is a transient single-field prompt; focus must land in it on open
          autoFocus
        />
        <div className="flex justify-end gap-2 mt-3">
          <button
            type="button"
            onClick={onCancel}
            className="px-2 py-1 text-[10px] rounded border text-muted-foreground hover:text-foreground"
          >
            {t('common:action.cancel')}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={!renameValue.trim() || renameValue.trim() === renamePrompt.initialName}
            className="px-2 py-1 text-[10px] rounded border border-primary text-primary font-medium hover:bg-primary hover:text-primary-foreground disabled:opacity-40"
          >
            {t('common:action.rename')}
          </button>
        </div>
      </div>
    </div>
  );
}
