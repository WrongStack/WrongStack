import { useEffect, useState } from 'react';
import { surfaceFetch } from '../host';

export function useKanbanRegistrySessionIds(): string[] {
  const [registrySessionIds, setRegistrySessionIds] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    const refreshRegistry = async () => {
      try {
        // Through the host: on Desktop the webview has no `/api` server.
        const response = await surfaceFetch('/api/sessions');
        if (!response.ok) return;
        const data = (await response.json()) as unknown;
        if (!Array.isArray(data) || cancelled) return;
        const ids = data
          .filter(
            (entry): entry is { sessionId: string; status?: string } =>
              Boolean(entry) &&
              typeof entry === 'object' &&
              typeof (entry as { sessionId?: unknown }).sessionId === 'string' &&
              (entry as { status?: unknown }).status !== 'lost',
          )
          .map((entry) => entry.sessionId)
          .sort();
        setRegistrySessionIds((current) =>
          current.length === ids.length && current.every((id, index) => id === ids[index])
            ? current
            : ids,
        );
      } catch {
        // Standalone/static WebUI builds may not expose /api/sessions.
      }
    };
    void refreshRegistry();
    const interval = window.setInterval(refreshRegistry, 8_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, []);

  return registrySessionIds;
}
