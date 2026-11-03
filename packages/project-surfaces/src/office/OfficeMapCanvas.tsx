import { useAppTranslation } from '../lib/i18n';
/**
 * OfficeMapCanvas — React Flow canvas with real-time office environment visualization.
 *
 * Displays all connected clients (WebUI, TUI, REPL, etc.) as nodes in an office floor plan.
 * Shows live status (mail read, mail sent, idle, active, error) with animated wire connections.
 * Uses viz store for real-time events and fleet store for agent status.
 */

import { Background, BackgroundVariant, Controls, ReactFlow } from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import { Building2 } from 'lucide-react';
import {
  OfficeMiniMap,
  OfficeToolbar,
  SessionWatchDrawer,
} from './OfficeMapCanvas/CanvasPanels.js';
import { edgeTypes } from './OfficeMapCanvas/edges.js';
import { LiveFeed, StatsHUD } from './OfficeMapCanvas/Hud.js';
import { FIT_VIEW_PADDING, nodeTypes } from './OfficeMapCanvas/nodes.js';
import { BroadcastComposer, OfficeMapLegends } from './OfficeMapCanvas/Overlays.js';
import { SelectedNodeDetailPanel } from './OfficeMapCanvas/SelectedNodeDetailPanel.js';
import { useOfficeMapCanvas } from './use-office-map-canvas.js';

// ── Main Canvas Component ────────────────────────────────────────────────────

export function OfficeMapCanvas() {
  const {
    canvasRef,
    showHud,
    showLegend,
    nodes,
    edges,
    onNodesChange,
    onEdgesChange,
    onConnect,
    onNodeClick,
    onPaneClick,
    broadcastOpen,
    onArrange,
    setBroadcastOpen,
    setShowFeed,
    showFeed,
    background,
    showControls,
    showMinimap,
    vizEvents,
    broadcastDraft,
    broadcasting,
    broadcastResult,
    setBroadcastDraft,
    sendBroadcast,
    selectedNode,
    selectedAgentTranscript,
    mailboxMessages,
    setWatch,
    watch,
  } = useOfficeMapCanvas();
  const { t } = useAppTranslation();

  return (
    <div
      ref={canvasRef}
      className="relative h-full w-full overflow-hidden bg-[hsl(var(--surface-2)/0.55)]"
    >
      {/* Grid background */}
      <div
        className="absolute inset-0 opacity-[0.03]"
        style={{
          backgroundImage: `
            linear-gradient(hsl(var(--foreground) / 0.1) 1px, transparent 1px),
            linear-gradient(90deg, hsl(var(--foreground) / 0.1) 1px, transparent 1px)
          `,
          backgroundSize: '40px 40px',
        }}
      />

      {/* Real-time Stats HUD */}
      {showHud && <StatsHUD />}

      {/* Room labels */}
      <div className="absolute top-3 left-1/2 -translate-x-1/2 z-10">
        <div className="rounded-lg border border-border/70 bg-card/90 px-4 py-2 ws-dialog backdrop-blur">
          <div className="flex items-center gap-2 text-xs font-bold text-foreground">
            <Building2 className="h-4 w-4 text-primary" />
            {t('activity:office.fleetHq')}
            <span className="ml-2 h-2 w-2 animate-pulse rounded-full bg-success" />
            <span className="text-[10px] font-normal text-muted-foreground">
              {t('activity:office.live')}
            </span>
          </div>
        </div>
      </div>

      {showLegend && <OfficeMapLegends />}

      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onNodeClick={onNodeClick}
        onPaneClick={onPaneClick}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        fitView
        fitViewOptions={{ padding: FIT_VIEW_PADDING }}
        minZoom={0.15}
        maxZoom={1.5}
        defaultEdgeOptions={{
          type: 'wire',
        }}
        proOptions={{ hideAttribution: true }}
      >
        <OfficeToolbar
          broadcastOpen={broadcastOpen}
          labels={{
            arrange: t('activity:office.arrange'),
            arrangeTitle: t('activity:office.arrangeTitle'),
            broadcast: t('activity:office.broadcast'),
            broadcastTitle: t('activity:office.broadcastTitle'),
            feed: t('activity:office.feed'),
            feedTitle: t('activity:office.feedTitle'),
          }}
          onArrange={onArrange}
          onBroadcastToggle={() => setBroadcastOpen((v) => !v)}
          onFeedToggle={() => setShowFeed(!showFeed)}
          showFeed={showFeed}
        />
        {background !== 'none' && (
          <Background
            variant={
              background === 'lines'
                ? BackgroundVariant.Lines
                : background === 'cross'
                  ? BackgroundVariant.Cross
                  : BackgroundVariant.Dots
            }
            gap={20}
            size={1}
            color="hsl(var(--border) / 0.35)"
          />
        )}
        {showControls && (
          <Controls className="rounded-lg border border-border/70 bg-card/90 [&>button]:bg-card [&>button]:text-foreground" />
        )}
        {showMinimap && <OfficeMiniMap />}
      </ReactFlow>

      {showFeed && <LiveFeed events={vizEvents} now={Date.now()} />}

      {broadcastOpen && (
        <BroadcastComposer
          draft={broadcastDraft}
          isSending={broadcasting}
          result={broadcastResult}
          onClose={() => setBroadcastOpen(false)}
          onDraftChange={setBroadcastDraft}
          onSend={() => void sendBroadcast()}
        />
      )}

      {/* Selected node detail panel */}
      {selectedNode && (
        <SelectedNodeDetailPanel
          selectedNode={selectedNode}
          selectedAgentTranscript={selectedAgentTranscript}
          mailboxMessages={mailboxMessages}
          onClose={onPaneClick}
          onOpenWatch={setWatch}
        />
      )}

      {watch && (
        <SessionWatchDrawer
          closeTitle={t('activity:office.closeEsc')}
          label={watch.label}
          onClose={() => setWatch(null)}
          sessionId={watch.sessionId}
          streamTitle={t('activity:office.fullOperationStream')}
        />
      )}
    </div>
  );
}
