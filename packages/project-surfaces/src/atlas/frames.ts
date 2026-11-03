import { extractActivitiesFromMessage, useCodemapActivityStore } from './codemap-activity-store';
import { useCodemapIndexStore } from './codemap-index-store';

/** The engine frames the atlas reads its live activity and index updates from. */
export const ATLAS_FRAME_TYPES = [
  'tool.started',
  'tool.executed',
  'tool.progress',
  'codemap.tool_started',
  'codemap.tool_executed',
  'codemap.file_event',
  'codemap.index_updated',
  'file.saved',
] as const;

type Frame = { type: string; payload?: unknown };

/** Feeds one engine frame to the atlas stores, as the WebUI's socket handlers do. */
export function applyAtlasFrame(frame: Frame): void {
  const activity = useCodemapActivityStore.getState();
  switch (frame.type) {
    case 'tool.started':
    case 'codemap.tool_started': {
      const activities = extractActivitiesFromMessage(frame);
      if (activities.length > 0) activity.startActivities(activities);
      return;
    }
    case 'tool.executed':
    case 'codemap.tool_executed': {
      const payload = (frame.payload ?? {}) as {
        id?: unknown;
        durationMs?: unknown;
        ok?: unknown;
      };
      if (typeof payload.id !== 'string') return;
      activity.finishTool(payload.id, {
        ...(typeof payload.durationMs === 'number' ? { durationMs: payload.durationMs } : {}),
        ok: payload.ok !== false,
      });
      return;
    }
    case 'tool.progress':
    case 'codemap.file_event':
    case 'file.saved':
      for (const item of extractActivitiesFromMessage(frame)) activity.recordFileEvent(item);
      return;
    case 'codemap.index_updated': {
      const at = (frame.payload as { at?: unknown } | undefined)?.at;
      useCodemapIndexStore.getState().notifyIndexUpdated(typeof at === 'number' ? at : undefined);
      return;
    }
  }
}

/** Subscribes the atlas stores to a host's frames; returns the unsubscribe. */
export function bindAtlasFrames(
  on: (type: string, handler: (message: { payload: unknown }) => void) => () => void,
): () => void {
  const stops = ATLAS_FRAME_TYPES.map((type) =>
    on(type, (message) => applyAtlasFrame({ type, payload: message.payload })),
  );
  return () => {
    for (const stop of stops) stop();
  };
}
