import './status-chips.css';

/**
 * Which pieces of a conversation's status bar show, as the TUI's `/statusline` picker and the
 * WebUI's dock customizer choose theirs. The state and the context meter always show.
 */
export const statusChips = ['cache', 'memory', 'iteration', 'git', 'tokens', 'cost'] as const;
export type StatusChip = (typeof statusChips)[number];

export interface StatusAppearance {
  /** Chips hidden from the status bar; unset shows them all. */
  statusHidden?: StatusChip[] | undefined;
}

/** The hidden chips of a stored appearance: known names, once each, in the bar's order. */
export function parseStatusAppearance(candidate: Record<string, unknown>): StatusAppearance {
  const stored = candidate['statusHidden'];
  if (!Array.isArray(stored)) return {};
  const hidden = statusChips.filter((chip) => stored.includes(chip));
  return hidden.length ? { statusHidden: hidden } : {};
}

/** `statusHidden` with `chip` shown or hidden; undefined once every chip shows. */
export function toggleStatusChip(
  hidden: readonly StatusChip[] | undefined,
  chip: StatusChip,
  visible: boolean,
): StatusChip[] | undefined {
  const next = statusChips.filter((item) =>
    item === chip ? !visible : (hidden ?? []).includes(item),
  );
  return next.length ? next : undefined;
}

/** Marks the hidden chips on the document, where status-chips.css hides them. */
export function applyStatusAppearance(root: HTMLElement, status: StatusAppearance) {
  if (status.statusHidden?.length) root.dataset['statusHidden'] = status.statusHidden.join(' ');
  else delete root.dataset['statusHidden'];
}
