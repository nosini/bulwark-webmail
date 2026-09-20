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
/** RFC 5322 §2.1.1: a line may not exceed 998 octets, excluding the CRLF. */
const MAX_LINE_OCTETS = 998;
/**
 * Longest token that always fits a folded line: folding puts a token on a line
 * of its own after the header name (`Subject: `) or a single space, and the
 * slack covers the longest name emitted here.
 */
const MAX_TOKEN_OCTETS = MAX_LINE_OCTETS - 32;

const ARMOR_BEGIN = '-----BEGIN PGP MESSAGE-----';
const ARMOR_END = '-----END PGP MESSAGE-----';
/** RFC 4880 §6.2 armor header, e.g. `Version: Mailvelope v6.3.0`. */
const ARMOR_HEADER_RE = /^[A-Za-z][A-Za-z0-9-]*:( .*)?$/;
/**
 * Radix-64 data line (RFC 4880 §6.3). The alternative is a line of nothing but
 * padding, which happens when the encoded length is a multiple of the wrap
 * width and the `=` or `==` is carried onto a line of its own.
 */
const ARMOR_DATA_RE = /^(?:[A-Za-z0-9+/]+={0,2}|={1,2})$/;
/** Trailing CRC-24: `=` plus four radix-64 characters. Optional per RFC 9580. */
const ARMOR_CRC_RE = /^=[A-Za-z0-9+/]{4}$/;

/**
 * One complete armored block and nothing else.
 *
 * Matching only the BEGIN and END markers is not enough: a greedy match spans
 * an END/BEGIN pair, so `block + plaintext + block` looks like one block. Every
 * interior line is therefore checked against the armor grammar, which no
 * marker line and almost no prose can satisfy.
 */
function isArmoredMessage(text: string): boolean {
  const lines = text.split('\n');
  if (lines.length < 3) return false;
  if (lines[0] !== ARMOR_BEGIN || lines[lines.length - 1] !== ARMOR_END) return false;

  const body = lines.slice(1, -1).map(line => line.replace(/[ \t]+$/, ''));
  let i = 0;
  // Optional armor headers, terminated by a blank line.
  while (i < body.length && body[i] !== '' && ARMOR_HEADER_RE.test(body[i])) i++;
  if (i < body.length && body[i] === '') i++;

  let dataLines = 0;
  for (; i < body.length; i++) {
    // The CRC-24, when present, is the last line before the END marker.
    if (ARMOR_CRC_RE.test(body[i])) return dataLines > 0 && i === body.length - 1;
    if (!ARMOR_DATA_RE.test(body[i])) return false;
    dataLines++;
  }
  return dataLines > 0;
}

/** Throws unless `armored` is one complete armored `PGP MESSAGE` block. */
export function assertArmoredMessage(armored: string): string {
  const normalized = armored.replace(/\r\n?/g, '\n').trim();
  // Checked before the structure so a non-ASCII byte is named as such rather
  // than reported as a broken block.
  if (/[^\x20-\x7E\n]/.test(normalized)) {
    throw new Error('Refusing to build a PGP/MIME message: the armored payload is not 7-bit ASCII');
  }
  if (!isArmoredMessage(normalized)) {
    // The last line of defense against wrapping and sending plaintext.
    throw new Error('Refusing to build a PGP/MIME message: the payload is not an armored PGP MESSAGE');
  }
  return normalized;
}

// eslint-disable-next-line no-control-regex
const CONTROLS_RE = /[\x00-\x1F\x7F]+/g;

function cleanText(value: string): string {
  return value.replace(CONTROLS_RE, ' ').trim();
}

function octetLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

/** A token short enough to fold onto a line of its own within MAX_LINE_OCTETS. */
function fitsLine(token: string): boolean {
  return octetLength(token) <= MAX_TOKEN_OCTETS;
}

function utf8ToBase64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * RFC 2047 encoded-words for already-cleaned text. Each word stays under the
 * fold width, and RFC 2047 §6.2 drops the whitespace between adjacent
 * encoded-words, so the text survives folding exactly — unlike breaking a long
 * token by hand, which unfolds with a space inserted into it.
 */
function encodedWords(text: string): string[] {
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

/**
 * Header text as breakable tokens. Plain ASCII words are kept as they are, but
 * a word too long to fit a line — a pasted URL in a subject — is encoded
 * instead, because folding cannot break inside a token and the line would
 * otherwise run past the 998-octet limit.
 */
function encodeWords(value: string): string[] {
  const text = cleanText(value);
  if (!text) return [];
  const words = text.split(/ +/);
  if (!/[^\x20-\x7E]/.test(text) && words.every(fitsLine)) return words;
  return encodedWords(text);
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
  // Every token that can be broken up is already short enough, so a line over
  // the limit here means an unbreakable one: an absurd addr-spec. There is no
  // legal way to emit it, so refuse rather than send a malformed message.
  for (const emitted of lines) {
    if (octetLength(emitted) > MAX_LINE_OCTETS) {
      throw new Error(`Refusing to build a PGP/MIME message: the ${name} header cannot be folded under 998 octets`);
    }
  }
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
  if (/[()<>[\]:;@\\,."]/.test(display)) {
    const quoted = `"${display.replace(/["\\]/g, '\\$&')}"`;
    // Encoded-words need no quoting, and unlike the raw words they cannot
    // leave a bare comma loose in an address list.
    return fitsLine(quoted) ? [quoted, `<${addr}>`] : [...encodedWords(display), `<${addr}>`];
  }
  const words = display.split(/ +/);
  if (!words.every(fitsLine)) return [...encodedWords(display), `<${addr}>`];
  return [...words, `<${addr}>`];
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
  // A msg-id cannot be folded or encoded, so one too long for a line is
  // dropped: threading degrades, which beats being unable to reply at all to a
  // message whose Message-ID was absurd.
  const inReplyTo = (opts.inReplyTo ?? []).map(bracketed).filter((id) => id && fitsLine(id));
  const references = (opts.references ?? []).map(bracketed).filter((id) => id && fitsLine(id));

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
