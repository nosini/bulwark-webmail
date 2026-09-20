import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAILVELOPE_DETECT_TIMEOUT_MS,
  MAILVELOPE_KEYRING_ID,
  getOrCreateKeyring,
  onMailvelopeArrival,
  resetMailvelopeReadyForTests,
  whenMailvelopeReady,
} from '@/lib/mailvelope/bootstrap';
import { resetMailvelopeStoreForTests, selectPgpAvailable, useMailvelopeStore } from '@/stores/mailvelope-store';
import type { MailvelopeApi, MailvelopeKeyring } from '@/lib/mailvelope/types';

const keyring = { identifier: MAILVELOPE_KEYRING_ID } as MailvelopeKeyring;

function coded(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

function fakeApi(over: Partial<MailvelopeApi> = {}): MailvelopeApi {
  return {
    getVersion: vi.fn().mockResolvedValue('6.3.0'),
    getKeyring: vi.fn().mockResolvedValue(keyring),
    createKeyring: vi.fn().mockResolvedValue(keyring),
    createDisplayContainer: vi.fn(),
    createEditorContainer: vi.fn(),
    ...over,
  } as MailvelopeApi;
}

beforeEach(() => {
  vi.useFakeTimers();
  resetMailvelopeReadyForTests();
  resetMailvelopeStoreForTests();
  delete window.mailvelope;
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete window.mailvelope;
});

describe('whenMailvelopeReady', () => {
  it('resolves at once when window.mailvelope already exists', async () => {
    const api = fakeApi();
    window.mailvelope = api;
    await expect(whenMailvelopeReady()).resolves.toBe(api);
  });

  it('resolves when the extension announces itself with the mailvelope event', async () => {
    const pending = whenMailvelopeReady();
    const api = fakeApi();
    window.mailvelope = api;
    window.dispatchEvent(new CustomEvent('mailvelope', { detail: api }));
    await expect(pending).resolves.toBe(api);
  });

  it('falls back to the event detail when the global is not set', async () => {
    const pending = whenMailvelopeReady();
    const api = fakeApi();
    window.dispatchEvent(new CustomEvent('mailvelope', { detail: api }));
    await expect(pending).resolves.toBe(api);
  });

  it('gives up with null after the timeout, silently', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warns = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    const pending = whenMailvelopeReady();
    await vi.advanceTimersByTimeAsync(MAILVELOPE_DETECT_TIMEOUT_MS);
    await expect(pending).resolves.toBeNull();
    expect(errors).not.toHaveBeenCalled();
    expect(warns).not.toHaveBeenCalled();
    expect(logs).not.toHaveBeenCalled();
  });

  it('is a singleton, and an extension appearing unannounced does not reopen it', async () => {
    const first = whenMailvelopeReady();
    expect(whenMailvelopeReady()).toBe(first);
    await vi.advanceTimersByTimeAsync(MAILVELOPE_DETECT_TIMEOUT_MS);
    await expect(first).resolves.toBeNull();
    // Setting the global without announcing it is not something the extension
    // does; only the event drops the cached answer.
    window.mailvelope = fakeApi();
    await expect(whenMailvelopeReady()).resolves.toBeNull();
  });
});

describe('onMailvelopeArrival', () => {
  it('drops a timed-out result so the next detection sees the extension', async () => {
    const listener = vi.fn();
    const stop = onMailvelopeArrival(listener);
    const timedOut = whenMailvelopeReady();
    await vi.advanceTimersByTimeAsync(MAILVELOPE_DETECT_TIMEOUT_MS);
    await expect(timedOut).resolves.toBeNull();

    const api = fakeApi();
    window.mailvelope = api;
    window.dispatchEvent(new CustomEvent('mailvelope', { detail: api }));

    expect(listener).toHaveBeenCalledTimes(1);
    await expect(whenMailvelopeReady()).resolves.toBe(api);
    stop();
  });

  it('stops calling back once unsubscribed', () => {
    const listener = vi.fn();
    onMailvelopeArrival(listener)();
    window.dispatchEvent(new CustomEvent('mailvelope', { detail: fakeApi() }));
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('getOrCreateKeyring', () => {
  it('returns an existing keyring without creating one', async () => {
    const api = fakeApi();
    await expect(getOrCreateKeyring(api)).resolves.toBe(keyring);
    expect(api.getKeyring).toHaveBeenCalledWith(MAILVELOPE_KEYRING_ID);
    expect(api.createKeyring).not.toHaveBeenCalled();
  });

  it('creates it lazily on NO_KEYRING_FOR_ID', async () => {
    const api = fakeApi({ getKeyring: vi.fn().mockRejectedValue(coded('NO_KEYRING_FOR_ID')) });
    await expect(getOrCreateKeyring(api)).resolves.toBe(keyring);
    expect(api.createKeyring).toHaveBeenCalledWith(MAILVELOPE_KEYRING_ID);
  });

  it('re-fetches when another tab created it first', async () => {
    const getKeyring = vi.fn().mockRejectedValueOnce(coded('NO_KEYRING_FOR_ID')).mockResolvedValueOnce(keyring);
    const api = fakeApi({ getKeyring, createKeyring: vi.fn().mockRejectedValue(coded('KEYRING_ALREADY_EXISTS')) });
    await expect(getOrCreateKeyring(api)).resolves.toBe(keyring);
    expect(getKeyring).toHaveBeenCalledTimes(2);
  });

  it('propagates any other error', async () => {
    const api = fakeApi({ getKeyring: vi.fn().mockRejectedValue(coded('NO_CONNECTION')) });
    await expect(getOrCreateKeyring(api)).rejects.toMatchObject({ code: 'NO_CONNECTION' });
  });
});

describe('mailvelope store', () => {
  it('reports pgpAvailable once the keyring is ready', async () => {
    window.mailvelope = fakeApi();
    await useMailvelopeStore.getState().init();
    const state = useMailvelopeStore.getState();
    expect(state.status).toBe('ready');
    expect(state.keyring).toBe(keyring);
    expect(state.version).toBe('6.3.0');
    expect(selectPgpAvailable(state)).toBe(true);
  });

  it('stays unavailable, with no console output, when the extension is absent', async () => {
    const spies = (['error', 'warn', 'log'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    const init = useMailvelopeStore.getState().init();
    await vi.advanceTimersByTimeAsync(MAILVELOPE_DETECT_TIMEOUT_MS);
    await init;
    const state = useMailvelopeStore.getState();
    expect(state.status).toBe('unavailable');
    expect(selectPgpAvailable(state)).toBe(false);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it('degrades to unavailable, quietly, when the keyring cannot be obtained', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    window.mailvelope = fakeApi({ getKeyring: vi.fn().mockRejectedValue(coded('NO_CONNECTION')) });
    await useMailvelopeStore.getState().init();
    expect(selectPgpAvailable(useMailvelopeStore.getState())).toBe(false);
    expect(errors).not.toHaveBeenCalled();
  });

  it('init is idempotent', async () => {
    const api = fakeApi();
    window.mailvelope = api;
    await Promise.all([useMailvelopeStore.getState().init(), useMailvelopeStore.getState().init()]);
    expect(api.getKeyring).toHaveBeenCalledTimes(1);
  });

  it('turns unavailable again when the extension disconnects', async () => {
    window.mailvelope = fakeApi();
    await useMailvelopeStore.getState().init();
    window.dispatchEvent(new Event('mailvelope-disconnect'));
    expect(selectPgpAvailable(useMailvelopeStore.getState())).toBe(false);
  });

  it('picks up an extension that announces itself after detection gave up', async () => {
    const init = useMailvelopeStore.getState().init();
    await vi.advanceTimersByTimeAsync(MAILVELOPE_DETECT_TIMEOUT_MS);
    await init;
    expect(useMailvelopeStore.getState().status).toBe('unavailable');

    const api = fakeApi();
    window.mailvelope = api;
    window.dispatchEvent(new CustomEvent('mailvelope', { detail: api }));
    await vi.advanceTimersByTimeAsync(0);

    const state = useMailvelopeStore.getState();
    expect(state.status).toBe('ready');
    expect(selectPgpAvailable(state)).toBe(true);
  });

  it('comes back when the extension reconnects after a disconnect', async () => {
    window.mailvelope = fakeApi();
    await useMailvelopeStore.getState().init();
    window.dispatchEvent(new Event('mailvelope-disconnect'));
    expect(selectPgpAvailable(useMailvelopeStore.getState())).toBe(false);

    // An update finished and the content script injected itself again.
    const api = fakeApi();
    window.mailvelope = api;
    window.dispatchEvent(new CustomEvent('mailvelope', { detail: api }));
    await vi.advanceTimersByTimeAsync(0);

    expect(selectPgpAvailable(useMailvelopeStore.getState())).toBe(true);
    expect(useMailvelopeStore.getState().api).toBe(api);
  });

  it('ignores an announcement while it is already ready', async () => {
    const api = fakeApi();
    window.mailvelope = api;
    await useMailvelopeStore.getState().init();
    window.dispatchEvent(new CustomEvent('mailvelope', { detail: api }));
    await vi.advanceTimersByTimeAsync(0);
    expect(api.getKeyring).toHaveBeenCalledTimes(1);
  });
});
