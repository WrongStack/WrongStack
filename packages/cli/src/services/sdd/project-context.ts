import type { AISpecBuilder, AISpecPhase, SpecIndexEntry, SpecStore } from '@wrongstack/sdd';
// Shared with the WebUI wizard — single implementation in @wrongstack/sdd.
export { gatherProjectContext } from '@wrongstack/sdd';
import { sddState } from './state.js';

export function getActiveBuilder(): AISpecBuilder | null {
  return sddState.getBuilder();
}

export function getActiveSDDContext(): string | null {
  return sddState.getContext();
}

export function getActiveSDDPhase(): AISpecPhase | null {
  return sddState.getPhase();
}

export async function findSpec(store: SpecStore, idOrTitle: string) {
  if (!idOrTitle) return null;
  const byId = await store.load(idOrTitle);
  if (byId) return byId;
  const all = await store.list();
  const match = all.find(
    (e: SpecIndexEntry) =>
      e.id.startsWith(idOrTitle) || e.title.toLowerCase().includes(idOrTitle.toLowerCase()),
  );
  if (match) return store.load(match.id);
  return null;
}
