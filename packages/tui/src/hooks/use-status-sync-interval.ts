import { useEffect, useRef } from 'react';
import type { Agent } from '@wrongstack/core/agent';

interface UseStatusSyncIntervalOptions {
  getAutonomy?: (() => string) | undefined;
  getYolo?: (() => boolean) | undefined;
  getModeLabel?: (() => string) | undefined;
  getEternalEngine?: unknown;
  getParallelEngine?: unknown;
  agent: Agent;
  autonomyLive: string;
  yoloLive: boolean;
  liveModeLabel: string;
  liveModel: string;
  liveProvider: string;
  setAutonomyLive: (v: any) => void;
  setYoloLive: (v: boolean) => void;
  setLiveModeLabel: (v: string) => void;
  setLiveModel: (v: string) => void;
  setLiveProvider: (v: string) => void;
  runEternalLoopRef: React.MutableRefObject<() => Promise<void>>;
  runParallelLoopRef: React.MutableRefObject<() => Promise<void>>;
}

export function useStatusSyncInterval({
  getAutonomy,
  getYolo,
  getModeLabel,
  getEternalEngine,
  getParallelEngine,
  agent,
  autonomyLive,
  yoloLive,
  liveModeLabel,
  liveModel,
  liveProvider,
  setAutonomyLive,
  setYoloLive,
  setLiveModeLabel,
  setLiveModel,
  setLiveProvider,
  runEternalLoopRef,
  runParallelLoopRef,
}: UseStatusSyncIntervalOptions) {
  const staleGuardRef = useRef(JSON.stringify({ a: '', y: false, m: '', model: '', provider: '' }));

  useEffect(() => {
    const poll = () => {
      const a = getAutonomy?.() ?? 'off';
      const y = getYolo?.() ?? false;
      const m = getModeLabel?.() ?? '';
      const curModel = agent.ctx.model;
      const curProvider = (agent.ctx.provider as { id?: string | undefined } | undefined)?.id ?? '';
      const snap = JSON.stringify({ a, y, m, model: curModel, provider: curProvider });
      if (snap !== staleGuardRef.current) {
        staleGuardRef.current = snap;
        if (a !== autonomyLive) setAutonomyLive(a);
        if (y !== yoloLive) setYoloLive(y);
        if (m !== liveModeLabel) setLiveModeLabel(m);
        if (curModel !== liveModel) setLiveModel(curModel);
        if (curProvider !== liveProvider) setLiveProvider(curProvider);
        if (a === 'eternal' && getEternalEngine) void runEternalLoopRef.current();
        if (a === 'eternal-parallel' && getParallelEngine) void runParallelLoopRef.current();
      }
    };
    const t = setInterval(poll, 2000);
    return () => clearInterval(t);
  }, [
    getAutonomy,
    getYolo,
    getModeLabel,
    getEternalEngine,
    getParallelEngine,
    autonomyLive,
    yoloLive,
    liveModeLabel,
    liveModel,
    liveProvider,
    agent.ctx.model,
    agent.ctx.provider,
    setAutonomyLive,
    setYoloLive,
    setLiveModeLabel,
    setLiveModel,
    setLiveProvider,
    runEternalLoopRef,
    runParallelLoopRef,
  ]);
}
