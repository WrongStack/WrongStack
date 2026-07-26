import * as fs from 'node:fs/promises';

export interface ActivePlanCache {
  path: string;
  mtimeMs: number;
  text: string;
}

export async function readActivePlanBlock(args: {
  planPath: string | undefined;
  cache: ActivePlanCache | undefined;
}): Promise<{ text: string; cache: ActivePlanCache | undefined }> {
  const { planPath, cache } = args;
  if (!planPath) return { text: '', cache };

  try {
    const stat = await fs.stat(planPath);
    if (cache && cache.path === planPath && cache.mtimeMs === stat.mtimeMs) {
      return { text: cache.text, cache };
    }
    const raw = await fs.readFile(planPath, 'utf8');
    const text = formatActivePlan(raw);
    return { text, cache: { path: planPath, mtimeMs: stat.mtimeMs, text } };
  } catch {
    return { text: '', cache: undefined };
  }
}

function formatActivePlan(raw: string): string {
  let parsed: {
    items?: Array<{ status?: string | undefined; title?: string | undefined }>;
    title?: string | undefined;
  };
  try {
    parsed = JSON.parse(raw);
  } catch {
    return '';
  }
  if (!Array.isArray(parsed.items) || parsed.items.length === 0) return '';
  const open = parsed.items.filter((i) => i?.status !== 'done');
  if (open.length === 0) return '';
  const lines = ['## Active plan'];
  if (parsed.title) lines.push(`*${parsed.title}*`, '');
  parsed.items.forEach((it, idx) => {
    const mark = it?.status === 'done' ? '[x]' : it?.status === 'in_progress' ? '[~]' : '[ ]';
    lines.push(`${idx + 1}. ${mark} ${it?.title ?? '(untitled)'}`);
  });
  lines.push(
    '',
    'Use `/plan` (user) or the `plan` tool to update status as you progress. The roadmap survives session resume.',
  );
  return lines.join('\n');
}
