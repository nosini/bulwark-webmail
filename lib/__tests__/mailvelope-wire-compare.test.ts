// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { buildPgpMimeMessage } from '@/lib/mailvelope/pgp-mime';
import { compareWire, parseHeaders, splitMessage } from '../../scripts/mailvelope/wire-compare.mjs';

const ARMOR = ['-----BEGIN PGP MESSAGE-----', '', 'hQEMA1Vn7c1u8bVh', '=AbCd', '-----END PGP MESSAGE-----'].join('\n');
const { raw: SENT } = buildPgpMimeMessage({
  from: { name: 'Alice', email: 'alice@example.com' },
  to: [{ email: 'bob@example.org' }],
  subject: 'Grüße',
  armored: ARMOR,
  boundary: 'b-1',
});

/** What Stalwart does to a message: prepends trace headers, leaves the rest alone. */
const delivered = (raw: string) =>
  `Return-Path: <alice@example.com>\r\nReceived: from mail.example.com by mx.example.org; Sat, 19 Sep 2026 12:00:01 +0000\r\n${raw}`;

describe('compareWire', () => {
  it('accepts a message the server only gave trace headers', () => {
    const result = compareWire(SENT, delivered(SENT));
    expect(result.problems).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.addedHeaders).toEqual(['Return-Path', 'Received']);
  });

  it('accepts a DKIM signature and a server-added header', () => {
    const received = `DKIM-Signature: v=1; a=rsa-sha256; d=example.com; s=x; b=abc\r\n${delivered(SENT)}`;
    expect(compareWire(SENT, received).ok).toBe(true);
  });

  it('flags a lost protocol parameter (the RFC 3156 marker)', () => {
    const received = delivered(SENT.replace(/\tprotocol="application\/pgp-encrypted";\r\n/, ''));
    const { ok, problems } = compareWire(SENT, received);
    expect(ok).toBe(false);
    expect(problems.join('\n')).toMatch(/protocol/);
  });

  it('flags a message re-serialized as multipart/mixed', () => {
    const received = delivered(SENT.replace('multipart/encrypted', 'multipart/mixed'));
    const { ok, problems } = compareWire(SENT, received);
    expect(ok).toBe(false);
    expect(problems.join('\n')).toMatch(/not multipart\/encrypted/);
  });

  it('flags any change to the body, even a line-ending rewrite of the ciphertext', () => {
    const { head, body } = splitMessage(SENT);
    const received = delivered(`${head}\r\n\r\n${body.replace(/\r\n/g, '\n')}`);
    const { ok, problems } = compareWire(SENT, received);
    expect(ok).toBe(false);
    expect(problems.join('\n')).toMatch(/body was altered/);
  });

  it('flags a rewritten header the sender set', () => {
    const received = delivered(SENT.replace('Subject: =?UTF-8?B?', 'Subject: X =?UTF-8?B?'));
    expect(compareWire(SENT, received).problems.join('\n')).toMatch(/header "Subject"/);
  });

  it('flags a dropped header', () => {
    const received = delivered(SENT.replace(/^From: .*\r\n/m, ''));
    expect(compareWire(SENT, received).problems.join('\n')).toMatch(/header "From"/);
  });

  it('flags a leaked Bcc header', () => {
    const received = delivered(SENT.replace('MIME-Version: 1.0', 'Bcc: hidden@example.net\r\nMIME-Version: 1.0'));
    expect(compareWire(SENT, received).problems.join('\n')).toMatch(/Bcc/);
  });

  it('ignores header folding and case differences', () => {
    const received = delivered(SENT.replace('Content-Type:', 'content-type:').replace(/;\r\n\t/g, ';\r\n    '));
    expect(compareWire(SENT, received).ok).toBe(true);
  });
});

describe('parseHeaders', () => {
  it('unfolds continuation lines', () => {
    expect(parseHeaders('A: one\r\n two\r\nB: x')).toEqual([
      ['A', 'one two'],
      ['B', 'x'],
    ]);
  });
});
