import { useSurfaceHost } from '../host';
import type { SetupHost } from './setup-host';

/** The host's first-run setup; it renders only where an application provides one. */
export function useSetupHost(): SetupHost {
  const setup = useSurfaceHost().setup;
  if (!setup) throw new Error('The setup screen rendered without a setup host.');
  return setup;
}
