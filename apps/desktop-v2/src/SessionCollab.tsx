import { CollabPanel } from '@wrongstack/project-surfaces/collab/CollabPanel';
import { useMemo } from 'react';
import { I18nextProvider } from 'react-i18next';
import type { EngineState } from './engine-state';
import { backendStream } from './engine-stream';
import { collabClient, pendingToolCalls } from './session-collab-model';
import { surfaceI18n } from './surface-i18n';
import './surfaces.css';

/**
 * The WebUI's collaboration bar on one desktop conversation: who is watching the run, and
 * joining it as an observer, annotator or controller (pause, resume, hand over control,
 * inject a tool result). The engine decides which roles it allows.
 */
export default function SessionCollab({ id, state }: { id: string; state: EngineState }) {
  const client = useMemo(() => collabClient(backendStream('engine', id)), [id]);
  const pendingTools = useMemo(() => pendingToolCalls(state.activity), [state.activity]);
  if (!state.sessionId) return null;
  return (
    <I18nextProvider i18n={surfaceI18n}>
      <div className="ws-surfaces session-collab">
        <CollabPanel sessionId={state.sessionId} client={client} pendingTools={pendingTools} />
      </div>
    </I18nextProvider>
  );
}
