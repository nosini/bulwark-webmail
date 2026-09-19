import { renderHook, act } from '@testing-library/react';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { useRecipientKeyStatus } from '../use-recipient-key-status';
import type { MailvelopeKeyMap, MailvelopeKeyring } from '@/lib/mailvelope/types';

const DEBOUNCE_MS = 600;

function keyringWith(validKeyForAddress: (addresses: string[]) => Promise<MailvelopeKeyMap>): MailvelopeKeyring {
  return { identifier: 'bulwark-webmail', validKeyForAddress: vi.fn(validKeyForAddress) } as unknown as MailvelopeKeyring;
}

/** Every address answers "no key", which is enough to see who was asked about. */
const noKeys = (addresses: string[]) =>
  Promise.resolve(Object.fromEntries(addresses.map((a) => [a, false])) as MailvelopeKeyMap);

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

async function settle(ms = DEBOUNCE_MS) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe('useRecipientKeyStatus', () => {
  it('does not look up an address that is still being typed', async () => {
    const keyring = keyringWith(noKeys);
    const { rerender } = renderHook(({ to }) => useRecipientKeyStatus(true, keyring, to), {
      initialProps: { to: ['b'] },
    });

    // A pause long enough to fire the debounce at every stage of typing.
    for (const partial of ['bo', 'bob', 'bob@', 'bob@exa', 'bob@example']) {
      rerender({ to: [partial] });
      await settle();
    }
    expect(keyring.validKeyForAddress).not.toHaveBeenCalled();

    rerender({ to: ['bob@example.org'] });
    await settle();
    expect(keyring.validKeyForAddress).toHaveBeenCalledTimes(1);
    expect(keyring.validKeyForAddress).toHaveBeenCalledWith(['bob@example.org']);
  });

  it('reports a half-typed address as missing rather than checking forever', async () => {
    const keyring = keyringWith(noKeys);
    const { result } = renderHook(() => useRecipientKeyStatus(true, keyring, ['bob@exa']));
    await settle();

    expect(keyring.validKeyForAddress).not.toHaveBeenCalled();
    expect(result.current.checking).toBe(false);
    expect(result.current.statuses).toEqual([{ address: 'bob@exa', state: 'missing', keys: [] }]);
  });

  it('keeps an in-flight answer when the recipients change underneath it', async () => {
    let release: (map: MailvelopeKeyMap) => void = () => {};
    const keyring = keyringWith((addresses) => {
      if (addresses.includes('alice@example.com')) return new Promise((r) => { release = r; });
      return noKeys(addresses);
    });

    const { result, rerender } = renderHook(({ to }) => useRecipientKeyStatus(true, keyring, to), {
      initialProps: { to: ['alice@example.com'] },
    });
    await settle();
    expect(keyring.validKeyForAddress).toHaveBeenCalledTimes(1);

    // A second recipient arrives while the first lookup is still in flight.
    rerender({ to: ['alice@example.com', 'bob@example.org'] });
    await act(async () => {
      release({ 'alice@example.com': false });
      await Promise.resolve();
    });
    await settle();

    // The superseded answer was kept, so only bob is asked about the second time.
    const asked = (keyring.validKeyForAddress as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(asked).toEqual([['alice@example.com'], ['bob@example.org']]);
    expect(result.current.checking).toBe(false);
    expect(result.current.statuses.map((s) => s.address)).toEqual(['alice@example.com', 'bob@example.org']);
  });
});
