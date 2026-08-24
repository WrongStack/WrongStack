import { describe, expect, it } from 'vitest';
import {
  resolveSettingsFieldValue,
  getSettingsFieldValue,
  type SettingsPickerValues,
} from '../src/components/settings-picker-model.js';

const baseValues: SettingsPickerValues = {
  mode: 'auto',
  delayMs: 30_000,
  titleAnimation: true,
  yolo: false,
  fleetChat: 'off',
  chime: true,
  confirmExit: false,
  nextPrediction: true,
  featureMcp: true,
  featurePlugins: false,
  featureMemory: true,
  featureSkills: true,
  featureModelsRegistry: false,
  tokenSavingTier: 'medium',
  allowOutsideProjectRoot: true,
  contextAutoCompact: false,
  contextStrategy: 'hybrid',
  contextMode: 'deep',
  maxConcurrent: 10,
  logLevel: 'debug',
  auditLevel: 'standard',
  indexOnStart: false,
  multiDiffSummaryThreshold: 5,
  maxIterations: 500,
  autoProceedMaxIterations: 0,
  enhanceDelayMs: 60_000,
  preRefineSeconds: 3,
  enhanceEnabled: true,
  enhanceLanguage: 'english',
  debugStream: false,
  statuslineMode: 'detailed',
  reasoningMode: 'on',
  reasoningEffort: 'xhigh',
  reasoningPreserve: true,
  thinkingWord: 'brewing',
  cacheTtl: '5m',
  configScope: 'project',
  animationStyle: 'rainbow',
  breakerEnabled: false,
  breakerAutoKillResetMs: 60_000,
  showModelReasoning: true,
  showAgentSwarmPanel: 'bottom',
  showSageMemoryInject: false,
  sageMemoryInjectThreshold: 0.85,
  readSymbols: true,
  nextStepsTool: false,
  // WrongProxy / WrongTrace (fields 59/60).
  wrongProxyEnabled: false,
  wrongProxyUrl: 'http://localhost:8000',
  panelPositions: {
    projectPicker: 'bottom',
    fleet: 'bottom',
    agents: 'bottom',
    worktree: 'bottom',
    plan: 'bottom',
    todos: 'bottom',
    queue: 'bottom',
    processList: 'bottom',
    goal: 'bottom',
    sessions: 'bottom',
    coordinator: 'bottom',
    kanban: 'bottom',
    connections: 'bottom',
  },
};

describe('/settings agent-swarm-panel slash command', () => {
  it('accepts "bottom" for field 40', () => {
    const r = resolveSettingsFieldValue(40, 'bottom');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.displayValue).toBe('bottom');
      expect(r.patch).toEqual({ showAgentSwarmPanel: 'bottom' });
    }
  });

  it('accepts "sidebar" for field 40', () => {
    const r = resolveSettingsFieldValue(40, 'sidebar');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.displayValue).toBe('sidebar');
      expect(r.patch).toEqual({ showAgentSwarmPanel: 'sidebar' });
    }
  });

  it('accepts "off" for field 40', () => {
    const r = resolveSettingsFieldValue(40, 'off');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.displayValue).toBe('off');
      expect(r.patch).toEqual({ showAgentSwarmPanel: 'off' });
    }
  });

  it('rejects invalid value with valid options listed', () => {
    const r = resolveSettingsFieldValue(40, 'top');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain('bottom');
      expect(r.error).toContain('sidebar');
      expect(r.error).toContain('off');
    }
  });

  it('is case-insensitive', () => {
    const r = resolveSettingsFieldValue(40, 'SIDEBAR');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.displayValue).toBe('sidebar');
  });

  it('getSettingsFieldValue reads the current mode', () => {
    const r = getSettingsFieldValue({ ...baseValues, showAgentSwarmPanel: 'sidebar' }, 40);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.label).toBe('Agent swarm panel');
      expect(r.displayValue).toBe('sidebar');
    }
  });
});
