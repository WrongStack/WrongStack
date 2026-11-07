/** A bounded journal projection: arguments and result contents are deliberately ignored. */
export interface ToolUsageEvent {
  type: string;
  ts?: string | undefined;
  id?: string | undefined;
  name?: string | undefined;
  isError?: boolean | undefined;
  inferred?: boolean | undefined;
}

export interface ToolUsageCatalogEntry {
  name: string;
  aliases?: readonly string[] | undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function resolvedToolName(rawName: unknown, rawInput: unknown): string | undefined {
  if (typeof rawName !== 'string') return undefined;
  if (rawName === 'tool_use') {
    const nested = record(rawInput)?.['tool'];
    if (typeof nested === 'string' && nested.trim().length > 0) {
      return nested.trim();
    }
  }
  return rawName;
}

/** Core audit journals reconstruct calls from messages rather than separate tool_use events. */
export function projectToolUsageEvents(value: unknown): ToolUsageEvent[] {
  const event = record(value);
  if (!event) return [];
  const ts = typeof event['ts'] === 'string' ? event['ts'] : undefined;
  if (event['type'] === 'tool_use' || event['type'] === 'tool_result') {
    return [
      {
        type: event['type'],
        ts,
        id: typeof event['id'] === 'string' ? event['id'] : undefined,
        name: resolvedToolName(event['name'], event['input']),
        isError: event['isError'] === true,
        inferred: event['inferred'] === true,
      },
    ];
  }
  const message =
    event['type'] === 'llm_response'
      ? { role: 'assistant', content: event['content'] }
      : event['type'] === 'message_appended' || event['type'] === 'message_updated'
        ? record(event['message'])
        : undefined;
  if (!message || !Array.isArray(message['content'])) return [];
  return message['content'].flatMap((value: unknown): ToolUsageEvent[] => {
    const block = record(value);
    if (!block) return [];
    if (
      message['role'] === 'assistant' &&
      block['type'] === 'tool_use' &&
      typeof block['id'] === 'string' &&
      typeof block['name'] === 'string'
    ) {
      return [
        {
          type: 'tool_use',
          ts,
          id: block['id'],
          name: resolvedToolName(block['name'], block['input']),
          inferred: true,
        },
      ];
    }
    if (
      message['role'] === 'user' &&
      block['type'] === 'tool_result' &&
      typeof block['tool_use_id'] === 'string'
    ) {
      return [
        {
          type: 'tool_result',
          ts,
          id: block['tool_use_id'],
          isError: block['is_error'] === true,
          inferred: true,
        },
      ];
    }
    return [];
  });
}

export function summarizeToolUsage(
  catalog: readonly ToolUsageCatalogEntry[],
  journals: readonly (readonly unknown[])[],
  window: { from?: string | undefined; to?: string | undefined } = {},
) {
  const names = new Map(
    catalog.flatMap((tool) =>
      [tool.name, ...(tool.aliases ?? [])].map((name) => [name, tool.name] as const),
    ),
  );
  const rows = new Map(
    catalog.map((tool) => [
      tool.name,
      {
        name: tool.name,
        invocations: 0,
        failures: 0,
        sessions: 0,
        lastInvokedAt: null as string | null,
      },
    ]),
  );
  const from = window.from ? Date.parse(window.from) : Number.NEGATIVE_INFINITY;
  const to = window.to ? Date.parse(window.to) : Number.POSITIVE_INFINITY;
  if (Number.isNaN(from) || Number.isNaN(to) || from > to)
    throw new Error('Invalid usage report time window');
  let unrecognizedCalls = 0;
  let unsettledCalls = 0;
  for (const journal of journals) {
    const events = journal.flatMap(projectToolUsageEvents);
    const calls = new Map<string, ToolUsageEvent>();
    const settled = new Set<string>();
    const seen = new Set<string>();
    for (const event of events) {
      if (event.type !== 'tool_use' || !event.id || !event.name) continue;
      const previous = calls.get(event.id);
      if (!previous || !event.inferred) calls.set(event.id, event);
    }
    for (const event of events) {
      if (!event.id) continue;
      if (event.type !== 'tool_result' || settled.has(event.id)) continue;
      settled.add(event.id);
      const call = calls.get(event.id);
      const time = Date.parse(call?.ts ?? event.ts ?? '');
      if (!Number.isFinite(time) || time < from || time > to) continue;
      const called = call?.name;
      const canonical = called ? names.get(called) : undefined;
      const row = canonical ? rows.get(canonical) : undefined;
      if (!row) {
        unrecognizedCalls++;
        continue;
      }
      row.invocations++;
      if (event.isError) row.failures++;
      if (!row.lastInvokedAt || time > Date.parse(row.lastInvokedAt))
        row.lastInvokedAt = new Date(time).toISOString();
      if (!seen.has(row.name)) {
        row.sessions++;
        seen.add(row.name);
      }
    }
    unsettledCalls += [...calls.values()].filter((call) => {
      const time = Date.parse(call.ts ?? '');
      return !settled.has(call.id!) && Number.isFinite(time) && time >= from && time <= to;
    }).length;
  }
  return {
    schemaVersion: 1,
    source: 'explicit-journal-sample',
    sampledSessions: journals.length,
    window,
    unrecognizedCalls,
    unsettledCalls,
    // No observation in this sample is not proof that a tool is unused globally.
    tools: [...rows.values()]
      .map((row) => ({ ...row, observation: row.invocations ? 'observed' : 'not-observed' }))
      .sort((a, b) => a.invocations - b.invocations || a.name.localeCompare(b.name)),
  };
}
