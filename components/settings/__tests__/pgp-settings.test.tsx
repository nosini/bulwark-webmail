import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgpSettings } from '../pgp-settings';

const mv = vi.hoisted(() => ({
  createSettingsContainer: vi.fn(),
  openSettings: vi.fn(),
  hasContainerApi: true,
}));

vi.mock('@/stores/mailvelope-store', () => {
  const keyring = { identifier: 'k', openSettings: (...a: unknown[]) => mv.openSettings(...a) };
  const state = () => ({
    api: mv.hasContainerApi ? { createSettingsContainer: (...a: unknown[]) => mv.createSettingsContainer(...a) } : {},
    keyring,
    version: '6.3.0',
  });
  const hook = (sel?: (s: ReturnType<typeof state>) => unknown) => (typeof sel === 'function' ? sel(state()) : state());
  hook.getState = state;
  return { useMailvelopeStore: hook };
});

vi.mock('@/stores/identity-store', () => {
  const state = { identities: [{ id: 'i1', email: 'me@example.com', name: 'Me Myself <me@example.com>' }] };
  const hook = (sel?: (s: typeof state) => unknown) => (typeof sel === 'function' ? sel(state) : state);
  return { useIdentityStore: hook };
});

vi.mock('@/stores/toast-store', () => ({ toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() } }));

beforeEach(() => {
  mv.hasContainerApi = true;
  mv.createSettingsContainer.mockReset().mockResolvedValue(undefined);
  mv.openSettings.mockReset().mockResolvedValue(undefined);
});

describe('PgpSettings', () => {
  it('embeds the extension key manager, prefilled with the sender identity, and shows the connected version', async () => {
    render(<PgpSettings />);
    await waitFor(() => expect(mv.createSettingsContainer).toHaveBeenCalledTimes(1));

    const [selector, keyring, options] = mv.createSettingsContainer.mock.calls[0];
    expect(selector).toMatch(/^#mailvelope-host-\d+$/);
    expect(keyring).toMatchObject({ identifier: 'k' });
    // Identity names come back as "Name <addr>"; only the name is a name.
    expect(options).toEqual({ email: 'me@example.com', fullName: 'Me Myself' });
    expect(screen.getByText('status_connected')).toBeInTheDocument();
    expect(screen.getByTestId('pgp-settings-frame')).not.toHaveAttribute('hidden');
  });

  it('falls back to the settings button when the deprecated container is gone', async () => {
    mv.hasContainerApi = false;
    render(<PgpSettings />);
    expect(await screen.findByText('keys_embed_failed')).toBeInTheDocument();
    expect(mv.createSettingsContainer).not.toHaveBeenCalled();
    expect(screen.getByTestId('pgp-settings-frame')).toHaveAttribute('hidden');
  });

  it('falls back when the container fails to load', async () => {
    mv.createSettingsContainer.mockRejectedValue(new Error('boom'));
    render(<PgpSettings />);
    expect(await screen.findByText('keys_embed_failed')).toBeInTheDocument();
  });

  it('opens the extension settings in its own tab', async () => {
    render(<PgpSettings />);
    fireEvent.click(screen.getByText('open_settings'));
    await waitFor(() => expect(mv.openSettings).toHaveBeenCalledTimes(1));
  });
});
