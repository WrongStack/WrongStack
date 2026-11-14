/**
 * The WebUI Settings plugin installer: adds or removes a plugin through the engine's
 * `/plugin` command, never passes an option along (`--install` would run a package manager),
 * and shows the command's own message or error.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PluginInstaller, pluginSpec } from '../../src/components/SettingsPanel/PluginInstaller';

const rpc = vi.hoisted(() => vi.fn());
vi.mock('@/lib/portable-command-rpc', () => ({ invokePortableCommand: rpc }));
vi.mock('@/i18n', () => ({ useAppTranslation: () => ({ t: (key: string) => key }) }));

const field = () => screen.getByLabelText('settings:context.pluginInstaller.placeholder');
const click = (key: string) =>
  fireEvent.click(screen.getByRole('button', { name: new RegExp(key.replace(/\./g, '\\.')) }));

beforeEach(() => rpc.mockReset());
afterEach(cleanup);

describe('PluginInstaller', () => {
  it('accepts aliases and package names, never options or spaces', () => {
    expect(pluginSpec(' telegram ')).toBe('telegram');
    expect(pluginSpec('@scope/pkg-name.v2')).toBe('@scope/pkg-name.v2');
    expect(pluginSpec('--install')).toBeUndefined();
    expect(pluginSpec('telegram --install')).toBeUndefined();
    expect(pluginSpec('')).toBeUndefined();
  });

  it('installs and removes by name and shows the engine message', async () => {
    rpc.mockResolvedValue({ message: 'Added telegram. Restart to load it.' });
    render(<PluginInstaller />);
    fireEvent.change(field(), { target: { value: ' telegram ' } });
    click('settings:context.pluginInstaller.install');
    expect(await screen.findByText('Added telegram. Restart to load it.')).toBeTruthy();
    expect(rpc).toHaveBeenLastCalledWith('plugin', 'install telegram', { timeoutMs: 20_000 });

    click('settings:context.pluginInstaller.remove');
    await waitFor(() =>
      expect(rpc).toHaveBeenLastCalledWith('plugin', 'remove telegram', { timeoutMs: 20_000 }),
    );
  });

  it('refuses an option before anything reaches the engine', () => {
    render(<PluginInstaller />);
    fireEvent.change(field(), { target: { value: 'evil --install' } });
    click('settings:context.pluginInstaller.install');
    expect(screen.getByRole('alert').textContent).toBe(
      'settings:context.pluginInstaller.specInvalid',
    );
    expect(rpc).not.toHaveBeenCalled();
  });

  it('lists configured and official plugins and shows a command error', async () => {
    rpc.mockResolvedValueOnce({ message: 'secret-scanner  enabled' });
    render(<PluginInstaller />);
    click('settings:context.pluginInstaller.showConfigured');
    expect(
      await screen.findByText('secret-scanner enabled', {
        normalizer: (t) => t.replace(/\s+/g, ' '),
      }),
    ).toBeTruthy();
    expect(rpc).toHaveBeenLastCalledWith('plugin', 'list', { timeoutMs: 20_000 });

    rpc.mockResolvedValueOnce({ error: 'Timed out waiting for /plugin response.' });
    click('settings:context.pluginInstaller.showOfficial');
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Timed out waiting for /plugin response.',
    );
    expect(rpc).toHaveBeenLastCalledWith('plugin', 'official', { timeoutMs: 20_000 });
  });
});
