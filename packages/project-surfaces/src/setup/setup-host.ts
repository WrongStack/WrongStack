import type { ProviderClient } from '../providers/provider-host';

/** The outcome of making a provider and model the profile's default. */
export interface SetupModelResult {
  success: boolean;
  message?: string | undefined;
}

/** What the first-run setup reads and does, fed by each application. */
export interface SetupHost {
  /** The profile connection; null until the application has one. */
  useClient(): ProviderClient | null;
  useConnected(): boolean;
  /** The model the profile uses now, preselected when its provider's list arrives. */
  useCurrentModel(): string;
  notify: { success(message: string): void; error(message: string): void };
  /**
   * Where an updated popular-provider list is read from, in order; the list built into the
   * application is used when none answers.
   */
  popularSources?: (() => readonly string[]) | undefined;
  /**
   * Makes the provider and model the profile's default. With `start`, the application then
   * begins a conversation with them; without it, the user returns to where they were.
   */
  chooseModel(provider: string, model: string, start: boolean): Promise<SetupModelResult>;
}
