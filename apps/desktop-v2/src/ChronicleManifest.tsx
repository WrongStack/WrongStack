import type { ManifestView } from './chronicle-manifest';

const shown = (value: number | null) => (value === null ? 'not recorded' : value.toLocaleString());
const short = (hash: string) => (hash ? hash.slice(0, 12) : '—');

/** What a provider request sent, from the manifest Chronicle recorded for it. */
export function ChronicleManifest({ manifest }: { manifest: ManifestView }) {
  const { system, tools } = manifest;
  return (
    <section className="chronicle-manifest" aria-label="Prompt manifest">
      <h3>Prompt manifest</h3>
      <dl>
        <div>
          <dt>Messages</dt>
          <dd>{shown(manifest.messageCount)}</dd>
        </div>
        <div>
          <dt>Message tokens (engine estimate)</dt>
          <dd>{shown(manifest.estimatedMessageTokens)}</dd>
        </div>
        <div>
          <dt>Content bytes</dt>
          <dd>{shown(manifest.contentBytes)}</dd>
        </div>
        <div>
          <dt>Roles</dt>
          <dd>
            {manifest.roles.map(([role, value]) => `${role} ${value}`).join(' · ') ||
              'not recorded'}
          </dd>
        </div>
        <div>
          <dt>Blocks</dt>
          <dd>
            {manifest.blockKinds.map(([kind, value]) => `${kind} ${value}`).join(' · ') ||
              'not recorded'}
          </dd>
        </div>
      </dl>
      <h4>
        System prompt · {shown(system.blockCount)} blocks · {shown(system.bytes)} bytes ·{' '}
        <code title={system.hash}>{short(system.hash)}</code>
      </h4>
      {system.blocks ? (
        <table aria-label="System prompt composition">
          <thead>
            <tr>
              <th scope="col">Layer</th>
              <th scope="col">Bytes</th>
              <th scope="col">Hash</th>
            </tr>
          </thead>
          <tbody>
            {system.blocks.map((block, index) => (
              <tr key={`${index}-${block.hash}`}>
                <td>{block.source}</td>
                <td>{shown(block.bytes)}</td>
                <td>
                  <code title={block.hash}>{short(block.hash)}</code>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="field-help">
          This manifest predates per-block system composition, so only the total is recorded.
        </p>
      )}
      <h4>
        Tools · {shown(tools.count)} · {shown(tools.estimatedDefinitionTokens)} definition tokens
        (engine estimate) · {shown(tools.mutating)} mutating · {shown(tools.destructive)}{' '}
        destructive
      </h4>
      {tools.names ? (
        <p className="chronicle-manifest-tools">{tools.names.join(', ') || 'No tools offered.'}</p>
      ) : (
        <p className="field-help">
          Tool names were recorded on an earlier request with the same tool set (
          <code title={tools.namesRef || tools.manifestHash}>
            {short(tools.namesRef || tools.manifestHash)}
          </code>
          ).
        </p>
      )}
      <h4>Messages{manifest.messagesOmitted ? ' (most recent)' : ''}</h4>
      {manifest.messagesOmitted > 0 && (
        <p className="field-help">
          {manifest.messagesOmitted.toLocaleString()} earlier messages are not itemised; the
          manifest ID still covers them.
        </p>
      )}
      <table aria-label="Manifest messages">
        <thead>
          <tr>
            <th scope="col">#</th>
            <th scope="col">Role</th>
            <th scope="col">Bytes</th>
            <th scope="col">Tokens (estimate)</th>
            <th scope="col">Hash</th>
          </tr>
        </thead>
        <tbody>
          {manifest.messages.map((message, index) => (
            <tr key={`${message.index ?? index}-${message.hash}`}>
              <td>{shown(message.index)}</td>
              <td>{message.role}</td>
              <td>{shown(message.bytes)}</td>
              <td>{shown(message.estimatedTokens)}</td>
              <td>
                <code title={message.hash}>{short(message.hash)}</code>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <small>
        Manifest <code>{manifest.manifestId}</code>
      </small>
    </section>
  );
}
