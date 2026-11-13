'use client';

import { Users } from 'lucide-react';
import type { Dispatch, SetStateAction } from 'react';
import type { AgentEntry, SessionState } from '../lib/session';
import type { SessionController } from '../lib/use-session';
import { AcpRuntime } from './acp-runtime';
import { EffortSelect, ModelPicker } from './model-picker';

/**
 * The per-session toolbar strip above the composer: model picker plus effort /
 * ACP runtime controls, the context window summary, runtime chip and the live
 * agent count. Pure projection — all state stays owned by `Workspace`.
 */
export function SessionToolbar({
  state,
  controller,
  locked,
  modelPending,
  chooseModel,
  refreshModels,
  presentation,
  liveAgents,
  revealAgents,
  setProvidersOpen,
  setSettings,
  setContextOpen,
}: {
  state: SessionState;
  controller: SessionController;
  locked: boolean;
  modelPending: boolean;
  chooseModel: (provider: string, model: string, context: number) => void;
  refreshModels: () => void;
  presentation: 'simple' | 'extended';
  liveAgents: AgentEntry[];
  revealAgents: () => void;
  setProvidersOpen: Dispatch<SetStateAction<boolean>>;
  setSettings: Dispatch<SetStateAction<boolean>>;
  setContextOpen: Dispatch<SetStateAction<boolean>>;
}) {
  return (
    <div className="session-toolbar">
      <div className="model-controls">
        <ModelPicker
          models={state.models}
          providers={state.providers}
          provider={state.provider}
          model={state.model}
          locked={locked}
          pending={modelPending}
          onChoose={chooseModel}
          onSettings={setProvidersOpen}
          onRefresh={refreshModels}
        />
        {state.provider === 'acp' ? (
          <AcpRuntime
            state={state}
            disabled={locked}
            send={controller.send}
            subscribe={controller.subscribe}
          />
        ) : (
          <EffortSelect state={state} disabled={locked} onChange={controller.setEffort} />
        )}
      </div>
      <ContextSummary state={state} presentation={presentation} setContextOpen={setContextOpen} />
      {typeof state.prefs.autonomy === 'string' && (
        <button
          type="button"
          className="runtime-chip"
          aria-label="Agent settings"
          onClick={() => setSettings(true)}
        >
          {state.mode || 'Default'} · {state.prefs.autonomy}
          {state.prefs.yoloPlus === true ? ' · YOLO+' : state.prefs.yolo === true ? ' · YOLO' : ''}
        </button>
      )}
      {liveAgents.length > 0 && (
        <button
          type="button"
          className="agent-count"
          aria-label="View agents"
          title={`${liveAgents.length} active ${liveAgents.length === 1 ? 'agent' : 'agents'}`}
          onClick={revealAgents}
        >
          <Users size={13} /> {liveAgents.length}
        </button>
      )}
    </div>
  );
}

/** Token/context load summary button opening the context dialog. */
function ContextSummary({
  state,
  presentation,
  setContextOpen,
}: {
  state: Pick<SessionState, 'tokens' | 'maxContext' | 'cache' | 'load'>;
  presentation: 'simple' | 'extended';
  setContextOpen: Dispatch<SetStateAction<boolean>>;
}) {
  return (
    <button
      type="button"
      aria-label="View context"
      onClick={() => setContextOpen(true)}
      className="context-summary"
      title={`${state.tokens.toLocaleString()} / ${state.maxContext.toLocaleString()} context tokens${state.cache ? ` · cache hit ${Math.round((state.cache.lastHitRatio ?? state.cache.hitRatio) * 100)}%` : ''}`}
    >
      <span className="context-track">
        <span style={{ width: `${Math.min(100, state.load * 100)}%` }} />
      </span>
      <span className="context-label">
        {presentation === 'simple' ? (
          <>Conversation space · {Math.round(state.load * 100)}%</>
        ) : (
          <>
            {Intl.NumberFormat('en', {
              notation: 'compact',
              maximumFractionDigits: 1,
            }).format(state.tokens)}{' '}
            /{' '}
            {Intl.NumberFormat('en', {
              notation: 'compact',
              maximumFractionDigits: 1,
            }).format(state.maxContext)}{' '}
            <span className="context-percentage"> · {Math.round(state.load * 100)}%</span>
            {state.cache && (
              <span className="context-cache">
                {' '}
                · cache {Math.round((state.cache.lastHitRatio ?? state.cache.hitRatio) * 100)}%
              </span>
            )}
          </>
        )}
      </span>
    </button>
  );
}
