import type { BrowserSessionManager } from './manager.js';
import type { BrowserFrame, BrowserLiveDetails, BrowserLiveSummary } from './types.js';

/** Read-only viewer access. The owning tools module supplies its project-scoped registry. */
export function createLiveBrowserAccess(
  getManager: (projectRoot: string) => BrowserSessionManager | undefined,
) {
  return {
    async pick(
      projectRoot: string,
      id: string,
      conversationId: string,
      point: { x: number; y: number; url: string },
    ) {
      const manager = getManager(projectRoot);
      if (!manager) throw new Error('No browser is open in this project');
      return manager.pickElement(id, conversationId, point);
    },
    async sessions(projectRoot: string): Promise<BrowserLiveSummary[]> {
      return (await getManager(projectRoot)?.liveSessions()) ?? [];
    },
    async details(
      projectRoot: string,
      id: string,
      limit: number,
    ): Promise<BrowserLiveDetails | undefined> {
      return getManager(projectRoot)?.liveDetails(id, limit);
    },
    async watch(
      projectRoot: string,
      id: string,
      viewer: (frame: BrowserFrame) => void,
    ): Promise<() => Promise<void>> {
      const manager = getManager(projectRoot);
      if (!manager) throw new Error(`browser session ${id} is not open`);
      return manager.watch(id, viewer);
    },
  };
}
