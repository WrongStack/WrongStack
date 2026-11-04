import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import { useEffect, useRef } from 'react';
import { useDesktopText } from './desktop-i18n';
import { request, streamTerminal } from './platform';
import '@xterm/xterm/css/xterm.css';

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
      fontFamily: 'Cascadia Code, Consolas, monospace',
      scrollback: 10000,
    });
    const updateTheme = () => {
      const css = getComputedStyle(document.documentElement);
      terminal.options.theme = {
        background: css.getPropertyValue('--terminal-background').trim(),
        foreground: css.getPropertyValue('--terminal-foreground').trim(),
        cursor: css.getPropertyValue('--terminal-cursor').trim(),
        selectionBackground: css.getPropertyValue('--terminal-selection').trim(),
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
      input.dispose();
      terminal.dispose();
    };
  }, [id, writable, onError]);
  return (
    <section className="terminal-surface" ref={container} aria-label={t('terminalPane.label')} />
  );
}
