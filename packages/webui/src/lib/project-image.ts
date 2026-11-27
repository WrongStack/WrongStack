/**
 * Load an image from the project for display (`files.image`): the server
 * checks the path stays inside the project, sniffs the bytes, and answers
 * with a data URL. Answers are cached for the page (a few dozen, newest kept);
 * a miss is not cached, so a later look can succeed.
 */

import { useEffect, useState } from 'react';
import { useConfigStore } from '@/stores';
import { getWSClient } from './ws-client';

export type ProjectImageState =
  | { status: 'loading' }
  | { status: 'ready'; dataUrl: string; bytes?: number | undefined }
  | { status: 'unavailable'; reason: 'tooLarge' | 'notImage' | 'error'; detail?: string };

const MAX_CACHED = 32;
const TIMEOUT_MS = 15_000;
const cache = new Map<string, Promise<ProjectImageState>>();

/**
 * `key` tells apart two looks at one path (the same file generated twice);
 * it defaults to the path.
 */
export function loadProjectImage(filePath: string, key = filePath): Promise<ProjectImageState> {
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const ws = getWSClient(useConfigStore.getState().wsUrl);
  const pending = new Promise<ProjectImageState>((resolve) => {
    const timer = setTimeout(() => {
      off();
      resolve({ status: 'unavailable', reason: 'error', detail: 'no answer' });
    }, TIMEOUT_MS);
    const off = ws.on('files.image', (msg) => {
      const p = msg.payload;
      if (p.filePath !== filePath) return;
      clearTimeout(timer);
      off();
      if (p.dataUrl) resolve({ status: 'ready', dataUrl: p.dataUrl, bytes: p.bytes });
      else if (p.tooLarge) resolve({ status: 'unavailable', reason: 'tooLarge' });
      else if (p.notImage) resolve({ status: 'unavailable', reason: 'notImage' });
      else resolve({ status: 'unavailable', reason: 'error', detail: p.error });
    });
    ws.send({ type: 'files.image', payload: ws.withSession({ filePath }) });
  });
  cache.set(key, pending);
  while (cache.size > MAX_CACHED) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  void pending.then((state) => {
    if (state.status !== 'ready' && cache.get(key) === pending) cache.delete(key);
  });
  return pending;
}

export function useProjectImage(filePath: string | undefined, key?: string): ProjectImageState {
  const [state, setState] = useState<ProjectImageState>({ status: 'loading' });
  useEffect(() => {
    if (!filePath) return;
    let live = true;
    setState({ status: 'loading' });
    void loadProjectImage(filePath, key).then((next) => {
      if (live) setState(next);
    });
    return () => {
      live = false;
    };
  }, [filePath, key]);
  return state;
}

/** `12.3 KiB`-style size for image captions. */
export function formatImageBytes(bytes: number | undefined): string {
  if (bytes === undefined) return '';
  if (bytes < 1024) return `${bytes} B`;
  // Promote on the rounded value: 1_048_575 B is "1.0 MiB", not "1024.0 KiB".
  const kib = (bytes / 1024).toFixed(1);
  if (Number(kib) < 1024) return `${kib} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
