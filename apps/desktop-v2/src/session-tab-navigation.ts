/**
 * Pure navigation math for the session tab strip's IDE-style keyboard model.
 * The strip is a roving-tabindex widget: one Tab stop, arrows/Home/End move the
 * focus without activating (Enter, Space or click activate), and Delete detaches.
 */
export function nextRovingIndex(key: string, index: number, count: number): number {
  if (count <= 0) return -1;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  if (key === 'ArrowRight') return (index + 1) % count;
  if (key === 'ArrowLeft') return (index + count - 1) % count;
  return -1;
}
