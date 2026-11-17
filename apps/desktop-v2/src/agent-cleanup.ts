import { useEffect, useState } from 'react';
import type { AgentTranscript } from './agent-transcripts';

type ClearedAgents = Readonly<Record<string, string>>;
const changed = 'wrongstack:agent-cleanup';
const keyFor = (sessionId: string) => `wrongstack.desktop.agent-cleanup:${sessionId}`;

/** Fail closed: waiting/starting and future statuses are not proof that work has ended. */
export function isInactiveAgent(agent: Pick<AgentTranscript, 'id' | 'status'>): boolean {
  return (
    agent.id !== 'leader' &&
    ['completed', 'failed', 'timeout', 'stopped', 'cancelled'].includes(agent.status)
  );
}

/** Output fingerprint, not only the id: new attempts reappear without copying transcripts to storage. */
function receipt(agent: AgentTranscript): string {
  const text = JSON.stringify([agent.status, agent.task, agent.entries]);
  let first = 2166136261;
  let second = 5381;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    first = Math.imul(first ^ code, 16777619);
    second = Math.imul(second, 33) ^ code;
  }
  // A display preference fingerprint, not an authentication or integrity credential.
  return `${text.length}:${first >>> 0}:${second >>> 0}`;
}

function readCleared(key: string): ClearedAgents {
  const value: unknown = JSON.parse(localStorage.getItem(key) ?? '{}');
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw Error('Invalid cleanup preferences');
  return Object.fromEntries(Object.entries(value).filter(([, stamp]) => typeof stamp === 'string'));
}

function load(key: string): { key: string; cleared: ClearedAgents; problem: boolean } {
  try {
    return { key, cleared: readCleared(key), problem: false };
  } catch {
    // Reading remains available; the rail reports the unavailable preference store.
    return { key, cleared: {}, problem: true };
  }
}

/** UI-only, per recorded session. No history, engine state, or running process is deleted. */
export function useAgentCleanup(sessionId: string) {
  const key = keyFor(sessionId);
  const [snapshot, setSnapshot] = useState(() => load(key));
  useEffect(() => {
    const refresh = () => setSnapshot(load(key));
    refresh();
    const storage = (event: StorageEvent) => {
      if (event.key === key || event.key === null) refresh();
    };
    window.addEventListener('storage', storage);
    window.addEventListener(changed, refresh);
    return () => {
      window.removeEventListener('storage', storage);
      window.removeEventListener(changed, refresh);
    };
  }, [key]);
  const cleared = snapshot.key === key ? snapshot.cleared : {};
  return {
    problem: snapshot.key === key && snapshot.problem,
    hidden: (agent: AgentTranscript) =>
      isInactiveAgent(agent) &&
      typeof cleared[agent.id] === 'string' &&
      cleared[agent.id] === receipt(agent),
    clear: (agents: readonly AgentTranscript[]) => {
      if (!sessionId) return false;
      try {
        const next = { ...readCleared(key) };
        for (const agent of agents) if (isInactiveAgent(agent)) next[agent.id] = receipt(agent);
        localStorage.setItem(key, JSON.stringify(next));
        setSnapshot({ key, cleared: next, problem: false });
        window.dispatchEvent(new Event(changed));
        return true;
      } catch {
        setSnapshot((current) => ({ ...current, key, problem: true }));
        return false;
      }
    },
    restore: () => {
      try {
        localStorage.removeItem(key);
        setSnapshot({ key, cleared: {}, problem: false });
        window.dispatchEvent(new Event(changed));
        return true;
      } catch {
        setSnapshot((current) => ({ ...current, key, problem: true }));
        return false;
      }
    },
  };
}
