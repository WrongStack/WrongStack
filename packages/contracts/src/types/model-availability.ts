/** One recurring provider/model availability window from `config.modelAvailabilitySchedule`. */
export interface ModelBlackoutRule {
  id: string;
  enabled?: boolean | undefined;
  provider?: string | undefined;
  model?: string | undefined;
  /** JavaScript weekday numbers: Sunday=0 … Saturday=6. Empty means every day. */
  days?: number[] | undefined;
  /** Inclusive local start, HH:mm. */
  start: string;
  /** Exclusive local end, HH:mm. Equal to start means all day. */
  end: string;
  /** IANA timezone. Defaults to the host timezone. */
  timezone?: string | undefined;
  label?: string | undefined;
  /** `blackout`: deny inside. `allow_only`: deny outside all matching allow windows. */
  mode?: 'blackout' | 'allow_only' | undefined;
}
