import { buildPgpMimeMessage, type MimeAddress } from './pgp-mime';
import { bareAddress, uniqueAddresses } from './recipients';
import type { MailvelopeEditor, MailvelopeError, MailvelopeKeyring } from './types';

export interface EncryptedMessageInput {
  editor: MailvelopeEditor;
  keyring: MailvelopeKeyring;
  from: MimeAddress;
  to: MimeAddress[];
  cc: MimeAddress[];
  bcc: MimeAddress[];
  subject: string;
  inReplyTo?: string[];
  references?: string[];
}

export interface EncryptedMessage {
  /** Full RFC 822 message: the only thing that is ever uploaded. */
  raw: string;
  /** Every To/Cc/Bcc address, for the SMTP envelope. Bcc never appears in `raw`. */
  envelopeRecipients: string[];
}

/**
 * Whether the sender's own address has a key in the local keyring, i.e. the
 * Sent copy can be encrypted to them as well. Adding an address Mailvelope
 * cannot resolve would make the whole encryption fail, so this is checked
 * rather than assumed.
 */
async function hasOwnKey(keyring: MailvelopeKeyring, address: string): Promise<boolean> {
  try {
    const entry = (await keyring.validKeyForAddress([address]))[address];
    return entry ? entry.keys.some((key) => key.source === 'LOC') : false;
  } catch {
    return false;
  }
}

/**
 * Ask Mailvelope to encrypt the editor content and wrap the result in a
 * PGP/MIME message. Nothing here sees plaintext or key material: the plaintext
 * lives in the extension's iframe and `armored` is already ciphertext.
 */
export async function encryptAndBuildMessage(input: EncryptedMessageInput): Promise<EncryptedMessage> {
  const envelopeRecipients = uniqueAddresses([...input.to, ...input.cc, ...input.bcc].map((a) => a.email));

  // Encrypt to the sender too, so the copy in Sent stays readable.
  const from = bareAddress(input.from.email);
  const targets = envelopeRecipients.includes(from) || !(await hasOwnKey(input.keyring, from))
    ? envelopeRecipients
    : [...envelopeRecipients, from];

  const armored = await input.editor.encrypt(targets);

  const { raw } = buildPgpMimeMessage({
    from: input.from,
    to: input.to,
    cc: input.cc,
    subject: input.subject,
    armored,
    inReplyTo: input.inReplyTo,
    references: input.references,
  });
  return { raw, envelopeRecipients };
}

/** Mailvelope error codes the composer explains to the user; anything else gets a generic message. */
export const PGP_ERROR_MESSAGE_KEYS: Record<string, string> = {
  NO_KEY_FOR_RECIPIENT: 'error_no_key_for_recipient',
  NO_KEY_FOR_ENCRYPTION: 'error_no_own_key',
  NO_DEFAULT_KEY_FOUND: 'error_no_own_key',
  ENCRYPT_QUOTA_SIZE: 'error_quota',
  ENCRYPT_IN_PROGRESS: 'error_in_progress',
  EDITOR_DIALOG_CANCEL: 'error_cancelled',
  PWD_DIALOG_CANCEL: 'error_cancelled',
  NO_CONNECTION: 'error_disconnected',
};

export function pgpErrorMessageKey(err: unknown): string {
  const code = (err as MailvelopeError | undefined)?.code;
  return (code && PGP_ERROR_MESSAGE_KEYS[code]) || 'error_generic';
}
