import { ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { createPortal } from 'react-dom';
import { useDesktopText } from './desktop-i18n';
import type { EngineCommand } from './engine-operations';
import type { EngineState } from './engine-state';
import { SessionPermissionRules } from './SessionPermissionRules';

/**
 * The composer options menu's entry for the conversation's permission rules. The dialog is
 * rendered into the document body: the menu is a `<details>` that closes on a click, and a
 * dialog left inside it would close and vanish with it.
 */
export function SessionPermissionsOption({
  state,
  command,
}: {
  state: EngineState;
  command: EngineCommand;
}) {
  const { t } = useDesktopText();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        disabled={!state.connected || !state.sessionId}
        onClick={(event) => {
          event.currentTarget.closest('details')?.removeAttribute('open');
          setOpen(true);
        }}
      >
        <ShieldCheck size={14} />
        {t('sessionPermissions.menu')}
      </button>
      {open &&
        state.sessionId &&
        createPortal(
          <SessionPermissionRules
            command={command}
            sessionId={state.sessionId}
            onClose={() => setOpen(false)}
          />,
          document.body,
        )}
    </>
  );
}
