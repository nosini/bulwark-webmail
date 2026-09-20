// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { encryptAndBuildMessage, pgpErrorMessageKey } from '@/lib/mailvelope/compose';
import { bareAddress, checkRecipientKeys, classifyKeyMap, importRecipientKey, uniqueAddresses } from '@/lib/mailvelope/recipients';
import type { MailvelopeEditor, MailvelopeKeyMap, MailvelopeKeyring, MailvelopeLookupResult } from '@/lib/mailvelope/types';

const ARMOR = ['-----BEGIN PGP MESSAGE-----', '', 'hQEMA1Vn7c1u8bVh', '=AbCd', '-----END PGP MESSAGE-----'].join('\n');

const key = (source: string, armored?: string): MailvelopeLookupResult => ({
  fingerprint: 'f'.repeat(40),
  lastModified: new Date(0),
  source,
  ...(armored ? { armored } : {}),
});

function fakeKeyring(keyMap: MailvelopeKeyMap): MailvelopeKeyring {
  return {
    identifier: 'k',
    validKeyForAddress: vi.fn(async (addrs: string[]) => Object.fromEntries(addrs.map((a) => [a, keyMap[a] ?? false]))),
    importPublicKey: vi.fn().mockResolvedValue('IMPORTED'),
    hasPrivateKey: vi.fn(),
    exportOwnPublicKey: vi.fn(),
    openSettings: vi.fn(),
  } as unknown as MailvelopeKeyring;
}

describe('recipient key resolution', () => {
  it('extracts bare lowercase addresses and de-duplicates', () => {
    expect(bareAddress('"Doe, Jane" <Jane@Example.COM>')).toBe('jane@example.com');
    expect(bareAddress(' a@b.c ')).toBe('a@b.c');
    expect(uniqueAddresses(['A@b.c', 'Name <a@b.c>', 'x@y.z'])).toEqual(['a@b.c', 'x@y.z']);
  });

  it('classifies ready, importable and missing recipients', () => {
    const map: MailvelopeKeyMap = {
      'a@x.org': { keys: [key('LOC')] },
      'b@x.org': { keys: [key('WKD', 'ARMOR')] },
      'c@x.org': false,
      'd@x.org': { keys: [] },
    };
    expect(classifyKeyMap(['a@x.org', 'b@x.org', 'c@x.org', 'd@x.org'], map).map((s) => s.state)).toEqual([
      'ready',
      'importable',
      'missing',
      'missing',
    ]);
  });

  it('a local key wins over a remote candidate', () => {
    const [status] = classifyKeyMap(['a@x.org'], { 'a@x.org': { keys: [key('WKD', 'A'), key('LOC')] } });
    expect(status.state).toBe('ready');
  });

  it('asks Mailvelope once for the de-duplicated list, and not at all for an empty one', async () => {
    const keyring = fakeKeyring({ 'a@x.org': { keys: [key('LOC')] } });
    await checkRecipientKeys(keyring, ['A@x.org', 'Name <a@x.org>', 'b@x.org']);
    expect(keyring.validKeyForAddress).toHaveBeenCalledWith(['a@x.org', 'b@x.org']);
    await expect(checkRecipientKeys(keyring, [])).resolves.toEqual([]);
    expect(keyring.validKeyForAddress).toHaveBeenCalledTimes(1);
  });

  it('imports through Mailvelope, which asks the user, and only when a key is offered', async () => {
    const keyring = fakeKeyring({});
    const [importable] = classifyKeyMap(['b@x.org'], { 'b@x.org': { keys: [key('OKS', 'ARMORED-KEY')] } });
    await expect(importRecipientKey(keyring, importable)).resolves.toBe('IMPORTED');
    expect(keyring.importPublicKey).toHaveBeenCalledWith('ARMORED-KEY');

    const [missing] = classifyKeyMap(['c@x.org'], { 'c@x.org': false });
    await expect(importRecipientKey(keyring, missing)).resolves.toBeNull();
    expect(keyring.importPublicKey).toHaveBeenCalledTimes(1);
  });
});

describe('encryptAndBuildMessage', () => {
  const editor = (armored: string | Error): MailvelopeEditor => ({
    encrypt: vi.fn(async () => {
      if (armored instanceof Error) throw armored;
      return armored;
    }),
    createDraft: vi.fn(),
  });

  const input = (ed: MailvelopeEditor, keyring: MailvelopeKeyring) => ({
    editor: ed,
    keyring,
    from: { name: 'Me', email: 'me@example.com' },
    to: [{ email: 'to@example.org' }],
    cc: [{ email: 'cc@example.org' }],
    bcc: [{ email: 'hidden@example.net' }],
    subject: 'Plans',
  });

  it('wraps the ciphertext as PGP/MIME and lists every recipient, Bcc included, in the envelope only', async () => {
    const ed = editor(ARMOR);
    const { raw, envelopeRecipients } = await encryptAndBuildMessage(input(ed, fakeKeyring({})));
    expect(envelopeRecipients).toEqual(['to@example.org', 'cc@example.org', 'hidden@example.net']);
    expect(raw).toContain('multipart/encrypted');
    expect(raw).toContain(ARMOR.replace(/\n/g, '\r\n'));
    expect(raw).not.toContain('hidden@example.net');
    expect(raw).not.toMatch(/^bcc:/im);
  });

  // Checking this after encrypting means the user answers the passphrase
  // dialog, waits, and is then told the message cannot be built.
  it.each([
    ['a To address', { to: [{ email: 'jörg@example.org' }] }],
    ['a Cc address', { cc: [{ email: 'jörg@example.org' }] }],
    // Bcc reaches no header, so only this check can catch it.
    ['a Bcc address', { bcc: [{ email: 'jörg@example.org' }] }],
    ['the sender', { from: { email: 'jörg@example.org' } }],
  ])('rejects a non-ASCII %s without encrypting', async (_label, override) => {
    const ed = editor(ARMOR);
    await expect(encryptAndBuildMessage({ ...input(ed, fakeKeyring({})), ...override })).rejects.toMatchObject({
      code: 'BULWARK_NON_ASCII_ADDRESS',
      address: 'jörg@example.org',
    });
    expect(ed.encrypt).not.toHaveBeenCalled();
  });

  it('rejects a malformed address without encrypting', async () => {
    const ed = editor(ARMOR);
    await expect(
      encryptAndBuildMessage({ ...input(ed, fakeKeyring({})), to: [{ email: 'not-an-address' }] }),
    ).rejects.toMatchObject({ code: 'BULWARK_INVALID_ADDRESS', address: 'not-an-address' });
    expect(ed.encrypt).not.toHaveBeenCalled();
  });

  it('maps the address codes to their own messages', () => {
    expect(pgpErrorMessageKey({ code: 'BULWARK_NON_ASCII_ADDRESS' })).toBe('error_non_ascii_address');
    expect(pgpErrorMessageKey({ code: 'BULWARK_INVALID_ADDRESS' })).toBe('error_invalid_address');
  });

  it('encrypts to the sender as well when their key is in the local keyring', async () => {
    const ed = editor(ARMOR);
    await encryptAndBuildMessage(input(ed, fakeKeyring({ 'me@example.com': { keys: [key('LOC')] } })));
    expect(ed.encrypt).toHaveBeenCalledWith(['to@example.org', 'cc@example.org', 'hidden@example.net', 'me@example.com']);
  });

  it('leaves the sender out when they have no local key, so encryption cannot fail on it', async () => {
    const ed = editor(ARMOR);
    await encryptAndBuildMessage(input(ed, fakeKeyring({ 'me@example.com': { keys: [key('WKD', 'A')] } })));
    expect(ed.encrypt).toHaveBeenCalledWith(['to@example.org', 'cc@example.org', 'hidden@example.net']);
  });

  it('does not list the sender twice when they write to themselves', async () => {
    const ed = editor(ARMOR);
    await encryptAndBuildMessage({ ...input(ed, fakeKeyring({})), to: [{ email: 'Me@Example.com' }], cc: [], bcc: [] });
    expect(ed.encrypt).toHaveBeenCalledWith(['me@example.com']);
  });

  it('never builds a message from anything but ciphertext', async () => {
    for (const bad of ['Meet at noon', '', `leak\n${ARMOR}`]) {
      await expect(encryptAndBuildMessage(input(editor(bad), fakeKeyring({})))).rejects.toThrow(/armored PGP MESSAGE/);
    }
  });

  it('lets Mailvelope errors through untouched', async () => {
    const err = Object.assign(new Error('No valid encryption key'), { code: 'NO_KEY_FOR_RECIPIENT' });
    await expect(encryptAndBuildMessage(input(editor(err), fakeKeyring({})))).rejects.toBe(err);
  });
});

describe('pgpErrorMessageKey', () => {
  it('maps known Mailvelope codes and falls back to a generic message', () => {
    expect(pgpErrorMessageKey(Object.assign(new Error('x'), { code: 'NO_KEY_FOR_RECIPIENT' }))).toBe('error_no_key_for_recipient');
    expect(pgpErrorMessageKey(Object.assign(new Error('x'), { code: 'ENCRYPT_QUOTA_SIZE' }))).toBe('error_quota');
    expect(pgpErrorMessageKey(Object.assign(new Error('x'), { code: 'WHO_KNOWS' }))).toBe('error_generic');
    expect(pgpErrorMessageKey(new Error('plain'))).toBe('error_generic');
    expect(pgpErrorMessageKey(undefined)).toBe('error_generic');
  });
});
