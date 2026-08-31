/**
 * Recursively walk a React element tree and force every <Text> descendant to
 * use `wrap="truncate"`, so the text can never overflow its parent's width
 * and break a wrapping frame (e.g. the per-row `│ … │` chrome of a Card or
 * SidebarPanelCard).
 *
 * Why this exists: Ink lays out a flex child at the size yoga gives it, but
 * a <Text> that doesn't set `wrap="truncate"` will soft-wrap into a multi-
 * line block when the visible content is wider than the parent. That extra
 * height "punches through" our per-row `│` wrapper — the right bar only sits
 * on the first line, so the wrapped overflow lines are bare and the frame
 * looks broken.
 *
 * The clean fix is to ensure EVERY <Text> in the body has `wrap="truncate"`.
 * Rather than asking every call site to remember that, we walk the rendered
 * tree once before it reaches the Card and rewrite the prop. Box children
 * pass through unchanged (their internal layout is the caller's concern, but
 * they usually contain a single Text row anyway).
 */
import type { ReactElement, ReactNode } from 'react';
import React from 'react';

type AnyElement = ReactElement<Record<string, unknown>>;

function isReactElement(value: unknown): value is AnyElement {
  return React.isValidElement(value);
}

function truncateTextDeep(node: ReactNode): ReactNode {
  if (node === null || node === undefined || node === false || node === true) {
    return node;
  }
  if (typeof node === 'string' || typeof node === 'number') {
    return node;
  }
  if (Array.isArray(node)) {
    return node.map((child, index) => {
      const walked = truncateTextDeep(child);
      // Callers frequently return the Card body as a bare array; React then
      // warns "each child in a list should have a unique key" against the
      // Card that renders it. Fill keys the caller omitted, leaving keys the
      // caller set untouched.
      if (isReactElement(walked) && walked.key === null) {
        return React.cloneElement(walked, { key: `wst-wrap-${index}` });
      }
      return walked;
    });
  }
  if (!isReactElement(node)) {
    return node;
  }
  const element = node as AnyElement;
  const type = element.type as unknown;
  if (type === React.Fragment) {
    const child = (element.props as { children?: ReactNode }).children;
    return React.cloneElement(element, { ...element.props, children: truncateTextDeep(child) });
  }
  // Ink's <Text> renders as a function/forwardRef component. We can't easily
  // distinguish Text from a non-Text element by type, but the prop we care
  // about (`wrap`) is only meaningful on Text — applying it to a Box or
  // other component is a harmless no-op because they ignore unknown props.
  // (React would warn about unknown DOM props in the browser, but Ink is
  // server-rendered / custom reconciler and ignores them.)
  const props = element.props;
  const nextProps: Record<string, unknown> = { ...props };
  if (nextProps.wrap === undefined) {
    nextProps.wrap = 'truncate';
  }
  if ('children' in props) {
    nextProps.children = truncateTextDeep((props as { children?: ReactNode }).children);
  }
  return React.cloneElement(element, nextProps);
}

export function truncateTextChildren(node: ReactNode): ReactNode {
  return truncateTextDeep(node);
}
