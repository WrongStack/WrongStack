import { type PointerEvent, useRef, useState } from 'react';
import { clampPaneWidth } from './pane-layout';
import './pane-splitter.css';

export function PaneSplitter({
  label,
  controls,
  side,
  width,
  min,
  max,
  onResize,
}: {
  label: string;
  controls: string;
  side: 'left' | 'right';
  width: number;
  min: number;
  max: number;
  onResize: (width: number) => void;
}) {
  const drag = useRef<{ id: number; x: number; start: number } | null>(null);
  const [preview, setPreview] = useState<number | null>(null);
  const direction = side === 'left' ? 1 : -1;
  const bound = (next: number) => clampPaneWidth(next, min, max);
  const nextWidth = (event: PointerEvent) => {
    const start = drag.current;
    return start ? bound(start.start + (event.clientX - start.x) * direction) : width;
  };
  function cancel() {
    drag.current = null;
    setPreview(null);
  }
  return (
    // biome-ignore lint/a11y/useSemanticElements: a focusable, draggable splitter is a widget separator; <hr> is static and cannot take focus or pointer drags.
    <div
      className="pane-splitter"
      data-side={side}
      data-dragging={preview !== null || undefined}
      style={
        preview === null
          ? undefined
          : { transform: `translateX(${(preview - width) * direction}px)` }
      }
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-label={label}
      aria-controls={controls}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={preview ?? width}
      aria-valuetext={`${preview ?? width} px`}
      onPointerDown={(event) => {
        if (drag.current || event.button !== 0 || !event.isPrimary) return;
        event.preventDefault();
        event.currentTarget.focus({ preventScroll: true });
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { id: event.pointerId, x: event.clientX, start: width };
        setPreview(width);
      }}
      onPointerMove={(event) => {
        if (drag.current?.id === event.pointerId) setPreview(nextWidth(event));
      }}
      onPointerUp={(event) => {
        if (drag.current?.id !== event.pointerId) return;
        const next = nextWidth(event);
        cancel();
        if (next !== width) onResize(next);
      }}
      onPointerCancel={cancel}
      onLostPointerCapture={cancel}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && drag.current) {
          event.preventDefault();
          event.stopPropagation();
          event.currentTarget.releasePointerCapture(drag.current.id);
          cancel();
          return;
        }
        if (drag.current || event.altKey || event.ctrlKey || event.metaKey) return;
        const step = event.shiftKey ? 32 : 8;
        const next =
          event.key === 'ArrowLeft'
            ? width - step * direction
            : event.key === 'ArrowRight'
              ? width + step * direction
              : event.key === 'Home'
                ? min
                : event.key === 'End'
                  ? max
                  : undefined;
        if (next === undefined) return;
        event.preventDefault();
        event.stopPropagation();
        onResize(bound(next));
      }}
    />
  );
}
