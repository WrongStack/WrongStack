/**
 * Structured audit logger for the `wstack auth local` lifecycle.
 *
 * Emits JSON-line events to an injectable sink (default: stdout).
 * The event names mirror the WebUI's WS message types
 * (`provider.clear_models` ↔ `auth.local.clear`,
 * `provider.undo_clear` ↔ `auth.local.undo`) so a downstream
 * tool that filters on one convention finds the corresponding
 * events on the other surface.
 *
 * Why a dedicated logger (vs. `console.log`)?
 *   - **Test seam** — tests inject an in-memory array sink and
 *     assert on the recorded events. `console.log` can't be
 *     captured cleanly across the test runner / reporter.
 *   - **Schema stability** — the discriminated union of
 *     `AuthAuditEvent` types gives downstream consumers a
 *     contract they can switch on. Plain `console.log` strings
 *     drift on every commit.
 *   - **Redaction built in** — every event passes through a
 *     `SecretScrubber` before reaching the sink, so a Bearer
 *     token accidentally captured in a payload can't echo to
 *     stdout / the audit file in plaintext.
 *
 * The logger is intentionally minimal: no buffering, no
 * rotation, no transport. The CLI process is short-lived and
 * emits at most a handful of events per invocation. A
 * long-running consumer (file rotation, OTLP export) would
 * belong in a dedicated audit-sink module, not here.
 */

import { appendFileSync } from 'node:fs';
import { DefaultSecretScrubber } from '@wrongstack/core/security';
import type { SecretScrubber } from '@wrongstack/core/types';

/**
 * Discriminated union of every event the auth-menu local flow
 * can emit. New events slot in here as the lifecycle grows —
 * the `type` field is the stable contract.
 */
export type AuthAuditEvent =
  | {
      type: 'auth.local.add';
      providerId: string;
      baseUrl: string;
      /** The resolved model list saved to disk. Empty when the
       *  user didn't pass `--model`. */
      models: string[];
      /** Label of the saved key entry, if any. */
      keyLabel?: string | undefined;
    }
  | {
      /**
       * Emitted when the save replaces a previously non-empty
       * `cfg.models` allowlist with `[]`. Pairs with
       * `auth.local.undo` — a search for both events in
       * sequence surfaces a "user changed their mind" pair.
       */
      type: 'auth.local.clear';
      providerId: string;
      baseUrl: string;
      /** The list the user just removed. */
      previousModels: string[];
    }
  | {
      /**
       * Emitted when the save restores a non-empty `cfg.models`
       * allowlist that was previously `[]` or absent. The
       * `restoredModels` field carries the new list verbatim.
       * Pairs with `auth.local.clear`.
       */
      type: 'auth.local.undo';
      providerId: string;
      baseUrl: string;
      /** The list the user just restored. */
      restoredModels: string[];
    }
  | {
      /**
       * Emitted when the `--model` flag was probe-driven
       * (`'first'` / `'<N>'`) but the probe didn't return
       * enough ids. The flag is silently ignored in that case
       * — this event lets the audit log surface the silent
       * skip.
       */
      type: 'auth.local.probe_skip';
      providerId: string;
      baseUrl: string;
      requestedShape: 'first' | string;
    }
  | {
      /**
       * Emitted when the health probe failed AND the user chose
       * to save anyway. Pairs with the probe result line in
       * the terminal — the audit event is the durable record
       * that the provider was saved in a known-bad state.
       */
      type: 'auth.local.probe_failed_save';
      providerId: string;
      baseUrl: string;
      probeStatus: string;
      probeDetail?: string | undefined;
    };

/**
 * Sink contract: receives the post-scrub, post-stringify event
 * line. The default implementation writes to stdout; tests
 * inject an in-memory array.
 */
export interface AuthAuditSink {
  write(line: string): void;
}

/** Default sink: one JSON line per event on stdout. */
function defaultStdoutSink(): AuthAuditSink {
  // process.stdout.write is the right primitive here — it
  // bypasses the test runner's `console.log` capture and
  // never throws. Use \n explicitly; some terminals buffer
  // until they see one.
  return {
    write(line: string) {
      process.stdout.write(`${line}\n`);
    },
  };
}

/** Stderr sink: one JSON line per event on stderr. */
function defaultStderrSink(): AuthAuditSink {
  return {
    write(line: string) {
      process.stderr.write(`${line}\n`);
    },
  };
}

/**
 * File sink: appends one JSON line per event to the named
 * path. Uses synchronous append + newline so events are
 * durable on process exit. Wraps any I/O failure as a thrown
 * error so the caller can surface it.
 */
export function fileAuditSink(path: string): AuthAuditSink {
  return {
    write(line: string) {
      appendFileSync(path, `${line}\n`, { encoding: 'utf8' });
    },
  };
}

/**
 * Resolve the `--audit` flag value (parsed by `parseAuthFlags`)
 * to a concrete `AuthAuditSink`. Returns `undefined` when the
 * caller didn't pass `--audit` (no sink is wired and the
 * audit log is silent).
 *
 * Resolution rules:
 *   - `true` (bare `--audit`)         → stdout
 *   - `'stdout'`                       → stdout
 *   - `'stderr'`                       → stderr
 *   - `'<file-path>'`                  → append to the file
 *   - `undefined`                      → undefined (no sink)
 */
export function resolveAuditSink(flag: boolean | string | undefined): AuthAuditSink | undefined {
  if (flag === undefined) return undefined;
  if (flag === true || flag === 'stdout') return defaultStdoutSink();
  if (flag === 'stderr') return defaultStderrSink();
  // At this point, `flag` is narrowed to `string` — the
  // boolean literal `true` was handled above and the
  // `string` literals 'stdout' / 'stderr' are also handled.
  // The explicit `typeof` guard documents the narrowing for
  // the reader and silences a residual `boolean` in the
  // union (TS doesn't always narrow `boolean | string`
  // through `=== literal` chains).
  if (typeof flag !== 'string') return undefined;
  return fileAuditSink(flag);
}

/** In-memory sink for tests. Records every line verbatim. */
export function memAuthAuditSink(): AuthAuditSink & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    write(line: string) {
      lines.push(line);
    },
  };
}

export interface AuthAuditLogger {
  /** Emit an event. The payload is JSON-serialized, scrubbed,
   *  and written to the sink. No-ops when the sink is
   *  `undefined` (tests that don't care about the audit log
   *  can pass `audit: undefined`). */
  emit(event: AuthAuditEvent): void;
}

/** No-op logger for tests that don't need the audit log. */
export const NOOP_AUDIT_LOGGER: AuthAuditLogger = {
  emit: () => {},
};

/**
 * Build the canonical logger. The `scrubber` runs over the
 * serialized event so a Bearer token accidentally included
 * in a payload (e.g. an echo from a misbehaving server) is
 * redacted before reaching the sink.
 */
export function createAuthAuditLogger(
  sink: AuthAuditSink | undefined,
  scrubber: SecretScrubber = new DefaultSecretScrubber(),
): AuthAuditLogger {
  if (!sink) return NOOP_AUDIT_LOGGER;
  return {
    emit(event) {
      // Scrub first, then serialize. Scrubbing the object
      // directly is more reliable than scrubbing the
      // serialized line (a value could contain a quote that
      // looks like a credential when serialized).
      const scrubbed = scrubEvent(event, scrubber);
      sink.write(JSON.stringify(scrubbed));
    },
  };
}

/**
 * Run the scrubber over every string leaf of the event
 * payload. The `type` discriminator is left intact (it's a
 * contract, not data). Nested arrays (`models`,
 * `previousModels`, `restoredModels`) are scrubbed
 * element-by-element.
 */
function scrubEvent(event: AuthAuditEvent, scrubber: SecretScrubber): AuthAuditEvent {
  switch (event.type) {
    case 'auth.local.add':
      return {
        type: 'auth.local.add',
        providerId: scrubber.scrub(event.providerId),
        baseUrl: scrubber.scrub(event.baseUrl),
        models: event.models.map((m) => scrubber.scrub(m)),
        ...(event.keyLabel !== undefined ? { keyLabel: scrubber.scrub(event.keyLabel) } : {}),
      };
    case 'auth.local.clear':
      return {
        type: 'auth.local.clear',
        providerId: scrubber.scrub(event.providerId),
        baseUrl: scrubber.scrub(event.baseUrl),
        previousModels: event.previousModels.map((m) => scrubber.scrub(m)),
      };
    case 'auth.local.undo':
      return {
        type: 'auth.local.undo',
        providerId: scrubber.scrub(event.providerId),
        baseUrl: scrubber.scrub(event.baseUrl),
        restoredModels: event.restoredModels.map((m) => scrubber.scrub(m)),
      };
    case 'auth.local.probe_skip':
      return {
        type: 'auth.local.probe_skip',
        providerId: scrubber.scrub(event.providerId),
        baseUrl: scrubber.scrub(event.baseUrl),
        requestedShape: scrubber.scrub(event.requestedShape),
      };
    case 'auth.local.probe_failed_save':
      return {
        type: 'auth.local.probe_failed_save',
        providerId: scrubber.scrub(event.providerId),
        baseUrl: scrubber.scrub(event.baseUrl),
        probeStatus: scrubber.scrub(event.probeStatus),
        ...(event.probeDetail !== undefined
          ? { probeDetail: scrubber.scrub(event.probeDetail) }
          : {}),
      };
  }
}

/**
 * Decide which audit event(s) to emit given the previous saved
 * state and the new save's resolved values. Pure function —
 * the caller is responsible for the actual `emit()` call so
 * the same input always produces the same event list (and the
 * test suite can pin it).
 *
 *   - `previousModels` is `undefined` when no prior entry
 *     existed. `[]` means "the user previously cleared".
 *   - `newModels` is `null` when the `--model` flag wasn't
 *     passed (don't touch `cfg.models`). `[]` means "the user
 *     passed `--model ''` to clear". A non-empty list is the
 *     resolved list (probe-driven or literal).
 */
export function decideAuthLocalEvents(opts: {
  providerId: string;
  baseUrl: string;
  previousModels: string[] | undefined;
  newModels: string[] | null;
  keyLabel: string | undefined;
  probeSkip?: { shape: 'first' | string } | undefined;
  probeFailedSave?: { status: string; detail?: string } | undefined;
}): AuthAuditEvent[] {
  const events: AuthAuditEvent[] = [];

  // The probe-skip and probe-failed-save events are emitted
  // unconditionally when they apply (the caller decides based
  // on the runtime probe result).
  if (opts.probeSkip) {
    events.push({
      type: 'auth.local.probe_skip',
      providerId: opts.providerId,
      baseUrl: opts.baseUrl,
      requestedShape: opts.probeSkip.shape,
    });
  }
  if (opts.probeFailedSave) {
    events.push({
      type: 'auth.local.probe_failed_save',
      providerId: opts.providerId,
      baseUrl: opts.baseUrl,
      probeStatus: opts.probeFailedSave.status,
      ...(opts.probeFailedSave.detail !== undefined
        ? { probeDetail: opts.probeFailedSave.detail }
        : {}),
    });
  }

  // The add/clear/undo detection runs only when the user
  // actually wrote `models` (i.e. the --model flag was
  // passed). When the flag is omitted we don't change the
  // allowlist, so no lifecycle event.
  if (opts.newModels === null) return events;

  const hadPriorAllowlist = opts.previousModels !== undefined && opts.previousModels.length > 0;

  if (hadPriorAllowlist && opts.newModels.length === 0) {
    // Non-empty → empty: a clear.
    events.push({
      type: 'auth.local.clear',
      providerId: opts.providerId,
      baseUrl: opts.baseUrl,
      previousModels: opts.previousModels!,
    });
    return events;
  }

  if (!hadPriorAllowlist && opts.newModels.length > 0) {
    // No prior allowlist (either undefined or []) → non-empty
    // list: a fresh add OR an undo (we can't distinguish a
    // "user is configuring for the first time" add from a
    // "user just cleared and is now restoring" undo from
    // disk state alone — the only signal is the prior state
    // being literally [] vs. undefined).
    if (opts.previousModels !== undefined) {
      // prior was [] (or some other empty state we
      // collapsed). This is an undo.
      events.push({
        type: 'auth.local.undo',
        providerId: opts.providerId,
        baseUrl: opts.baseUrl,
        restoredModels: [...opts.newModels],
      });
    } else {
      events.push({
        type: 'auth.local.add',
        providerId: opts.providerId,
        baseUrl: opts.baseUrl,
        models: [...opts.newModels],
        ...(opts.keyLabel !== undefined ? { keyLabel: opts.keyLabel } : {}),
      });
    }
    return events;
  }

  if (hadPriorAllowlist && opts.newModels.length > 0) {
    // Non-empty → non-empty: the user is overwriting an
    // existing allowlist. Not strictly a clear+undo — emit a
    // plain add so the audit log records the new state.
    events.push({
      type: 'auth.local.add',
      providerId: opts.providerId,
      baseUrl: opts.baseUrl,
      models: [...opts.newModels],
      ...(opts.keyLabel !== undefined ? { keyLabel: opts.keyLabel } : {}),
    });
    return events;
  }

  // Both empty (no prior allowlist, --model ''): the user
  // explicitly cleared an already-empty allowlist. No-op
  // for the audit log — no state change.
  return events;
}
