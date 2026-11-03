import { useEffect, useState } from 'react';
import { useKanbanHost } from './feed';

interface KanbanToolOption {
  name: string;
  description?: string | undefined;
}

interface KanbanSkillOption {
  name: string;
  description?: string | undefined;
  source?: string | undefined;
}

interface KanbanMeta {
  /** Real registered tools from the live agent runtime (not hardcoded). */
  tools: KanbanToolOption[];
  /** Installed skills available for explicit task-level force loading. */
  skills: KanbanSkillOption[];
  /** Real named fallback chains from the active config. */
  fallbackProfiles: Record<string, string[]>;
  /** The current session's provider — the dispatch fallback when a task has none. */
  sessionProvider: string;
  /** The current session's model — the dispatch fallback when a task has none. */
  sessionModel: string;
}

/**
 * Quiet metadata for the kanban task inspector. Requests the `kanban.meta`
 * round-trip (registered tools + live session provider/model) while a task is
 * selected. Unlike the `tools.list` message this does NOT print to chat.
 *
 * `sessionProvider`/`sessionModel` fall back to the host's default model so
 * session defaults still work on the standalone (single-agent) server, which
 * does not answer `kanban.meta`.
 */
export function useKanbanMeta(active: boolean): KanbanMeta {
  const host = useKanbanHost();
  const { provider: cfgProvider, model: cfgModel } = host.useDefaultModel();
  const [tools, setTools] = useState<KanbanToolOption[]>([]);
  const [skills, setSkills] = useState<KanbanSkillOption[]>([]);
  const [fallbackProfiles, setFallbackProfiles] = useState<Record<string, string[]>>({});
  const [sessionProvider, setSessionProvider] = useState('');
  const [sessionModel, setSessionModel] = useState('');

  useEffect(() => {
    const off = host.on('kanban.meta', (msg) => {
      const p = (msg.payload as { data?: unknown } | undefined)?.data as
        | {
            tools?: KanbanToolOption[];
            skills?: KanbanSkillOption[];
            fallbackProfiles?: Record<string, string[]>;
            sessionProvider?: string;
            sessionModel?: string;
          }
        | undefined;
      if (!p) return;
      setTools(p.tools ?? []);
      setSkills(p.skills ?? []);
      setFallbackProfiles(p.fallbackProfiles ?? {});
      if (p.sessionProvider) setSessionProvider(p.sessionProvider);
      if (p.sessionModel) setSessionModel(p.sessionModel);
    });
    return () => off();
  }, [host]);

  useEffect(() => {
    if (active) host.send('kanban.meta');
  }, [active, host]);

  return {
    tools,
    skills,
    fallbackProfiles,
    sessionProvider: sessionProvider || cfgProvider,
    sessionModel: sessionModel || cfgModel,
  };
}
