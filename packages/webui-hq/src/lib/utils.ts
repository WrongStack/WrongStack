import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Merge Tailwind class lists so the last conflicting utility wins.
 * Identical to `packages/webui/src/lib/utils.ts` — the two surfaces share one
 * design system, so they must share one class-merge semantics.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
