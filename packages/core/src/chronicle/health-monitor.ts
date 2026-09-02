import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import type { EventBus } from '../kernel/events.js';
import type { ChronicleContext } from './context.js';
import type { ChronicleEventSink } from './sink.js';

export interface ChronicleHealthMonitorOptions {
  events: EventBus;
  journal: ChronicleEventSink;
  context: ChronicleContext | (() => ChronicleContext);
  intervalMs?: number | undefined;
  onPersistError?: ((error: unknown) => void) | undefined;
}

/**
 * Low-frequency self-observation proving that telemetry is not starving the
 * runtime. Emitted on the EventBus rather than appended to Chronicle
 * directly — rollup-adapter.ts windows it into one bounded `metrics.rollup`
 * event instead of one raw event per sample.
 */
export function startChronicleHealthMonitor(options: ChronicleHealthMonitorOptions): () => void {
  const intervalMs = Math.max(5_000, options.intervalMs ?? 30_000);
  const delay = monitorEventLoopDelay({ resolution: 20 });
  delay.enable();
  let previousCpu = process.cpuUsage();
  let previousElu = performance.eventLoopUtilization();

  const sample = (): void => {
    const context = typeof options.context === 'function' ? options.context() : options.context;
    const memory = process.memoryUsage();
    const cpu = process.cpuUsage(previousCpu);
    previousCpu = process.cpuUsage();
    const elu = performance.eventLoopUtilization(previousElu);
    previousElu = performance.eventLoopUtilization();
    const journalBeforeSample = options.journal.stats();
    try {
      options.events.emit('runtime.health.sampled', {
        sessionId: context.scope.sessionId,
        uptimeSeconds: process.uptime(),
        eventLoop: {
          utilization: elu.utilization,
          activeMs: elu.active,
          idleMs: elu.idle,
          delayMeanMs: Number(delay.mean) / 1e6,
          delayP95Ms: Number(delay.percentile(95)) / 1e6,
          delayMaxMs: Number(delay.max) / 1e6,
        },
        cpu: { userMicros: cpu.user, systemMicros: cpu.system },
        memory: {
          rssBytes: memory.rss,
          heapTotalBytes: memory.heapTotal,
          heapUsedBytes: memory.heapUsed,
          externalBytes: memory.external,
          arrayBuffersBytes: memory.arrayBuffers,
        },
        chronicle: journalBeforeSample,
      });
    } catch (error) {
      options.onPersistError?.(error);
    }
    delay.reset();
  };

  const timer = setInterval(sample, intervalMs);
  timer.unref?.();
  return () => {
    clearInterval(timer);
    delay.disable();
  };
}
