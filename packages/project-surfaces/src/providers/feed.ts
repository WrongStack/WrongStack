import { useSurfaceHost } from '../host';
import type { ProviderHost } from './provider-host';

/** The host's provider surfaces; they render only where an application provides them. */
export function useProviderHost(): ProviderHost {
  const providers = useSurfaceHost().providers;
  if (!providers) throw new Error('A provider surface rendered without a provider host.');
  return providers;
}
