import { beforeEach, describe, expect, it } from 'vitest';
import {
  type BackgroundStyle,
  type OfficeViewMode,
  useOfficeMapStore,
} from '../../src/stores/office-map-store';

const store = () => useOfficeMapStore.getState();

const DEFAULTS = {
  viewMode: 'office' as OfficeViewMode,
  showHud: true,
  showLegend: true,
  showMinimap: true,
  showControls: true,
  animateEdges: true,
  showFeed: true,
  background: 'dots' as BackgroundStyle,
};

describe('office map store', () => {
  beforeEach(() => {
    useOfficeMapStore.setState({ ...DEFAULTS });
  });

  it('defaults to the office lanes view with all chrome visible', () => {
    expect(store()).toMatchObject(DEFAULTS);
  });

  it('defaults the waiting threshold to 2 minutes', () => {
    expect(store().waitThresholdMs).toBe(120_000);
  });

  it('setWaitThresholdMs accepts positive finite values', () => {
    store().setWaitThresholdMs(30_000);
    expect(store().waitThresholdMs).toBe(30_000);
    store().setWaitThresholdMs(600_000);
    expect(store().waitThresholdMs).toBe(600_000);
  });

  it.each([0, -5_000, Number.NaN, Number.POSITIVE_INFINITY])(
    'setWaitThresholdMs rejects %s and falls back to the default',
    (bad) => {
      store().setWaitThresholdMs(bad);
      expect(store().waitThresholdMs).toBe(120_000);
    },
  );

  it('setWaitThresholdMs rounds fractional values to whole milliseconds', () => {
    store().setWaitThresholdMs(45_500.7);
    expect(store().waitThresholdMs).toBe(45_501);
  });

  it('persists under a stable storage key so preferences survive a reload', () => {
    expect(useOfficeMapStore.persist.getOptions().name).toBe('wrongstack-officemap');
  });

  it.each<OfficeViewMode>(['office', 'topology'])('setViewMode switches to %s', (mode) => {
    store().setViewMode(mode);
    expect(store().viewMode).toBe(mode);
  });

  it.each<BackgroundStyle>(['dots', 'lines', 'cross', 'none'])(
    'setBackground switches the grid to %s',
    (bg) => {
      store().setBackground(bg);
      expect(store().background).toBe(bg);
    },
  );

  it.each([
    ['setShowHud', 'showHud'],
    ['setShowLegend', 'showLegend'],
    ['setShowMinimap', 'showMinimap'],
    ['setShowControls', 'showControls'],
    ['setAnimateEdges', 'animateEdges'],
    ['setShowFeed', 'showFeed'],
  ] as const)('%s toggles %s in both directions', (setter, key) => {
    store()[setter](false);
    expect(store()[key]).toBe(false);
    store()[setter](true);
    expect(store()[key]).toBe(true);
  });

  it('each toggle is independent of the others', () => {
    store().setShowHud(false);
    store().setShowMinimap(false);
    const s = store();
    expect(s.showHud).toBe(false);
    expect(s.showMinimap).toBe(false);
    expect(s.showLegend).toBe(true);
    expect(s.showControls).toBe(true);
    expect(s.animateEdges).toBe(true);
    expect(s.showFeed).toBe(true);
  });

  it('switching the view mode leaves the chrome toggles alone', () => {
    store().setShowHud(false);
    store().setBackground('none');
    store().setViewMode('topology');
    expect(store().showHud).toBe(false);
    expect(store().background).toBe('none');
  });

  it('supports a fully stripped-down canvas', () => {
    store().setShowHud(false);
    store().setShowLegend(false);
    store().setShowMinimap(false);
    store().setShowControls(false);
    store().setAnimateEdges(false);
    store().setShowFeed(false);
    store().setBackground('none');
    expect(store()).toMatchObject({
      showHud: false,
      showLegend: false,
      showMinimap: false,
      showControls: false,
      animateEdges: false,
      showFeed: false,
      background: 'none',
    });
  });
});
