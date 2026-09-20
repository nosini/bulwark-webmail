import type { Email, EmailBodyPart } from '@/lib/jmap/types';

/**
 * How an incoming message carries OpenPGP data.
 *
 * - `pgp-mime`: RFC 3156 `multipart/encrypted`. The armored ciphertext is the
 *   `application/octet-stream` part and has to be fetched as a blob.
 * - `inline`: an armored block inside a text/plain body, already in hand.
 */
export type PgpMessageSource =
  | {
      kind: 'pgp-mime';
      payloadBlobId: string;
      payloadName?: string;
      payloadType: string;
      /** Part ids of the control and payload parts, hidden from the attachment list. */
      hiddenPartIds: string[];
    }
  | { kind: 'inline'; armored: string };

const PGP_ENCRYPTED_PROTOCOL = 'application/pgp-encrypted';

/**
 * One armored block a display container can open: an encrypted message, or a
 * cleartext-signed one (which ends with the signature block).
 */
const ARMORED_BLOCK_RE =
  /-----BEGIN PGP MESSAGE-----[\s\S]*?-----END PGP MESSAGE-----|-----BEGIN PGP SIGNED MESSAGE-----[\s\S]*?-----END PGP SIGNATURE-----/;

const ARMORED_MESSAGE_RE = /-----BEGIN PGP MESSAGE-----[\s\S]*?-----END PGP MESSAGE-----/;

/**
 * Line endings and trailing whitespace differ between mail clients
 * (format=flowed, quoted-printable soft breaks). Armor tolerates neither
 * being missing nor being present, so hand the extension one clean form.
 */
export function normalizeArmor(armored: string): string {
  return armored
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .trim();
}

/** First armored PGP block in `text`, normalized, or null. */
export function extractInlineArmor(text: string | undefined | null): string | null {
  if (!text) return null;
  const match = ARMORED_BLOCK_RE.exec(text);
  return match ? normalizeArmor(match[0]) : null;
}

/** The armored ciphertext out of a decoded `encrypted.asc` part, or null. */
export function extractEncryptedPayload(text: string | undefined | null): string | null {
  if (!text) return null;
  const match = ARMORED_MESSAGE_RE.exec(text);
  return match ? normalizeArmor(match[0]) : null;
}

function headerValue(email: Email, name: string): string | undefined {
  const headers = email.headers;
  if (!headers) return undefined;
  const wanted = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() !== wanted) continue;
    const value = headers[key];
    return Array.isArray(value) ? value[0] : value;
  }
  return undefined;
}

function contentTypeProtocol(contentType: string | undefined): string | undefined {
  if (!contentType) return undefined;
  const match = /;\s*protocol\s*=\s*(?:"([^"]*)"|([^\s;]+))/i.exec(contentType);
  const value = match?.[1] ?? match?.[2];
  return value?.trim().toLowerCase();
}

function detectPgpMime(email: Email): PgpMessageSource | null {
  const root = email.bodyStructure;
  if (!root || root.type?.toLowerCase() !== 'multipart/encrypted') return null;

  // S/MIME and other schemes never use multipart/encrypted with another
  // protocol, but a stated protocol that is not OpenPGP's is authoritative.
  const protocol = contentTypeProtocol(headerValue(email, 'content-type'));
  if (protocol && protocol !== PGP_ENCRYPTED_PROTOCOL) return null;

  const parts: EmailBodyPart[] = root.subParts ?? [];
  const control = parts.find((p) => p.type?.toLowerCase() === PGP_ENCRYPTED_PROTOCOL);
  // RFC 3156 §4: the second part carries the data. Prefer that, but accept
  // any octet-stream part for clients that reorder.
  const payload =
    (parts[1]?.type?.toLowerCase() === 'application/octet-stream' ? parts[1] : undefined) ??
    parts.find((p) => p.type?.toLowerCase() === 'application/octet-stream');

  if (!payload?.blobId) return null;
  if (!control && protocol !== PGP_ENCRYPTED_PROTOCOL) return null;

  return {
    kind: 'pgp-mime',
    payloadBlobId: payload.blobId,
    payloadName: payload.name,
    payloadType: payload.type,
    hiddenPartIds: [control?.partId, payload.partId].filter((id): id is string => Boolean(id)),
  };
}

function detectInlinePgp(email: Email): PgpMessageSource | null {
  const parts = email.textBody ?? [];
  for (const part of parts) {
    if (part.type && part.type.toLowerCase() !== 'text/plain') continue;
    const value = email.bodyValues?.[part.partId];
    if (!value || value.isTruncated) continue;
    const armored = extractInlineArmor(value.value);
    if (armored) return { kind: 'inline', armored };
  }
  return null;
}

/**
 * Classify a message as PGP/MIME, inline PGP, or neither. Pure: it only looks
 * at what `Email/get` already returned (`bodyStructure`, `headers`, and the
 * text body values), so it costs nothing on messages that are not encrypted.
 */
export function detectPgpMessage(email: Email | null | undefined): PgpMessageSource | null {
  if (!email) return null;
  return detectPgpMime(email) ?? detectInlinePgp(email);
}

/**
 * Cheap identity for everything {@link detectPgpMessage} reads, so a caller can
 * memoize the result across renders. Ids, types and lengths only — never body
 * text, which for an inline PGP message is the whole armored block. It changes
 * when a lazily fetched or untruncated body arrives, so detection runs again.
 */
export function pgpDetectionKey(email: Email | null | undefined): string {
  if (!email) return '';
  const bodies = (email.textBody ?? [])
    .map((part) => {
      const value = email.bodyValues?.[part.partId];
      return `${part.partId}:${part.type ?? ''}:${value ? value.value.length : -1}:${value?.isTruncated ? 't' : ''}`;
    })
    .join(',');
  return `${email.id}|${email.blobId ?? ''}|${email.bodyStructure?.type ?? ''}|${bodies}`;
}
