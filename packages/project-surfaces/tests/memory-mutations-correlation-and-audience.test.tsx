/**
 * @vitest-environment jsdom
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SurfaceClient } from '../src/host.js';
import type { MemoryDraft } from '../src/sage/shared.js';
import { createSageSocket } from '../src/sage/socket.js';
import type { SageEntry } from '../src/sage/types.js';
import { useMemoryMutations } from '../src/sage/useMemoryMutations.js';

function makeMemory(id: string, overrides: Partial<SageEntry> = {}): SageEntry {
  return {
    id,
    revision: 2,
    scope: 'project',
    kind: 'decision',
    status: 'active',
    text: `Memory ${id} text`,
    importance: 0.8,
    confidence: 0.85,
    freshness: 0.9,
    tags: ['sage'],
    anchors: [],
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeDraft(overrides: Partial<MemoryDraft> = {}): MemoryDraft {
  return {
    text: 'Updated target memory text.',
    validityStatement: '',
    validityChecks: [],
    observedRevision: 2,
    kind: 'decision',
    scope: 'project',
    status: 'active',
    tags: 'sage',
    importance: 0.8,
    confidence: 0.85,
    freshness: 0.9,
    anchors: [],
    audienceRoles: '',
    audienceTaskTypes: '',
    audienceModes: '',
    supersedes: '',
    contradicts: '',
    ...overrides,
  };
}

describe('useMemoryMutations reply correlation, send failure cleanup, and audience clearing', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it('ignores foreign memory.sage.update/remember replies, clears existing audience scope on empty draft lists, and cleans up on sync send throws', async () => {
    const listeners = new Map<string, Set<(msg: { type: string; payload: unknown }) => void>>();
    const wireFrames: Array<{ type: string; payload?: Record<string, unknown> }> = [];
    let shouldThrowOnSend = false;

    const client: SurfaceClient = {
      on(type, handler) {
        const set = listeners.get(type) ?? new Set();
        set.add(handler);
        listeners.set(type, set);
        return () => set.delete(handler);
      },
      findMemoriesForFile() {},
    };
    const emit = (type: string, payload: unknown) => {
      for (const cb of [...(listeners.get(type) ?? [])]) cb({ type, payload });
    };
    const socket = createSageSocket(client, (frame) => {
      if (shouldThrowOnSend) throw new Error('Socket transport closed');
      wireFrames.push(frame);
    });

    let state!: {
      busyAction: 'create' | 'update' | null;
      editing: boolean;
      selectedId: string | null;
      mutationError: string | null;
      submitCreate: () => void;
      submitUpdate: () => void;
      setEditing: (v: boolean) => void;
    };

    function Harness() {
      const [draft] = useState<MemoryDraft>(() => makeDraft());
      const [selectedMemory] = useState<SageEntry | null>(() =>
        makeMemory('mem_target', { audience: { roles: ['reviewer'] } }),
      );
      const [busyAction, setBusyAction] = useState<'create' | 'update' | null>(null);
      const [editing, setEditing] = useState(true);
      const [, setCreating] = useState(false);
      const [selectedId, setSelectedId] = useState<string | null>('mem_target');
      const [mutationError, setMutationError] = useState<string | null>(null);
      const [, setNotice] = useState<string | null>(null);
      const [, setMemories] = useState<SageEntry[]>([]);
      const mutationGenerationRef = useRef(0);
      const mutationCleanupRef = useRef<(() => void) | null>(null);
      const mountedRef = useRef(true);

      const { submitCreate, submitUpdate } = useMemoryMutations({
        draft,
        setMutationError,
        mutationGenerationRef,
        mutationCleanupRef,
        setBusyAction,
        setNotice,
        mountedRef,
        setMemories,
        setSelectedId,
        setCreating,
        setEditing,
        t: ((key: string) => key) as never,
        loadMemories: () => {},
        client,
        rememberSage: socket.rememberSage,
        selectedMemory,
        updateSage: socket.updateSage,
      });

      state = {
        busyAction,
        editing,
        selectedId,
        mutationError,
        submitCreate,
        submitUpdate,
        setEditing,
      };
      return null;
    }

    await act(async () => {
      root.render(<Harness />);
    });

    await act(async () => {
      state.submitUpdate();
    });
    const sentUpdate = wireFrames.at(-1)!;
    expect(sentUpdate.payload?.['audience']).toEqual({
      roles: [],
      taskTypes: [],
      modes: [],
    });
    const reqId = sentUpdate.payload?.['requestId'];
    expect(typeof reqId).toBe('string');

    // Foreign reply (different requestId / different memory.id) must not hijack or close editor
    await act(async () => {
      emit('memory.sage.update', {
        requestId: 'ack_foreign_drawer',
        memory: makeMemory('mem_other', { persistence: 'permanent' }),
      });
    });
    expect(state.editing).toBe(true);
    expect(state.busyAction).toBe('update');
    expect(state.selectedId).toBe('mem_target');

    // Matching conflict error surfaces on the editor
    await act(async () => {
      emit('memory.sage.update', {
        requestId: reqId,
        error: 'SAGE revision changed; read the current memory before updating it.',
      });
    });
    expect(state.busyAction).toBeNull();
    expect(state.mutationError).toContain('revision changed');

    // Synchronous send failure cleans up listener and busyAction immediately
    shouldThrowOnSend = true;
    await act(async () => {
      state.submitCreate();
    });
    expect(listeners.get('memory.sage.remember')?.size ?? 0).toBe(0);
    expect(state.busyAction).toBeNull();
    expect(state.mutationError).toBe('Socket transport closed');
  });
});
