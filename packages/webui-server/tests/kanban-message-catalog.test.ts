/**
 * `KANBAN_CLIENT_MESSAGE_TYPES` is the declared catalog of kanban messages a
 * client may send to the standalone route table. Two parity tests already check
 * that every listed type is dispatched; neither could catch the other
 * direction, and `kanban.board.history` had been handled by
 * `kanban-board-routes.ts` — and sent by the WebUI store — while being absent
 * from the list.
 *
 * That omission was latent rather than broken: the runtime registry admits any
 * `kanban.*` prefix, and the constant is currently only re-exported. But a
 * catalog that silently disagrees with the switch is the exact failure the
 * catalog exists to prevent, so this test closes the loop by scanning the route
 * sources for their `case 'kanban.…'` labels.
 *
 * `kanban-host-routes.ts` is deliberately excluded: it is a SEPARATE surface
 * (the CLI-hosted WebUI supplies its handlers) with its own four message types,
 * which is why `kanban.meta` and `kanban.run.start` are correctly absent from
 * the standalone catalog.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { KANBAN_CLIENT_MESSAGE_TYPES } from '../src/server/kanban-routes.js';

const SERVER_DIR = path.resolve(import.meta.dirname, '../src/server');

/** Route modules reachable from `handleKanbanRoute`. Host routes are separate. */
const ROUTE_FILES = [
  'kanban-board-routes.ts',
  'kanban-companion-routes.ts',
  'kanban-contract-routes.ts',
  'kanban-decomposition-routes.ts',
  'kanban-item-routes.ts',
  'kanban-orchestration-routes.ts',
  'kanban-routes.ts',
  'kanban-task-lifecycle-routes.ts',
  'kanban-task-routes.ts',
];

const HOST_ROUTE_FILE = 'kanban-host-routes.ts';

function caseLabels(fileName: string): string[] {
  const source = fs.readFileSync(path.join(SERVER_DIR, fileName), 'utf8');
  return [...source.matchAll(/case '(kanban\.[^']+)':/g)].map((match) => match[1] as string);
}

describe('kanban client message catalog', () => {
  it('lists every kanban.* case the standalone route table dispatches', () => {
    const handled = new Set(ROUTE_FILES.flatMap(caseLabels));
    const declared = new Set<string>(KANBAN_CLIENT_MESSAGE_TYPES);
    const missing = [...handled].filter((type) => !declared.has(type)).sort();
    expect(missing).toEqual([]);
  });

  it('does not list host-surface message types', () => {
    // These are answered only when a host supplies KanbanHostRouteHandlers, so
    // putting them in the standalone catalog would promise a route that the
    // standalone server does not have.
    const hostOnly = new Set(caseLabels(HOST_ROUTE_FILE));
    const declared = new Set<string>(KANBAN_CLIENT_MESSAGE_TYPES);
    // `kanban.supervisor.*` is served by BOTH surfaces, so only the two that
    // exist nowhere else are asserted absent.
    for (const type of ['kanban.meta', 'kanban.run.start']) {
      expect(hostOnly.has(type), `${type} should be a host route`).toBe(true);
      expect(declared.has(type), `${type} should not be in the standalone catalog`).toBe(false);
    }
  });

  it('keeps the catalog sorted and free of duplicates', () => {
    const declared = [...KANBAN_CLIENT_MESSAGE_TYPES];
    expect(declared).toEqual([...declared].sort());
    expect(new Set(declared).size).toBe(declared.length);
  });
});
