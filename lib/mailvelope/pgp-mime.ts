/**
 * Assembles an RFC 3156 PGP/MIME (`multipart/encrypted`) message around the
 * armored ciphertext Mailvelope produced.
 *
 * Mailvelope's editor container already encrypts a MIME entity (multipart/mixed
 * with the text and any attachments), which is exactly the payload RFC 3156 §4
 * asks for, so wrapping the armor is all that is left to do. Only the headers
 * are visible on the wire: Subject, From, To, Cc and threading stay cleartext.
 *
 * Self-contained on purpose (no app imports): scripts/mailvelope/wire-check.mjs
 * runs this same code against a real server.
 */

export interface MimeAddress {
  name?: string;
  email: string;
}

export interface PgpMimeMessageOptions {
  from: MimeAddress;
  to: MimeAddress[];
  cc?: MimeAddress[];
  subject: string;
  /** `-----BEGIN PGP MESSAGE-----` block as returned by `editor.encrypt()`. */
  armored: string;
  date?: Date;
  /** Bare or `<bracketed>`. Generated from the sender's domain when omitted. */
  messageId?: string;
  inReplyTo?: string[];
  references?: string[];
  boundary?: string;
}

export interface BuiltPgpMimeMessage {
  /** CRLF-terminated, 7-bit clean RFC 5322 message. */
  raw: string;
  /** Bracketed Message-ID that went into the header. */
  messageId: string;
}

const CRLF = '\r\n';
/** Fold structured headers at this column; RFC 5322 §2.2.3 recommends 78. */
const FOLD_AT = 76;
/**
 * 39 bytes of UTF-8 are 52 base64 chars, so an encoded-word is 64 chars: under
 * RFC 2047's 75, and still inside the 78-column fold after "Subject: ".
 */
const ENCODED_WORD_BYTES = 39;

const ARMORED_MESSAGE_RE = /^-----BEGIN PGP MESSAGE-----\n[\s\S]+\n-----END PGP MESSAGE-----$/;

/** Throws unless `armored` is one complete armored `PGP MESSAGE` block. */
export function assertArmoredMessage(armored: string): string {
  const normalized = armored.replace(/\r\n?/g, '\n').trim();
  if (!ARMORED_MESSAGE_RE.test(normalized)) {
    // The last line of defense against wrapping and sending plaintext.
    throw new Error('Refusing to build a PGP/MIME message: the payload is not an armored PGP MESSAGE');
  }
  if (/[^\x20-\x7E\n]/.test(normalized)) {
    throw new Error('Refusing to build a PGP/MIME message: the armored payload is not 7-bit ASCII');
  }
  return normalized;
}

// eslint-disable-next-line no-control-regex
const CONTROLS_RE = /[\x00-\x1F\x7F]+/g;

function cleanText(value: string): string {
  return value.replace(CONTROLS_RE, ' ').trim();
}

function utf8ToBase64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** RFC 2047 encoded-words (unbreakable tokens) for text that is not plain printable ASCII. */
function encodeWords(value: string): string[] {
  const text = cleanText(value);
  if (!text) return [];
  if (!/[^\x20-\x7E]/.test(text)) return text.split(/ +/);

  const encoder = new TextEncoder();
  const words: string[] = [];
  let chunk = '';
  let bytes = 0;
  const flush = () => {
    if (chunk) words.push(`=?UTF-8?B?${utf8ToBase64(chunk)}?=`);
    chunk = '';
    bytes = 0;
  };
  for (const ch of text) {
    const size = encoder.encode(ch).length;
    if (bytes + size > ENCODED_WORD_BYTES) flush();
    chunk += ch;
    bytes += size;
  }
  flush();
  return words;
}

/** Greedy fold of unbreakable tokens: a line break replaces the space before a token. */
function fold(name: string, tokens: string[]): string {
  const lines: string[] = [];
  let line = `${name}:`;
  let lineHasToken = false;
  for (const token of tokens) {
    const candidate = `${line} ${token}`;
    // A line always keeps at least one token, so an oversized token cannot loop.
    if (lineHasToken && candidate.length > FOLD_AT) {
      lines.push(line);
      line = ` ${token}`;
    } else {
      line = candidate;
    }
    lineHasToken = true;
  }
  lines.push(line);
  return lines.join(CRLF);
}

const ADDR_SPEC_RE = /^[^\s<>",;:\\()[\]]+@[^\s<>",;:\\()[\]]+$/;

function addrSpec(email: string): string {
  const cleaned = email.trim();
  if (!ADDR_SPEC_RE.test(cleaned)) throw new Error(`Invalid email address: ${JSON.stringify(email)}`);
  if (/[^\x21-\x7E]/.test(cleaned)) {
    throw new Error(`Cannot send PGP/MIME to a non-ASCII address (${cleaned}): it would need SMTPUTF8`);
  }
  return cleaned;
}

/** One mailbox as breakable tokens: the phrase's words, then `<addr>`. */
function mailboxTokens({ name, email }: MimeAddress): string[] {
  const addr = addrSpec(email);
  const display = name ? cleanText(name) : '';
  if (!display) return [addr];
  if (/[^\x20-\x7E]/.test(display)) return [...encodeWords(display), `<${addr}>`];
  if (/[()<>[\]:;@\\,."]/.test(display)) return [`"${display.replace(/["\\]/g, '\\$&')}"`, `<${addr}>`];
  return [...display.split(/ +/), `<${addr}>`];
}

/** Address-list tokens: the comma trails the last token of every mailbox but the final one. */
function addressListTokens(addresses: MimeAddress[]): string[] {
  return addresses.flatMap((address, index) => {
    const tokens = mailboxTokens(address);
    if (index < addresses.length - 1) tokens[tokens.length - 1] += ',';
    return tokens;
  });
}

/** Date in RFC 5322 §3.3 form, always UTC. */
export function rfc5322Date(date: Date): string {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${days[date.getUTCDay()]}, ${date.getUTCDate()} ${months[date.getUTCMonth()]} ${date.getUTCFullYear()} ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} +0000`
  );
}

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  // getRandomValues exists in insecure contexts too, unlike randomUUID.
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}

function bracketed(id: string): string {
  const bare = id.replace(/[\s<>]+/g, '');
  return bare ? `<${bare}>` : '';
}

/** A fresh `<time.random@sender-domain>` id, so the server does not invent one from its hostname. */
export function generatePgpMessageId(fromEmail: string): string {
  const at = fromEmail.lastIndexOf('@');
  const domain = at > 0 ? fromEmail.slice(at + 1).replace(/[^A-Za-z0-9.-]/g, '') : '';
  return `<${Date.now().toString(36)}.${randomHex(12)}@${domain || 'localhost'}>`;
}

export function buildPgpMimeMessage(opts: PgpMimeMessageOptions): BuiltPgpMimeMessage {
  const armor = assertArmoredMessage(opts.armored);
  const armorLines = armor.split('\n');

  let boundary = opts.boundary ?? `bulwark-pgp-${randomHex(16)}`;
  while (armorLines.some((line) => line.startsWith(`--${boundary}`))) {
    boundary = `bulwark-pgp-${randomHex(16)}`;
  }
  if (!/^[A-Za-z0-9'()+_,./:=?-]{1,70}$/.test(boundary)) {
    throw new Error('Invalid MIME boundary');
  }

  const cc = opts.cc ?? [];
  if (opts.to.length === 0 && cc.length === 0) throw new Error('A PGP/MIME message needs at least one recipient');

  const messageId = opts.messageId ? bracketed(opts.messageId) : generatePgpMessageId(opts.from.email);
  const inReplyTo = (opts.inReplyTo ?? []).map(bracketed).filter(Boolean);
  const references = (opts.references ?? []).map(bracketed).filter(Boolean);

  const headers = [
    fold('Date', [rfc5322Date(opts.date ?? new Date())]),
    fold('From', mailboxTokens(opts.from)),
    ...(opts.to.length > 0 ? [fold('To', addressListTokens(opts.to))] : []),
    ...(cc.length > 0 ? [fold('Cc', addressListTokens(cc))] : []),
    fold('Subject', encodeWords(opts.subject)),
    fold('Message-ID', [messageId]),
    ...(inReplyTo.length > 0 ? [fold('In-Reply-To', inReplyTo)] : []),
    ...(references.length > 0 ? [fold('References', references)] : []),
    'MIME-Version: 1.0',
    `Content-Type: multipart/encrypted;${CRLF}\tprotocol="application/pgp-encrypted";${CRLF}\tboundary="${boundary}"`,
  ];

  const body = [
    'This is an OpenPGP/MIME encrypted message (RFC 4880 and 3156)',
    `--${boundary}`,
    'Content-Type: application/pgp-encrypted',
    'Content-Description: PGP/MIME version identification',
    '',
    'Version: 1',
    '',
    `--${boundary}`,
    'Content-Type: application/octet-stream; name="encrypted.asc"',
    'Content-Description: OpenPGP encrypted message',
    'Content-Disposition: inline; filename="encrypted.asc"',
    '',
    ...armorLines,
    `--${boundary}--`,
    '',
  ];

  const raw = `${headers.join(CRLF)}${CRLF}${CRLF}${body.join(CRLF)}`;

  // Everything above is meant to be 7-bit; anything else slipped past an
  // encoder, and shipping it would corrupt headers or the ciphertext.
  // eslint-disable-next-line no-control-regex
  if (/[^\x09\x0A\x0D\x20-\x7E]/.test(raw)) throw new Error('PGP/MIME message is not 7-bit ASCII');

  return { raw, messageId };
}
