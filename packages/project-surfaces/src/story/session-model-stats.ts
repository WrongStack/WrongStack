import type { buildSessionStory, StoryEvent } from './session-story';

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const text = (value: unknown) => (typeof value === 'string' && value ? value : undefined);
const number = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
export function distribution(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    n: sorted.length,
    avg: sorted.length ? sorted.reduce((a, b) => a + b, 0) / sorted.length : undefined,
    p50: sorted.length ? sorted[Math.ceil(sorted.length * 0.5) - 1] : undefined,
    p95: sorted.length ? sorted[Math.ceil(sorted.length * 0.95) - 1] : undefined,
    max: sorted.at(-1),
    total: sorted.reduce((a, b) => a + b, 0),
  };
}
export interface SessionModelStats {
  key: string;
  model: string;
  provider: string;
  agents: Set<string>;
  requests: Set<string>;
  attempts: number;
  completed: number;
  failed: number;
  unsettled: number;
  retryAttempts: number;
  retriesScheduled: number;
  retryScheduleSamples: number;
  retryDelaySamples: number;
  retryDelay: number;
  recovered: number;
  fallbackOut: number;
  fallbackIn: number;
  durations: number[];
  firstChunk: number[];
  promptTokens: number[];
  responseTokens: number[];
  messageCounts: number[];
  offeredTools: number[];
  streamingSamples: number;
  streamingAttempts: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  usageSamples: number;
  usageSource: string;
  accountingSamples: number;
  pricedSamples: number;
  cost: number;
  timedOutput: number;
  timedOutputMs: number;
  stopReasons: Record<string, number>;
  errorKinds: Record<string, number>;
  httpStatuses: Record<string, number>;
  toolCalls: number;
  toolSuccess: number;
  toolFailed: number;
  toolBlocked: number;
  toolUnsettled: number;
  toolDurations: number[];
  invalidInputs: number;
  loops: number;
  interventions: number;
  drift: number;
  verificationFailed: number;
  taskSuccess: number;
  taskFailed: number;
  taskTimeout: number;
  taskStopped: number;
  taskUnknown: number;
  evidence: StoryEvent[];
}

/** Explicit identities or unambiguous request/task correlations only. Never use an actor's latest model. */
export function sessionModelStats(story: ReturnType<typeof buildSessionStory>) {
  const models = new Map<string, SessionModelStats>();
  const identity = (event: StoryEvent) => {
    const raw = event.raw;
    const attrs = raw?.attributes ?? {};
    const model = raw?.runtime?.modelId ?? text(attrs.model);
    const provider = raw?.runtime?.providerId ?? text(attrs.providerId) ?? text(attrs.provider);
    return model ? ([provider ?? 'Unknown provider', model] as const) : undefined;
  };
  const ensure = (pair?: readonly [string, string]) => {
    const provider = pair?.[0] ?? 'Unattributed';
    const model = pair?.[1] ?? 'Unknown model';
    const key = JSON.stringify([provider, model]);
    let row = models.get(key);
    if (!row) {
      row = {
        key,
        model,
        provider,
        agents: new Set(),
        requests: new Set(),
        attempts: 0,
        completed: 0,
        failed: 0,
        unsettled: 0,
        retryAttempts: 0,
        retriesScheduled: 0,
        retryScheduleSamples: 0,
        retryDelaySamples: 0,
        retryDelay: 0,
        recovered: 0,
        fallbackOut: 0,
        fallbackIn: 0,
        durations: [],
        firstChunk: [],
        promptTokens: [],
        responseTokens: [],
        messageCounts: [],
        offeredTools: [],
        streamingSamples: 0,
        streamingAttempts: 0,
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        usageSamples: 0,
        usageSource: 'attempts',
        accountingSamples: 0,
        pricedSamples: 0,
        cost: 0,
        timedOutput: 0,
        timedOutputMs: 0,
        stopReasons: {},
        errorKinds: {},
        httpStatuses: {},
        toolCalls: 0,
        toolSuccess: 0,
        toolFailed: 0,
        toolBlocked: 0,
        toolUnsettled: 0,
        toolDurations: [],
        invalidInputs: 0,
        loops: 0,
        interventions: 0,
        drift: 0,
        verificationFailed: 0,
        taskSuccess: 0,
        taskFailed: 0,
        taskTimeout: 0,
        taskStopped: 0,
        taskUnknown: 0,
        evidence: [],
      };
      models.set(key, row);
    }
    return row;
  };
  const correlations = new Map<string, Set<string>>();
  const refs = (event: StoryEvent) => {
    const raw = event.raw;
    const attrs = raw?.attributes ?? {};
    return [
      raw?.correlation.attemptId ? `a:${event.actor}:${raw.correlation.attemptId}` : '',
      raw?.correlation.logicalRequestId
        ? `r:${event.actor}:${raw.correlation.logicalRequestId}`
        : '',
      (raw?.scope.taskId ?? text(attrs.taskId))
        ? `t:${raw?.scope.taskId ?? text(attrs.taskId)}`
        : '',
    ].filter(Boolean);
  };
  for (const event of story.events) {
    const pair = identity(event);
    if (!pair) continue;
    const row = ensure(pair);
    for (const ref of refs(event)) {
      const values = correlations.get(ref) ?? new Set<string>();
      values.add(row.key);
      correlations.set(ref, values);
    }
  }
  const owner = (event: StoryEvent) => {
    const pair = identity(event);
    if (pair) return ensure(pair);
    // A more specific attempt may resolve a request that switched models.
    for (const ref of refs(event)) {
      const candidates = correlations.get(ref);
      if (candidates?.size === 1) return models.get([...candidates][0]!)!;
      if (candidates && candidates.size > 1) return ensure();
    }
    return ensure();
  };
  const attempts = new Map<
    string,
    { start?: StoryEvent; terminal?: StoryEvent; row: SessionModelStats }
  >();
  const tools = new Map<string, { event: StoryEvent; end?: StoryEvent }>();
  const streams = new Map<string, StoryEvent>();
  const accounting = new Map<
    string,
    { input: number; output: number; cacheRead: number; cacheWrite: number; samples: number }
  >();
  const tasks = new Map<string, { event: StoryEvent; status: string }>();
  const evidenceSeen = new Map<string, Set<string>>();
  const attach = (row: SessionModelStats, event: StoryEvent) => {
    row.agents.add(event.actor);
    const seen = evidenceSeen.get(row.key) ?? new Set<string>();
    if (!seen.has(event.id)) {
      row.evidence.push(event);
      seen.add(event.id);
    }
    evidenceSeen.set(row.key, seen);
  };
  const count = (values: Record<string, number>, key: string) => {
    Object.defineProperty(values, key, {
      value: (Object.hasOwn(values, key) ? values[key]! : 0) + 1,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  };
  const usage = (value: unknown) => {
    const data = object(value);
    const input = number(data.input),
      output = number(data.output);
    if (input === undefined || output === undefined) return undefined;
    return {
      input,
      output,
      cacheRead: number(data.cacheRead) ?? 0,
      cacheWrite:
        number(data.cacheWrite) ??
        (number(data.cacheWrite5m) ?? 0) + (number(data.cacheWrite1h) ?? 0),
    };
  };
  for (const event of story.events) {
    const raw = event.raw;
    if (!raw) continue;
    const attrs = raw.attributes ?? {};
    const type = raw.eventType;
    const phase = type.startsWith('provider.attempt.')
      ? type.slice('provider.attempt.'.length)
      : type === 'subagent.provider_attempt'
        ? text(attrs.outcome)
        : undefined;
    if (phase && ['started', 'completed', 'failed'].includes(phase)) {
      const requestAttempt =
        raw.correlation.logicalRequestId && number(attrs.attempt) !== undefined
          ? `${raw.correlation.logicalRequestId}:${attrs.attempt}`
          : undefined;
      const key = `${event.actor}:${raw.correlation.attemptId ?? text(attrs.attemptId) ?? requestAttempt ?? event.id}`;
      const row = owner(event);
      const attempt = attempts.get(key) ?? { row };
      if (phase === 'started') attempt.start = event;
      else attempt.terminal = event;
      attempt.row = row;
      attempts.set(key, attempt);
      attach(row, event);
      continue;
    }
    if (/^(tool\.(started|executed|failed)|subagent\.tool_(started|executed|failed))$/.test(type)) {
      const key = `${event.actor}:${raw.correlation.toolCallId ?? text(attrs.id) ?? text(attrs.toolUseId) ?? event.id}`;
      const call = tools.get(key) ?? { event };
      if (!/started$/.test(type)) call.end = event;
      tools.set(key, call);
      continue;
    }
    if (type === 'provider.stream.summarized') {
      streams.set(`${event.actor}:${raw.correlation.attemptId ?? event.id}`, event);
      continue;
    }
    if (/^(token\.accounted|subagent\.token_accounted)$/.test(type)) {
      const row = owner(event);
      attach(row, event);
      row.accountingSamples++;
      const delta = usage(attrs.deltaUsage);
      if (delta) {
        const sum = accounting.get(row.key) ?? {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          samples: 0,
        };
        sum.input += delta.input;
        sum.output += delta.output;
        sum.cacheRead += delta.cacheRead;
        sum.cacheWrite += delta.cacheWrite;
        sum.samples++;
        accounting.set(row.key, sum);
      }
      const deltaCost = number(object(attrs.deltaCost).total);
      if (deltaCost !== undefined) {
        row.cost += deltaCost;
        row.pricedSamples++;
      }
      continue;
    }
    if (type === 'provider.fallback') {
      for (const direction of ['from', 'to'] as const) {
        const target = object(attrs[direction]);
        const model = text(target.model);
        if (!model) continue;
        const row = ensure([text(target.providerId) ?? 'Unknown provider', model]);
        if (direction === 'from') row.fallbackOut++;
        else row.fallbackIn++;
        attach(row, event);
      }
      continue;
    }
    if (
      type === 'subagent.task_completed' ||
      type === 'sdd.task.completed' ||
      type === 'sdd.task.failed'
    ) {
      const task = raw.scope.taskId ?? text(attrs.taskId);
      const status =
        type === 'sdd.task.completed'
          ? 'success'
          : type === 'sdd.task.failed'
            ? 'failed'
            : (text(attrs.status) ?? 'unknown');
      tasks.set(task ?? event.id, { event, status });
      continue;
    }
    if (
      /^(tool|subagent)\.loop_detected$/.test(type) ||
      /drift/.test(type) ||
      type === 'brain.intervention' ||
      type === 'sdd.task.verification_failed'
    ) {
      const row = owner(event);
      attach(row, event);
      if (/^(tool|subagent)\.loop_detected$/.test(type)) row.loops++;
      if (/drift/.test(type)) row.drift++;
      if (type === 'brain.intervention' && attrs.intervened === true) row.interventions++;
      if (type === 'sdd.task.verification_failed') row.verificationFailed++;
    }
  }
  const requests = new Map<string, { row: SessionModelStats; success: boolean; failed: boolean }>();
  for (const attempt of attempts.values()) {
    const event = attempt.terminal ?? attempt.start!;
    const row = attempt.row;
    const attrs = event.raw?.attributes ?? {};
    row.attempts++;
    const started = attempt.start?.raw?.attributes ?? {};
    const messages = number(started.messageCount),
      offered = number(started.toolCount);
    if (messages !== undefined) row.messageCounts.push(messages);
    if (offered !== undefined) row.offeredTools.push(offered);
    if (typeof started.streaming === 'boolean') {
      row.streamingSamples++;
      if (started.streaming) row.streamingAttempts++;
    }
    const request = event.raw?.correlation.logicalRequestId;
    if (request) row.requests.add(`${event.actor}:${request}`);
    const phase =
      event.raw?.eventType === 'subagent.provider_attempt'
        ? attrs.outcome
        : event.raw?.eventType.split('.').at(-1);
    if (phase === 'completed') row.completed++;
    else if (phase === 'failed') row.failed++;
    else row.unsettled++;
    if ((number(attrs.attempt) ?? number(attempt.start?.raw?.attributes?.attempt) ?? 0) > 0)
      row.retryAttempts++;
    if (phase === 'failed' && typeof attrs.retryScheduled === 'boolean') row.retryScheduleSamples++;
    if (attrs.retryScheduled === true) {
      row.retriesScheduled++;
      const delay = number(attrs.retryDelayMs);
      if (delay !== undefined) {
        row.retryDelay += delay;
        row.retryDelaySamples++;
      }
    }
    if (attempt.terminal?.durationMs !== undefined) row.durations.push(attempt.terminal.durationMs);
    if (phase === 'completed') {
      const tokens = usage(attrs.usage);
      if (tokens) {
        row.promptTokens.push(tokens.input + tokens.cacheRead + tokens.cacheWrite);
        row.responseTokens.push(tokens.output);
        row.input += tokens.input;
        row.output += tokens.output;
        row.cacheRead += tokens.cacheRead;
        row.cacheWrite += tokens.cacheWrite;
        row.usageSamples++;
      }
      if (tokens && event.durationMs !== undefined && event.durationMs > 0) {
        row.timedOutput += tokens.output;
        row.timedOutputMs += event.durationMs;
      }
      count(row.stopReasons, text(attrs.stopReason) ?? 'unknown');
    }
    if (phase === 'failed') {
      count(row.errorKinds, text(attrs.failureKind) ?? 'unknown');
      const status = number(attrs.status);
      if (status !== undefined) count(row.httpStatuses, String(status));
    }
    if (request) {
      const key = `${row.key}:${event.actor}:${request}`;
      const group = requests.get(key) ?? { row, success: false, failed: false };
      group.success ||= phase === 'completed';
      group.failed ||= phase === 'failed';
      requests.set(key, group);
    }
  }
  for (const request of requests.values())
    if (request.success && request.failed) request.row.recovered++;
  for (const event of streams.values()) {
    const row = owner(event);
    const latency = number(event.raw?.attributes?.firstChunkLatencyMs);
    if (latency !== undefined) row.firstChunk.push(latency);
    attach(row, event);
  }
  for (const call of tools.values()) {
    const event = call.end ?? call.event;
    // A start record may carry the model even if the terminal omitted it.
    const row = identity(event)
      ? owner(event)
      : identity(call.event)
        ? owner(call.event)
        : owner(event);
    attach(row, event);
    row.toolCalls++;
    if (!call.end) row.toolUnsettled++;
    else if (event.raw?.outcome === 'success') row.toolSuccess++;
    else if (['denied', 'cancelled'].includes(event.raw?.outcome ?? '')) row.toolBlocked++;
    else if (event.raw?.outcome === 'failure') row.toolFailed++;
    else row.toolUnsettled++;
    if (call.end?.durationMs !== undefined) row.toolDurations.push(call.end.durationMs);
    if (
      ['invalid_input', 'unknown_tool'].includes(text(event.raw?.attributes?.settlement) ?? '') ||
      /validation|invalid_input/.test(text(event.raw?.attributes?.category) ?? '')
    )
      row.invalidInputs++;
  }
  for (const { event, status } of tasks.values()) {
    const row = owner(event);
    attach(row, event);
    if (status === 'success') row.taskSuccess++;
    else if (status === 'failed') row.taskFailed++;
    else if (status === 'timeout') row.taskTimeout++;
    else if (status === 'stopped') row.taskStopped++;
    else row.taskUnknown++;
  }
  for (const row of models.values()) {
    // Cumulative token/cost snapshots are never assigned wholesale to their last model.
    const delta = accounting.get(row.key);
    if (!row.usageSamples && delta) {
      row.input = delta.input;
      row.output = delta.output;
      row.cacheRead = delta.cacheRead;
      row.cacheWrite = delta.cacheWrite;
      row.usageSamples = delta.samples;
      row.usageSource = 'accounting deltas';
    }
  }
  return [...models.values()]
    .filter((row) => row.evidence.length > 0)
    .sort((a, b) => b.attempts - a.attempts || a.model.localeCompare(b.model));
}
