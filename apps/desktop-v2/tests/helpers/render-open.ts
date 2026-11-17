import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { EagerDetails } from '../../src/LazyDetails';

/** Static markup with every collapsed section's body built, for tests that read inside them. */
export function renderOpen(element: ReactElement): string {
  return renderToStaticMarkup(createElement(EagerDetails.Provider, { value: true }, element));
}
