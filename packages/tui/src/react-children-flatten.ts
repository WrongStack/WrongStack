/**
 * Recursively unwrap React Fragments AND Boxes into a flat list of leaf
 * element children.
 *
 * `React.Children.toArray` does NOT flatten Fragments — a Fragment with three
 * `<Text>` children is reported as a single Fragment element. That behavior
 * is fine for most React APIs (which then recurse themselves), but in
 * sidebar cards we want to wrap EACH child in a `│ … │` row. To do that
 * correctly across nested conditional Fragments AND Boxes (which callers
 * use to group their body rows), we need a real flattener that pulls the
 * children out at any depth.
 *
 * Box recursion: a `<Box flexDirection="column">` with several Text rows
 * inside is treated as a group of separate children, not one block. The
 * reason is that the per-row `│ … │` wrapper paints the side bar on the
 * FIRST line of each child element — if the Box is treated as a single
 * child, only its first line gets a right `│` and the rest of the Box
 * overflows past the right edge, visually breaking the frame. Recursing
 * into Boxes costs us the inner Box's flex/width/padding context, but
 * callers use Boxes for "group my rows vertically" semantics, and the
 * per-row `│ … │` wrapper already controls width, padding, and background.
 *
 * Text/primitive nodes are skipped: we only return elements that the
 * caller asked to wrap in `│ … │`.
 */
import type { ReactElement, ReactNode } from 'react';
import React from 'react';

export function flattenChildren(node: ReactNode): ReactElement[] {
  const result: ReactElement[] = [];
  const visit = (n: ReactNode): void => {
    if (n === null || n === undefined || n === false || n === true) return;
    if (typeof n === 'string' || typeof n === 'number') return;
    if (Array.isArray(n)) {
      for (const c of n) visit(c);
      return;
    }
    if (React.isValidElement(n)) {
      const type = n.type as unknown;
      if (type === React.Fragment) {
        const children = (n.props as { children?: ReactNode }).children;
        visit(children);
        return;
      }
      // Recurse into <Box flexDirection="column"> so its leaf children
      // become separate top-level rows (the per-row `│ … │` wrapper paints
      // `│` on every line; if a column Box were kept as one child, only
      // its first line would get a right `│` and the rest would overflow
      // past the frame). Box's own props (padding, background, …) are lost
      // in the process — that's intentional, the wrapper supplies its own.
      //
      // We deliberately do NOT recurse into row-flex Boxes: their children
      // are meant to live on the same line (e.g. the percentage + label +
      // inline bar inside the context-load header), and splitting them
      // into separate wrapper rows would shatter the layout.
      //
      // Detection: our Ink shim wraps Box in `React.forwardRef`, so the
      // element's `type` is the *forwardRef object* (typeof === 'object',
      // with a `render` method and a `$$typeof` symbol), not a function.
      // We then read the `flexDirection` prop: only "column" gets
      // flattened; "row" and the default ("row") stay intact.
      if (typeof type !== 'function') {
        const props = n.props as { flexDirection?: string; children?: ReactNode };
        if (props.flexDirection === 'column') {
          visit(props.children);
          return;
        }
      }
      result.push(n);
      return;
    }
  };
  visit(node);
  return result;
}
