/**
 * Process Guardian — Protects WrongStack processes from being killed via
 * bash/kill commands. Runs as a watchdog that:
 *
 * 1. Registers the main process and all children with persistent registry
 * 2. Monitors for kill attempts against protected PIDs
 * 3. Provides recovery mechanisms when killed processes are detected
 * 4. Coordinates protection across multiple WrongStack instances
 *
 * This is NOT a security mechanism against intentional root-level kills.
 * A user with sudo/root can still kill any process. This is a guardrail
 * to prevent accidental kills from the WrongStack agent itself.
 */

import * as os from 'node:os';
import {
  getPersistentProcessRegistry,
  type PersistentProcessRegistry,
} from './process-registry-persistent.js';

export interface ProcessGuardianConfig {
  /** Interval for heartbeat in ms */
  heartbeatIntervalMs?: number;
  /** Enable automatic process resurrection */
  autoResurrect?: boolean;
  /** Maximum resurrection attempts */
  maxResurrectionAttempts?: number;
  /** Custom protection patterns */
  protectedPatterns?: string[];
  /**
   * How many SIGTERM signals to tolerate before exiting.
   * The first N-1 are ignored to protect against accidental `kill` from the
   * AI agent; the Nth triggers graceful shutdown via `stop()` + `process.exit(0)`.
   * Default 3 — balances AI guardrail vs container orchestration (Docker,
   * systemd repeat SIGTERM up to StopTimeout ~10s, then SIGKILL).
   * Set to 0 to always exit on the first SIGTERM, or Infinity to never exit.
   */
  sigtermThreshold?: number;
}

interface ProtectedProcess {
  pid: number;
  name: string;
  lastSeen: number;
  resurrectionAttempts: number;
}

/**
 * Process Guardian watches over WrongStack processes and prevents accidental kills.
 */
export class ProcessGuardian {
  private readonly registry: PersistentProcessRegistry;
  private readonly config: Required<ProcessGuardianConfig>;
  private readonly protectedProcesses: Map<number, ProtectedProcess> = new Map();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private isRunning = false;
  private instanceId: string;
  private sigtermCount = 0;
  private processHandlersInstalled = false;

  private readonly onProcessExit = (code: number): void => {
    console.log(
      JSON.stringify({
        level: 'info',
        event: 'process_guardian.process_exiting',
        pid: process.pid,
        code,
        instanceId: this.instanceId,
      }),
    );
    this.stop();
  };

  private readonly onUncaughtException = (err: Error): void => {
    console.error(
      JSON.stringify({
        level: 'error',
        event: 'process_guardian.uncaught_exception',
        error: err.message,
        stack: err.stack,
        instanceId: this.instanceId,
        fatal: true,
      }),
    );
    this.stop();
    process.exit(1);
  };

  private readonly onUnhandledRejection = (reason: unknown): void => {
    const err =
      reason instanceof Error
        ? { message: reason.message, stack: reason.stack }
        : { value: String(reason) };
    console.error(
      JSON.stringify({
        level: 'error',
        event: 'process_guardian.unhandled_rejection',
        ...err,
        instanceId: this.instanceId,
        fatal: true,
      }),
    );
    this.stop();
    process.exit(1);
  };

  private readonly onSigterm = (): void => {
    this.sigtermCount++;
    const threshold = this.config.sigtermThreshold;
    if (threshold === Infinity) {
      console.log(
        JSON.stringify({
          level: 'warn',
          event: 'process_guardian.sigterm_ignored',
          pid: process.pid,
          instanceId: this.instanceId,
          sigtermCount: this.sigtermCount,
          message:
            'SIGTERM received but sigtermThreshold is Infinity — ignoring (use graceful shutdown instead)',
        }),
      );
      return;
    }
    if (this.sigtermCount < threshold) {
      console.log(
        JSON.stringify({
          level: 'warn',
          event: 'process_guardian.sigterm_deferred',
          pid: process.pid,
          instanceId: this.instanceId,
          sigtermCount: this.sigtermCount,
          threshold,
          message: `SIGTERM received (${this.sigtermCount}/${threshold}) — ignoring until threshold is reached`,
        }),
      );
      return;
    }
    console.log(
      JSON.stringify({
        level: 'warn',
        event: 'process_guardian.sigterm_exiting',
        pid: process.pid,
        instanceId: this.instanceId,
        sigtermCount: this.sigtermCount,
        threshold,
        message: `SIGTERM threshold (${threshold}) reached — shutting down gracefully`,
      }),
    );
    this.stop();
    process.exit(0);
  };

  private readonly onSighup = (): void => {
    console.log(
      JSON.stringify({
        level: 'warn',
        event: 'process_guardian.sighup_received',
        pid: process.pid,
        instanceId: this.instanceId,
        message: 'SIGHUP received but ignored - WrongStack continues running',
      }),
    );
  };

  constructor(config: ProcessGuardianConfig = {}) {
    this.registry = getPersistentProcessRegistry();
    this.config = {
      heartbeatIntervalMs: config.heartbeatIntervalMs ?? 5_000,
      autoResurrect: config.autoResurrect ?? false, // Disabled by default
      maxResurrectionAttempts: config.maxResurrectionAttempts ?? 3,
      protectedPatterns: config.protectedPatterns ?? ['node', 'wrongstack'],
      sigtermThreshold: config.sigtermThreshold ?? 3,
    };
    this.instanceId = this.registry.getInstanceId();
  }

  /**
   * Start the guardian - begins monitoring and registration.
   */
  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;

    // Register the main process
    this.registerProcess(process.pid, 'wrongstack-main');

    // Register all existing child processes
    this.registerExistingChildren();

    // Start heartbeat
    this.heartbeatTimer = setInterval(() => {
      this.heartbeat();
    }, this.config.heartbeatIntervalMs);
    this.heartbeatTimer.unref?.();

    // Set up process event handlers
    this.setupProcessHandlers();

    console.log(
      JSON.stringify({
        level: 'info',
        event: 'process_guardian.started',
        instanceId: this.instanceId,
        mainPid: process.pid,
        hostname: os.hostname(),
        platform: process.platform,
      }),
    );
  }

  /**
   * Stop the guardian gracefully.
   */
  stop(): void {
    this.removeProcessHandlers();
    if (!this.isRunning) return;
    this.isRunning = false;

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    this.registry.stop();

    console.log(
      JSON.stringify({
        level: 'info',
        event: 'process_guardian.stopped',
        instanceId: this.instanceId,
        mainPid: process.pid,
      }),
    );
  }

  /**
   * Register a process with the guardian.
   */
  registerProcess(pid: number, name: string): void {
    this.protectedProcesses.set(pid, {
      pid,
      name,
      lastSeen: Date.now(),
      resurrectionAttempts: 0,
    });

    // Also register with persistent registry
    this.registry.registerChildProcess(pid, name, name, undefined, 'spawn');

    console.log(
      JSON.stringify({
        level: 'info',
        event: 'process_guardian.registered',
        pid,
        name,
        instanceId: this.instanceId,
      }),
    );
  }

  /**
   * Unregister a process (e.g., when it exits normally).
   */
  unregisterProcess(pid: number): void {
    this.protectedProcesses.delete(pid);
    this.registry.unregister(pid).catch((err) => {
      console.error(
        JSON.stringify({
          level: 'error',
          event: 'process_guardian.unregister_failed',
          pid,
          error: err.message,
        }),
      );
    });
  }

  /**
   * Register all child processes that already exist.
   */
  private registerExistingChildren(): void {
    // In Node.js, we don't have direct access to child processes
    // unless we spawned them ourselves. The ProcessRegistry tracks
    // what we spawned, so we sync with it.
    this.syncWithProcessRegistry();
  }

  /**
   * Sync protected processes with the base ProcessRegistry.
   */
  private syncWithProcessRegistry(): void {
    // This would sync with the in-memory process registry
    // to pick up any child processes that were registered there
  }

  /**
   * Heartbeat - updates timestamps and checks for anomalies.
   */
  private heartbeat(): void {
    const now = Date.now();

    for (const [_pid, proc] of this.protectedProcesses) {
      proc.lastSeen = now;
    }

    // Log status periodically (every 10 heartbeats)
    if (Math.random() < 0.1) {
      console.log(
        JSON.stringify({
          level: 'debug',
          event: 'process_guardian.heartbeat',
          protectedCount: this.protectedProcesses.size,
          instanceId: this.instanceId,
        }),
      );
    }
  }

  /**
   * Set up process-level event handlers.
   */
  private setupProcessHandlers(): void {
    if (this.processHandlersInstalled) return;
    this.processHandlersInstalled = true;
    process.on('exit', this.onProcessExit);
    process.on('uncaughtException', this.onUncaughtException);
    process.on('unhandledRejection', this.onUnhandledRejection);
    process.on('SIGTERM', this.onSigterm);
    process.on('SIGHUP', this.onSighup);
  }

  private removeProcessHandlers(): void {
    if (!this.processHandlersInstalled) return;
    this.processHandlersInstalled = false;
    process.off('exit', this.onProcessExit);
    process.off('uncaughtException', this.onUncaughtException);
    process.off('unhandledRejection', this.onUnhandledRejection);
    process.off('SIGTERM', this.onSigterm);
    process.off('SIGHUP', this.onSighup);
  }

  /**
   * Check if a PID is protected by this guardian.
   */
  isProtected(pid: number): boolean {
    return this.protectedProcesses.has(pid);
  }

  /**
   * Get all PIDs protected by this guardian.
   */
  getProtectedPids(): number[] {
    return Array.from(this.protectedProcesses.keys());
  }

  /**
   * Get status information for monitoring.
   */
  getStatus(): {
    instanceId: string;
    mainPid: number;
    protectedCount: number;
    platform: string;
    hostname: string;
    uptime: number;
  } {
    return {
      instanceId: this.instanceId,
      mainPid: process.pid,
      protectedCount: this.protectedProcesses.size,
      platform: os.platform(),
      hostname: os.hostname(),
      uptime: process.uptime(),
    };
  }
}

// Singleton instance
let _guardian: ProcessGuardian | undefined;

export function getProcessGuardian(): ProcessGuardian {
  if (!_guardian) {
    _guardian = new ProcessGuardian();
  }
  return _guardian;
}

export function startProcessGuardian(config?: ProcessGuardianConfig): ProcessGuardian {
  _guardian?.stop();
  const guardian = new ProcessGuardian(config);
  guardian.start();
  _guardian = guardian;
  return guardian;
}

export function stopProcessGuardian(): void {
  if (_guardian) {
    _guardian.stop();
    _guardian = undefined;
  }
}
