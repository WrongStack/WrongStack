import { createHash } from 'node:crypto';

export interface QualityReviewPolicy {
  allowedEditPaths?: string[];
  requiredFinalMarkers?: string[];
  repeatLimit?: number;
}
export interface QualityFinding {
  category:
    | 'repeated-tool-call'
    | 'scope-excursion'
    | 'failed-tool-call'
    | 'missing-test-evidence'
    | 'missing-final-requirement';
  eventIndexes: number[];
  detail: string;
}
/** Advisory observations with exact transcript offsets; never a completion or test gate. */
export function reviewTranscript(
  events: Record<string, unknown>[],
  sourceHash: string,
  policy: QualityReviewPolicy = {},
  sourceFormat: 'jsonl' | 'event-array' = 'jsonl',
) {
  if (
    !policy ||
    typeof policy !== 'object' ||
    Array.isArray(policy) ||
    Object.keys(policy).some(
      (key) => !['allowedEditPaths', 'requiredFinalMarkers', 'repeatLimit'].includes(key),
    )
  )
    throw new Error('Invalid review policy');
  if (!/^[a-f0-9]{64}$/.test(sourceHash) || events.length > 100_000)
    throw new Error('Invalid or oversized review source');
  const repeatLimit = policy.repeatLimit ?? 3;
  if (!Number.isSafeInteger(repeatLimit) || repeatLimit < 2 || repeatLimit > 100)
    throw new Error('Invalid repeat limit');
  for (const items of [policy.allowedEditPaths, policy.requiredFinalMarkers])
    if (
      items !== undefined &&
      (!Array.isArray(items) ||
        items.length > 200 ||
        items.some((item) => typeof item !== 'string' || !item || item.length > 4096))
    )
      throw new Error('Invalid review policy');
  const findings: QualityFinding[] = [];
  const calls = new Map<string, { index: number; name: string; input: Record<string, unknown> }>();
  const settled = new Set<string>();
  const failed = new Set<string>();
  let toolInputsObserved = 0;
  let toolOutcomesObserved = 0;
  const repetitions = new Map<string, number[]>();
  const reads = new Map<string, number>();
  const lastCompactionIndex = new Map<string, number>();
  let edits = 0;
  let testCommandsObserved = 0;
  let compactions = 0;
  let rereadsAfterCompaction = 0;
  let finalText = '';
  let fullRequestTokensSaved = 0;
  let measuredCompactions = 0;
  events.forEach((event, index) => {
    const type = event['type'];
    const agent = typeof event['agentId'] === 'string' ? event['agentId'] : 'leader';
    if (
      (type === 'tool_use' || type === 'tool_call_start') &&
      typeof event['id'] === 'string' &&
      typeof event['name'] === 'string'
    ) {
      const name = event['name'].toLowerCase().replace(/-/g, '_');
      const input =
        event['input'] && typeof event['input'] === 'object'
          ? (event['input'] as Record<string, unknown>)
          : {};
      const callKey = `${agent}:${event['id']}`;
      if (calls.has(callKey) && !settled.has(callKey)) return;
      settled.delete(callKey);
      failed.delete(callKey);
      toolInputsObserved++;
      calls.set(`${agent}:${event['id']}`, { index, name, input });
      const signature = createHash('sha256')
        .update(JSON.stringify({ agent, name, input }))
        .digest('hex');
      const indexes = repetitions.get(signature) ?? [];
      indexes.push(index);
      repetitions.set(signature, indexes);
      const file =
        typeof input['path'] === 'string'
          ? input['path']
          : typeof input['file_path'] === 'string'
            ? input['file_path']
            : undefined;
      if (['read', 'read_file'].includes(name) && file) {
        const readKey = `${agent}:${file}`;
        const firstRead = reads.get(readKey);
        const compactedAt = lastCompactionIndex.get(agent);
        if (firstRead !== undefined && compactedAt !== undefined && firstRead < compactedAt) {
          rereadsAfterCompaction++;
        }
        if (firstRead === undefined) reads.set(readKey, index);
      }
      if (
        [
          'edit',
          'write',
          'patch',
          'apply_patch',
          'replace',
          'str_replace',
          'multi_edit',
          'multiedit',
        ].includes(name)
      ) {
        edits++;
        if (file && policy.allowedEditPaths && !policy.allowedEditPaths.includes(file))
          findings.push({
            category: 'scope-excursion',
            eventIndexes: [index],
            detail: `Edit path outside the curated allow-list: ${file}`,
          });
      }
    } else if (type === 'tool_call_end' || type === 'tool_result') {
      const callKey = `${agent}:${String(event['id'])}`;
      const call = calls.get(callKey);
      const alreadySettled = settled.has(callKey);
      settled.add(callKey);
      if (!alreadySettled) toolOutcomesObserved++;
      if ((event['ok'] === false || event['isError'] === true) && !failed.has(callKey)) {
        failed.add(callKey);
        findings.push({
          category: 'failed-tool-call',
          eventIndexes: [index],
          detail: 'Tool reported failure; inspect the source event.',
        });
      }
      if (!alreadySettled && call && ['bash', 'exec', 'shell', 'terminal'].includes(call.name)) {
        const command = call.input['command'] ?? call.input['cmd'];
        if (
          typeof command === 'string' &&
          /(?:^|[;&|]\s*|\s)(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?test(?:\s|$)|(?:^|\s)(?:pytest|vitest|jest|cargo\s+test|go\s+test)(?:\s|$)/.test(
            command,
          ) &&
          !/^\s*(echo|printf)\b/.test(command)
        )
          testCommandsObserved++;
      }
    } else if (type === 'compaction' || type === 'compaction.fired') {
      compactions++;
      lastCompactionIndex.set(agent, index);
      const report =
        event['report'] && typeof event['report'] === 'object'
          ? (event['report'] as Record<string, unknown>)
          : event;
      const before = report['fullRequestTokensBefore'];
      const after = report['fullRequestTokensAfter'];
      if (
        typeof before === 'number' &&
        typeof after === 'number' &&
        Number.isFinite(before) &&
        Number.isFinite(after) &&
        before >= after &&
        after >= 0
      ) {
        measuredCompactions++;
        fullRequestTokensSaved += before - after;
      }
    } else if (
      agent === 'leader' &&
      (type === 'assistant_message' || type === 'assistant' || type === 'llm_response')
    ) {
      const text = event['text'] ?? event['content'];
      if (typeof text === 'string') {
        if (text.length > 0) finalText = text;
      } else if (Array.isArray(text)) {
        const joined = text
          .flatMap((block) =>
            block &&
            typeof block === 'object' &&
            block.type === 'text' &&
            typeof block.text === 'string'
              ? [block.text]
              : [],
          )
          .join('\n');
        if (joined.length > 0) finalText = joined;
      }
    }
  });
  for (const indexes of repetitions.values())
    if (indexes.length >= repeatLimit)
      findings.push({
        category: 'repeated-tool-call',
        eventIndexes: indexes.slice(0, 100),
        detail: `${indexes.length} identical calls; repetition is advisory, not proof of a loop.`,
      });
  if (edits && !testCommandsObserved)
    findings.push({
      category: 'missing-test-evidence',
      eventIndexes: [],
      detail:
        'Edits observed without a recognized test command. Custom verification may still exist.',
    });
  for (const marker of policy.requiredFinalMarkers ?? [])
    if (!finalText.includes(marker))
      findings.push({
        category: 'missing-final-requirement',
        eventIndexes: [],
        detail: `Curated final-answer marker absent: ${marker}`,
      });
  return {
    version: 1 as const,
    advisory: true as const,
    sourceHash,
    sourceFormat,
    eventCount: events.length,
    findings: findings.slice(0, 1000),
    findingsTruncated: findings.length > 1000,
    observations: {
      toolInputsObserved,
      toolOutcomesObserved,
      edits,
      testCommandsObserved,
      compactions,
      rereadsAfterCompaction,
      fullRequestTokensSaved:
        measuredCompactions === compactions && compactions > 0 ? fullRequestTokensSaved : null,
    },
    validation: 'not-independently-verified' as const,
  };
}
