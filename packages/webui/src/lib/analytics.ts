import { useCallback } from 'react';

export interface AnalyticsEvent {
  event: string;
  category: string;
  label?: string | undefined;
  value?: number | undefined;
  metadata?: Record<string, unknown> | undefined;
  timestamp: string;
}

const ANALYTICS_QUEUE: AnalyticsEvent[] = [];
const MAX_QUEUE_SIZE = 100;

/** Interval (ms) between automatic flushes to the backend. */
const FLUSH_INTERVAL_MS = 30_000;
/** Minimum number of events before a flush is triggered. */
const MIN_FLUSH_SIZE = 5;

let flushTimer: ReturnType<typeof setInterval> | null = null;
let isFlushing = false;

function enqueueEvent(event: AnalyticsEvent): void {
  ANALYTICS_QUEUE.push(event);
  if (ANALYTICS_QUEUE.length > MAX_QUEUE_SIZE) {
    ANALYTICS_QUEUE.shift();
  }

  // Auto-flush when we hit the threshold
  if (ANALYTICS_QUEUE.length >= MIN_FLUSH_SIZE && !isFlushing) {
    flushAnalytics();
  }
}

/** Flush the analytics queue to the backend. */
export async function flushAnalytics(): Promise<void> {
  if (isFlushing || ANALYTICS_QUEUE.length === 0) return;

  isFlushing = true;
  const events = ANALYTICS_QUEUE.splice(0, ANALYTICS_QUEUE.length);

  try {
    const res = await fetch('/api/analytics', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(events),
    });

    if (!res.ok) {
      // Re-queue events on failure so they can be retried
      ANALYTICS_QUEUE.unshift(...events);
      if (ANALYTICS_QUEUE.length > MAX_QUEUE_SIZE) {
        ANALYTICS_QUEUE.length = MAX_QUEUE_SIZE;
      }
    }

    // Log result in development
    if (typeof __DEV__ !== 'undefined' && __DEV__) {
      const result = await res.json().catch(() => ({ accepted: 0, rejected: 0 }));
      console.log('[Analytics] Flushed', result.accepted, 'events, rejected', result.rejected);
    }
  } catch {
    // Re-queue events on network failure
    ANALYTICS_QUEUE.unshift(...events);
    if (ANALYTICS_QUEUE.length > MAX_QUEUE_SIZE) {
      ANALYTICS_QUEUE.length = MAX_QUEUE_SIZE;
    }
  } finally {
    isFlushing = false;
  }
}

/** Start the periodic flush timer. Call once on app init. */
export function startAnalyticsFlush(): void {
  if (flushTimer) return;
  flushTimer = setInterval(() => {
    if (ANALYTICS_QUEUE.length > 0) {
      flushAnalytics();
    }
  }, FLUSH_INTERVAL_MS);
}

/** Stop the periodic flush timer. Call on app teardown. */
export function stopAnalyticsFlush(): void {
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
}

export function trackEvent(
  event: string,
  category: string,
  options?: {
    label?: string;
    value?: number;
    metadata?: Record<string, unknown>;
  },
): void {
  const analyticsEvent: AnalyticsEvent = {
    event,
    category,
    label: options?.label,
    value: options?.value,
    metadata: options?.metadata,
    timestamp: new Date().toISOString(),
  };

  enqueueEvent(analyticsEvent);

  // Also log to console in development
  if (typeof __DEV__ !== 'undefined' && __DEV__) {
    console.log('[Analytics]', analyticsEvent);
  }
}

export function useAnalytics() {
  const track = useCallback(
    (
      event: string,
      category: string,
      options?: {
        label?: string;
        value?: number;
        metadata?: Record<string, unknown>;
      },
    ) => {
      trackEvent(event, category, options);
    },
    [],
  );

  return { track };
}

export function getAnalyticsQueue(): readonly AnalyticsEvent[] {
  return [...ANALYTICS_QUEUE];
}

export function clearAnalyticsQueue(): void {
  ANALYTICS_QUEUE.length = 0;
}

// ── Referral Click Tracking ──────────────────────────────────────────────────

const REFERRAL_CLICK_KEY = 'wrongstack_referral_click';

interface ReferralClickData {
  providerId: string;
  providerName: string;
  referralCode: string;
  clickedAt: string;
  docsUrl: string;
}

/** Record that a user clicked on a referral link. Call from the docs link onClick. */
export function recordReferralClick(data: ReferralClickData): void {
  try {
    sessionStorage.setItem(REFERRAL_CLICK_KEY, JSON.stringify(data));
  } catch {
    // sessionStorage may be unavailable (private mode, etc.)
  }

  trackEvent('referral_link_clicked', 'engagement', {
    label: data.providerName,
    metadata: {
      providerId: data.providerId,
      referralCode: data.referralCode,
      docsUrl: data.docsUrl,
    },
  });
}

/** Check if a referral click was recorded and return it (for conversion tracking). */
export function getReferralClick(): ReferralClickData | null {
  try {
    const raw = sessionStorage.getItem(REFERRAL_CLICK_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as ReferralClickData;
  } catch {
    return null;
  }
}

/** Clear the recorded referral click. Call after tracking conversion or on session end. */
export function clearReferralClick(): void {
  try {
    sessionStorage.removeItem(REFERRAL_CLICK_KEY);
  } catch {
    // sessionStorage may be unavailable
  }
}

/** Track a referral conversion (API key saved after clicking referral link). */
export function trackReferralConversion(providerId: string, providerName: string): void {
  const click = getReferralClick();
  if (click && click.providerId === providerId) {
    const timeToConvert = Date.now() - new Date(click.clickedAt).getTime();

    trackEvent('referral_converted', 'conversion', {
      label: providerName,
      value: Math.round(timeToConvert / 1000), // seconds to convert
      metadata: {
        providerId,
        referralCode: click.referralCode,
        timeToConvertMs: timeToConvert,
        clickedAt: click.clickedAt,
      },
    });

    clearReferralClick();
  }
}
