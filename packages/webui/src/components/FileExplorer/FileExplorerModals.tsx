import type React from 'react';
import { FilePlus, FolderPlus, Trash2 } from 'lucide-react';
import { useAppTranslation } from '@/i18n';
import type { TreeNode } from '@/stores/file-store';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import type { CreatePromptState, CrumbContext, RenamePromptState } from './types';

/**
 * Radix-based menus and dialogs (replacing the hand-rolled fixed-position
 * divs from the 2026-08-27 a11y audit). Using the shared ui/ wrappers buys:
 * real menu/dialog semantics (role, aria-*), keyboard item navigation,
 * focus trap in dialogs, Escape/outside-click dismissal, and viewport
 * collision clamping — none of which the old implementation had.
 *
 * Context menus open at arbitrary coordinates (right-click cursor position,
 * or the focused row's rect for Shift+F10), not at a persistent trigger.
 * Anchoring Radix's DropdownMenuContent to an invisible 1×1 fixed-position
 * span at those coordinates provides the same behavior with collision
 * detection intact.
 */

/**
 * After a menu closes, put focus back on the tree container — the keyboard
 * scope that opened it (APG expectation: focus returns to the invoking
 * element). Scopes to the Files tree by id (a bare role="tree" query could
 * match an unrelated tree elsewhere in the DOM), and steps aside when a
 * dialog just opened from the menu: the dialog owns focus then, and racing
 * it would strand keyboard input on the hidden tree.
 */
function restoreTreeFocus(): void {
  if (document.querySelector('[role="dialog"]')) return;
  document.getElementById('ws-file-tree')?.focus();
}

interface BreadcrumbContextMenuProps {
  contextMenu: { x: number; y: number; crumb: CrumbContext };
  /** Clears the parent's contextMenu state (Escape / outside click / item select). */
  onClose: () => void;
  copyToClipboard: (text: string) => void;
  handleStartCreate: (dirPath: string, type: 'file' | 'directory') => void;
  handleShellOpen: (dirPath: string, target: 'terminal' | 'file-manager') => void;
}

export function BreadcrumbContextMenu({
  contextMenu,
  onClose,
  copyToClipboard,
  handleStartCreate,
  handleShellOpen,
}: BreadcrumbContextMenuProps) {
  const { t } = useAppTranslation();
  const crumb = contextMenu.crumb;
  return (
    <DropdownMenu
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      {/* Invisible 1×1 anchor at the cursor; content positions against this
          rect with viewport collision flipping. Inlined (not a component) so
          Radix's asChild ref/props reach the DOM element directly. */}
      <DropdownMenuTrigger asChild>
        <span
          aria-hidden="true"
          tabIndex={-1}
          style={{
            position: 'fixed',
            left: contextMenu.x,
            top: contextMenu.y,
            width: 1,
            height: 1,
          }}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="right"
        align="start"
        className="min-w-[160px]"
        onCloseAutoFocus={(e) => {
          e.preventDefault();
          restoreTreeFocus();
        }}
      >
        <DropdownMenuItem onSelect={() => copyToClipboard(crumb.absPath)}>
          {t('activity:fileExplorer.copyAbsPath')}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => copyToClipboard(crumb.relPath)}>
          {t('activity:fileExplorer.copyRelPath')}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={() => handleStartCreate(crumb.relPath === '.' ? '' : crumb.relPath, 'file')}
        >
          <FilePlus />
          {t('activity:fileExplorer.newFile')}
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() =>
            handleStartCreate(crumb.relPath === '.' ? '' : crumb.relPath, 'directory')
          }
        >
          <FolderPlus />
          {t('activity:fileExplorer.newFolder')}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => handleShellOpen(crumb.absPath, 'terminal')}>
          {t('activity:fileExplorer.openInTerminal')}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => handleShellOpen(crumb.absPath, 'file-manager')}>
          {t('activity:fileExplorer.openInFileManager')}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="max-w-[220px] truncate text-[9px] font-normal text-muted-foreground/70">
          {crumb.absPath}
        </DropdownMenuLabel>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

interface NodeContextMenuProps {
  nodeMenu: { x: number; y: number; node: TreeNode };
  /** Clears the parent's nodeMenu state (Escape / outside click / item select). */
  onClose: () => void;
  handleMentionInChat: (node: TreeNode) => void;
  copyNodePath: (path: string) => void;
  handleStartCreate: (dirPath: string, type: 'file' | 'directory') => void;
  handleStartRename: (node: TreeNode) => void;
  handleDelete: (node: TreeNode) => void;
}

export function NodeContextMenu({
  nodeMenu,
  onClose,
  handleMentionInChat,
  copyNodePath,
  handleStartCreate,
  handleStartRename,
  handleDelete,
}: NodeContextMenuProps) {
  const { t } = useAppTranslation();
  const node = nodeMenu.node;
  return (
    <DropdownMenu
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      {/* Invisible 1×1 anchor (right-click coords or focused-row rect). */}
      <DropdownMenuTrigger asChild>
        <span
          aria-hidden="true"
          tabIndex={-1}
          style={{ position: 'fixed', left: nodeMenu.x, top: nodeMenu.y, width: 1, height: 1 }}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="right"
        align="start"
        className="min-w-[170px]"
        onCloseAutoFocus={(e) => {
          e.preventDefault();
          restoreTreeFocus();
        }}
      >
        {node.type === 'file' && (
          <DropdownMenuItem onSelect={() => handleMentionInChat(node)}>
            {t('activity:fileExplorer.mentionInChat')}
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onSelect={() => copyNodePath(node.path)}>
          {t('activity:fileExplorer.copyPath')}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {node.type === 'directory' && (
          <>
            <DropdownMenuItem onSelect={() => handleStartCreate(node.path, 'file')}>
              <FilePlus />
              {t('activity:fileExplorer.newFile')}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => handleStartCreate(node.path, 'directory')}>
              <FolderPlus />
              {t('activity:fileExplorer.newFolder')}
            </DropdownMenuItem>
          </>
        )}
        <DropdownMenuItem onSelect={() => handleStartRename(node)}>
          {t('activity:fileExplorer.rename')}
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() => handleDelete(node)}
          className="text-destructive focus:bg-destructive/10"
        >
          <Trash2 />
          {t('activity:fileExplorer.delete')}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="max-w-[220px] truncate text-[9px] font-normal text-muted-foreground/70">
          {node.path}
        </DropdownMenuLabel>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

interface CreatePromptModalProps {
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
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o) onCancel();
      }}
    >
      <DialogContent showCloseButton={false} className="max-w-[340px] gap-3 p-4">
        <DialogHeader>
          <DialogTitle className="text-[13px]">
            {createPrompt.type === 'file'
              ? t('activity:fileExplorer.newFileTitle')
              : t('activity:fileExplorer.newFolderTitle')}
          </DialogTitle>
          <DialogDescription className="truncate text-[11px]">
            {createPrompt.dirPath || '.'}
          </DialogDescription>
        </DialogHeader>
        <input
          type="text"
          value={createName}
          onChange={(e) => setCreateName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onConfirm();
          }}
          placeholder={
            createPrompt.type === 'file'
              ? t('activity:fileExplorer.newFileNamePlaceholder')
              : t('activity:fileExplorer.newFolderNamePlaceholder')
          }
          className="w-full px-2 py-1 text-[11px] border rounded bg-background outline-none focus:ring-1 ring-primary"
        />
        <DialogFooter className="gap-2">
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
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface RenamePromptModalProps {
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
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o) onCancel();
      }}
    >
      <DialogContent showCloseButton={false} className="max-w-[340px] gap-3 p-4">
        <DialogHeader>
          <DialogTitle className="text-[13px]">
            {t('activity:fileExplorer.renameTitle')}
          </DialogTitle>
          <DialogDescription className="truncate text-[11px]">
            {renamePrompt.oldPath}
          </DialogDescription>
        </DialogHeader>
        <input
          type="text"
          value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onConfirm();
          }}
          className="w-full px-2 py-1 text-[11px] border rounded bg-background outline-none focus:ring-1 ring-primary"
        />
        <DialogFooter className="gap-2">
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
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
