import { toErrorMessage } from '@wrongstack/core/utils';
import type { MemoryAudienceSelector, SageSurface } from '@wrongstack/sage';

// ── /memory audience — view and manage role-scoped memories ──────────

interface ParsedAudienceFlags {
  roles?: string[];
  taskTypes?: string[];
  modes?: string[];
  errors: string[];
}

function parseAudienceFlags(tokens: string[]): ParsedAudienceFlags {
  const out: ParsedAudienceFlags = { errors: [] };
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] ?? '';
    if (!token.startsWith('--')) continue;
    const name = token.slice(2).toLowerCase();
    const value = tokens[i + 1];
    if (!value || value.startsWith('--')) {
      out.errors.push(`--${name} needs a value.`);
      continue;
    }
    i++;
    const csv = value
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean);
    switch (name) {
      case 'role':
      case 'roles':
        out.roles = [...(out.roles ?? []), ...csv];
        break;
      case 'task-type':
      case 'task-types':
      case 'tasktype':
      case 'tasktypes':
        out.taskTypes = [...(out.taskTypes ?? []), ...csv];
        break;
      case 'mode':
      case 'modes':
        out.modes = [...(out.modes ?? []), ...csv];
        break;
      default:
        out.errors.push(`Unknown audience flag "--${name}".`);
    }
  }
  return out;
}

function hasAudienceSelector(parsed: ParsedAudienceFlags): boolean {
  return !!(parsed.roles?.length || parsed.taskTypes?.length || parsed.modes?.length);
}

function formatAudienceSelector(audience: MemoryAudienceSelector): string {
  const parts: string[] = [];
  if (audience.roles?.length) parts.push(`roles: ${audience.roles.join(', ')}`);
  if (audience.taskTypes?.length) parts.push(`taskTypes: ${audience.taskTypes.join(', ')}`);
  if (audience.modes?.length) parts.push(`modes: ${audience.modes.join(', ')}`);
  return parts.join(' · ');
}

export async function runAudienceMemory(
  store: SageSurface,
  rest: string[],
): Promise<{ message: string }> {
  const sub = rest[0]?.toLowerCase() ?? 'list';

  // /memory audience list [--role <r>] [--task-type <t>] [--mode <m>]
  if (sub === 'list' || sub === 'show' || sub === 'ls') {
    const flags = parseAudienceFlags(rest.slice(1));
    if (flags.errors.length > 0) {
      return { message: `Cannot parse audience flags:\n- ${flags.errors.join('\n- ')}` };
    }
    if (hasAudienceSelector(flags)) {
      const matches = await store.retrieveForAudience(
        {
          ...(flags.roles ? { role: flags.roles[0] } : {}),
          ...(flags.taskTypes ? { taskType: flags.taskTypes[0] } : {}),
          ...(flags.modes ? { mode: flags.modes[0] } : {}),
        },
        50,
      );
      if (matches.length === 0)
        return { message: 'No audience-scoped memories match the given selectors.' };
      const lines = ['## Audience-Scoped Memory — Matching', ''];
      for (const mem of matches) {
        const aud = mem.audience ? ` (${formatAudienceSelector(mem.audience)})` : '';
        lines.push(`- \`${mem.id}\` [${mem.kind}|${mem.status}] ${mem.text}${aud}`);
      }
      return { message: lines.join('\n') };
    }
    // No selectors: list ALL audience-scoped memories
    const all = await store.listSage(['active', 'stale']);
    const scoped = all.filter((m) => m.audience);
    if (scoped.length === 0) {
      return {
        message:
          'No audience-scoped memories. Add one with `/memory audience remember --role <r> <text>`.',
      };
    }
    const lines = ['## Audience-Scoped Memory', ''];
    for (const mem of scoped) {
      const aud = mem.audience ? ` (${formatAudienceSelector(mem.audience)})` : '';
      lines.push(`- \`${mem.id}\` [${mem.kind}|${mem.status}] ${mem.text}${aud}`);
    }
    return { message: lines.join('\n') };
  }

  // /memory audience remember --role <r> [--task-type <t>] [--mode <m>] <text>
  if (sub === 'remember' || sub === 'add') {
    const flags = parseAudienceFlags(rest.slice(1));
    if (flags.errors.length > 0) {
      return { message: `Cannot remember:\n- ${flags.errors.join('\n- ')}` };
    }
    if (!hasAudienceSelector(flags)) {
      return {
        message:
          'Usage: /memory audience remember --role <role> [--task-type <t>] [--mode <m>] <text>\nAt least one of --role, --task-type, or --mode is required.',
      };
    }
    // Extract text: tokens after the flags
    const words: string[] = [];
    const flagSet = new Set([
      '--role',
      '--roles',
      '--task-type',
      '--task-types',
      '--tasktype',
      '--tasktypes',
      '--mode',
      '--modes',
    ]);
    for (let i = 1; i < rest.length; i++) {
      const token = rest[i] ?? '';
      if (token.startsWith('--')) {
        if (flagSet.has(token.toLowerCase())) i++; // skip value
        continue;
      }
      words.push(token);
    }
    const text = words.join(' ').trim();
    if (!text) {
      return { message: 'Nothing to remember — provide the memory text after the flags.' };
    }
    try {
      const audience: MemoryAudienceSelector = {};
      if (flags.roles?.length) audience.roles = flags.roles;
      if (flags.taskTypes?.length) audience.taskTypes = flags.taskTypes;
      if (flags.modes?.length) audience.modes = flags.modes;
      const memory = await store.rememberSage({ text, audience });
      return {
        message: `Remembered \`${memory.id}\` for ${formatAudienceSelector(memory.audience!)}: ${memory.text}`,
      };
    } catch (err) {
      return { message: `Could not remember: ${toErrorMessage(err)}` };
    }
  }

  // /memory audience clear <memory-id>
  if (sub === 'clear') {
    const id = rest[1];
    if (!id) return { message: 'Usage: /memory audience clear <memory-id>' };
    try {
      await store.updateSage(id, { audience: {} });
      return {
        message: `Cleared audience scope from \`${id}\` — it is now general project memory.`,
      };
    } catch (err) {
      return { message: `Could not clear audience: ${toErrorMessage(err)}` };
    }
  }

  // /memory audience search <query>
  // Searches audience-scoped memories by partial text/role/mode match.
  if (sub === 'search' || sub === 'find') {
    const query = rest.slice(1).join(' ').trim().toLowerCase();
    if (!query) return { message: 'Usage: /memory audience search <query>' };
    const all = await store.listSage(['active', 'stale']);
    const scoped = all.filter((m) => m.audience);
    const matches = scoped.filter((m) => {
      const haystack = [
        m.text,
        m.audience?.roles?.join(' ') ?? '',
        m.audience?.taskTypes?.join(' ') ?? '',
        m.audience?.modes?.join(' ') ?? '',
        m.tags.join(' '),
      ]
        .join(' ')
        .toLowerCase();
      return haystack.includes(query);
    });
    if (matches.length === 0) return { message: `No audience-scoped memories match "${query}".` };
    const lines = [`## Audience-Scoped Memory — Search: "${query}"`, ''];
    for (const mem of matches) {
      const aud = mem.audience ? ` (${formatAudienceSelector(mem.audience)})` : '';
      lines.push(`- \`${mem.id}\` [${mem.kind}|${mem.status}] ${mem.text}${aud}`);
    }
    return { message: lines.join('\n') };
  }

  // /memory audience transfer <from-role> <to-role>
  // Re-scopes all memories targeting <from-role> to <to-role> instead.
  if (sub === 'transfer' || sub === 'reassign') {
    const fromRole = rest[1]?.toLowerCase();
    const toRole = rest[2]?.toLowerCase();
    if (!fromRole || !toRole) {
      return { message: 'Usage: /memory audience transfer <from-role> <to-role>' };
    }
    const all = await store.listSage(['active', 'stale']);
    const toUpdate = all.filter((m) =>
      m.audience?.roles?.some((r) => r.toLowerCase() === fromRole),
    );
    if (toUpdate.length === 0) {
      return { message: `No audience-scoped memories found for role "${fromRole}".` };
    }
    let updated = 0;
    for (const mem of toUpdate) {
      const roles = (mem.audience!.roles ?? []).map((r) =>
        r.toLowerCase() === fromRole ? toRole : r,
      );
      const deduped = [...new Set(roles)];
      try {
        await store.updateSage(mem.id, {
          audience: {
            roles: deduped,
            ...(mem.audience!.taskTypes?.length ? { taskTypes: mem.audience!.taskTypes } : {}),
            ...(mem.audience!.modes?.length ? { modes: mem.audience!.modes } : {}),
          },
        });
        updated++;
      } catch {
        // continue on per-memory errors
      }
    }
    return {
      message:
        updated === 0
          ? `Failed to transfer any memories from "${fromRole}" to "${toRole}".`
          : `Transferred ${updated} memor${updated === 1 ? 'y' : 'ies'} from role "${fromRole}" to "${toRole}".`,
    };
  }

  // /memory audience export [--role <r>] [--task-type <t>] [--mode <m>]
  // Dumps matching audience-scoped memories as JSON for sharing/backup.
  if (sub === 'export' || sub === 'dump') {
    const flags = parseAudienceFlags(rest.slice(1));
    if (flags.errors.length > 0) {
      return { message: `Cannot parse audience flags:\n- ${flags.errors.join('\n- ')}` };
    }
    const all = await store.listSage(['active', 'stale']);
    let scoped = all.filter((m) => m.audience);
    if (hasAudienceSelector(flags)) {
      const roleMatch = flags.roles?.[0]?.toLowerCase();
      const taskMatch = flags.taskTypes?.[0]?.toLowerCase();
      const modeMatch = flags.modes?.[0]?.toLowerCase();
      scoped = scoped.filter((m) => {
        if (roleMatch && !(m.audience?.roles ?? []).some((r) => r.toLowerCase() === roleMatch))
          return false;
        if (taskMatch && !(m.audience?.taskTypes ?? []).some((r) => r.toLowerCase() === taskMatch))
          return false;
        if (modeMatch && !(m.audience?.modes ?? []).some((r) => r.toLowerCase() === modeMatch))
          return false;
        return true;
      });
    }
    if (scoped.length === 0) {
      return { message: 'No audience-scoped memories to export.' };
    }
    const exportData = scoped.map((m) => ({
      id: m.id,
      text: m.text,
      kind: m.kind,
      status: m.status,
      audience: m.audience,
      tags: m.tags,
      importance: m.importance,
      confidence: m.confidence,
    }));
    return {
      message: '```json\n' + JSON.stringify(exportData, null, 2) + '\n```',
    };
  }

  // /memory audience import <json-array>
  // Loads exported memories from JSON into this project's store.
  if (sub === 'import' || sub === 'load') {
    const jsonText = rest.slice(1).join(' ').trim();
    if (!jsonText) {
      return {
        message:
          'Usage: /memory audience import <json-array>\nPaste the JSON output from `/memory audience export`.',
      };
    }
    let entries: Array<{
      text?: unknown;
      kind?: unknown;
      status?: unknown;
      audience?: unknown;
      tags?: unknown;
      importance?: unknown;
      confidence?: unknown;
    }>;
    try {
      const cleaned = jsonText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
      entries = JSON.parse(cleaned);
    } catch {
      return { message: 'Invalid JSON. Paste the output from `/memory audience export`.' };
    }
    if (!Array.isArray(entries) || entries.length === 0) {
      return { message: 'No entries found in the JSON.' };
    }
    let imported = 0;
    let skipped = 0;
    for (const entry of entries) {
      if (typeof entry.text !== 'string' || !entry.text.trim()) {
        skipped++;
        continue;
      }
      try {
        await store.rememberSage({
          text: entry.text,
          ...(typeof entry.kind === 'string' ? { kind: entry.kind as never } : {}),
          ...(Array.isArray(entry.tags) ? { tags: entry.tags as string[] } : {}),
          ...(entry.audience && typeof entry.audience === 'object'
            ? { audience: entry.audience as never }
            : {}),
          ...(typeof entry.importance === 'number' ? { importance: entry.importance } : {}),
          ...(typeof entry.confidence === 'number' ? { confidence: entry.confidence } : {}),
        });
        imported++;
      } catch {
        skipped++;
      }
    }
    return {
      message:
        imported === 0
          ? 'No memories imported — all entries were invalid.'
          : `Imported ${imported} memor${imported === 1 ? 'y' : 'ies'}${skipped > 0 ? `, skipped ${skipped}` : ''}.`,
    };
  }

  return {
    message: [
      '## /memory audience',
      '',
      '`/memory audience list [--role <r>] [--task-type <t>] [--mode <m>]` — view scoped memories',
      '`/memory audience remember --role <r> [--task-type <t>] [--mode <m>] <text>` — add a scoped memory',
      '`/memory audience search <query>` — search scoped memories by partial text/role/mode',
      '`/memory audience transfer <from-role> <to-role>` — bulk re-scope memories from one role to another',
      '`/memory audience export [--role <r>]` — dump scoped memories as JSON',
      '`/memory audience import <json-array>` — load exported memories from JSON',
      '`/memory audience clear <memory-id>` — remove scope (becomes general memory)',
    ].join('\n'),
  };
}
