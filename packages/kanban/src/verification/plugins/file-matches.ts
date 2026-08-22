/**
 * file_matches plugin — reads a file and tests its content against a regex pattern.
 * The pattern is stored in check.notes as a JSON object { file, pattern, flags }.
 * Produces evidence: { path, pattern, matched, lineNumbers[] }.
 */

import type { KanbanCheck, KanbanVerificationCheckResult } from '../../types.js';
import { capSubject, compileSafeRegex } from '../safe-regex.js';
import type { VerificationContext } from '../verification-context.js';
import type { VerifierPlugin } from '../verifier-plugin.js';

export class FileMatchesPlugin implements VerifierPlugin {
  readonly id = 'file_matches';
  readonly kind = 'deterministic' as const;

  canHandle(checkType: string): boolean {
    return checkType === 'file_matches';
  }

  async verify(
    check: KanbanCheck,
    context: VerificationContext,
  ): Promise<KanbanVerificationCheckResult> {
    // Parse config from notes JSON or extract from description
    let config: { file: string; pattern: string; flags?: string } | null = null;
    try {
      if (check.notes?.trim()) {
        config = JSON.parse(check.notes) as { file: string; pattern: string; flags?: string };
      }
    } catch {
      // not JSON — parse from description
    }

    if (!config) {
      // Fallback: description = "file should contain pattern"
      const parts = check.description.split(/\s+(should|must|contains?)\s+/i);
      config = {
        file: parts[0]?.trim() ?? '',
        pattern: parts[parts.length - 1]?.trim() ?? '',
      };
    }

    if (!config.file || !config.pattern) {
      return {
        checkId: check.id,
        description: check.description,
        type: check.type,
        status: 'error',
        evidence: {},
        error: 'file_matches check requires { file, pattern } in notes JSON or description.',
      };
    }

    // The pattern arrives from check config, which the agent may author from
    // repo content — untrusted. Compile it through the ReDoS guard rather than
    // `new RegExp` directly, and report a bad pattern as a check error instead
    // of throwing out of the plugin.
    const compiled = compileSafeRegex(config.pattern, config.flags ?? '');
    if (!compiled.ok) {
      return {
        checkId: check.id,
        description: check.description,
        type: check.type,
        status: 'error',
        evidence: { path: config.file, pattern: config.pattern },
        error: `Invalid file_matches pattern: ${compiled.reason}`,
      };
    }

    try {
      const content = await context.readFile(config.file);
      const regex = compiled.regex;
      // Bound the subject too: guarding the pattern still leaves a linear-time
      // regex scanning an arbitrarily large file.
      const match = capSubject(content).match(regex);
      const lineNumbers: number[] = [];
      if (match) {
        // Find line numbers for all matches
        const lines = capSubject(content).split('\n');
        for (let i = 0; i < lines.length; i++) {
          // `test` advances `lastIndex` on a /g/ regex, so consecutive calls
          // would resume mid-line and skip matches. Reset per line.
          regex.lastIndex = 0;
          if (regex.test(lines[i]!)) {
            lineNumbers.push(i + 1);
          }
        }
      }

      return {
        checkId: check.id,
        description: check.description,
        type: check.type,
        status: match ? 'passed' : 'failed',
        evidence: {
          path: config.file,
          pattern: config.pattern,
          matched: match !== null,
          matchCount: lineNumbers.length,
          lineNumbers: lineNumbers.length > 0 ? lineNumbers : undefined,
        },
        error: match ? undefined : `Pattern "${config.pattern}" not found in ${config.file}.`,
      };
    } catch (err) {
      return {
        checkId: check.id,
        description: check.description,
        type: check.type,
        status: 'error',
        evidence: { path: config.file, pattern: config.pattern },
        error: `Error reading ${config.file}: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
}
