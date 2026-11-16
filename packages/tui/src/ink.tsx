// Theme-aware Ink shim.
//
// Ink resolves bare color names (`color="red"`) against the terminal's own
// 16-color palette — typically dark and harsh. Rather than rewrite the ~300
// hardcoded color attributes scattered across the TUI, we wrap Ink's `Text`
// and `Box` so every `color` / `backgroundColor` / `borderColor` they receive
// is routed through `softColor` and remapped to the active theme (see
// theme.ts). This catches *both* static literals and dynamic values (syntax
// highlight tokens, per-subagent colors, status-chip ternaries) with a single
// import swap per component (`from 'ink'` → `from './ink.js'`).
//
// Input hooks also preserve bracketed-paste provenance below. Other Ink hooks
// are re-exported so callers can switch one import line without losing them.

import { isAsciiMode, toAscii } from '@wrongstack/core/utils';
import {
  type DOMElement,
  Box as InkBox,
  type Key as InkKey,
  Text as InkText,
  useInput as useInkInput,
  usePaste as useInkPaste,
  useStdout as useInkStdout,
} from 'ink';
import {
  type ComponentProps,
  type ForwardRefExoticComponent,
  forwardRef,
  type ReactElement,
  type ReactNode,
  type RefAttributes,
} from 'react';
import { softColor } from './theme.js';

// Mirror Ink's own prop types exactly so any call site that compiled against
// Ink's `Box`/`Text` compiles unchanged against these wrappers (including the
// `borderBottom={cond ? false : undefined}`-style explicit `undefined` that
// `exactOptionalPropertyTypes` permits on Ink's props).
// The color-ish props are widened with `| undefined`: the shim strips them and
// only re-attaches when they resolve to a value, so an explicit `undefined`
// (e.g. `color={isSelected ? 'cyan' : undefined}`) is safe here even though
// Ink's own props reject it under `exactOptionalPropertyTypes`.
type TextOwnProps = Omit<ComponentProps<typeof InkText>, 'color' | 'backgroundColor'> & {
  color?: string | undefined;
  backgroundColor?: string | undefined;
};
type BoxOwnProps = Omit<
  ComponentProps<typeof InkBox>,
  'ref' | 'borderColor' | 'backgroundColor'
> & {
  borderColor?: string | undefined;
  backgroundColor?: string | undefined;
};

export type { DOMElement } from 'ink';
export type Key = InkKey & { readonly paste?: boolean };
export {
  measureElement,
  Static,
  useAnimation,
  useApp,
  useStdin,
} from 'ink';

const PASTE_KEY: Key = {
  upArrow: false,
  downArrow: false,
  leftArrow: false,
  rightArrow: false,
  pageUp: false,
  pageDown: false,
  home: false,
  end: false,
  return: false,
  escape: false,
  ctrl: false,
  shift: false,
  tab: false,
  backspace: false,
  delete: false,
  meta: false,
  super: false,
  hyper: false,
  capsLock: false,
  numLock: false,
  paste: true,
};

/**
 * Keep paste as data for every input owner, including locally handled panels.
 * Ink's legacy fallback parses a paste as a key and loses its provenance;
 * xterm.js also converts pasted newlines to CR before sending them to the PTY.
 */
export function useInput(
  handler: (input: string, key: Key) => void,
  options?: Parameters<typeof useInkInput>[1],
): void {
  useInkInput((input, key) => {
    // A PTY may coalesce the final typed characters and Return into one read.
    // Bracketed paste has its own channel below, so CR here is a submit key.
    if (input.includes('\r') && !key.ctrl && !key.meta) {
      const parts = input.split(/\r\n?/);
      for (let index = 0; index < parts.length; index++) {
        if (parts[index]) handler(parts[index]!, key);
        if (index < parts.length - 1) handler('', { ...key, return: true });
      }
      return;
    }
    handler(input, key);
  }, options);
  useInkPaste((text) => handler(text.replace(/\r\n?/g, '\n'), PASTE_KEY), options);
}

// Ink 8 accepts generic writable streams. Terminal dimensions are optional on
// pipes and injected renderers; callers retain their existing non-TTY defaults.
type TerminalOutput = NodeJS.WritableStream & Partial<Pick<NodeJS.WriteStream, 'columns' | 'rows'>>;

export function useStdout(): Omit<ReturnType<typeof useInkStdout>, 'stdout'> & {
  stdout: TerminalOutput;
} {
  return useInkStdout();
}

// `exactOptionalPropertyTypes` forbids passing `color={undefined}`, so we only
// attach a color prop when it actually resolves to a value.
const colorProps = (color?: string, backgroundColor?: string) => {
  const c = softColor(color);
  const bg = softColor(backgroundColor);
  return { ...(c ? { color: c } : {}), ...(bg ? { backgroundColor: bg } : {}) };
};

// ASCII mode (`--ascii` / WRONGSTACK_TUI_ICON_STYLE=ascii): text is converted
// here, before Ink measures it, so layout and output agree; borders use Ink's
// `classic` (+-|) style. Read once, like the glyph set in ui-glyphs.ts.
const ASCII_MODE = isAsciiMode();

function asciiChildren(children: ReactNode): ReactNode {
  if (typeof children === 'string') return toAscii(children);
  if (Array.isArray(children)) return children.map(asciiChildren);
  return children;
}

/** Ink `Text` with named colors resolved against the active theme. */
export function Text({ color, backgroundColor, children, ...rest }: TextOwnProps): ReactElement {
  return (
    <InkText {...rest} {...colorProps(color, backgroundColor)}>
      {ASCII_MODE ? asciiChildren(children) : children}
    </InkText>
  );
}

/**
 * Ink `Box` with named border/background colors resolved against the theme. Forwards
 * `ref` so `measureElement` (used by the scrollable history) keeps working.
 */
export const Box: ForwardRefExoticComponent<BoxOwnProps & RefAttributes<DOMElement>> = forwardRef<
  DOMElement,
  BoxOwnProps
>(function Box({ borderColor, backgroundColor, ...rest }, ref) {
  const bc = softColor(borderColor);
  const bg = softColor(backgroundColor);
  return (
    <InkBox
      ref={ref}
      {...rest}
      {...(ASCII_MODE && rest.borderStyle ? { borderStyle: 'classic' as const } : {})}
      {...(bc ? { borderColor: bc } : {})}
      {...(bg ? { backgroundColor: bg } : {})}
    />
  );
});
