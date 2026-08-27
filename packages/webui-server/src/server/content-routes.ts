import type { WebSocket } from 'ws';
import {
  type DesignContext,
  handleDesignList,
  handleDesignMaterialize,
  handleDesignSet,
  handleDesignState,
  handleDesignSwap,
  handleDesignTune,
  handleDesignUse,
  handleDesignVerify,
} from './design-handlers.js';
import {
  handleFilesCreate,
  handleFilesDelete,
  handleFilesList,
  handleFilesMove,
  handleFilesRead,
  handleFilesRename,
  handleFilesSkeleton,
  handleFilesTree,
  handleFilesWrite,
} from './file-handlers.js';
import {
  handlePromptsContent,
  handlePromptsCreate,
  handlePromptsFavorite,
  handlePromptsJournal,
  handlePromptsList,
  handlePromptsRecent,
  handlePromptsSearch,
  handlePromptsUsed,
  type PromptsContext,
} from './prompts-handlers.js';
import {
  handleSkillsContent,
  handleSkillsCreate,
  handleSkillsEdit,
  handleSkillsExport,
  handleSkillsInstall,
  handleSkillsList,
  handleSkillsUninstall,
  handleSkillsUpdate,
  type SkillsContext,
} from './skills-handlers.js';
import type { WSClientMessage } from './types.js';
import { messageSessionId } from './ws-utils.js';

export interface ContentRouteContext {
  getProjectRoot: () => string;
  getSkillsContext: () => SkillsContext;
  getPromptsContext: () => PromptsContext;
  /**
   * The design kit is pinned on a conversation's own meta, so the tab that
   * picked it is the one whose prompts carry it. Without the id every pick
   * landed on the leader — tab 3 choosing a kit re-styled tab 1's next turn.
   */
  getDesignContext: (sessionId?: string | undefined) => DesignContext;
  onFileWritten?: ((filePath: string) => void) | undefined;
}

/** Canonical file/skill/prompt/design routing shared by every WebUI host. */
export async function handleContentRoute(
  ctx: ContentRouteContext,
  ws: WebSocket,
  message: WSClientMessage,
): Promise<boolean> {
  /**
   * Design context for the asking tab, carrying its session id so every
   * response can be stamped and routed back to that tab's lane only. Without
   * the echo, a late response from another tab overwrote this tab's kit view.
   */
  const designCtx = (): DesignContext => {
    const sessionId = messageSessionId(message);
    const base = ctx.getDesignContext(sessionId);
    return sessionId ? { ...base, sessionId } : base;
  };
  switch (message.type) {
    case 'files.list':
      await handleFilesList(ws, message, ctx.getProjectRoot());
      return true;
    case 'files.tree':
      await handleFilesTree(ws, message, ctx.getProjectRoot());
      return true;
    case 'files.read':
      await handleFilesRead(ws, message, ctx.getProjectRoot());
      return true;
    case 'files.skeleton':
      await handleFilesSkeleton(ws, message, ctx.getProjectRoot());
      return true;
    case 'files.write':
      await handleFilesWrite(ws, message, ctx.getProjectRoot(), {
        onWritten: ctx.onFileWritten,
      });
      return true;
    case 'files.create':
      await handleFilesCreate(ws, message, ctx.getProjectRoot());
      return true;
    case 'files.delete':
      await handleFilesDelete(ws, message, ctx.getProjectRoot());
      return true;
    case 'files.rename':
      await handleFilesRename(ws, message, ctx.getProjectRoot());
      return true;
    case 'files.move':
      await handleFilesMove(ws, message, ctx.getProjectRoot());
      return true;
    case 'skills.list':
      await handleSkillsList(ws, ctx.getSkillsContext());
      return true;
    case 'skills.content':
      await handleSkillsContent(ws, ctx.getSkillsContext(), message);
      return true;
    case 'skills.install':
      await handleSkillsInstall(ws, ctx.getSkillsContext(), message);
      return true;
    case 'skills.uninstall':
      await handleSkillsUninstall(ws, ctx.getSkillsContext(), message);
      return true;
    case 'skills.update':
      await handleSkillsUpdate(ws, ctx.getSkillsContext(), message);
      return true;
    case 'skills.create':
      await handleSkillsCreate(ws, ctx.getSkillsContext(), message);
      return true;
    case 'skills.edit':
      await handleSkillsEdit(ws, ctx.getSkillsContext(), message);
      return true;
    case 'skills.export':
      await handleSkillsExport(ws, ctx.getSkillsContext());
      return true;
    case 'prompts.list':
      await handlePromptsList(ws, ctx.getPromptsContext());
      return true;
    case 'prompts.search':
      await handlePromptsSearch(ws, ctx.getPromptsContext(), message);
      return true;
    case 'prompts.content':
      await handlePromptsContent(ws, ctx.getPromptsContext(), message);
      return true;
    case 'prompts.favorite':
      await handlePromptsFavorite(ws, ctx.getPromptsContext(), message);
      return true;
    case 'prompts.create':
      await handlePromptsCreate(ws, ctx.getPromptsContext(), message);
      return true;
    case 'prompts.used':
      await handlePromptsUsed(ws, ctx.getPromptsContext(), message);
      return true;
    case 'prompts.recent':
      await handlePromptsRecent(ws, ctx.getPromptsContext());
      return true;
    case 'prompts.journal':
      await handlePromptsJournal(ws, message, ctx.getProjectRoot());
      return true;
    case 'design.list':
      await handleDesignList(ws, designCtx());
      return true;
    case 'design.use':
      await handleDesignUse(ws, designCtx(), message);
      return true;
    case 'design.state':
      await handleDesignState(ws, designCtx());
      return true;
    case 'design.set':
      await handleDesignSet(ws, designCtx(), message);
      return true;
    case 'design.tune':
      await handleDesignTune(ws, designCtx(), message);
      return true;
    case 'design.swap':
      await handleDesignSwap(ws, designCtx(), message);
      return true;
    case 'design.materialize':
      await handleDesignMaterialize(ws, designCtx(), message);
      return true;
    case 'design.verify':
      await handleDesignVerify(ws, designCtx());
      return true;
    default:
      return false;
  }
}
