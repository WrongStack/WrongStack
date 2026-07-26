import { useEffect, useRef, useState } from 'react';
import {
  MOUSE_CLICK_ON,
  MOUSE_DRAG_ON,
  MOUSE_OFF,
  shouldEnableMouseTracking,
  type MouseTrackingPolicy,
} from '../mouse.js';

type MouseWritable = { write(data: string): unknown } | undefined;

export function useMouseTracking(input: {
  initialMouseMode: boolean;
  overlayOpen: boolean;
  protocol?: MouseTrackingPolicy['protocol'];
  stdout: MouseWritable;
}): { mouseMode: boolean; setMouseMode: (value: boolean) => void } {
  const { initialMouseMode, overlayOpen, protocol, stdout } = input;
  const [mouseMode, setMouseMode] = useState(initialMouseMode);
  const mouseTrackingOn = shouldEnableMouseTracking({
    fullMode: mouseMode,
    overlayOpen,
    managedHistory: true,
    protocol,
  });
  const mouseTrackingSequence = mouseTrackingOn
    ? mouseMode
      ? MOUSE_DRAG_ON
      : MOUSE_CLICK_ON
    : MOUSE_OFF;
  const mouseWrittenRef = useRef<string | null>(null);

  useEffect(() => {
    if (mouseWrittenRef.current === mouseTrackingSequence) return;
    mouseWrittenRef.current = mouseTrackingSequence;
    try {
      stdout?.write(mouseTrackingSequence);
    } catch {
      // stdout closed during shutdown.
    }
  }, [mouseTrackingSequence, stdout]);

  useEffect(
    () => () => {
      const wasTracking =
        mouseWrittenRef.current !== null && mouseWrittenRef.current !== MOUSE_OFF;
      mouseWrittenRef.current = null;
      if (!wasTracking) return;
      try {
        stdout?.write(MOUSE_OFF);
      } catch {
        // process is tearing down.
      }
    },
    [stdout],
  );

  return { mouseMode, setMouseMode };
}
