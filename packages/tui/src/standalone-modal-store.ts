import type { PluginPromptOptions } from '@wrongstack/contracts/types/plugin';
import { useEffect, useState } from 'react';
import type { Action } from './app-action-type.js';

export type StandaloneModalState =
  | null
  | { kind: 'tree' }
  | { kind: 'plugin-panel'; panelId?: string | undefined }
  | {
      kind: 'plugin-prompt';
      owner: string;
      opts: PluginPromptOptions<string>;
      resolve: (value: string | boolean | null) => void;
    }
  | { kind: 'image'; filePath: string };

export interface StandaloneModalStore {
  get(): StandaloneModalState;
  set(next: StandaloneModalState): void;
  close(): void;
  subscribe(listener: () => void): () => void;
}

const storesByDispatch = new WeakMap<(action: Action) => void, StandaloneModalStore>();

function createStandaloneModalStore(): StandaloneModalStore {
  let state: StandaloneModalState = null;
  const listeners = new Set<() => void>();
  return {
    get() {
      return state;
    },
    set(next) {
      state = next;
      for (const listener of [...listeners]) {
        listener();
      }
    },
    close() {
      if (state === null) return;
      state = null;
      for (const listener of [...listeners]) {
        listener();
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export function standaloneModalStoreOf(dispatch: (action: Action) => void): StandaloneModalStore {
  let store = storesByDispatch.get(dispatch);
  if (!store) {
    store = createStandaloneModalStore();
    storesByDispatch.set(dispatch, store);
  }
  return store;
}

export function useStandaloneModal(dispatch: (action: Action) => void): {
  modal: StandaloneModalState;
  closeModal: () => void;
} {
  const store = standaloneModalStoreOf(dispatch);
  const [modal, setModal] = useState<StandaloneModalState>(() => store.get());
  useEffect(() => {
    setModal(store.get());
    return store.subscribe(() => {
      setModal(store.get());
    });
  }, [store]);
  return {
    modal,
    closeModal: () => store.close(),
  };
}
