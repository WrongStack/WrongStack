import { EngineHttpError } from './engine-http-error';

export { EngineHttpError, engineHttpError } from './engine-http-error';

import { request } from './platform';

export type EngineHttp = (resource: string, method?: string, body?: unknown) => Promise<unknown>;
export function engineHttp(id: string): EngineHttp {
  return scopedHttp('engine', id);
}
export function projectHttp(id: string): EngineHttp {
  return scopedHttp('project', id);
}
export function profileHttp(): EngineHttp {
  return scopedHttp('profile', '');
}
function scopedHttp(scope: 'engine' | 'project' | 'profile', id: string): EngineHttp {
  return async (resource, method = 'GET', body) => {
    const response = await request<{ ok: boolean; status: number; data: unknown }>(
      `${scope}.http`,
      {
        ...(scope === 'project' ? { projectId: id } : { id }),
        resource,
        method,
        body: body ?? null,
        ...(method === 'POST' ? { operationId: crypto.randomUUID() } : {}),
      },
    );
    if (!response.ok) throw new EngineHttpError(response.status, response.data);
    return response.data;
  };
}
/**
 * Retries a read the engine answers with 503 while its data is being rebuilt (the code index
 * during a background refresh), 1, 2, 4, 8 and 16 seconds apart; after that the error stands.
 */
export function retryWhileUnavailable(
  http: EngineHttp,
  delays: readonly number[] = [1000, 2000, 4000, 8000, 16000],
): EngineHttp {
  return async (resource, method = 'GET', body) => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await http(resource, method, body);
      } catch (error) {
        const unavailable = error instanceof EngineHttpError && error.status === 503;
        if (!unavailable || method !== 'GET' || attempt >= delays.length) throw error;
        await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
      }
    }
  };
}
