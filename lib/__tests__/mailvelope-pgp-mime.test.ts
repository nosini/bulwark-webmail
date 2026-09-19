// @vitest-environment node
import { describe, it, expect } from 'vitest';
import PostalMime from 'postal-mime';
import { assertArmoredMessage, buildPgpMimeMessage, rfc5322Date } from '@/lib/mailvelope/pgp-mime';

const ARMOR = [
  '-----BEGIN PGP MESSAGE-----',
  '',
  'hQEMA1Vn7c1u8bVhAQf/Xk3dR0m4d3aVwqQm0Pq0y5k8q1mXo2c1bHc3s9xZ4N7b',
  'r9TQpJ8z0QeH1S5oV3mU6yK2n8c4bW7dF1aL0xE9tG3hJ5uR2iO4pS6kM8nB1vC3',
  '=AbCd',
  '-----END PGP MESSAGE-----',
].join('\n');

const base = {
  from: { name: 'Alice Example', email: 'alice@example.com' },
  to: [{ email: 'bob@example.org' }],
  subject: 'Hello',
  armored: ARMOR,
  date: new Date('2026-09-19T12:00:00Z'),
  messageId: 'abc123@example.com',
  boundary: 'bulwark-pgp-test-boundary',
};

/** Split a message into its header block and body at the first blank line. */
function split(raw: string): { head: string; body: string } {
  const at = raw.indexOf('\r\n\r\n');
  return { head: raw.slice(0, at), body: raw.slice(at + 4) };
}

/** Undo header folding so a header can be asserted as one line. */
function unfold(head: string): string {
  return head.replace(/\r\n[ \t]+/g, ' ');
}

describe('buildPgpMimeMessage: RFC 3156 structure', () => {
  it('emits multipart/encrypted with the pgp-encrypted protocol and the given boundary', () => {
    const { raw } = buildPgpMimeMessage(base);
    const head = unfold(split(raw).head);
    expect(head).toContain('MIME-Version: 1.0');
    expect(head).toMatch(
      /Content-Type: multipart\/encrypted; protocol="application\/pgp-encrypted"; boundary="bulwark-pgp-test-boundary"/,
    );
  });

  it('has exactly two parts: a "Version: 1" control part, then encrypted.asc', () => {
    const { body } = split(buildPgpMimeMessage(base).raw);
    const delimiters = body.match(/^--bulwark-pgp-test-boundary(--)?$/gm);
    expect(delimiters).toEqual(['--bulwark-pgp-test-boundary', '--bulwark-pgp-test-boundary', '--bulwark-pgp-test-boundary--']);

    const [, control, payload] = body.split(/^--bulwark-pgp-test-boundary(?:--)?$/m);
    expect(control).toContain('Content-Type: application/pgp-encrypted');
    expect(control.split('\r\n\r\n')[1].trim()).toBe('Version: 1');
    expect(payload).toContain('Content-Type: application/octet-stream; name="encrypted.asc"');
    expect(payload).toContain('Content-Disposition: inline; filename="encrypted.asc"');
  });

  it('carries the armored ciphertext byte for byte, CRLF-terminated', () => {
    const { raw } = buildPgpMimeMessage(base);
    expect(raw).toContain(ARMOR.replace(/\n/g, '\r\n'));
  });

  it('uses CRLF throughout and stays 7-bit with short lines', () => {
    const { raw } = buildPgpMimeMessage({ ...base, subject: 'Grüße aus Zürich — 你好 '.repeat(6) });
    expect(raw.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
    // eslint-disable-next-line no-control-regex
    expect(raw).not.toMatch(/[^\x09\x0A\x0D\x20-\x7E]/);
    for (const line of raw.split('\r\n')) expect(line.length).toBeLessThanOrEqual(78);
    expect(raw.endsWith('--\r\n')).toBe(true);
  });

  it('writes Date, From, To, Subject and Message-ID', () => {
    const { raw, messageId } = buildPgpMimeMessage(base);
    const head = unfold(split(raw).head);
    expect(head).toContain('Date: Sat, 19 Sep 2026 12:00:00 +0000');
    expect(head).toContain('From: Alice Example <alice@example.com>');
    expect(head).toContain('To: bob@example.org');
    expect(head).toContain('Subject: Hello');
    expect(head).toContain('Message-ID: <abc123@example.com>');
    expect(messageId).toBe('<abc123@example.com>');
  });

  it('generates a Message-ID on the sender domain when none is given', () => {
    const { messageId } = buildPgpMimeMessage({ ...base, messageId: undefined });
    expect(messageId).toMatch(/^<[0-9a-z]+\.[0-9a-f]{24}@example\.com>$/);
  });

  it('never writes a Bcc header', () => {
    expect(buildPgpMimeMessage(base).raw).not.toMatch(/^bcc:/im);
  });

  it('is parsed as a two-part multipart/encrypted message by an independent MIME parser', async () => {
    const { raw } = buildPgpMimeMessage({ ...base, cc: [{ name: 'Carol, PhD', email: 'carol@example.net' }] });
    const parsed = await PostalMime.parse(raw);
    expect(parsed.subject).toBe('Hello');
    expect(parsed.from?.address).toBe('alice@example.com');
    expect(parsed.cc?.[0]).toMatchObject({ name: 'Carol, PhD', address: 'carol@example.net' });
    const encrypted = parsed.attachments.find((a) => a.filename === 'encrypted.asc');
    expect(encrypted?.mimeType).toBe('application/octet-stream');
    const content = encrypted!.content as ArrayBuffer;
    // postal-mime hands back decoded content with LF line endings.
    expect(new TextDecoder().decode(content).replace(/\r\n/g, '\n').trim()).toBe(ARMOR);
  });
});

describe('buildPgpMimeMessage: headers', () => {
  it('RFC 2047-encodes a non-ASCII subject in words of at most 75 characters that decode back', async () => {
    const subject = 'Grüße aus Zürich — 你好世界, this is a rather long subject line to force several encoded words';
    const { raw } = buildPgpMimeMessage({ ...base, subject });
    const head = split(raw).head;
    const words = head.match(/=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=/g) ?? [];
    expect(words.length).toBeGreaterThan(1);
    for (const word of words) expect(word.length).toBeLessThanOrEqual(75);
    expect((await PostalMime.parse(raw)).subject).toBe(subject);
  });

  it('never splits a multi-byte character across encoded words', async () => {
    const subject = '你好世界'.repeat(20);
    expect((await PostalMime.parse(buildPgpMimeMessage({ ...base, subject }).raw)).subject).toBe(subject);
  });

  it('folds a long ASCII subject at whitespace without changing it', async () => {
    const subject = 'word '.repeat(40).trim();
    const { raw } = buildPgpMimeMessage({ ...base, subject });
    expect(unfold(split(raw).head)).toContain(`Subject: ${subject}`);
    expect((await PostalMime.parse(raw)).subject).toBe(subject);
  });

  it('folds long recipient lists between mailboxes', async () => {
    const to = Array.from({ length: 12 }, (_, i) => ({ name: `Person ${i}`, email: `person${i}@example.org` }));
    const { raw } = buildPgpMimeMessage({ ...base, to });
    for (const line of split(raw).head.split('\r\n')) expect(line.length).toBeLessThanOrEqual(78);
    const parsed = await PostalMime.parse(raw);
    expect(parsed.to?.map((a) => a.address)).toEqual(to.map((a) => a.email));
  });

  it('quotes display names that contain specials and encodes non-ASCII ones', async () => {
    const { raw } = buildPgpMimeMessage({
      ...base,
      from: { name: 'Doe, "Jane"', email: 'jane@example.com' },
      to: [{ name: 'Zoë Müller', email: 'zoe@example.org' }],
    });
    const parsed = await PostalMime.parse(raw);
    expect(parsed.from?.name).toBe('Doe, "Jane"');
    expect(parsed.to?.[0].name).toBe('Zoë Müller');
  });

  it('brackets threading ids and keeps them in order', () => {
    const { raw } = buildPgpMimeMessage({
      ...base,
      inReplyTo: ['parent@example.org'],
      references: ['root@example.org', '<parent@example.org>'],
    });
    const head = unfold(split(raw).head);
    expect(head).toContain('In-Reply-To: <parent@example.org>');
    expect(head).toContain('References: <root@example.org> <parent@example.org>');
  });

  it('cannot be made to inject headers through the subject or a display name', () => {
    const { raw } = buildPgpMimeMessage({
      ...base,
      subject: 'Hi\r\nBcc: evil@example.org',
      from: { name: 'Eve\r\nBcc: evil@example.org', email: 'eve@example.com' },
    });
    expect(raw).not.toMatch(/^Bcc:/im);
    expect(split(raw).head.split('\r\n').filter((l) => /^[A-Za-z-]+:/.test(l)).every((l) => !l.startsWith('Bcc'))).toBe(true);
  });

  it('rejects malformed and non-ASCII addresses instead of guessing', () => {
    expect(() => buildPgpMimeMessage({ ...base, to: [{ email: 'a@b.c\r\nBcc: x@y.z' }] })).toThrow(/Invalid email/);
    expect(() => buildPgpMimeMessage({ ...base, to: [{ email: 'not-an-address' }] })).toThrow(/Invalid email/);
    expect(() => buildPgpMimeMessage({ ...base, to: [{ email: 'jörg@example.org' }] })).toThrow(/non-ASCII/);
  });

  it('accepts an apostrophe in the local part', () => {
    expect(buildPgpMimeMessage({ ...base, to: [{ email: "o'brien@example.org" }] }).raw).toContain("o'brien@example.org");
  });

  it('needs a recipient', () => {
    expect(() => buildPgpMimeMessage({ ...base, to: [], cc: [] })).toThrow(/recipient/);
  });

  it('picks a new boundary when the armor would contain the delimiter', () => {
    const hostile = ARMOR.replace('=AbCd', '--bulwark-pgp-test-boundary\n=AbCd');
    const { raw } = buildPgpMimeMessage({ ...base, armored: hostile });
    expect(raw).not.toContain('boundary="bulwark-pgp-test-boundary"');
  });
});

describe('assertArmoredMessage: never wraps anything but ciphertext', () => {
  it('accepts an armored message with CRLF or LF endings', () => {
    expect(assertArmoredMessage(ARMOR.replace(/\n/g, '\r\n'))).toBe(ARMOR);
  });

  it.each([
    ['plaintext', 'Meet me at noon.'],
    ['empty', ''],
    ['a public key block', '-----BEGIN PGP PUBLIC KEY BLOCK-----\n\nabc\n-----END PGP PUBLIC KEY BLOCK-----'],
    ['a cleartext-signed message', '-----BEGIN PGP SIGNED MESSAGE-----\nHash: SHA256\n\nhi\n-----BEGIN PGP SIGNATURE-----\nabc\n-----END PGP SIGNATURE-----'],
    ['a truncated block', '-----BEGIN PGP MESSAGE-----\n\nabc'],
    ['text around the block', `secret text\n${ARMOR}`],
  ])('rejects %s', (_label, payload) => {
    expect(() => assertArmoredMessage(payload)).toThrow(/armored PGP MESSAGE/);
    expect(() => buildPgpMimeMessage({ ...base, armored: payload })).toThrow();
  });

  it('rejects non-ASCII payloads', () => {
    expect(() => assertArmoredMessage(ARMOR.replace('=AbCd', '=Abéd'))).toThrow(/7-bit/);
  });
});

describe('rfc5322Date', () => {
  it('formats in UTC with a numeric zone', () => {
    expect(rfc5322Date(new Date('2026-01-05T03:04:05Z'))).toBe('Mon, 5 Jan 2026 03:04:05 +0000');
  });
});
