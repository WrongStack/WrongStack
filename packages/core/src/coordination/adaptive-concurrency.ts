/**
 * Adaptive Concurrency Controller
 *
 * Automatically adjusts `maxConcurrent` based on:
 * - Rate limit (429) errors → decrease concurrency
 * - Sustained successful requests → increase concurrency
 *
 * This provides automatic backpressure without manual tuning.
 */

import type { FleetBus, FleetEvent } from './fleet-bus.js';
import type { AdaptiveConcurrencyConfig } from '../types/config.js';
import type { Logger } from '../types/logger.js';

export interface AdaptiveConcurrencyState {
  current: number;
  min: number;
  max: number;
  consecutiveSuccesses: number;
  consecutiveFailures: number;
  totalDecreases: number;
  totalIncreases: number;
  enabled: boolean;
}

interface InternalConfig {
  enabled: boolean;
  minConcurrent: number;
  maxConcurrent: number;
  decreaseFactor: number;
  successThreshold: number;
  recoveryIntervalMs: number;
}

const DEFAULT_CONFIG: InternalConfig = Object.freeze({
  enabled: false,
  minConcurrent: 1,
  maxConcurrent: 16,
  decreaseFactor: 0.5,
  successThreshold: 10,
  recoveryIntervalMs: 30_000,
});

/**
 * Adaptive Concurrency Controller
 *
 * Monitors fleet events for rate-limit (429) errors and adjusts concurrency
 * automatically to prevent overwhelming the API provider.
 */
export class AdaptiveConcurrencyController {
  private readonly config: InternalConfig;
  private state: AdaptiveConcurrencyState;
  private readonly disposers: (() => void)[] = [];
  private stateChangeHandlers: ((state: AdaptiveConcurrencyState) => void)[] = [];
  private readonly logger: Pick<Logger, 'warn'> | undefined;

  constructor(
    fleetBus: FleetBus,
    setMaxConcurrent: (n: number) => void,
    config: Partial<AdaptiveConcurrencyConfig> = {},
    onStateChange?: (state: AdaptiveConcurrencyState) => void,
    // Writing to stdout from core corrupts TUI rendering; adjustments are
    // only reported through this logger (and the onStateChange handlers).
    logger?: Pick<Logger, 'warn'>,
  ) {
    this.logger = logger;
    // Apply config with defaults
    this.config = {
      enabled: config.enabled ?? DEFAULT_CONFIG.enabled,
      minConcurrent: config.minConcurrent ?? DEFAULT_CONFIG.minConcurrent,
      maxConcurrent: config.maxConcurrent ?? DEFAULT_CONFIG.maxConcurrent,
      decreaseFactor: config.decreaseFactor ?? DEFAULT_CONFIG.decreaseFactor,
      successThreshold: config.successThreshold ?? DEFAULT_CONFIG.successThreshold,
      recoveryIntervalMs: config.recoveryIntervalMs ?? DEFAULT_CONFIG.recoveryIntervalMs,
    };

    this.state = {
      current: this.config.maxConcurrent,
      min: this.config.minConcurrent,
      max: this.config.maxConcurrent,
      consecutiveSuccesses: 0,
      consecutiveFailures: 0,
      totalDecreases: 0,
      totalIncreases: 0,
      enabled: this.config.enabled,
    };

    if (onStateChange) {
      this.stateChangeHandlers.push(onStateChange);
    }

    // Apply initial concurrency
    if (this.config.enabled) {
      setMaxConcurrent(this.state.current);
    }

    // Subscribe to fleet events
    this.setupEventHandlers(fleetBus, setMaxConcurrent);
  }

  private setupEventHandlers(fleetBus: FleetBus, setMaxConcurrent: (n: number) => void): void {
    if (!this.config.enabled) return;

    const off = fleetBus.onAny((event: FleetEvent) => {
      if (!this.config.enabled) return;

      // Check for rate limit indicators
      if (event.type === 'error' || event.type === 'provider_error') {
        const payload = event.payload as { status?: number; code?: string; kind?: string };
        if (payload?.status === 429 || payload?.code === 'rate_limit_error' || payload?.kind === 'rate_limit') {
          this.handleRateLimit(setMaxConcurrent);
        }
      }
    });

    this.disposers.push(off);
  }

  /**
   * Handle a rate limit (429) error - decrease concurrency
   */
  private handleRateLimit(setMaxConcurrent: (n: number) => void): void {
    if (this.state.current <= this.config.minConcurrent) {
      // Already at minimum, just track the failure
      this.state.consecutiveFailures++;
      this.state.consecutiveSuccesses = 0;
      this.notifyStateChange();
      return;
    }

    const newConcurrent = Math.max(
      this.config.minConcurrent,
      Math.floor(this.state.current * this.config.decreaseFactor),
    );

    if (newConcurrent < this.state.current) {
      const previousConcurrent = this.state.current;
      this.state.current = newConcurrent;
      this.state.consecutiveFailures++;
      this.state.consecutiveSuccesses = 0;
      this.state.totalDecreases++;

      setMaxConcurrent(this.state.current);
      this.notifyStateChange();

      this.logger?.warn('adaptive_concurrency.decreased', {
        reason: 'rate_limit',
        previousConcurrent,
        newConcurrent: this.state.current,
        decreaseFactor: this.config.decreaseFactor,
        totalDecreases: this.state.totalDecreases,
      });
    }
  }

  /**
   * Force a decrease (e.g., manual trigger or other error types)
   */
  decrease(target?: number): void {
    if (!this.config.enabled) return;

    const newConcurrent = target ?? Math.max(
      this.config.minConcurrent,
      Math.floor(this.state.current * this.config.decreaseFactor),
    );

    if (newConcurrent < this.state.current) {
      const previousConcurrent = this.state.current;
      this.state.current = newConcurrent;
      this.state.consecutiveSuccesses = 0;
      this.state.totalDecreases++;

      this.notifyStateChange();

      this.logger?.warn('adaptive_concurrency.decreased', {
        reason: 'manual',
        previousConcurrent,
        newConcurrent: this.state.current,
        totalDecreases: this.state.totalDecreases,
      });
    }
  }

  /**
   * Get the current state
   */
  getState(): AdaptiveConcurrencyState {
    return { ...this.state };
  }

  /**
   * Update configuration at runtime
   */
  updateConfig(config: Partial<AdaptiveConcurrencyConfig>): void {
    if (config.enabled !== undefined) {
      this.config.enabled = config.enabled;
    }
    if (config.minConcurrent !== undefined) {
      this.config.minConcurrent = config.minConcurrent;
    }
    if (config.maxConcurrent !== undefined) {
      this.config.maxConcurrent = config.maxConcurrent;
    }
    if (config.decreaseFactor !== undefined) {
      this.config.decreaseFactor = config.decreaseFactor;
    }
    if (config.successThreshold !== undefined) {
      this.config.successThreshold = config.successThreshold;
    }
    if (config.recoveryIntervalMs !== undefined) {
      this.config.recoveryIntervalMs = config.recoveryIntervalMs;
    }

    // Ensure current is within bounds
    this.state.current = Math.max(this.config.minConcurrent, Math.min(this.state.current, this.config.maxConcurrent));
    this.state.enabled = this.config.enabled;
    this.state.min = this.config.minConcurrent;
    this.state.max = this.config.maxConcurrent;

    this.notifyStateChange();
  }

  /**
   * Dispose of the controller and clean up event listeners
   */
  dispose(): void {
    for (const dispose of this.disposers) {
      dispose();
    }
    this.disposers.length = 0;
    this.stateChangeHandlers = [];
  }

  private notifyStateChange(): void {
    const state = this.getState();
    for (const handler of [...this.stateChangeHandlers]) {
      try {
        handler(state);
      } catch {
        // Safe dispatch — handler exception does not block other listeners
      }
    }
  }

  /**
   * Register a state change handler
   */
  onStateChange(handler: (state: AdaptiveConcurrencyState) => void): () => void {
    this.stateChangeHandlers.push(handler);
    return () => {
      const index = this.stateChangeHandlers.indexOf(handler);
      if (index !== -1) {
        this.stateChangeHandlers.splice(index, 1);
      }
    };
  }
}
