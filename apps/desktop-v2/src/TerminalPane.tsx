import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import { useEffect, useRef } from 'react';
import { currentCodeFont, DEFAULT_CODE_STACK, subscribeCodeFont } from './appearance-fonts';
import { useDesktopText } from './desktop-i18n';
import { request, streamTerminal } from './platform';
import '@xterm/xterm/css/xterm.css';

/** ANSI colours readable on the light terminal background. */
const LIGHT_ANSI = {
  black: '#1f2328',
  red: '#b3261e',
  green: '#1a7f37',
  yellow: '#7a5600',
  blue: '#0b5cad',
  magenta: '#8e3fb2',
  cyan: '#0f6b78',
  white: '#57606a',
  brightBlack: '#57606a',
  brightRed: '#a40e26',
  brightGreen: '#116329',
  brightYellow: '#6f4e00',
  brightBlue: '#0a4a8c',
  brightMagenta: '#6e2d8f',
  brightCyan: '#0b5866',
  brightWhite: '#424a53',
};

export function TerminalPane({
  id,
  writable,
  onError,
}: {
  id: string;
  writable: boolean;
  onError: (error: unknown) => void;
}) {
  const { t } = useDesktopText();
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!container.current) return;
    const terminal = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: currentCodeFont().family ?? DEFAULT_CODE_STACK,
      scrollback: 10000,
    });
    const updateTheme = () => {
      const css = getComputedStyle(document.documentElement);
      terminal.options.theme = {
        background: css.getPropertyValue('--terminal-background').trim(),
        foreground: css.getPropertyValue('--terminal-foreground').trim(),
        cursor: css.getPropertyValue('--terminal-cursor').trim(),
        selectionBackground: css.getPropertyValue('--terminal-selection').trim(),
        // The ANSI colours xterm ships are made for a dark background; on the light one its
        // yellow (PowerShell's commands) and bright colours were unreadable.
        ...(document.documentElement.dataset['mode'] === 'dark' ? {} : LIGHT_ANSI),
      };
    };
    updateTheme();
    const themeObserver = new MutationObserver(updateTheme);
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-mode', 'data-accent'],
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(container.current);
    let pending = Promise.resolve();
    const input = terminal.onData((data) => {
      if (writable)
        pending = pending.then(() => request<void>('session.write', { id, data })).catch(onError);
    });
    let resizeFrame = 0;
    let lastSize = '';
    const resize = () => {
      cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(() => {
        fit.fit();
        const size = `${terminal.cols}x${terminal.rows}`;
        if (writable && size !== lastSize) {
          lastSize = size;
          void request('session.resize', { id, rows: terminal.rows, cols: terminal.cols }).catch(
            onError,
          );
        }
      });
    };
    // A code font chosen in Appearance re-measures the grid, which may change its size.
    const stopFont = subscribeCodeFont(() => {
      terminal.options.fontFamily = currentCodeFont().family ?? DEFAULT_CODE_STACK;
      resize();
    });
    const observer = new ResizeObserver(resize);
    observer.observe(container.current);
    const stop = streamTerminal(
      id,
      (data, acknowledge) => terminal.write(data, acknowledge),
      onError,
    );
    const frame = requestAnimationFrame(() => {
      resize();
      terminal.focus();
    });
    return () => {
      cancelAnimationFrame(frame);
      cancelAnimationFrame(resizeFrame);
      stop();
      observer.disconnect();
      themeObserver.disconnect();
      stopFont();
      input.dispose();
      terminal.dispose();
    };
  }, [id, writable, onError]);
  return (
    <section className="terminal-surface" ref={container} aria-label={t('terminalPane.label')} />
  );
}
