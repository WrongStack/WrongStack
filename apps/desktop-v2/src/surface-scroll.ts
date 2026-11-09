import { useLayoutEffect, useRef } from 'react';

const positions = new Map<string, number>();
export const surfaceScrollKey = (scope: string, key: string) =>
  `wrongstack.desktop.scroll:${encodeURIComponent(scope)}:${encodeURIComponent(key)}`;

/** Window-local history: project/profile and inspector keys never share a position. */
export function useSurfaceScroll<T extends HTMLElement>(
  scope: string,
  key: string,
  enabled = true,
) {
  const ref = useRef<T | null>(null);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node || !enabled) return;
    const storageKey = surfaceScrollKey(scope, key);
    let saved = positions.get(storageKey) ?? 0;
    try {
      const stored = sessionStorage.getItem(storageKey);
      if (stored !== null && Number.isFinite(Number(stored))) saved = Math.max(0, Number(stored));
    } catch {
      /* Window memory still provides revisit restoration. */
    }
    let restored = false,
      frame = 0;
    const save = () => {
      if (!restored) return;
      positions.set(storageKey, node.scrollTop);
      if (positions.size > 200) positions.delete(positions.keys().next().value!);
      try {
        sessionStorage.setItem(storageKey, String(node.scrollTop));
      } catch {
        /* Memory fallback. */
      }
    };
    const restore = () => {
      if (restored) return;
      node.scrollTop = saved;
      restored = node.scrollHeight - node.clientHeight >= saved;
    };
    const interact = () => {
      restored = true;
      save();
    };
    const changed = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(restore);
    };
    node.addEventListener('scroll', save);
    node.addEventListener('wheel', interact, { passive: true });
    node.addEventListener('pointerdown', interact);
    node.addEventListener('keydown', interact);
    const changes = new MutationObserver(changed);
    changes.observe(node, { subtree: true, childList: true, characterData: true });
    const sizes = new ResizeObserver(changed);
    sizes.observe(node);
    restore();
    return () => {
      save();
      cancelAnimationFrame(frame);
      changes.disconnect();
      sizes.disconnect();
      node.removeEventListener('scroll', save);
      node.removeEventListener('wheel', interact);
      node.removeEventListener('pointerdown', interact);
      node.removeEventListener('keydown', interact);
    };
  });
  return ref;
}
