import type { MailvelopeImportResult, MailvelopeKeyMap, MailvelopeKeyring, MailvelopeLookupResult } from './types';

/**
 * - `ready`: a key is already in the keyring.
 * - `importable`: no local key, but one was found (WKD, key server, Autocrypt)
 *   and can be imported with the user's consent inside Mailvelope.
 * - `missing`: no usable key anywhere Mailvelope looks.
 */
export type RecipientKeyState = 'ready' | 'importable' | 'missing';

export interface RecipientKeyStatus {
  address: string;
  state: RecipientKeyState;
  keys: MailvelopeLookupResult[];
}

/** `"Name" <a@b.c>` or `a@b.c` down to a lowercase `a@b.c`. */
export function bareAddress(recipient: string): string {
  const angled = /<([^<>]+)>\s*$/.exec(recipient);
  return (angled ? angled[1] : recipient).trim().toLowerCase();
}

export function uniqueAddresses(recipients: string[]): string[] {
  return [...new Set(recipients.map(bareAddress).filter(Boolean))];
}

export function classifyKeyMap(addresses: string[], keyMap: MailvelopeKeyMap): RecipientKeyStatus[] {
  return addresses.map((address) => {
    const entry = keyMap[address];
    const keys = entry ? entry.keys : [];
    if (keys.length === 0) return { address, state: 'missing', keys: [] };
    const state: RecipientKeyState = keys.some((key) => key.source === 'LOC') ? 'ready' : 'importable';
    return { address, state, keys };
  });
}

/**
 * Ask Mailvelope which of `recipients` have a usable key. Mailvelope may
 * consult WKD and key servers for addresses it has no local key for, so
 * callers should debounce and cache rather than call this per keystroke.
 */
export async function checkRecipientKeys(
  keyring: MailvelopeKeyring,
  recipients: string[],
): Promise<RecipientKeyStatus[]> {
  const addresses = uniqueAddresses(recipients);
  if (addresses.length === 0) return [];
  const keyMap = await keyring.validKeyForAddress(addresses);
  return classifyKeyMap(addresses, keyMap);
}

/**
 * Offer the found key to the user. Mailvelope shows its own confirmation
 * prompt, so nothing is added to the keyring without consent.
 */
export async function importRecipientKey(
  keyring: MailvelopeKeyring,
  status: RecipientKeyStatus,
): Promise<MailvelopeImportResult | null> {
  const candidate = status.keys.find((key) => key.armored);
  if (!candidate?.armored) return null;
  return keyring.importPublicKey(candidate.armored);
}
