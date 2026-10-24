import type {
  AggregateHealth,
  HealthCheck,
  HealthCheckResult,
  HealthRegistry,
  HealthStatus,
} from '@wrongstack/contracts/types/observability';
import { toErrorMessage } from '../utils/error.js';

const SEVERITY: Record<HealthStatus, number> = {
  healthy: 0,
  degraded: 1,
  unhealthy: 2,
};

/**
 * Aggregates registered health checks. Worst status wins — one unhealthy check
 * makes the whole system unhealthy. Use timeouts so a slow probe can't stall
 * the response.
 */
export class DefaultHealthRegistry implements HealthRegistry {
  private checks = new Map<string, HealthCheck>();
  private readonly timeoutMs: number;

  constructor(opts: { timeoutMs?: number | undefined } = {}) {
    this.timeoutMs = opts.timeoutMs ?? 5_000;
  }

  register(check: HealthCheck): void {
    this.checks.set(check.name, check);
  }

  unregister(name: string): void {
    this.checks.delete(name);
  }

  async run(): Promise<AggregateHealth> {
    const results = await Promise.all(
      Array.from(this.checks.values()).map(async (c) => {
        const result = await this.runOne(c);
        return { name: c.name, ...result };
      }),
    );

    let status: HealthStatus = 'healthy';
    for (const r of results) {
      if (SEVERITY[r.status] > SEVERITY[status]) status = r.status;
    }

    return { status, timestamp: Date.now(), checks: results };
  }

  private async runOne(check: HealthCheck): Promise<HealthCheckResult> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<HealthCheckResult>((resolve) => {
      timer = setTimeout(
        () => resolve({ status: 'unhealthy', detail: `timeout after ${this.timeoutMs}ms` }),
        this.timeoutMs,
      );
    });
    try {
      return await Promise.race([check.check(), timeout]);
    } catch (err) {
      return { status: 'unhealthy', detail: toErrorMessage(err) };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
