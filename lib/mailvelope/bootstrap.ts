import type { MailvelopeApi, MailvelopeError, MailvelopeKeyring } from './types';

/**
 * Identifier of the keyring Bulwark uses inside Mailvelope. Mailvelope already
 * scopes API keyrings to the calling site, so a fixed name is stable across
 * Stalwart mount prefixes and does not depend on the page's origin string.
 */
export const MAILVELOPE_KEYRING_ID = 'bulwark-webmail';

/**
 * How long to wait for the extension to announce itself. It injects
 * `window.mailvelope` only on origins the user authorized, so on every other
 * setup nothing ever arrives and this is the price of finding that out.
 */
export const MAILVELOPE_DETECT_TIMEOUT_MS = 3000;

let readyPromise: Promise<MailvelopeApi | null> | null = null;

/**
 * Singleton "Mailvelope is ready" promise. Resolves with the API when
 * `window.mailvelope` exists or the `mailvelope` event fires, and with `null`
 * once the timeout elapses (extension missing, or origin not authorized).
 * Never rejects and never logs, so an absent extension leaves no trace.
 */
export function whenMailvelopeReady(timeoutMs: number = MAILVELOPE_DETECT_TIMEOUT_MS): Promise<MailvelopeApi | null> {
  if (typeof window === 'undefined') return Promise.resolve(null);
  if (readyPromise) return readyPromise;

  readyPromise = new Promise<MailvelopeApi | null>((resolve) => {
    if (window.mailvelope) {
      resolve(window.mailvelope);
      return;
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    const onReady = (event: Event) => {
      if (timer) clearTimeout(timer);
      const detail = (event as CustomEvent<MailvelopeApi | undefined>).detail;
      resolve(window.mailvelope ?? detail ?? null);
    };
    window.addEventListener('mailvelope', onReady, { once: true });
    timer = setTimeout(() => {
      window.removeEventListener('mailvelope', onReady);
      resolve(null);
    }, timeoutMs);
  });
  return readyPromise;
}

/** Forget the cached detection result. Tests only. */
export function resetMailvelopeReadyForTests(): void {
  readyPromise = null;
}

function errorCode(err: unknown): string | undefined {
  return (err as MailvelopeError | undefined)?.code;
}

/** Fetch the app keyring, creating it on first use. */
export async function getOrCreateKeyring(
  api: MailvelopeApi,
  identifier: string = MAILVELOPE_KEYRING_ID,
): Promise<MailvelopeKeyring> {
  try {
    return await api.getKeyring(identifier);
  } catch (err) {
    if (errorCode(err) !== 'NO_KEYRING_FOR_ID') throw err;
  }
  try {
    return await api.createKeyring(identifier);
  } catch (err) {
    // Another tab created it between the two calls.
    if (errorCode(err) === 'KEYRING_ALREADY_EXISTS') return api.getKeyring(identifier);
    throw err;
  }
}
