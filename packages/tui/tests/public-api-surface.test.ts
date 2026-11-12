import { describe, expect, it } from 'vitest';
import * as appModule from '../src/app.js';
import * as appReducer from '../src/app-reducer.js';
import * as barrel from '../src/index.js';
import * as runTuiModule from '../src/run-tui.js';

/**
 * TUI decomposition Phase 0.2 (docs/decomposition-plan.md, decision D3):
 * freezes the RUNTIME (value) export surface of the four modules the
 * god-file decomposition touches. If one of these lists changes
 * intentionally, update the list in the same commit. If it changes
 * unintentionally, a decomposition step moved something it must not have.
 *
 * Type-only exports are guarded by `pnpm --filter @wrongstack/tui typecheck`
 * in both consumer projects and cannot be asserted at runtime here.
 */
describe('public API surface freeze (decomposition Phase 0.2)', () => {
  it('barrel src/index.ts exports exactly these runtime values', () => {
    expect(Object.keys(barrel).sort()).toEqual([
      'DEFAULT_SYNC_STDOUT_MAX_BATCH_BYTES',
      'ImagePreviewModal',
      'KITTY_BASE64_CHUNK_SIZE',
      'MAX_IMAGE_PREVIEW_CACHE_ENTRIES',
      'MAX_TUI_IMAGE_INPUT_BYTES',
      'PluginPanelOverlay',
      'PluginPromptModal',
      'PluginStatusStrip',
      'PluginViewNodeView',
      'SessionTreeOverlay',
      'buildGoalPreamble',
      'buildHalfBlockGrid',
      'clearImagePreviewCache',
      'computeImageCellBox',
      'createSynchronizedStdout',
      'decodePngToRgbaThumbnail',
      'encodeIterm2Graphics',
      'encodeKittyGraphics',
      'encodeNativeTerminalImage',
      'extractToolImageArtifactPath',
      'flattenSessionTreeRows',
      'getImagePreviewCacheSize',
      'inspectImageHeader',
      'loadCachedImagePreview',
      'parseInline',
      'parseNextSteps',
      'replaySessionMessages',
      'runTui',
      'stripTerminalGraphicsResponses',
    ]);
  });

  it('src/app.tsx exports exactly these runtime values', () => {
    expect(Object.keys(appModule).sort()).toEqual([
      'App',
      'buildGoalPreamble',
      'buildSteeringPreamble',
      'nextInputWordStart',
      'previousInputWordStart',
      'reducer',
      'renderRunningTools',
      'selectedSlashCommandLine',
    ]);
  });

  it('src/app-reducer.ts exports exactly these runtime values', () => {
    expect(Object.keys(appReducer).sort()).toEqual([
      'firstSelectable',
      'pruneToolInput',
      'reducer',
      'skipDivider',
    ]);
  });

  it('src/run-tui.ts exports exactly these runtime values', () => {
    expect(Object.keys(runTuiModule).sort()).toEqual([
      'runTui',
      'silenceTerminal',
      'unsilenceTerminal',
    ]);
  });
});
