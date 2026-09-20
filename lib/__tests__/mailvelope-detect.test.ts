import { describe, it, expect } from 'vitest';
import type { Email, EmailBodyPart } from '@/lib/jmap/types';
import {
  detectPgpMessage,
  extractEncryptedPayload,
  extractInlineArmor,
  normalizeArmor,
  pgpDetectionKey,
} from '@/lib/mailvelope/detect';

const ARMOR = ['-----BEGIN PGP MESSAGE-----', '', 'hQEMA1Vn7c1u8bVh', '=AbCd', '-----END PGP MESSAGE-----'].join('\n');
const SIGNED = [
  '-----BEGIN PGP SIGNED MESSAGE-----',
  'Hash: SHA256',
  '',
  'hello',
  '-----BEGIN PGP SIGNATURE-----',
  '',
  'iQEzBAEBCAAdFiEE',
  '-----END PGP SIGNATURE-----',
].join('\n');

const part = (over: Partial<EmailBodyPart>): EmailBodyPart => ({ partId: '1', blobId: 'b1', size: 1, type: 'text/plain', ...over });

function email(over: Partial<Email>): Email {
  return { id: 'e1', threadId: 't1', mailboxIds: {}, keywords: {}, size: 1, receivedAt: '', hasAttachment: false, ...over };
}

const pgpMime = (over: Partial<Email> = {}): Email =>
  email({
    headers: { 'content-type': 'multipart/encrypted; protocol="application/pgp-encrypted"; boundary="x"' },
    bodyStructure: part({
      partId: '',
      blobId: '',
      type: 'multipart/encrypted',
      subParts: [
        part({ partId: '1', blobId: 'ctl', type: 'application/pgp-encrypted' }),
        part({ partId: '2', blobId: 'payload', type: 'application/octet-stream', name: 'encrypted.asc' }),
      ],
    }),
    ...over,
  });

describe('detectPgpMessage: PGP/MIME', () => {
  it('finds the octet-stream payload of a multipart/encrypted message', () => {
    expect(detectPgpMessage(pgpMime())).toEqual({
      kind: 'pgp-mime',
      payloadBlobId: 'payload',
      payloadName: 'encrypted.asc',
      payloadType: 'application/octet-stream',
      hiddenPartIds: ['1', '2'],
    });
  });

  it('works without the Content-Type header, from the part structure alone', () => {
    expect(detectPgpMessage(pgpMime({ headers: undefined }))?.kind).toBe('pgp-mime');
  });

  it('reads the protocol parameter case-insensitively from a folded header', () => {
    const e = pgpMime({ headers: { 'Content-Type': ['multipart/encrypted;\r\n  PROTOCOL = "Application/PGP-Encrypted";\r\n  boundary=x'] } });
    expect(detectPgpMessage(e)?.kind).toBe('pgp-mime');
  });

  it('rejects multipart/encrypted with a different protocol', () => {
    const e = pgpMime({ headers: { 'content-type': 'multipart/encrypted; protocol="application/x-other"; boundary=x' } });
    expect(detectPgpMessage(e)).toBeNull();
  });

  it('rejects multipart/encrypted with no usable payload', () => {
    const e = pgpMime();
    e.bodyStructure!.subParts = [part({ type: 'application/pgp-encrypted' })];
    expect(detectPgpMessage(e)).toBeNull();
  });

  it('does not treat S/MIME as PGP', () => {
    const e = email({ bodyStructure: part({ type: 'application/pkcs7-mime', name: 'smime.p7m' }) });
    expect(detectPgpMessage(e)).toBeNull();
  });

  it('does not treat multipart/signed or plain mail as PGP/MIME', () => {
    expect(detectPgpMessage(email({ bodyStructure: part({ type: 'multipart/signed' }) }))).toBeNull();
    expect(detectPgpMessage(email({ bodyStructure: part({ type: 'text/plain' }) }))).toBeNull();
  });
});

describe('detectPgpMessage: inline PGP', () => {
  const inline = (text: string, over: Partial<Email> = {}): Email =>
    email({ textBody: [part({ partId: '1' })], bodyValues: { '1': { value: text } }, ...over });

  it('finds an armored message inside a text/plain body', () => {
    expect(detectPgpMessage(inline(`Hi\n\n${ARMOR}\n\n-- \nsig`))).toEqual({ kind: 'inline', armored: ARMOR });
  });

  it('finds a cleartext-signed message', () => {
    expect(detectPgpMessage(inline(SIGNED))).toEqual({ kind: 'inline', armored: SIGNED });
  });

  it('ignores a body that only mentions PGP', () => {
    expect(detectPgpMessage(inline('The header is -----BEGIN PGP MESSAGE----- in armor'))).toBeNull();
  });

  it('ignores a truncated body value, which cannot hold a complete block', () => {
    expect(detectPgpMessage(inline(ARMOR, { bodyValues: { '1': { value: ARMOR, isTruncated: true } } }))).toBeNull();
  });

  it('ignores non-text/plain parts', () => {
    const e = inline(ARMOR, { textBody: [part({ partId: '1', type: 'text/html' })] });
    expect(detectPgpMessage(e)).toBeNull();
  });

  it('prefers PGP/MIME over inline armor', () => {
    const e = pgpMime({ textBody: [part({ partId: '1' })], bodyValues: { '1': { value: ARMOR } } });
    expect(detectPgpMessage(e)?.kind).toBe('pgp-mime');
  });

  it('returns null for missing or unencrypted mail', () => {
    expect(detectPgpMessage(null)).toBeNull();
    expect(detectPgpMessage(undefined)).toBeNull();
    expect(detectPgpMessage(email({}))).toBeNull();
  });
});

describe('armor helpers', () => {
  it('normalizes line endings and trailing whitespace', () => {
    expect(normalizeArmor(ARMOR.replace(/\n/g, ' \r\n'))).toBe(ARMOR);
  });

  it('extracts only the armored block from surrounding text', () => {
    expect(extractInlineArmor(`> quoted\n${ARMOR}\ntrailer`)).toBe(ARMOR);
    expect(extractInlineArmor('no armor here')).toBeNull();
    expect(extractInlineArmor('')).toBeNull();
  });

  it('extracts the ciphertext from a downloaded encrypted.asc, and only ciphertext', () => {
    expect(extractEncryptedPayload(ARMOR.replace(/\n/g, '\r\n'))).toBe(ARMOR);
    expect(extractEncryptedPayload(SIGNED)).toBeNull();
    expect(extractEncryptedPayload(undefined)).toBeNull();
  });
});

describe('pgpDetectionKey', () => {
  const inline = (value: string, over: Partial<Email> = {}): Email =>
    email({ textBody: [part({ partId: '1' })], bodyValues: { '1': { value } }, ...over });

  it('is stable when only the read state or keywords change', () => {
    const before = inline(ARMOR);
    const after = inline(ARMOR, { keywords: { $seen: true } });
    expect(pgpDetectionKey(after)).toBe(pgpDetectionKey(before));
  });

  it('changes once a lazily fetched body arrives', () => {
    const empty = email({ textBody: [part({ partId: '1' })] });
    expect(pgpDetectionKey(empty)).not.toBe(pgpDetectionKey(inline(ARMOR)));
  });

  it('changes when a truncated body is refetched in full', () => {
    const truncated = email({
      textBody: [part({ partId: '1' })],
      bodyValues: { '1': { value: ARMOR, isTruncated: true } },
    });
    expect(pgpDetectionKey(truncated)).not.toBe(pgpDetectionKey(inline(ARMOR)));
  });

  it('distinguishes two messages and handles none at all', () => {
    expect(pgpDetectionKey(inline(ARMOR))).not.toBe(pgpDetectionKey(inline(ARMOR, { id: 'e2' })));
    expect(pgpDetectionKey(null)).toBe('');
  });

  it('never embeds the body text, however large', () => {
    const huge = 'A'.repeat(200_000);
    const key = pgpDetectionKey(inline(huge));
    expect(key).not.toContain(huge);
    expect(key.length).toBeLessThan(200);
  });
});
