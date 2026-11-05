import { Focus, Minus, Plus } from 'lucide-react';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useDesktopText } from './desktop-i18n';
import { graphScope, placeGraph, type VisualGraph } from './graph-model';

const emptyPath: string[] = [];

export function GraphCanvas({
  graph,
  selected,
  onSelect,
  label,
  empty,
  layout = 'clusters',
  highlightPath = emptyPath,
  onActivate,
  minimap = false,
  nodeLimit = 160,
  directed = false,
}: {
  graph: VisualGraph;
  selected: string;
  onSelect: (id: string) => void;
  label: string;
  empty: React.ReactNode;
  layout?: 'clusters' | 'layers' | 'orbit';
  highlightPath?: string[];
  onActivate?: (id: string) => void;
  minimap?: boolean;
  nodeLimit?: number | null;
  directed?: boolean;
}) {
  const { t } = useDesktopText();
  const arrowId = `graph-arrow-${useId().replaceAll(':', '')}`;
  const surface = useRef<HTMLElement>(null);
  const visible = useMemo(
    () => graphScope(graph, selected, highlightPath, nodeLimit),
    [graph, selected, highlightPath, nodeLimit],
  );
  const nodes = useMemo(() => placeGraph(visible, layout), [visible, layout]);
  const positions = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const [camera, setCamera] = useState({ x: 0, y: 0, zoom: 0.75 });
  const drag = useRef<{ x: number; y: number; originalX: number; originalY: number } | null>(null);
  const fit = useCallback(() => {
    const box = surface.current?.getBoundingClientRect();
    if (!box || !nodes.length) return;
    const left = Math.min(...nodes.map((node) => node.x)) - 115;
    const right = Math.max(...nodes.map((node) => node.x)) + 115;
    const top = Math.min(...nodes.map((node) => node.y)) - 60;
    const bottom = Math.max(...nodes.map((node) => node.y)) + 60;
    // The overview sits over the map's lower-left corner: fit the graph above it.
    const height = box.height - (minimap ? 116 : 0);
    const zoom = Math.max(
      0.03,
      Math.min(1, Math.min((box.width - 60) / (right - left), (height - 80) / (bottom - top))),
    );
    setCamera({
      x: box.width / 2 - ((left + right) / 2) * zoom,
      y: height / 2 - ((top + bottom) / 2) * zoom,
      zoom,
    });
  }, [nodes, minimap]);
  useEffect(() => {
    const observer = new ResizeObserver(fit);
    if (surface.current) observer.observe(surface.current);
    fit();
    return () => observer.disconnect();
  }, [fit]);
  useEffect(() => {
    const node = positions.get(selected),
      box = surface.current?.getBoundingClientRect();
    if (!node || !box) return;
    setCamera((camera) => {
      const x = node.x * camera.zoom + camera.x,
        y = node.y * camera.zoom + camera.y;
      return x < 110 || x > box.width - 110 || y < 65 || y > box.height - 65
        ? {
            ...camera,
            x: box.width / 2 - node.x * camera.zoom,
            y: box.height / 2 - node.y * camera.zoom,
          }
        : camera;
    });
  }, [selected, positions]);
  const zoomBy = (multiplier: number) => {
    const box = surface.current?.getBoundingClientRect();
    if (!box) return;
    setCamera((camera) => {
      const zoom = Math.max(0.03, Math.min(2.5, camera.zoom * multiplier));
      const scale = zoom / camera.zoom;
      return {
        zoom,
        x: box.width / 2 - (box.width / 2 - camera.x) * scale,
        y: box.height / 2 - (box.height / 2 - camera.y) * scale,
      };
    });
  };
  const neighbors = new Set(
    graph.edges
      .filter((edge) => edge.source === selected || edge.target === selected)
      .flatMap((edge) => [edge.source, edge.target]),
  );
  const world = {
    left: Math.min(...nodes.map((node) => node.x)) - 130,
    top: Math.min(...nodes.map((node) => node.y)) - 70,
    right: Math.max(...nodes.map((node) => node.x)) + 130,
    bottom: Math.max(...nodes.map((node) => node.y)) + 70,
  };
  return (
    <section
      className="graph-surface"
      ref={surface}
      aria-label={label}
      onPointerDown={(event) => {
        if ((event.target as HTMLElement).closest('button')) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = {
          x: event.clientX,
          y: event.clientY,
          originalX: camera.x,
          originalY: camera.y,
        };
      }}
      onPointerMove={(event) => {
        const start = drag.current;
        if (start)
          setCamera((camera) => ({
            ...camera,
            x: start.originalX + event.clientX - start.x,
            y: start.originalY + event.clientY - start.y,
          }));
      }}
      onPointerUp={() => {
        drag.current = null;
      }}
      onPointerCancel={() => {
        drag.current = null;
      }}
    >
      {!nodes.length ? (
        <div className="graph-empty">{empty}</div>
      ) : (
        <div
          className="graph-camera"
          style={{ transform: `translate(${camera.x}px,${camera.y}px) scale(${camera.zoom})` }}
        >
          <svg className="graph-edges" aria-hidden="true">
            <title>{t('graphCanvas.relationships')}</title>
            {directed && (
              <defs>
                <marker
                  id={arrowId}
                  viewBox="0 0 10 10"
                  refX="9"
                  refY="5"
                  markerWidth="7"
                  markerHeight="7"
                  orient="auto-start-reverse"
                >
                  <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
                </marker>
              </defs>
            )}
            {graph.edges.map((edge, index) => {
              const a = positions.get(edge.source),
                b = positions.get(edge.target);
              if (!a || !b) return null;
              const active = edge.source === selected || edge.target === selected;
              return (
                <g
                  key={`${edge.source}-${edge.target}-${index}`}
                  className={`${active ? 'edge-active' : ''} ${highlightPath.indexOf(edge.source) >= 0 && highlightPath[highlightPath.indexOf(edge.source) + 1] === edge.target ? 'edge-path' : ''}`}
                >
                  <path
                    d={`M${a.x},${a.y} C${a.x + (b.x - a.x) * 0.45},${a.y} ${b.x - (b.x - a.x) * 0.45},${b.y} ${directed ? b.x - (b.x >= a.x ? 106 : -106) : b.x},${b.y}`}
                    markerEnd={directed ? `url(#${arrowId})` : undefined}
                  />
                  <text x={(a.x + b.x) / 2} y={(a.y + b.y) / 2 - 7}>
                    {active ? edge.label : ''}
                  </text>
                </g>
              );
            })}
          </svg>
          {nodes.map((node) => (
            <button
              key={node.id}
              type="button"
              className={`graph-node ${highlightPath.includes(node.id) ? 'graph-path-node' : ''} graph-kind-${String(
                node.data['kind'] ?? node.group,
              )
                .replace(/[^a-z]/gi, '')
                .toLowerCase()} ${selected === node.id ? 'graph-selected' : ''} ${selected && !neighbors.has(node.id) && node.id !== selected ? 'graph-dimmed' : ''}`}
              style={{ left: node.x - 100, top: node.y - 38 }}
              onClick={() => onSelect(node.id)}
              onDoubleClick={() => onActivate?.(node.id)}
              aria-label={node.label}
              aria-pressed={selected === node.id}
            >
              <span className="graph-node-mark" />
              <small>{node.group}</small>
              <strong>{node.label}</strong>
              <span>{node.detail}</span>
            </button>
          ))}
        </div>
      )}
      <div className="graph-controls">
        <button
          type="button"
          aria-label={t('graphCanvas.zoomOut')}
          onClick={() => zoomBy(1 / 1.25)}
        >
          <Minus size={15} />
        </button>
        <span>{Math.round(camera.zoom * 100)}%</span>
        <button type="button" aria-label={t('graphCanvas.zoomIn')} onClick={() => zoomBy(1.25)}>
          <Plus size={15} />
        </button>
        <button type="button" aria-label={t('graphCanvas.fit')} onClick={fit}>
          <Focus size={15} />
        </button>
      </div>
      {minimap && nodes.length > 0 && (
        <svg
          className="graph-minimap"
          role="img"
          aria-label={t('graphCanvas.overview')}
          viewBox={`${world.left} ${world.top} ${world.right - world.left} ${world.bottom - world.top}`}
          onPointerDown={(event) => {
            event.stopPropagation();
            const box = event.currentTarget.getBoundingClientRect(),
              surfaceBox = surface.current?.getBoundingClientRect();
            if (surfaceBox)
              setCamera((camera) => ({
                ...camera,
                x:
                  surfaceBox.width / 2 -
                  (world.left +
                    ((event.clientX - box.left) / box.width) * (world.right - world.left)) *
                    camera.zoom,
                y:
                  surfaceBox.height / 2 -
                  (world.top +
                    ((event.clientY - box.top) / box.height) * (world.bottom - world.top)) *
                    camera.zoom,
              }));
          }}
        >
          <title>{t('graphCanvas.overviewTitle')}</title>
          {nodes.map((node) => (
            <rect
              key={node.id}
              x={node.x - 85}
              y={node.y - 30}
              width={170}
              height={60}
              className={node.id === selected ? 'minimap-selected' : ''}
            />
          ))}
          <rect
            className="minimap-viewport"
            x={-camera.x / camera.zoom}
            y={-camera.y / camera.zoom}
            width={(surface.current?.clientWidth ?? 700) / camera.zoom}
            height={(surface.current?.clientHeight ?? 500) / camera.zoom}
          />
        </svg>
      )}
      <div className="graph-caption">
        {t('graphCanvas.caption')}
        {t('graphCanvas.showing', { shown: nodes.length, total: graph.nodes.length })}
      </div>
    </section>
  );
}
