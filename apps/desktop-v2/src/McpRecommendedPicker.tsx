import {
  OFFICIAL_SERVERS,
  type OfficialServer,
} from '@wrongstack/project-surfaces/lib/official-mcp-servers';
import { useDesktopText } from './desktop-i18n';

/**
 * The fields a recommended server carries beyond what the add dialog edits (its description,
 * fixed environment, tool allowlist and bearer-token variable), so adding it saves the same
 * configuration the WebUI's Recommended tab does.
 */
export function recommendedExtras(server: OfficialServer): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries({
      description: server.description,
      env: server.env,
      allowedTools: server.allowedTools,
      bearerTokenEnv: server.bearerTokenEnv,
    }).filter(([, value]) => value !== undefined),
  );
}

/**
 * Starts the add dialog from one of the WebUI's recommended MCP servers: picking one fills the
 * name, transport, URL or command and arguments, and says which environment variables it needs.
 * Servers already configured are listed but cannot be picked again.
 */
export function McpRecommendedPicker({
  added,
  picked,
  onPick,
}: {
  added: ReadonlySet<string>;
  picked: OfficialServer | null;
  onPick: (server: OfficialServer | null) => void;
}) {
  const { t } = useDesktopText();
  return (
    <>
      <label>
        {t('integrations.recommended.from')}
        <select
          aria-label={t('integrations.recommended.label')}
          value={picked?.name ?? ''}
          onChange={(event) =>
            onPick(OFFICIAL_SERVERS.find((server) => server.name === event.target.value) ?? null)
          }
        >
          <option value="">{t('integrations.recommended.custom')}</option>
          {OFFICIAL_SERVERS.map((server) => (
            <option key={server.name} value={server.name} disabled={added.has(server.name)}>
              {server.name}
              {server.badge ? ` · ${server.badge}` : ''}
              {added.has(server.name) ? ` (${t('integrations.recommended.added')})` : ''}
            </option>
          ))}
        </select>
      </label>
      {picked && (
        <p className="form-note">
          {picked.description}
          {picked.requiresEnvVars?.length
            ? ` ${t('integrations.recommended.needsEnv', { vars: picked.requiresEnvVars.join(', ') })}`
            : ''}
        </p>
      )}
    </>
  );
}
