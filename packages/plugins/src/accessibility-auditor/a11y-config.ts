import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface AccessibilityAuditorConfig {
  enabled: boolean;
  includeExtensions: string[];
  maxFindings: number;
  severity: 'warn' | 'block';
  onWriteEdit: boolean;
}

export const DEFAULTS: AccessibilityAuditorConfig = {
  enabled: true,
  includeExtensions: ['.tsx', '.jsx', '.html', '.vue'],
  maxFindings: 50,
  severity: 'warn',
  onWriteEdit: true,
};

export function readConfig(raw: unknown): AccessibilityAuditorConfig {
  if (!raw || typeof raw !== 'object') {
    return { ...DEFAULTS, includeExtensions: [...DEFAULTS.includeExtensions] };
  }
  const r = raw as Record<string, unknown>;
  const rawExts = r['includeExtensions'] ?? r['include_extensions'] ?? r['extensions'];
  const rawMax = r['maxFindings'] ?? r['max_findings'] ?? r['limit'];
  const rawSeverity =
    typeof (r['severity'] ?? r['mode'] ?? r['action']) === 'string'
      ? String(r['severity'] ?? r['mode'] ?? r['action'])
          .trim()
          .toLowerCase()
      : undefined;
  const severity = rawSeverity === 'block' ? 'block' : DEFAULTS.severity;
  return {
    enabled: r['enabled'] !== false,
    includeExtensions: Array.isArray(rawExts)
      ? (rawExts as unknown[]).filter((x): x is string => typeof x === 'string')
      : [...DEFAULTS.includeExtensions],
    maxFindings:
      typeof rawMax === 'number' && Number.isFinite(rawMax) && rawMax >= 1 && rawMax <= 500
        ? Math.floor(rawMax)
        : DEFAULTS.maxFindings,
    severity,
    onWriteEdit: (r['onWriteEdit'] ?? r['on_write_edit'] ?? r['onSave']) !== false,
  };
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

export async function assertPathExists(rawPath: string): Promise<void> {
  try {
    await stat(resolve(process.cwd(), rawPath));
  } catch (err) {
    throw new Error(`path not found: ${rawPath}`, { cause: err });
  }
}

export function normalizeExtensions(exts: string[]): string[] {
  return exts
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.length > 0 && e !== '.')
    .map((e) => (e.startsWith('.') ? e : `.${e}`));
}
