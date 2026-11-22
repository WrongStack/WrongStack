import { useEffect, useRef, useState } from 'react';

/**
 * The settings section to open first. needsSetup is only known once the profile engine has
 * reported (connected); before that the engine state reads needsSetup: true, so the choice
 * waits for the report instead of sending a configured profile to Quick setup.
 */
export function useInitialSettingsSection({
  connected,
  needsSetup,
}: {
  connected: boolean;
  needsSetup: boolean;
}) {
  const [section, setSection] = useState(() => (connected && needsSetup ? 'setup' : 'providers'));
  const settled = useRef(connected);
  useEffect(() => {
    if (!connected || settled.current) return;
    settled.current = true;
    // Only the untouched default moves; a section the user opened meanwhile stays.
    if (needsSetup) setSection((current) => (current === 'providers' ? 'setup' : current));
  }, [connected, needsSetup]);
  return [section, setSection] as const;
}
