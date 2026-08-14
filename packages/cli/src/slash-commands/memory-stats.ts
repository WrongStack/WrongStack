import type { SlashCommandContext } from './command-context.js';

// ── /memory stats — memory health dashboard ─────────────────────────────

export async function runStats(opts: SlashCommandContext): Promise<{ message: string }> {
  const store = opts.memoryStore;
  if (!store) return { message: 'No memory store configured.' };

  const entries = await store.list('project-memory');
  if (entries.length === 0) {
    return { message: '📊 Memory is empty. Start adding entries with `/memory remember <text>`.' };
  }

  const now = Date.now();
  const lines: string[] = ['## 📊 Memory Stats'];

  // ── Overview
  const raw = await store.read('project-memory');
  const byteSize = Buffer.byteLength(raw, 'utf8');
  const kbSize = (byteSize / 1024).toFixed(1);
  const maxKb = (32_000 / 1024).toFixed(1);
  const pctFull = ((byteSize / 32_000) * 100).toFixed(0);
  lines.push(`**Total:** ${entries.length} entries · ${kbSize} KB / ${maxKb} KB (${pctFull}%)`);

  // ── By type
  const byType = new Map<string, number>();
  for (const e of entries) {
    const t = e.type ?? 'untyped';
    byType.set(t, (byType.get(t) ?? 0) + 1);
  }
  if (byType.size > 0) {
    lines.push('');
    lines.push('### By Type');
    const typeOrder = [
      'convention',
      'decision',
      'fact',
      'preference',
      'reference',
      'anti_pattern',
      'untyped',
    ];
    for (const t of typeOrder) {
      const count = byType.get(t);
      if (count) {
        const bar = '█'.repeat(Math.min(count, 20));
        lines.push(`- \`${t}\` ${bar} ${count}`);
      }
    }
  }

  // ── By priority
  const byPriority = new Map<string, number>();
  for (const e of entries) {
    const p = e.priority ?? 'unset';
    byPriority.set(p, (byPriority.get(p) ?? 0) + 1);
  }
  if (byPriority.size > 0) {
    lines.push('');
    lines.push('### By Priority');
    const icon: Record<string, string> = {
      critical: '⚡',
      high: '▲',
      medium: '●',
      low: '○',
      unset: '·',
    };
    for (const [p, count] of [...byPriority.entries()].sort((a, b) => b[1] - a[1])) {
      lines.push(`- ${icon[p] ?? '·'} \`${p}\`: ${count}`);
    }
  }

  // ── By age
  const ages = entries.map((e) => {
    const ageDays = (now - new Date(e.ts).getTime()) / (1000 * 60 * 60 * 24);
    if (ageDays < 1) return '<1d';
    if (ageDays < 7) return '<7d';
    if (ageDays < 30) return '<30d';
    return '>30d';
  });
  const byAge = new Map<string, number>();
  for (const a of ages) byAge.set(a, (byAge.get(a) ?? 0) + 1);
  lines.push('');
  lines.push('### By Age');
  for (const age of ['<1d', '<7d', '<30d', '>30d']) {
    const actual = byAge.get(age) ?? 0;
    if (actual > 0 || age === '<7d') {
      lines.push(`- ${age}: ${actual}`);
    }
  }

  // ── Top tags
  const tagCounts = new Map<string, number>();
  for (const e of entries) {
    for (const t of e.tags ?? []) {
      tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
    }
  }
  if (tagCounts.size > 0) {
    lines.push('');
    lines.push('### Top Tags');
    const sorted = [...tagCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
    for (const [tag, count] of sorted) {
      lines.push(`- \`#${tag}\`: ${count}`);
    }
  }

  // ── Health
  lines.push('');
  lines.push('### Health');
  const untyped = byType.get('untyped') ?? 0;
  const unsetPriority = byPriority.get('unset') ?? 0;
  const old = byAge.get('>30d') ?? 0;

  if (untyped > entries.length * 0.5) {
    lines.push(
      `- ⚠️ ${untyped}/${entries.length} entries have no type — run \`/memory compact\` to categorize`,
    );
  } else if (untyped > 0) {
    lines.push(`- ℹ️ ${untyped} entries untyped — consider categorizing`);
  } else {
    lines.push('- ✅ All entries have types');
  }

  if (unsetPriority > entries.length * 0.5) {
    lines.push(`- ⚠️ ${unsetPriority}/${entries.length} entries have no priority`);
  } else if (unsetPriority > 0) {
    lines.push(`- ℹ️ ${unsetPriority} entries have no priority set`);
  } else {
    lines.push('- ✅ All entries have priorities');
  }

  if (old > 5) {
    lines.push(`- ⚠️ ${old} entries older than 30 days — run \`/memory compact\` to review`);
  }

  const pct = Number.parseInt(pctFull, 10);
  if (pct > 80) {
    lines.push(`- ⚠️ Storage ${pct}% full — run \`/memory compact\` to free space`);
  } else {
    lines.push(`- ✅ Storage ${pct}% full — healthy`);
  }

  lines.push('');
  lines.push('**Commands:** `/memory show` · `/memory compact` · `/memory remember <text>`');

  return { message: lines.join('\n') };
}
