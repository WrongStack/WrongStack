import type { SageStatus } from './model-types';
import type { VectorMemoryHit } from './vector/model.js';

export interface VectorSearchSnapshot {
  query: string;
  hits: readonly VectorMemoryHit[];
  nextCursor: string | null;
  similarity?: readonly (readonly number[])[] | undefined;
  limit: number;
  threshold: number | undefined;
  searchRan: boolean;
}

/** Search inputs shared by the two search lenses. Unsupported filters stay visible. */
export interface SharedMemorySearch {
  query: string;
  setQuery: (value: string) => void;
  statusFilter: 'all' | SageStatus;
  setStatusFilter: (value: 'all' | SageStatus) => void;
  kindFilter: string;
  setKindFilter: (value: string) => void;
  navigateToSage: (id: string) => void;
  vectorSnapshot?: VectorSearchSnapshot | null;
  setVectorSnapshot?: (snapshot: VectorSearchSnapshot | null) => void;
}
